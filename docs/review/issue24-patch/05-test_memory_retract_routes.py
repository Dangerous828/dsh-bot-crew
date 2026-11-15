#!/usr/bin/env python3
"""dsh-bot-crew#24 · 原子撤回/tombstone 契约测试（无 DB、无网）。

覆盖 `memory_retract_routes.retract_tombstone_impl` 的关键语义：

1. 未知 digest（无现有行）→ 新占一条 `deleted_at 已置、embedding=None、content=中性标记、不传正文` 的占位。
2. 已存在且已删 → 幂等 `already_retracted`，不重复插入。
3. 已存在且 live → 进 `existing_live`，不擅删、不覆盖。
4. 已存在但 source_file 不一致 → `conflicts`，路由层 409，不波及其它来源。
5. namespace 非 crew → 422；actor 非 admin → 403。
6. 未知 hash 不假称挡住：`placed` 只含请求的 knownDigest，不含任何“算出来的”东西。
7. 关键：插入行**不携带用户正文**（content == tombstone 标记），embedding 为 None，deleted_at 非空。

跑法：`python3.12 -m pytest tests/test_memory_retract_routes.py -q`
"""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import uuid
from pathlib import Path
from types import SimpleNamespace
from datetime import datetime, timezone

import pytest

HOME_HUB = Path("/Users/cpuser/Code/home-hub/hub")
if str(HOME_HUB) not in sys.path:
    sys.path.insert(0, str(HOME_HUB))

_TEST_STORAGE = Path(tempfile.mkdtemp(prefix="hub-retract-test-"))
os.environ.setdefault("HUB_CAS_ROOT", str(_TEST_STORAGE / "cas"))
os.environ.setdefault("HUB_SIGNING_KEY_PATH", str(_TEST_STORAGE / "keys" / "hub-ed25519.pem"))

from hub_service.memory_retract_routes import (  # noqa: E402
    RetractTombstone,
    _TombstoneMarker,
    _is_crew_namespace,
    retract_tombstone_impl,
)

from fastapi import HTTPException  # noqa: E402

NOW = datetime(2026, 11, 14, 9, 0, 0, tzinfo=timezone.utc)
NS = "dsh-memory/bot"


def run(coro):
    return asyncio.run(coro)


class FakeSession:
    """极简会话：`execute` 按预置行返回，`add` 收集、`commit` 无操作。

    `execute` 接收的是 SQLAlchemy select(...)；我们用闭包 `_existing` 决定命中，
    不解 SQL。够测逻辑分支即可。
    """

    def __init__(self, existing: list[dict] | None = None):
        self._existing = existing or []
        self.added: list[object] = []
        self.committed = 0

    async def execute(self, _stmt, _params=None):
        # 每个 digest 查询：按 metadata.dedupe_key 匹配预置行（单条或 None）。
        # 由于 impl 逐 digest 各调一次 execute，用调用计数对齐。
        idx = getattr(self, "_call", 0)
        self._call = idx + 1
        row = self._existing[idx] if idx < len(self._existing) else None
        return SimpleNamespace(scalar_one_or_none=lambda: row)

    def add(self, obj):
        self.added.append(obj)

    async def commit(self):
        self.committed += 1


def _existing_row(dk: str, source_file: str, deleted: bool):
    return SimpleNamespace(
        id=uuid.uuid4(),
        namespace=NS,
        content="用户正文不该被占位逻辑读到",
        memory_metadata={"dedupe_key": dk, "source_file": source_file},
        deleted_at=NOW if deleted else None,
        deleted_by="admin" if deleted else None,
    )


class TestNamespaceGate:
    def test_crew_namespace_accepts_exact_and_prefix(self):
        assert _is_crew_namespace("dsh-memory/bot")
        assert _is_crew_namespace("bot/lead")
        assert not _is_crew_namespace("dsh/ktool")
        assert not _is_crew_namespace("qoder/code")

    def test_non_crew_namespace_422(self):
        body = RetractTombstone(namespace="dsh/ktool", source_file="x.md", known_digests=[])
        with pytest.raises(HTTPException) as ei:
            run(retract_tombstone_impl(body, FakeSession(), "admin"))
        assert ei.value.status_code == 422

    def test_non_admin_403(self):
        body = RetractTombstone(namespace=NS, source_file="x.md", known_digests=["a" * 16])
        with pytest.raises(HTTPException) as ei:
            run(retract_tombstone_impl(body, FakeSession(), "node:mac"))
        assert ei.value.status_code == 403


class TestDigestValidation:
    def test_bad_digest_rejected(self):
        with pytest.raises(Exception):
            RetractTombstone(namespace=NS, source_file="x.md", known_digests=["XYZ"])

    def test_uppercase_normalized_and_dedup(self):
        body = RetractTombstone(
            namespace=NS, source_file="x.md",
            known_digests=["A" * 15 + "F".lower(), (("a" * 15) + "f"), "a" * 16],
        )
        # 两个都归一为 a*15+'f'，去重后应只剩 1 个（第三个 a*16 不同）
        assert len(body.known_digests) == 2


class TestPlaced:
    def test_unknown_digest_creates_deleted_no_body_placeholder(self):
        dk = "623bd5fb6702928a"
        body = RetractTombstone(namespace=NS, source_file="bot-coder-use-pnpm-test.md",
                                known_digests=[dk], reason="forget")
        sess = FakeSession(existing=[None])  # 无现有行
        res = run(retract_tombstone_impl(body, sess, "admin"))
        assert res["placed"] == [dk]
        assert res["already_retracted"] == []
        assert res["soft_deleted"] == []
        assert res["conflicts"] == []
        assert res["ok"] is True
        # 插入了 1 行 Memory + 1 行 audit
        kinds = [type(x).__name__ for x in sess.added]
        assert kinds.count("Memory") == 1
        assert kinds.count("MemoryDeleteAudit") == 1
        row = next(x for x in sess.added if type(x).__name__ == "Memory")
        # 关键：无用户正文、embedding None、deleted_at 已置、dedupe_key 落槽
        assert row.content == _TombstoneMarker
        assert row.embedding is None
        assert row.deleted_at is not None
        assert row.memory_metadata["dedupe_key"] == dk
        assert row.memory_metadata["source_file"] == "bot-coder-use-pnpm-test.md"
        assert row.memory_metadata["tombstone"] is True
        # 占位行的 content 绝不含“用户正文”字样来源（中性标记）
        assert "用户正文不该被占位逻辑读到" not in row.content
        assert res["mode"] == "tombstone"
        assert sess.committed == 1

    def test_existing_deleted_is_idempotent(self):
        dk = "88b996cba78aa5df"
        body = RetractTombstone(namespace=NS, source_file="bot-coder-x.md", known_digests=[dk])
        sess = FakeSession(existing=[_existing_row(dk, "bot-coder-x.md", deleted=True)])
        res = run(retract_tombstone_impl(body, sess, "admin"))
        assert res["already_retracted"] == [dk]
        assert res["placed"] == []
        # 幂等：不再插新行
        assert sum(type(x).__name__ == "Memory" for x in sess.added) == 0

    def test_existing_live_soft_deleted(self):
        dk = "aaaaaaaaaaaaaaaa"
        body = RetractTombstone(namespace=NS, source_file="bot-coder-x.md", known_digests=[dk])
        row = _existing_row(dk, "bot-coder-x.md", deleted=False)
        sess = FakeSession(existing=[row])
        res = run(retract_tombstone_impl(body, sess, "admin"))
        assert res["soft_deleted"] == [dk]
        assert res["placed"] == []
        # canonical 匹配的 live 行 → 本事务内软删、写 audit；不新建 Memory 行
        assert row.deleted_at is not None
        assert sum(type(x).__name__ == "Memory" for x in sess.added) == 0
        assert sum(type(x).__name__ == "MemoryDeleteAudit" for x in sess.added) == 1

    def test_source_file_mismatch_conflict(self):
        dk = "bbbbbbbbbbbbbbbb"
        body = RetractTombstone(namespace=NS, source_file="bot-coder-wanted.md", known_digests=[dk])
        sess = FakeSession(existing=[_existing_row(dk, "bot-coder-other.md", deleted=True)])
        res = run(retract_tombstone_impl(body, sess, "admin"))
        assert res["conflicts"] == [{"dedupe_key": dk, "existing_source_file": "bot-coder-other.md"}]
        assert res["ok"] is False
        # 不波及：既不删也不新占
        assert res["placed"] == []
        assert sum(type(x).__name__ == "Memory" for x in sess.added) == 0

    def test_unknown_hash_not_falsely_claimed(self):
        """只占请求里给的 knownDigest，绝不塞入“算出来的”未知 hash。"""
        wanted = ["cccccccccccccccc", "dddddddddddddddd"]
        body = RetractTombstone(namespace=NS, source_file="f.md", known_digests=wanted)
        sess = FakeSession(existing=[None, None])
        res = run(retract_tombstone_impl(body, sess, "admin"))
        assert set(res["placed"]) == set(wanted)
        assert len(res["placed"]) == 2


class TestHealthPayload:
    """health_payload 必须如实暴露 memory_retract 注册状态（与 memory_compat 同口径），
    避免「探测绿但功能未注册」的整根误报。"""

    def test_health_reports_both_compat_and_retract(self):
        import hub_service.main as m

        payload = m.health_payload()
        assert payload["status"] == "ok"
        # 两个兼容面字段都在，且值为 registered/unavailable:.../unknown 之一
        assert "memory_compat" in payload
        assert "memory_retract" in payload
        for key in ("memory_compat", "memory_retract"):
            assert payload[key] == "registered" or payload[key].startswith("unavailable:") or payload[key] == "unknown"

    def test_explicit_override_used_verbatim(self):
        import hub_service.main as m

        payload = m.health_payload(memory_compat="unavailable:ImportError", memory_retract="unavailable:RuntimeError")
        assert payload["memory_compat"] == "unavailable:ImportError"
        assert payload["memory_retract"] == "unavailable:RuntimeError"
        # 通用 status 仍 ok（兼容面挂掉 ≠ hub 挂掉）
        assert payload["status"] == "ok"
