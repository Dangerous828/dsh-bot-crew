"""dsh-bot-crew#24 兼容面 · 原子撤回/tombstone（issue24 retract，最小增量）。

背景与边界
----------
既有 `POST /v1/memories` **做不到**「原子创建一条已删除占位」：
`create_memory_impl` 把 `deleted_at=None, deleted_by=None` 写死（main_memory_routes.py:600），
`MemoryCreate` 无 `deleted_at` 字段。当前唯一「占位」办法是「先 POST 成短暂 live 再 DELETE」——
这会在事务间留下一小段 **live 窗口**，且需要正文、正文不可读时还算不出 dedupe_key。
lead 要求：**撤回答不得为占位把已撤销/从未上传的正文重新 POST 成短暂 live 再 DELETE**。

本模块新增一个**最小、受 admin 认证、crew 命名空间限定**的原子 tombstone 接口：
单事务 INSERT 一条 `deleted_at` 已置、`embedding=NULL`、**不传正文**的行，
只用 canonical `source_file` + `knownDigest`（16 hex 集合）占住 dedupe 槽位。
随后 pending/重扫按 content 复算同一 dedupe_key 时被 `ON CONFLICT DO NOTHING` 吸收 → 不复活。

不做的事（防止过度设计）
------------------------
- 不建新表、不建「版本系统」；只往既有 `memories` 插一条 deleted 行 + 复用 `MemoryDeleteAudit`。
- 不动 `/v1/memory/{search,consolidate}` 既有语义；`apply` 默认仍 false。
- 不放开 node 白名单：路由挂 `/v1` router 的 `require_token`，并**显式要求 admin actor**。
- 不波及其它来源：namespace 必须是 crew 命名空间；content 用中性 tombstone 标记（不含用户正文）；
  `metadata.source_file` 为规范名。已存在同 (namespace, dedupe_key) 行时校验 canonical 匹配，否则 409。

「已知 hash 才挡得住」
--------------------
tombstone 只能占住**调用方给的 knownDigest** 槽位。未知 hash（算不出的旧版本）本接口**不会**
假称挡住——它在响应里 `unoccupied`/`placed` 如实区分；调用方必须自己持久记录 render digest 历史。
"""
from __future__ import annotations

import logging
import uuid
from typing import Any

from fastapi import Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .db_models import Memory, MemoryDeleteAudit, utcnow

logger = logging.getLogger(__name__)

#: crew 命名空间白名单（与 memory_compat_routes 同口径：主 `dsh-memory/bot` + 未来 `bot/<id>`）。
_CREW_NS_EXACT = "dsh-memory/bot"
_CREW_NS_PREFIX = "bot/"
#: knownDigest 口径：16 hex（= local_dream `sha256(content)[:16]`）。
_DIGEST_RE = None  # 延迟编译，避免 import 期多余依赖
_TombstoneMarker = "# [retracted] 该来源的记忆已被撤回（tombstone；无正文）"


class RetractTombstone(BaseModel):
    """原子占位请求：不传正文，只传 canonical 标识 + 已知 16hex digest 集合。"""

    namespace: str = Field(min_length=1, max_length=128)
    source_file: str = Field(min_length=1, max_length=255)
    #: 已知远端 digest（local_dream `sha256(content)[:16]`）。空集合 = 只做既有行校验，不新占槽。
    known_digests: list[str] = Field(default_factory=list, max_length=64)
    #: 审计原因（短）。
    reason: str | None = Field(default=None, max_length=500)

    @field_validator("known_digests")
    @classmethod
    def digests_valid(cls, value: list[str]) -> list[str]:
        import re

        pat = re.compile(r"^[0-9a-f]{16}$")
        out: list[str] = []
        seen: set[str] = set()
        for d in value:
            text = str(d or "").strip().lower()
            if not pat.fullmatch(text):
                raise ValueError(f"known_digest must be 16 lowercase hex: {d!r}")
            if text not in seen:
                seen.add(text)
                out.append(text)
        return out


def _is_crew_namespace(namespace: str) -> bool:
    return namespace == _CREW_NS_EXACT or namespace.startswith(_CREW_NS_PREFIX)


def _require_admin(actor: str) -> str:
    from .main_memory_routes import api_error

    if actor != "admin":
        raise api_error(403, "admin token required for retract tombstone")
    return actor


async def retract_tombstone_impl(
    body: RetractTombstone,
    session: AsyncSession,
    actor: str,
) -> dict[str, Any]:
    """原子占位实现。返回精确的 placed/occupied/conflict 分类，绝不假称挡住未知 hash。"""
    from .main_memory_routes import api_error

    _require_admin(actor)
    if not _is_crew_namespace(body.namespace):
        raise api_error(422, f"namespace not in crew scope: {body.namespace!r}")

    now = utcnow()
    placed: list[str] = []       # 无行 → 新占槽
    already: list[str] = []      # 已存在且已删除（幂等命中）
    soft_deleted: list[str] = []  # 已存在且 live → 本事务内软删（保证最终 deleted）
    conflicts: list[dict[str, str]] = []

    for dk in body.known_digests:
        existing = (
            await session.execute(
                select(Memory).where(
                    Memory.namespace == body.namespace,
                    Memory.memory_metadata["dedupe_key"].astext == dk,
                )
            )
        ).scalar_one_or_none()

        if existing is not None:
            # canonical 校验：既有行的 source_file 必须与请求一致，否则不波及其它来源。
            ex_sf = str((existing.memory_metadata or {}).get("source_file") or "")
            if ex_sf and ex_sf != body.source_file:
                conflicts.append({"dedupe_key": dk, "existing_source_file": ex_sf})
                continue
            if existing.deleted_at is not None:
                already.append(dk)  # 幂等：已占位
                continue
            # live 行：canonical 已匹配 → 本事务内软删，保证最终 deleted（不擅删别的来源）。
            existing.deleted_at = now
            existing.deleted_by = actor
            session.add(
                MemoryDeleteAudit(
                    id=uuid.uuid4(),
                    memory_id=existing.id,
                    namespace=body.namespace,
                    dedupe_key=dk,
                    mode="soft",
                    actor=actor,
                    content_snapshot=None,
                    audit_metadata={"source_file": body.source_file, "reason": body.reason}
                    if body.reason
                    else {"source_file": body.source_file, "via": "retract-tombstone"},
                )
            )
            soft_deleted.append(dk)
            continue

        # 不存在 → 单事务插入一条已删除、无正文、无 embedding 的占位。
        row = Memory(
            id=uuid.uuid4(),
            namespace=body.namespace,
            content=_TombstoneMarker,
            layer="Context",
            embedding=None,
            memory_metadata={
                "source_file": body.source_file,
                "dedupe_key": dk,
                "origin": "retract-tombstone",
                "imported_from": "issue24-retract",
                "tombstone": True,
            },
            origin="retract-tombstone",
            origin_ref=body.source_file,
            embedding_kind="tei",
            deleted_at=now,
            deleted_by=actor,
        )
        session.add(row)
        session.add(
            MemoryDeleteAudit(
                id=uuid.uuid4(),
                memory_id=row.id,
                namespace=body.namespace,
                dedupe_key=dk,
                mode="tombstone",
                actor=actor,
                content_snapshot=None,
                audit_metadata={"source_file": body.source_file, "reason": body.reason} if body.reason
                else {"source_file": body.source_file},
            )
        )
        placed.append(dk)

    await session.commit()
    logger.info(
        "retract-tombstone ns=%s sf=%s placed=%d already=%d soft_deleted=%d conflict=%d actor=%s",
        body.namespace, body.source_file, len(placed), len(already),
        len(soft_deleted), len(conflicts), actor,
    )
    return {
        "namespace": body.namespace,
        "source_file": body.source_file,
        "placed": placed,            # 本次新占的槽（unknown hash 不会被塞进这里）
        "already_retracted": already,
        "soft_deleted": soft_deleted,     # live 行：本事务内已软删（canonical 匹配，最终 deleted）
        "conflicts": conflicts,           # canonical 不匹配（409 语义）：不波及其它来源
        "ok": not conflicts,
        "mode": "tombstone",
    }


def register_retract_routes(router: Any, *, session_type: Any = None) -> None:
    """挂 `POST /memory/retract-tombstone` 到 `/v1` router（继承 require_token）。"""
    if session_type is None:
        from .database import get_session

        from typing import Annotated
        from fastapi import Depends

        session_type = Annotated[AsyncSession, Depends(get_session)]
    Session = session_type
    globals()["Session"] = Session
    globals()["Request"] = Request

    @router.post("/memory/retract-tombstone")
    async def retract_tombstone(
        body: RetractTombstone, request: Request, session: Session
    ) -> dict[str, Any]:
        from .main_memory_routes import api_error

        actor = str(getattr(request.state, "actor", "unknown") or "unknown")
        result = await retract_tombstone_impl(body, session, actor)
        # canonical 冲突 → 409（既不改既有行、也不新占，调用方须先核对）。
        if result.get("conflicts"):
            raise api_error(409, f"canonical source_file mismatch: {result['conflicts']}")
        return result
