#!/usr/bin/env python3
"""dsh-bot-crew#24 契约测试：`/v1/memory/{search,consolidate}` 兼容面。

覆盖（全部无网、无 DB）：

1. **形状**：`entry_from_memory()` 的产出必须能被宿主机
   `backend/src/memory/hub-client.ts` 的 `memoryEntriesOf()` 接受
   （name/body 非空、type 四值内、importance 数字、created/updated 秒），
   且 `name` 带 `bot-<bot_id>-` 前缀——否则宿主机 `planWrite()` 直接抛。
2. **真实存储契约**：生产库里 Bot 记忆在**单一命名空间** `dsh-memory/bot`，
   `bot_id` 只在文件名 `bot-<bot_id>-<slug>.md` 与内容标头里。
   测试用 2026-11-14 实测的真实行形状（`origin=native`、
   `metadata.source_file=bot-coder-use-pnpm-test.md`）验证能正确拆出 bot。
3. **隔离**：同一命名空间里非 `bot-*` 的 dsh 记忆（`--Users-cpuser--/…`）
   与其它个人命名空间（`dsh/ktool`、`qoder/code`）一律不出现在结果里。
4. **不造成功空响应**：真没有 crew 命名空间时带 `reason=no-crew-namespace`；
   巩固默认 dry-run（`dryRun=true`、`merged=0`），`apply=true` 才真调 soft_delete。

跑法：`python3.12 -m pytest tests/test_memory_compat_routes.py -q`
"""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Annotated

import pytest

HOME_HUB = Path("/Users/cpuser/Code/home-hub/hub")
if str(HOME_HUB) not in sys.path:
    sys.path.insert(0, str(HOME_HUB))

# `hub_service.main` 在**模块级**构造 `SigningKey(settings.signing_key_path)`，
# 而 Settings 默认是相对路径 `./data/keys/hub-ed25519.pem` —— 任何 import main
# 的测试都会在当前目录生成一把真密钥。那既污染仓库（`data/` 未被 gitignore），
# 又让测试结果依赖运行目录。这里在 import 之前把两个存储根钉到临时目录，
# 保证测试零副作用（2026-11-14 实测踩到）。
_TEST_STORAGE = Path(tempfile.mkdtemp(prefix="hub-compat-test-"))
os.environ.setdefault("HUB_CAS_ROOT", str(_TEST_STORAGE / "cas"))
os.environ.setdefault("HUB_SIGNING_KEY_PATH", str(_TEST_STORAGE / "keys" / "hub-ed25519.pem"))

from hub_service.memory_compat_routes import (  # noqa: E402
    CREW_NAMESPACE,
    CompatConsolidate,
    CompatSearch,
    _window,
    bot_id_of,
    bot_id_of_row,
    compat_consolidate_impl,
    compat_search_impl,
    crew_namespaces_for,
    entry_from_memory,
    register_memory_compat_routes,
)

NOW = datetime(2026, 11, 14, 9, 0, 0, tzinfo=timezone.utc)


def run(coro):
    """同步跑协程：本仓没有 pytest-asyncio，用 asyncio.run 保持零额外依赖。"""
    return asyncio.run(coro)


def _row(**kw):
    """一条 Bot 记忆的默认形状 = 生产库实测行（dsh-memory/bot + native 直通）。"""
    base = {
        "id": uuid.uuid4(),
        "namespace": CREW_NAMESPACE,
        "content": (
            "# [dsh-auto-memory:feedback] bot-coder-use-pnpm-test — 跑测试用 pnpm test\n"
            "\n"
            "跑测试一律 `pnpm test`，不用 `npm test`。"
        ),
        "layer": "Context",
        "memory_metadata": {
            "origin": "native",
            "source": "native-memory",
            "dedupe_key": "e212a1239867a34bd47e3082eec9b4df",
            "source_file": "bot-coder-use-pnpm-test.md",
            "origin_ref": "bot-coder-use-pnpm-test.md",
        },
        "created_at": NOW,
        "origin": "native",
        "embedding": [1.0, 0.0],
        "embedding_kind": "tei",
    }
    base.update(kw)
    return SimpleNamespace(**base)


# ---------------------------------------------------------------------------
# 1. 形状：宿主机 HubHttp.memoryEntriesOf + planWrite 都能接受
# ---------------------------------------------------------------------------


class TestEntryShape:
    def test_production_shaped_row_maps_to_crew_entry(self):
        entry = entry_from_memory(_row())
        assert entry is not None
        # bot_id 来自文件名，不是命名空间（单命名空间模型）
        assert entry["bot_id"] == "coder"
        # name 必须带 bot-<bot_id>- 前缀，否则宿主机 planWrite() 抛
        assert entry["name"] == "bot-coder-use-pnpm-test"
        assert entry["name"].startswith("bot-coder-")
        # 正文去掉标头行，只留「这条记忆说了什么」
        assert "pnpm test" in entry["body"]
        assert not entry["body"].startswith("# [dsh-auto-memory")
        assert entry["type"] == "feedback"
        assert entry["description"] == "跑测试用 pnpm test"
        assert entry["status"] == "candidate"
        assert entry["importance"] == 3
        assert entry["state"] == "active"
        assert entry["toHub"] is True
        assert entry["created"] == int(NOW.timestamp())
        assert entry["updated"] == entry["created"]

    def test_metadata_overrides_are_honoured(self):
        entry = entry_from_memory(
            _row(memory_metadata={
                "source_file": "bot-lead-prefer-conclusion.md",
                "description": "先说结论",
                "type": "user",
                "importance": 8,
                "status": "verified",
                "dedupe_key": "prefer-conclusion-first",
            })
        )
        assert entry is not None
        assert entry["bot_id"] == "lead"
        assert entry["name"] == "bot-lead-prefer-conclusion"
        assert entry["dedupe_key"] == "prefer-conclusion-first"
        assert entry["description"] == "先说结论"
        assert entry["type"] == "user"
        assert entry["importance"] == 8
        assert entry["status"] == "verified"

    def test_legacy_bot_namespace_prefix_also_supported(self):
        """将来 local_dream 若改成按 bot 分命名空间，`bot/<id>` 也认。"""
        row = _row(namespace="bot/writer", memory_metadata={}, content="写手：克制，不堆词。")
        entry = entry_from_memory(row)
        assert entry is not None
        assert entry["bot_id"] == "writer"
        assert entry["name"] == "bot-writer-hub-" + entry["hub_id"][:8]

    def test_description_falls_back_to_header_then_body(self):
        row = _row(content="# [dsh-auto-memory:project] bot-lead-some-key\n\n正文首行说明")
        entry = entry_from_memory(row)
        assert entry is not None
        assert entry["description"] == "正文首行说明"

    def test_unknown_metadata_type_falls_back_to_content_header(self):
        """metadata.type 非法时，用内容标头里的 `[dsh-auto-memory:<type>]`（真实来源）。"""
        entry = entry_from_memory(
            _row(memory_metadata={"source_file": "bot-coder-x.md", "type": "乱七八糟", "importance": "很高"})
        )
        assert entry is not None
        assert entry["type"] == "feedback"  # 标头写的是 feedback
        assert entry["importance"] == 3

    def test_no_type_anywhere_defaults_to_project(self):
        entry = entry_from_memory(
            _row(memory_metadata={"source_file": "bot-coder-x.md"}, content="没有标头的正文，够长就行")
        )
        assert entry is not None
        assert entry["type"] == "project"

    def test_empty_content_is_dropped(self):
        assert entry_from_memory(_row(content="   \n  ")) is None

    def test_non_crew_namespace_is_dropped(self):
        for namespace in ("dsh/ktool", "qoder/code", "claude/home", "dsh-memory/home", ""):
            assert entry_from_memory(_row(namespace=namespace)) is None, namespace

    def test_non_bot_row_in_crew_namespace_is_dropped(self):
        """同一命名空间里还有 `--Users-cpuser--/xxx.md` 这类非 Bot 记忆，不得混进来。"""
        row = _row(
            memory_metadata={"source_file": "verify-by-actually-inspecting-outputs.md",
                             "origin_ref": "--Users-cpuser-Code-kTool--/verify-by-actually-inspecting-outputs.md"},
            content="# 验收要真看产物\n\n不要只看日志。",
        )
        assert entry_from_memory(row) is None

    def test_naive_datetime_treated_as_utc(self):
        naive = datetime(2026, 11, 14, 9, 0, 0)
        entry = entry_from_memory(_row(created_at=naive))
        assert entry is not None
        assert entry["created"] == int(naive.replace(tzinfo=timezone.utc).timestamp())

    def test_bot_id_of_row_prefers_source_file(self):
        assert bot_id_of_row(_row()) == "coder"
        assert bot_id_of_row(_row(memory_metadata={"source_file": "bot-scribbler-tone.md"})) == "scribbler"
        assert bot_id_of_row(_row(memory_metadata={}, content="没有标头也没有文件名")) == ""

    def test_bot_id_with_underscore(self):
        assert bot_id_of_row(_row(memory_metadata={"source_file": "bot-my_bot-slug.md"})) == "my_bot"

    def test_dashed_bot_id_disambiguated_by_known_bots(self):
        """bot_id 自带短横线时只有宿主机的 bot 名录能消歧（Hub 读不到设置）。"""
        row = _row(memory_metadata={"source_file": "bot-my-bot-2-slug.md"})
        # 没有名录：惰性取最短前缀（已知歧义，响应回 bots 让调用方核对）
        assert bot_id_of_row(row) == "my"
        # 给了名录：最长匹配优先
        assert bot_id_of_row(row, known_bots=["my", "my-bot-2"]) == "my-bot-2"


# ---------------------------------------------------------------------------
# 2. 命名空间 / bot_id 校验
# ---------------------------------------------------------------------------


class TestNamespaceGuard:
    def test_crew_namespace_is_the_dsh_passthrough_one(self):
        assert CREW_NAMESPACE == "dsh-memory/bot"
        # 单命名空间模型：所有 bot 共用同一个命名空间，`bots` 只决定查哪些
        assert set(crew_namespaces_for(["coder"])) == {CREW_NAMESPACE, "bot/coder"}

    @pytest.mark.parametrize("bad", ["", "Bot", "../etc", "a" * 65, "bot lead", "bot/lead", "a.b"])
    def test_invalid_bot_id_rejected(self, bad):
        with pytest.raises(ValueError):
            CompatSearch(bots=[bad])

    def test_bot_id_of_namespace(self):
        assert bot_id_of(CREW_NAMESPACE) == CREW_NAMESPACE
        assert bot_id_of("bot/lead") == "lead"
        assert bot_id_of("dsh/ktool") == ""
        assert bot_id_of("") == ""

    def test_search_model_rejects_injected_bot(self):
        with pytest.raises(ValueError):
            CompatSearch(bots=["bot/lead"])

    def test_search_model_defaults(self):
        body = CompatSearch()
        assert body.limit == 6 and body.bots is None and body.query == ""

    def test_search_model_limit_bounds(self):
        with pytest.raises(ValueError):
            CompatSearch(limit=0)
        with pytest.raises(ValueError):
            CompatSearch(limit=51)


# ---------------------------------------------------------------------------
# 3. search 实现（注入假 session / 假 impl）
# ---------------------------------------------------------------------------


class _FakeScalars:
    def __init__(self, values):
        self._values = values

    def __iter__(self):
        return iter(self._values)


class _FakeResult:
    def __init__(self, values):
        self._values = values

    def scalars(self):
        return _FakeScalars(self._values)


class _FakeSession:
    """只回应「现有哪些 crew 命名空间」这一条查询。"""

    def __init__(self, namespaces):
        self._namespaces = namespaces

    async def execute(self, _query):  # noqa: ANN001
        return _FakeResult(self._namespaces)


def _search_rows():
    """同一命名空间里混装：两位 Bot 的命中 + 一条非 Bot 记忆。"""
    return [
        {"id": str(uuid.uuid4()), "content": "# [dsh-auto-memory:feedback] bot-coder-a — 先说结论\n\n正文A",
         "metadata": {"source_file": "bot-coder-a.md"}, "created_at": NOW, "origin": "native", "score": 0.9},
        {"id": str(uuid.uuid4()), "content": "# [dsh-auto-memory:feedback] bot-writer-b — 别铺垫\n\n正文B",
         "metadata": {"source_file": "bot-writer-b.md"}, "created_at": NOW - timedelta(hours=2),
         "origin": "native", "score": 0.4},
        {"id": str(uuid.uuid4()), "content": "# 非 Bot 记忆\n\n不该出现",
         "metadata": {"source_file": "verify-by-actually-inspecting-outputs.md"},
         "created_at": NOW, "origin": "native", "score": 0.95},
    ]


@pytest.fixture()
def patched_search(monkeypatch):
    """把 search_memories_impl 换成可控假实现，并记录被查过的命名空间。"""
    seen: list[str] = []

    async def fake_impl(body, session, *, actor=None):  # noqa: ANN001, ARG001
        seen.append(body.namespace)
        return _search_rows() if body.namespace == CREW_NAMESPACE else []

    import hub_service.memory_compat_routes as mod

    monkeypatch.setattr(mod, "search_memories_impl", fake_impl)
    return seen


class TestSearchImpl:
    def test_queries_crew_namespace_and_drops_non_bot_rows(self, patched_search):
        session = _FakeSession([CREW_NAMESPACE])
        result = run(compat_search_impl(CompatSearch(query="结论"), session))
        assert patched_search == [CREW_NAMESPACE]
        assert result["namespaces"] == [CREW_NAMESPACE]
        assert [e["bot_id"] for e in result["entries"]] == ["coder", "writer"]
        assert result["degraded"] is False

    def test_entries_sorted_by_score_desc(self, patched_search):
        session = _FakeSession([CREW_NAMESPACE])
        result = run(compat_search_impl(CompatSearch(query="x", limit=6), session))
        assert [e["name"] for e in result["entries"]] == ["bot-coder-a", "bot-writer-b"]

    def test_limit_applied_after_bot_filtering(self, patched_search):
        session = _FakeSession([CREW_NAMESPACE])
        result = run(compat_search_impl(CompatSearch(query="x", limit=1), session))
        assert len(result["entries"]) == 1
        # 最高分那条是非 Bot 记忆，被过滤掉后不该占名额
        assert result["entries"][0]["name"] == "bot-coder-a"

    def test_bots_filter_narrows_to_named_bot(self, patched_search):
        session = _FakeSession([CREW_NAMESPACE])
        result = run(compat_search_impl(CompatSearch(query="x", bots=["writer"]), session))
        assert [e["bot_id"] for e in result["entries"]] == ["writer"]

    def test_unknown_bot_yields_empty_but_namespace_reported(self, patched_search):
        session = _FakeSession([CREW_NAMESPACE])
        result = run(compat_search_impl(CompatSearch(query="x", bots=["ghost"]), session))
        assert result["entries"] == []
        # 带 bots 时两个 crew 命名空间都要查（`bot/<id>` 是前向兼容落法）
        assert set(result["namespaces"]) == {CREW_NAMESPACE, "bot/ghost"}

    def test_no_crew_namespace_is_explicit_not_silent(self, patched_search):
        session = _FakeSession(["dsh/ktool", "dsh-memory/home"])
        result = run(compat_search_impl(CompatSearch(query="x"), session))
        assert result == {"entries": [], "namespaces": [], "bots": [], "degraded": False,
                          "reason": "no-crew-namespace"}
        assert patched_search == []


# ---------------------------------------------------------------------------
# 4. consolidate 实现：默认 dry-run，apply 才写
# ---------------------------------------------------------------------------


class TestWindow:
    def test_default_window_is_24h(self):
        since, until = _window(CompatConsolidate())
        assert int((until - since).total_seconds()) == 24 * 3600

    def test_explicit_window_respected(self):
        since, until = _window(CompatConsolidate(since=1_700_000_000, until=1_700_003_600))
        assert int(since.timestamp()) == 1_700_000_000
        assert int(until.timestamp()) == 1_700_003_600

    def test_inverted_window_rejected(self):
        with pytest.raises(Exception) as caught:
            _window(CompatConsolidate(since=1_700_003_600, until=1_700_000_000))
        assert "since" in str(getattr(caught.value, "detail", caught.value))


class _RowSession:
    """回应 consolidate 的唯一查询（窗口内 bot/* 行）。"""

    def __init__(self, rows):
        self._rows = rows
        self.commits = 0

    async def execute(self, _query):  # noqa: ANN001
        return _FakeResult(self._rows)

    async def commit(self):
        self.commits += 1


def _twin_rows():
    """两条近似重复的 Bot 记忆：同命名空间、同 embedding_kind、余弦 1.0、词面重合高。"""
    common = "记忆 系统 偏好 结论 先说 结论 不要 铺垫"
    older = _row(id=uuid.uuid4(), content=common, created_at=NOW - timedelta(hours=1),
                 memory_metadata={"dedupe_key": "old", "source_file": "bot-coder-old.md"},
                 embedding=[1.0, 0.0])
    newer = _row(id=uuid.uuid4(), content=common, created_at=NOW,
                 memory_metadata={"dedupe_key": "new", "source_file": "bot-coder-new.md"},
                 embedding=[1.0, 0.0])
    return older, newer


class TestConsolidateImpl:
    def test_counts_facts_and_dry_runs_by_default(self):
        older, newer = _twin_rows()
        session = _RowSession([older, newer])
        deleted: list[uuid.UUID] = []

        async def fake_delete(_session, *, memory_id, actor, reason=None):  # noqa: ANN001
            deleted.append(memory_id)

        result = run(compat_consolidate_impl(
            CompatConsolidate(since=int((NOW - timedelta(days=1)).timestamp()),
                              until=int((NOW + timedelta(minutes=1)).timestamp())),
            session,
            soft_delete=fake_delete,
        ))
        # 本层不提炼事实：facts 必须是 0（「这次提炼出几条」），存量统计走 existingFacts
        assert result["facts"] == 0
        assert result["existingFacts"] == 2
        assert result["scanned"] == 2
        assert result["candidateMerges"] == 1
        assert result["merged"] == 0
        assert result["dryRun"] is True
        assert deleted == [], "默认 dry-run 绝不能真删"
        assert session.commits == 0

    def test_apply_true_soft_deletes_older_row(self):
        older, newer = _twin_rows()
        session = _RowSession([older, newer])
        deleted: list[uuid.UUID] = []

        async def fake_delete(_session, *, memory_id, actor, reason=None):  # noqa: ANN001
            deleted.append(memory_id)
            assert "memory-compat merge" in (reason or "")

        result = run(compat_consolidate_impl(
            CompatConsolidate(since=int((NOW - timedelta(days=1)).timestamp()),
                              until=int((NOW + timedelta(minutes=1)).timestamp()),
                              apply=True),
            session,
            soft_delete=fake_delete,
        ))
        assert result["dryRun"] is False
        assert result["merged"] == 1
        assert deleted == [older.id], "较旧一方被软删，较新者保留"
        assert session.commits == 1

    def test_merge_failure_is_isolated(self):
        older, newer = _twin_rows()
        session = _RowSession([older, newer])

        async def boom(*_a, **_kw):
            raise RuntimeError("db down")

        result = run(compat_consolidate_impl(
            CompatConsolidate(since=int((NOW - timedelta(days=1)).timestamp()),
                              until=int((NOW + timedelta(minutes=1)).timestamp()),
                              apply=True),
            session,
            soft_delete=boom,
        ))
        assert result["merged"] == 0
        assert result["candidateMerges"] == 1
        assert session.commits == 0

    def test_superseded_counts_rows_with_supersedes_metadata(self):
        row = _row(memory_metadata={"supersedes": "old-name", "source_file": "bot-coder-x.md"},
                   origin="distill")
        session = _RowSession([row])
        result = run(compat_consolidate_impl(CompatConsolidate(), session, soft_delete=None))
        assert result["superseded"] == 1
        assert result["facts"] == 0
        assert result["existingFacts"] == 1


# ---------------------------------------------------------------------------
# 5. 路由注册：挂上 /memory/*，且不动既有 /memories/*
# ---------------------------------------------------------------------------


def _stub_session_dep():
    async def _dep():
        yield None

    return _dep


class TestRouteRegistration:
    def test_routes_attached_and_existing_untouched(self):
        from fastapi import APIRouter, FastAPI

        app = FastAPI()
        router = APIRouter(prefix="/v1")

        @router.post("/memories/search")
        async def legacy_search() -> list:
            return []

        register_memory_compat_routes(router, session_type=type(None))
        app.include_router(router)

        paths = app.openapi()["paths"]
        assert "post" in paths["/v1/memory/search"]
        assert "post" in paths["/v1/memory/consolidate"]
        # 既有 API 原样保留（不因兼容面被改路径或方法）
        assert "post" in paths["/v1/memories/search"]

    def test_openapi_generation_succeeds(self):
        """Session 播种缺失时 FastAPI 会在 openapi() 阶段抛 PydanticUserError/422。"""
        from fastapi import APIRouter, FastAPI

        app = FastAPI()
        router = APIRouter(prefix="/v1")
        register_memory_compat_routes(router, session_type=type(None))
        app.include_router(router)
        schema = app.openapi()
        assert "/v1/memory/search" in schema["paths"]
        assert "/v1/memory/consolidate" in schema["paths"]

    def test_live_route_returns_entries_object(self, monkeypatch):
        """真打一次路由：响应必须是 {entries:[...]}，不是裸数组（宿主机读 body.entries）。"""
        from fastapi import APIRouter, Depends, FastAPI
        from fastapi.testclient import TestClient
        from sqlalchemy.ext.asyncio import AsyncSession

        import hub_service.memory_compat_routes as mod

        async def fake_impl(body, session, *, actor=None):  # noqa: ANN001, ARG001
            if body.namespace != CREW_NAMESPACE:
                return []
            return [{
                "id": "11111111-1111-1111-1111-111111111111",
                "content": "# [dsh-auto-memory:user] bot-lead-prefer-conclusion — 先说结论\n\n先说结论，别铺垫。",
                "metadata": {"source_file": "bot-lead-prefer-conclusion.md",
                             "dedupe_key": "prefer-conclusion"},
                "created_at": NOW, "origin": "native", "score": 0.87,
            }]

        monkeypatch.setattr(mod, "search_memories_impl", fake_impl)

        async def _fake_session():
            yield _FakeSession([CREW_NAMESPACE, "dsh/ktool"])

        SessionDep = Annotated[AsyncSession, Depends(_fake_session)]
        app = FastAPI()
        router = APIRouter(prefix="/v1")
        mod.register_memory_compat_routes(router, session_type=SessionDep)
        app.include_router(router)

        with TestClient(app) as client:
            response = client.post("/v1/memory/search", json={"query": "结论", "limit": 6})
        assert response.status_code == 200
        payload = response.json()
        assert isinstance(payload, dict), "裸数组会让客户端永远空召回"
        assert payload["entries"][0]["name"] == "bot-lead-prefer-conclusion"
        assert payload["entries"][0]["bot_id"] == "lead"
        assert payload["entries"][0]["type"] == "user"
        # dsh/ktool 被租户隔离挡掉，只报真正被查的 crew 命名空间
        assert payload["namespaces"] == [CREW_NAMESPACE]
        assert payload["bots"] == ["lead"]

    def test_live_route_rejects_injected_bot_id(self):
        from fastapi import APIRouter, FastAPI
        from fastapi.testclient import TestClient

        app = FastAPI()
        router = APIRouter(prefix="/v1")
        register_memory_compat_routes(router, session_type=type(None))
        app.include_router(router)
        with TestClient(app) as client:
            response = client.post("/v1/memory/search", json={"query": "x", "bots": ["Bot/Lead"]})
        assert response.status_code == 422


# ---------------------------------------------------------------------------
# 6. 探测端点：客户端 `GET <hub>/health` 必须免鉴权 2xx
# ---------------------------------------------------------------------------


class TestProbeEndpoint:
    """宿主机 `HubProbe.refresh()` 打 `base + '/health'`，不带任何 header。

    base 指到 `/v1` 时探测就是 `/v1/health`；这条路由必须是 app 级（不经
    `/v1` router 的 require_token 依赖），否则探测恒 401 → 记忆永远退回本机版。
    """

    def test_v1_health_route_is_app_level(self):
        import hub_service.main as main_mod

        app_level = {
            route.path
            for route in main_mod.app.routes
            if getattr(route, "path", None) in {"/v1/health", "/healthz"}
        }
        assert "/v1/health" in app_level
        assert "/healthz" in app_level

    def test_v1_health_is_not_under_token_router(self):
        """`/v1/health` 不在带 require_token 的 router 上——否则探测必 401。"""
        import hub_service.main as main_mod

        token_paths = {
            getattr(route, "path", "")
            for route in main_mod.router.routes
        }
        assert "/v1/health" not in token_paths
        assert "/v1/memory/search" in token_paths, "兼容面必须走带鉴权的 router"
        assert "/v1/memory/consolidate" in token_paths


# ---------------------------------------------------------------------------
# 7. 时间解析：`search_memories_impl` 回的是 ISO 字符串，不是 datetime
# ---------------------------------------------------------------------------


class TestSecondsParsing:
    """真实 bug 回归：只认 datetime 会让 created/updated 全变 0。

    `_memory_json()` 把 created_at 序列化成 `2026-11-08T16:49:04.934689Z`。
    宿主机 `freshness()` 对 0 会算出「1970 年」，于是所有记忆同样陈旧、
    新记忆永远排不到前面。这条用生产库实测的字符串形态锁住。
    """

    def test_iso_z_string_is_parsed(self):
        entry = entry_from_memory(_row(created_at="2026-11-08T16:49:04.934689Z"))
        assert entry is not None
        assert entry["created"] == 1794156544
        assert entry["updated"] == 1794156544

    def test_iso_offset_string_is_parsed(self):
        entry = entry_from_memory(_row(created_at="2026-11-08T16:49:04+00:00"))
        assert entry is not None
        assert entry["created"] == 1794156544

    def test_naive_iso_string_treated_as_utc(self):
        entry = entry_from_memory(_row(created_at="2026-11-08T16:49:04"))
        assert entry is not None
        assert entry["created"] == 1794156544

    def test_garbage_string_is_zero_not_crash(self):
        entry = entry_from_memory(_row(created_at="not-a-date"))
        assert entry is not None
        assert entry["created"] == 0

    def test_bool_is_not_a_timestamp(self):
        entry = entry_from_memory(_row(created_at=True))
        assert entry is not None
        assert entry["created"] == 0


# ---------------------------------------------------------------------------
# 8. 测试卫生：import main 不得在仓库里落 data/
# ---------------------------------------------------------------------------


class TestNoRepoPollution:
    """`import hub_service.main` 会构造 SigningKey；本文件已在 import 前把存储根
    钉到临时目录，所以仓库里不该出现 `data/`。这条守住那个约定，防止有人删掉
    上面的 env 固定后悄悄复现（2026-11-14 实际踩到过）。"""

    def test_storage_env_pinned_to_temp(self):
        assert str(_TEST_STORAGE) in os.environ["HUB_SIGNING_KEY_PATH"]
        assert str(_TEST_STORAGE) in os.environ["HUB_CAS_ROOT"]

    def test_importing_main_creates_no_repo_data_dir(self):
        import hub_service.main  # noqa: F401  — 触发模块级 SigningKey 构造

        repo_data = Path(__file__).resolve().parents[1] / "data"
        assert not repo_data.exists(), f"import main 在仓库里生成了 {repo_data}；检查存储根 env 固定"


# ---------------------------------------------------------------------------
# 9. 审计项回归：本层只做兼容映射，不做鉴权隔离，也不虚构时间
# ---------------------------------------------------------------------------


class TestBotsFilterCoversBothNamespaces:
    """带 `bots` 时只查 `dsh-memory/bot` 会漏掉将来按 bot 分的 `bot/<id>`。

    `crew_namespace()` 对任何 bot 都返回同一个命名空间，所以旧实现里
    `bots=["writer"]` 只会查 `dsh-memory/bot`，`bot/writer` 里的行一条都读不到
    —— 过滤条件看着生效，实际是「另一个命名空间被整体跳过」。
    """

    def test_bots_query_includes_both_crew_namespaces(self, patched_search):
        session = _FakeSession([CREW_NAMESPACE])
        run(compat_search_impl(CompatSearch(query="x", bots=["writer"]), session))
        assert set(patched_search) == {CREW_NAMESPACE, "bot/writer"}

    def test_legacy_bot_namespace_rows_are_reachable(self, monkeypatch):
        async def fake_impl(body, session, *, actor=None):  # noqa: ANN001, ARG001
            if body.namespace != "bot/writer":
                return []
            return [{
                "id": str(uuid.uuid4()),
                "content": "写手：克制，不堆词。",
                "metadata": {},
                "created_at": NOW,
                "origin": "native",
                "score": 0.8,
            }]

        import hub_service.memory_compat_routes as mod

        monkeypatch.setattr(mod, "search_memories_impl", fake_impl)
        result = run(compat_search_impl(
            CompatSearch(query="x", bots=["writer"]), _FakeSession([CREW_NAMESPACE])
        ))
        assert [e["bot_id"] for e in result["entries"]] == ["writer"]


class TestBotIdMatchesClient:
    """服务端 bot_id 形状必须与宿主机 `BOT_ID = /^[a-z0-9_-]+$/` 同口径。

    旧实现用 `^[a-z0-9][a-z0-9_-]{0,63}$`，比客户端多两条约束：不许以 `-`
    开头、最长 64。客户端 `validateDirectory()` 认的 id 服务端回 422，
    契约就分叉了；真正的长度上限由宿主机写入侧（`mobile-http.ts` 的 64）管。
    """

    @pytest.mark.parametrize("good", ["coder", "-lead", "my_bot", "a-b_c", "x" * 64])
    def test_client_accepted_ids_pass(self, good):
        assert CompatSearch(bots=[good]).bots == [good]
        assert CREW_NAMESPACE in crew_namespaces_for([good])

    @pytest.mark.parametrize("bad", ["", "Bot", "bot/lead", "../etc", "a.b", "a b", "x" * 65])
    def test_rejects_only_what_client_rejects(self, bad):
        with pytest.raises(ValueError):
            CompatSearch(bots=[bad])


class TestWindowZeroIsAValue:
    """`since=0` 是 Unix 纪元，不是「没给」。

    旧实现用 `body.since if body.since else …`，`0` 落进假值分支被换成
    「24 小时前」—— 调用方明确要「从最早开始」却得到一个窄窗口，
    巩固统计静默少算。
    """

    def test_since_zero_means_epoch_not_default(self):
        since, until = _window(CompatConsolidate(since=0, until=1_700_003_600))
        assert int(since.timestamp()) == 0
        assert int(until.timestamp()) == 1_700_003_600

    def test_until_zero_is_epoch_not_now(self):
        since, until = _window(CompatConsolidate(since=0, until=0))
        assert int(until.timestamp()) == 0
        assert int(since.timestamp()) == 0

    def test_missing_bounds_still_default_to_last_24h(self):
        since, until = _window(CompatConsolidate())
        assert int((until - since).total_seconds()) == 24 * 3600


class TestConsolidateCountsAreFactsAboutThisCall:
    """`facts` 是「这次提炼出几条」，本层不提炼 → 恒 0。

    旧实现把窗口内存量 `origin in {distill,flush,native}` 的行数当 `facts`
    返回，客户端日志会写「本次巩固提炼了 3 条事实」，而它一条都没提炼。
    存量统计改名 `existingFacts`，并补 `scanned` 让调用方知道看了多少行。
    """

    def test_facts_is_zero_and_existing_facts_is_separate(self):
        row = _row(origin="distill", memory_metadata={"source_file": "bot-coder-a.md"})
        result = run(compat_consolidate_impl(
            CompatConsolidate(), _RowSession([row]), soft_delete=None
        ))
        assert result["facts"] == 0
        assert result["existingFacts"] == 1
        assert result["scanned"] == 1

    def test_non_crew_rows_are_not_scanned(self):
        crew = _row(memory_metadata={"source_file": "bot-coder-a.md"})
        stranger = _row(namespace="dsh/ktool", memory_metadata={"source_file": "note.md"})
        result = run(compat_consolidate_impl(
            CompatConsolidate(), _RowSession([crew, stranger]), soft_delete=None
        ))
        assert result["scanned"] == 1

    def test_updated_mirrors_created_and_is_not_invented(self):
        """Hub 没有独立的行更新时间，`updated` 只能等于 `created`。

        报告与注释必须说清这一点；测试锁住「不去编一个 now()」。
        """
        entry = entry_from_memory(_row(created_at="2026-11-08T16:49:04Z"))
        assert entry is not None
        assert entry["updated"] == entry["created"] == 1794156544


class TestKnownBotsDisambiguationIsWired:
    """`known_bots` 必须从请求接进行级解析，否则带短横线的 bot 永远查不到。

    `bot-my-bot-2-slug.md` 在没有名录时被惰性切成 `my`；调用方
    `bots=["my-bot-2"]` 于是过滤掉自己刚写的那条 —— 空召回，且没有任何报错。
    """

    def test_dashed_bot_id_resolved_via_requested_bots(self, monkeypatch):
        async def fake_impl(body, session, *, actor=None):  # noqa: ANN001, ARG001
            if body.namespace != CREW_NAMESPACE:
                return []
            return [{
                "id": str(uuid.uuid4()),
                "content": "# [dsh-auto-memory:feedback] bot-my-bot-2-slug — 短\n\n正文",
                "metadata": {"source_file": "bot-my-bot-2-slug.md"},
                "created_at": NOW,
                "origin": "native",
                "score": 0.5,
            }]

        import hub_service.memory_compat_routes as mod

        monkeypatch.setattr(mod, "search_memories_impl", fake_impl)
        result = run(compat_search_impl(
            CompatSearch(query="x", bots=["my-bot-2"]), _FakeSession([CREW_NAMESPACE])
        ))
        assert [e["bot_id"] for e in result["entries"]] == ["my-bot-2"]
        assert result["bots"] == ["my-bot-2"]

    def test_explicit_known_bots_are_accepted(self):
        assert CompatSearch(known_bots=["my-bot-2"]).known_bots == ["my-bot-2"]


class TestHeaderParsedOnce:
    """内容标头只解析一次，且 type/stem/description 三者同源。

    旧实现先 `bot_id_of_row()` 解析标头拿 stem，再 `_parse_header()` 解析一遍
    拿 type/description；两处各有一份「前 3 行 + 正则」的口径，任一处改动
    都会让 bot_id 与 name 来自不同的行。
    """

    def test_header_only_row_keeps_type_stem_description_consistent(self):
        row = _row(
            memory_metadata={},
            content="# [dsh-auto-memory:user] bot-writer-keep-it-terse — 少铺垫\n\n正文在这里，够长。",
        )
        entry = entry_from_memory(row)
        assert entry is not None
        assert entry["bot_id"] == "writer"
        assert entry["name"] == "bot-writer-keep-it-terse"
        assert entry["type"] == "user"
        assert entry["description"] == "少铺垫"


class TestSelfDeclaredMetadataIsNotAuthority:
    """`metadata.bot_id` 由写入方自填，不能当身份；冲突时拒绝而不是猜。

    这一层是**数据归类**：`bot` 只决定「这条记忆归谁看」，不决定「谁有权看」。
    权限边界仍是 `/v1` 的 `require_token`（单一 node/admin 凭据）+
    crew 命名空间硬过滤。所以这里只做两件可验证的事：
    冲突的自述与 canonical 文件名不一致时丢掉该行，别把两种说法混起来用。
    """

    def test_conflicting_declared_and_canonical_bot_is_rejected(self):
        row = _row(memory_metadata={
            "bot_id": "lead",
            "source_file": "bot-coder-use-pnpm-test.md",
        })
        assert bot_id_of_row(row) == ""
        assert entry_from_memory(row) is None

    def test_matching_declared_and_canonical_is_fine(self):
        row = _row(memory_metadata={
            "bot_id": "coder",
            "source_file": "bot-coder-use-pnpm-test.md",
        })
        assert bot_id_of_row(row) == "coder"

    def test_namespace_bot_namespace_wins_over_declared(self):
        """`bot/<id>` 是硬边界：命名空间说归谁就归谁，自述不覆盖它。"""
        row = _row(namespace="bot/writer", memory_metadata={"bot_id": "lead"}, content="正文")
        assert bot_id_of_row(row) == "writer"

    def test_declared_only_still_classifies(self):
        row = _row(memory_metadata={"bot_id": "lead"})
        assert bot_id_of_row(row) == "lead"


class TestHealthReportsCompatRegistration:
    """`/v1/health` 必须如实报兼容面注册状态。

    旧实现无论兼容面注册成功与否都回同一份 `{"status": "ok"}`：模块导入失败时
    探针照样 200，客户端以为中枢可用，每次召回都 404 → 全部静默降级本机。
    """

    def test_main_records_registered_status(self):
        import hub_service.main as main_mod

        assert main_mod.MEMORY_COMPAT_STATUS == "registered"
        assert "/v1/memory/search" in {r.path for r in main_mod.router.routes}

    def test_health_payload_carries_registration_state(self):
        import hub_service.main as main_mod

        ok = main_mod.health_payload("registered")
        assert ok["status"] == "ok"
        assert ok["memory_compat"] == "registered"
        # 既有字段一个不少（外部探针按 service/version 断言）
        assert ok["service"] == "home-agent-hub" and ok["version"]

    def test_health_payload_reports_failure_without_faking_ok_status(self):
        import hub_service.main as main_mod

        broken = main_mod.health_payload("unavailable:ImportError")
        assert broken["memory_compat"].startswith("unavailable")
        # 兼容面挂了不等于整个 hub 挂了：通用 status 仍 ok，但字段如实否定
        assert broken["status"] == "ok"

    def test_healthz_stays_untouched(self):
        import hub_service.main as main_mod

        assert main_mod.app.url_path_for("healthz") == "/healthz"
