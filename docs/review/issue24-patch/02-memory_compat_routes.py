"""dsh-bot-crew 记忆中枢兼容面（issue dsh-bot-crew#24）。

背景
----
`dsh-bot-crew` 宿主机侧（`backend/src/memory/hub-client.ts`）按自己的契约
（`backend/docs/08-memory-hub.md`）调用**两个根路径**：

    GET  <hub>/health
    POST <hub>/memory/search       {"query": str, "bots"?: [str], "limit"?: int}
    POST <hub>/memory/consolidate  {"since"?: int, "until"?: int}

Hub 现有 API 是 `/v1/memories/search`（`{namespace, query, limit, ...}` →
`[MemoryRecord]`）与 `/v1/memories`，形状不同。本模块是**最小兼容层**：
不改 `/v1` 既有 API 的任何行为，只在 `/v1/memory/*` 上把两侧契约对上。

为什么挂在 `/v1` 前缀下而不是根路径 `/memory/*`
-----------------------------------------------
公网入口 Caddy 只把 `/v1/*`、`/healthz` 反代到 hub-api（`jarvis/deploy/caddy/Caddyfile`），
根路径 `/memory/*` 会落到前端 catch-all 返回 200 HTML —— 探测会「假通」、调用会 405。
挂到 `/v1` 下即可复用现成路由，零 Caddy 改动。因此宿主机侧
`settings.memory.hub` 应填 `https://jarvis.kentonnie.top/v1`（或 LAN 内
`http://192.168.31.152:18080/v1`），客户端拼出的 `base + '/memory/search'`
正好落在 `/v1/memory/search`。

安全与隔离
----------
- 鉴权复用 `/v1` router 的 `require_token`（X-Hub-Token 或 node token），
  与既有 API 同门；本模块自己不再造一套鉴权。
- **命名空间硬过滤**：只认 `dsh-memory/bot` 与 `bot/<bot_id>`。`dsh/ktool`、
  `qoder/code`、`claude/*` 等个人命名空间一律不可见——即使调用方持有 admin token。
- `bots` / `known_bots` 按宿主机 `BOT_ID = /^[a-z0-9_-]+$/`（+ 写入侧 64 上限）校验，
  不合规 422；`bots` 只用于拼 `bot/<id>` 命名空间，不做字符串拼接之外的任何解释。

### 这一层**不是**权限边界（重要）

`bot_id` 是**数据归类**：它决定「这条记忆归谁看」，不决定「谁有权看」。
真实原因：Hub 的写入方可以自填 `metadata.bot_id` / `source_file` / `imported_from`，
`bot-<id>-` 文件名也只是约定。所以把两个自述字段拼起来宣称「已做 Bot 级鉴权隔离」
是假的——任何人都能写一条自称属于别人的行。

可信的只有两件事，本层也只依赖这两件：

1. `/v1` 的 `require_token` 认证出来的 `request.state.actor`（admin / node:<id>）；
2. 命名空间本身（写入路径决定，不接受行内自述覆盖）。

由此得到的真实边界是：**一个 node 凭据 = 一个操作者 = 全队记忆可见**。
独立 Bot principal（每个 Bot 各自一套凭据、只能读写自己的记忆）在这套系统里
不存在，也不该由兼容层假装存在——那会让「隔离」变成一句无法验证的声明。
`bots` 参数因此只做「缩小返回集」，越权读别人的 bot 不在它的防守范围内。
本层做的是可验证的收窄：自述与 canonical 名字冲突时**拒绝该行**，
不把两种说法混起来用。
- 失败一律如实报错（4xx/5xx），绝不返回「空列表当成功」：
  客户端 `HubMemory` 捕获异常后降级本机，那才是它认得的行为。

consolidate 的语义（刻意保守）
------------------------------
宿主机把它当「睡眠期巩固」触发点，超时只有 3s（`hub-client.ts`
`DEFAULT_TIMEOUT_MS`），所以**不能**在这里跑 LLM 蒸馏（Hub 的蒸馏在
`arbiter` 的 consolidation 循环里，一次几十秒，且产出要人审的 skill 草稿）。

本端点做的是**真实、有界、可逆**的那部分：

- `facts`：窗口内 `bot/*` 已蒸馏产物的行数（`origin in {distill, flush}`），只读统计。
- `merged` / `superseded`：窗口内 `bot/*` 的近似重复对，**默认只统计不写**
  （`apply=false`）。`apply=true` 才调用既有 `soft_delete_memory`（软删、
  有审计、可 restore）把较旧一方合并掉。
- 响应额外带 `dryRun` 与 `window`，让调用方与审计能区分「算了没做」与
  「做了零个」。默认 dry-run 是因为这个端点由客户端 3s 超时驱动，
  不拿它当批量删除入口；开启 `apply` 属拍板项。
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any, Sequence

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .db_models import Memory
from .main_memory_routes import MemorySearch, api_error, search_memories_impl
from .memory_hygiene import find_merge_pairs

logger = logging.getLogger(__name__)

#: `local_dream` 的 dsh 记忆直通源把 `~/.dsh/memory/<dir>/<file>.md` 映射成
#: `dsh-memory/<dir>`（`hub/node_bridge/local_dream.py` `_iter_dsh_auto_memories`）。
#: 宿主机 Bot 的记忆落在 `~/.dsh/memory/bot/<bot_id>/`，所以生产库里是**单一命名空间**
#: `dsh-memory/bot`，靠文件名 `bot-<bot_id>-<slug>.md` 区分是哪位 Bot。
#: 2026-11-14 实测：生产库 176 个命名空间里没有任何 `bot/*`，只有 `dsh-memory/bot`（3 条）。
CREW_NAMESPACE = "dsh-memory/bot"

#: 前向兼容：若将来 `local_dream` 改成按 bot 分命名空间，`bot/<bot_id>` 也一并认。
CREW_NAMESPACE_PREFIX = "bot/"

#: 宿主机一次召回的默认/上限条数（`HubMemory.recall` 传 6）。
DEFAULT_LIMIT = 6
MAX_LIMIT = 50

#: 巩固默认窗口：宿主机睡眠期一次跑，取最近 24h。
DEFAULT_WINDOW_SECONDS = 24 * 3600

#: 算作「已蒸馏产物」的 origin。dsh 直通源写的是 `native`（`imported_from=local-dream-native`），
#: `distill`/`flush` 是 local_dream 自己的蒸馏与自动落盘。
DISTILL_ORIGINS = ("distill", "flush", "native")

#: bot_id 的合法形状：与宿主机 `backend/src/crew/directory.ts` 的
#: `BOT_ID = /^[a-z0-9_-]+$/` **逐字同口径**。这里多出的 `{1,64}` 不是形状约束，
#: 是写入侧 `app/mobile-http.ts` 已有的 64 字符上限——服务端不复用它就会接受
#: 客户端永远写不出来的 id。**不要再加「不许以 `-` 开头」之类的自造规则**：
#: 客户端认的 id 服务端回 422，就是契约分叉。
_BOT_ID_RE = re.compile(r"^[a-z0-9_-]{1,64}$")

#: 文件名里的 bot_id：`bot-<bot_id>-<slug>.md`。
#: 惰性匹配（最短）——slug 由 `dedupe_key` 生成、本身可以带短横线，所以 bot_id
#: 取最短可行前缀才不会把 slug 的尾巴吃掉。**已知歧义**：bot_id 自己带短横线时
#: （如 `my-bot`）会被切成 `my`；宿主机侧真正的 bot 名录在设置里，Hub 读不到。
#: 响应里额外回 `bots` 字段列出实际解析出的 id，让调用方能发现对不上。
_FILE_BOT_RE = re.compile(r"^bot-([a-z0-9_-]+?)-[a-z0-9\u4e00-\u9fa5-]")
#: 内容首行的来源标头：`# [dsh-auto-memory:<type>] <stem> — <description>`
_HEADER_RE = re.compile(r"^#\s*\[dsh-auto-memory:([a-z]+)\]\s*(.*)$")

_MEMORY_TYPES = ("user", "feedback", "project", "reference")


# ---------------------------------------------------------------------------
# 纯函数：Hub 行 → 宿主机 MemoryEntry（可单测，不碰 DB）
# ---------------------------------------------------------------------------


def crew_namespaces_for(bot_ids: Sequence[str]) -> list[str]:
    """`bots` → 要查的命名空间集合。

    单命名空间模型下所有 bot 都在 `dsh-memory/bot`；但 `bot/<id>` 是前向兼容的
    另一种落法。只查前者会让「过滤条件生效」变成「另一个命名空间被整体跳过」——
    看着有过滤，实际永远空召回。
    """
    return sorted({CREW_NAMESPACE, *(f"{CREW_NAMESPACE_PREFIX}{bot}" for bot in bot_ids)})


def bot_id_of(namespace: str) -> str:
    """命名空间 → 固定标记。单命名空间模型下没有 bot 可推，返回命名空间本身。

    真正的 `bot_id` 在行级（文件名 / 标头）里，见 `bot_id_of_row()`。
    非 crew 命名空间返回空串，调用方据此丢弃整行。
    """
    if not isinstance(namespace, str):
        return ""
    if namespace == CREW_NAMESPACE:
        return CREW_NAMESPACE
    if namespace.startswith(CREW_NAMESPACE_PREFIX):
        return namespace[len(CREW_NAMESPACE_PREFIX):]
    return ""


def _stem_bot_id(stem: str, known_bots: Sequence[str] = ()) -> str:
    """`bot-<bot_id>-<slug>` → `bot_id`。

    文件名本身有歧义：bot_id 允许带短横线，`bot-my-bot-use-pnpm` 既可能是
    bot `my-bot` 的 slug `use-pnpm`，也可能是 bot `my` 的 slug `bot-use-pnpm`。
    Hub 读不到宿主机的 bot 名录，所以：

    1. 调用方给了 `known_bots`（宿主机设置里的名录）→ 按**最长匹配**优先，
       歧义就此消解；
    2. 没给 → 惰性取最短前缀（宿主机现有 bot id 都是单个词，实际不会错），
       响应里回 `bots` 让调用方自己核对。
    """
    if not stem.startswith("bot-"):
        return ""
    rest = stem[len("bot-"):]
    for candidate in sorted((b for b in known_bots if b), key=len, reverse=True):
        if rest.startswith(candidate + "-") and _BOT_ID_RE.fullmatch(candidate):
            return candidate
    matched = _FILE_BOT_RE.match(stem)
    return matched.group(1) if matched else ""


def bot_id_of_row(
    row: Any,
    known_bots: Sequence[str] = (),
    *,
    header: tuple[str, str, str] | None = None,
) -> str:
    """从一行的命名空间 / 文件名 / 内容标头里取 `bot_id`；认不出来或自相矛盾返回空串。

    判定顺序与依据（**这是数据归类，不是身份**）：

    1. 命名空间 `bot/<id>` 是硬边界——它说归谁就归谁，行内自述不覆盖它；
    2. `metadata.source_file` / `origin_ref` 的 `bot-<bot_id>-<slug>` 是 canonical 名字
       （local_dream 直通源按文件写入，名字由写盘路径决定）；
    3. 内容首行标头里的 stem 是兜底；
    4. 都不落空 = 不是 Bot 记忆，丢弃（同一命名空间里还混着大量非 Bot 的 dsh 记忆）。

    `metadata.bot_id` 由写入方自填，**不是可信身份**：它只在与 canonical 名字
    一致时被采用，冲突时整行丢弃——把两种说法拼在一起用，等于让写入方
    替别人认领记忆。真正的权限边界在 `/v1` 的 `require_token`，见模块 docstring。
    """
    namespace = getattr(row, "namespace", "") or ""
    if namespace.startswith(CREW_NAMESPACE_PREFIX):
        candidate = namespace[len(CREW_NAMESPACE_PREFIX):]
        return candidate if _BOT_ID_RE.fullmatch(candidate) else ""
    if namespace != CREW_NAMESPACE:
        # crew 之外的命名空间一律不算 Bot 记忆。SQL 层已按命名空间过滤，
        # 这里再挡一道：漏一次 SQL 条件就把别人的记忆当 crew 的记忆上报了。
        return ""

    meta = getattr(row, "memory_metadata", None) or {}
    declared = ""
    canonical = ""
    if isinstance(meta, dict):
        text = str(meta.get("bot_id") or "").strip()
        declared = text if _BOT_ID_RE.fullmatch(text) else ""
        for key in ("source_file", "origin_ref"):
            canonical = _stem_bot_id(str(meta.get(key) or "").rsplit("/", 1)[-1], known_bots)
            if canonical:
                break
    if declared and canonical and declared != canonical:
        logger.warning("compat: declared bot_id %r disagrees with canonical %r, row dropped", declared, canonical)
        return ""
    if declared or canonical:
        return declared or canonical

    if header is None:
        header = _parse_header(getattr(row, "content", "") or "")
    return _stem_bot_id(header[1], known_bots)


def _seconds(value: Any) -> int:
    """datetime / ISO 字符串 / 数字 → 秒级整数；认不出来就是 0。

    **三种都要认**：`search_memories_impl` 走的是 `_memory_json()`，它把
    `created_at` 序列化成 ISO 字符串（`2026-11-08T16:49:04.934689Z`），不是
    datetime。只认 datetime 会让每条记忆的 `created/updated` 都变成 0，
    宿主机 `freshness()` 把 0 当「1970 年」——所有记忆同样陈旧，排序项白算，
    而且新记忆永远排不到前面。这是 2026-11-14 用生产行验证时抓到的真实 bug。
    """
    if isinstance(value, datetime):
        moment = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return int(moment.timestamp())
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return int(value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return 0
        # `Z` 后缀 Python 3.10 以前不被 fromisoformat 认；统一换成 +00:00
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            moment = datetime.fromisoformat(text)
        except ValueError:
            return 0
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=timezone.utc)
        return int(moment.timestamp())
    return 0


def _first_line(text: str, limit: int = 200) -> str:
    for raw in (text or "").splitlines():
        line = raw.strip().lstrip("#").strip()
        if line:
            return line if len(line) <= limit else line[:limit] + "…"
    return ""


def _parse_header(content: str) -> tuple[str, str, str]:
    """拆内容首行标头 → `(type, stem, description)`；不是标头就全空。

    dsh 直通源写的是 `# [dsh-auto-memory:<type>] <stem> — <description>`，
    `description` 可能缺（`— ` 之后为空）。
    """
    for raw in content.splitlines()[:3]:
        header = _HEADER_RE.match(raw.strip())
        if not header:
            continue
        mem_type = header.group(1).strip().lower()
        rest = header.group(2).strip()
        if " — " in rest:
            stem, _, description = rest.partition(" — ")
        elif " - " in rest:
            stem, _, description = rest.partition(" - ")
        else:
            stem, description = rest, ""
        return mem_type, stem.strip(), description.strip()
    return "", "", ""


def entry_from_memory(row: Memory, known_bots: Sequence[str] = ()) -> dict[str, Any] | None:
    """一行 Hub memory → 宿主机 `MemoryEntry`；不是 Bot 记忆的行返回 None。

    字段口径与 `backend/src/memory/hub-client.ts` 的 `memoryEntriesOf()` 对齐：
    缺 `name` 或 `body` 的条目会被客户端丢弃，所以这里保证两者非空。

    另外两条必须成立，否则宿主机侧会静默丢数据：
    - `bot_id` 要能被 `MemoryLedger.byDedupeKey(botId, key)` 用上（按人分记忆）；
    - `name` 用文件 stem（`bot-<bot_id>-<slug>`），与宿主机自己 `planWrite()`
      要求的 `bot-${botId}-` 前缀一致，落盘不会撞名。
    """
    if not bot_id_of(getattr(row, "namespace", "") or ""):
        return None

    content = (getattr(row, "content", "") or "").strip()
    if not content:
        return None
    # 标头只解析一次：bot_id 与 name/type/description 必须来自同一行，
    # 各解析一遍迟早让两者漂到不同的行上。
    mem_type, stem, header_description = _parse_header(content)
    bot_id = bot_id_of_row(row, known_bots, header=(mem_type, stem, header_description))
    if not bot_id:
        return None
    meta = getattr(row, "memory_metadata", None) or {}
    if not isinstance(meta, dict):
        meta = {}

    # 文件名是 local_dream 的权威来源；内容标头的 stem 可能因手工编辑而漂移。
    source_file = str(meta.get("source_file") or "").rsplit("/", 1)[-1]
    if source_file.endswith(".md"):
        source_file = source_file[:-3]
    name = source_file or stem or f"bot-{bot_id}-hub-{str(getattr(row, 'id', ''))[:8]}"
    if not name.startswith(f"bot-{bot_id}-"):
        # 名字里带不上 bot 前缀，宿主机 `planWrite()` 会直接抛；补一个稳定前缀。
        name = f"bot-{bot_id}-{name}"

    # 正文去掉标头行，剩下的才是「这条记忆说了什么」；宿主机 `line()` 只取第一段。
    body = content
    lines = content.splitlines()
    if lines and _HEADER_RE.match(lines[0].strip()):
        body = "\n".join(lines[1:]).strip() or content

    description = (
        str(meta.get("description") or "").strip()
        or header_description
        or _first_line(body)
        or name
    )

    explicit_type = str(meta.get("type") or "").strip().lower()
    resolved_type = explicit_type if explicit_type in _MEMORY_TYPES else (
        mem_type if mem_type in _MEMORY_TYPES else "project"
    )

    importance = meta.get("importance")
    if not isinstance(importance, int) or isinstance(importance, bool) or not 1 <= importance <= 10:
        importance = 3
    status = "verified" if str(meta.get("status") or "").strip().lower() == "verified" else "candidate"
    created = _seconds(getattr(row, "created_at", None))
    # Hub 的 `memories` 表没有独立的行更新时间列（只有 created_at / deleted_at），
    # 也没有任何写入方在 metadata 里落 `updated`。所以 `updated` 只能镜像
    # `created`——**不编一个 now()**：那会让每次召回都把全部记忆算成「刚刚更新」，
    # 客户端 freshness 加权直接失效。等真有更新时间来源再改这里。
    dedupe_key = str(meta.get("dedupe_key") or "").strip() or name

    return {
        "name": name,
        "bot_id": bot_id,
        "description": description.replace("\n", " ").strip(),
        "body": body,
        "type": resolved_type,
        "status": status,
        "importance": importance,
        "toHub": True,
        "dedupe_key": dedupe_key,
        "created": created,
        "updated": created,
        "state": "active",
        "layer": getattr(row, "layer", "Context") or "Context",
        "origin": getattr(row, "origin", None) or str(meta.get("origin") or "unknown"),
        "hub_id": str(getattr(row, "id", "")),
    }


# ---------------------------------------------------------------------------
# 请求模型
# ---------------------------------------------------------------------------


class CompatSearch(BaseModel):
    """宿主机 `HubHttp.search()` 的请求体。

    `bots` 缺省 = 全队（同一命名空间里所有 `bot-*` 行）；给了就只回这几位的。
    """

    query: str = Field(default="", max_length=10_000)
    bots: list[str] | None = Field(default=None, max_length=64)
    #: 调用方设置里的 Bot 名录。**只用于消解文件名歧义**（`bot-my-bot-2-slug.md`
    #: 究竟是 `my` 还是 `my-bot-2` 写的），不参与任何权限判断：名录由同一个
    #: 调用方提供，它若想说谎，直接伪造 `bots` 更省事。
    known_bots: list[str] | None = Field(default=None, max_length=64)
    limit: int = Field(default=DEFAULT_LIMIT, ge=1, le=MAX_LIMIT)

    @field_validator("bots", "known_bots")
    @classmethod
    def bots_valid(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        cleaned: list[str] = []
        for item in value:
            text = str(item or "")
            # 与宿主机 `BOT_ID = /^[a-z0-9_-]+$/` 同口径；不合规直接 422，
            # 不做「清洗后当合规」的静默兜底。
            if not _BOT_ID_RE.fullmatch(text):
                raise ValueError(f"invalid bot id: {item!r}")
            cleaned.append(text)
        return cleaned


class CompatConsolidate(BaseModel):
    """宿主机 `HubHttp.consolidate()` 的请求体：秒级窗口 + 是否真写。"""

    since: int | None = Field(default=None, ge=0)
    until: int | None = Field(default=None, ge=0)
    #: 默认只统计。`true` 才把近似重复的较旧一方软删（可 restore）。
    apply: bool = False


# ---------------------------------------------------------------------------
# 实现
# ---------------------------------------------------------------------------


async def _crew_namespaces(session: AsyncSession) -> list[str]:
    """现存 crew 命名空间：主用 `dsh-memory/bot`，并认将来可能出现的 `bot/*`。

    返回空列表 = 生产库里一条 Bot 记忆都还没有；调用方必须如实上报，
    不能拿空列表当「检索无命中」糊过去。
    """
    rows = (
        await session.execute(
            select(Memory.namespace)
            .where(or_(Memory.namespace == CREW_NAMESPACE, Memory.namespace.like(f"{CREW_NAMESPACE_PREFIX}%")))
            .distinct()
        )
    ).scalars()
    return [str(ns) for ns in rows if bot_id_of(str(ns))]


async def compat_search_impl(
    body: CompatSearch,
    session: AsyncSession,
    *,
    actor: str | None = None,
) -> dict[str, Any]:
    """`POST /v1/memory/search` → `{entries, namespaces, degraded}`。

    复用既有 `search_memories_impl`（同一套 TEI/hash 混合打分、retrieval_log
    埋点、软删过滤），再按分数归并——不另写一套检索，避免两套排序口径打架。

    `limit` 在**归并之后**再截：单命名空间里 `bot-*` 行与其它 dsh 记忆混装，
    先截会让某一位 Bot 的命中被别人的行挤掉。
    """
    if body.bots:
        namespaces = crew_namespaces_for(body.bots)
    else:
        namespaces = await _crew_namespaces(session)
    if not namespaces:
        return {
            "entries": [],
            "namespaces": [],
            "bots": [],
            "degraded": False,
            "reason": "no-crew-namespace",
        }

    wanted_bots = set(body.bots or ())
    # 名录 = 调用方点名要的 + 它自报的名录：两者都是消歧线索，取并集。
    known_bots = tuple(dict.fromkeys([*(body.bots or ()), *(body.known_bots or ())]))
    # 单命名空间下候选行数与 Bot 数无关，取一个比 limit 大的固定窗口再归并。
    candidate_limit = min(MAX_LIMIT * 4, 100)  # MemorySearch.limit 上限 100

    collected: list[tuple[float, dict[str, Any]]] = []
    for namespace in namespaces:
        request = MemorySearch(namespace=namespace, query=body.query, limit=candidate_limit)
        rows = await search_memories_impl(request, session, actor=actor)
        for row in rows:
            view = _RowView(row, namespace)
            mapped = entry_from_memory(view, known_bots)
            if mapped is None:
                continue
            if wanted_bots and mapped["bot_id"] not in wanted_bots:
                continue
            score = row.get("score")
            collected.append((float(score) if isinstance(score, (int, float)) else 0.0, mapped))

    # 分数降序；同分按 updated 新→旧、再按 name，保证两次调用顺序一致。
    collected.sort(key=lambda pair: (-pair[0], -pair[1]["updated"], pair[1]["name"]))
    entries = [entry for _score, entry in collected[: body.limit]]
    # `bots` 列出这次真的解析出条目的 bot id，便于宿主机核对「解析出的 bot 名与
    # 设置里的名录是否一致」（文件名带短横线的歧义只有调用方能判）。
    bots = sorted({entry["bot_id"] for entry in entries})
    return {"entries": entries, "namespaces": namespaces, "bots": bots, "degraded": False}


class _RowView:
    """把 `search_memories_impl` 返回的 dict 伪装成 ORM 行，供 `entry_from_memory` 复用。

    `_memory_json()` 的响应体**不含 namespace**，而兼容面要靠它判「这是不是 crew
    命名空间」，所以由调用方把刚查的命名空间传进来。命名空间本身就是
    `bot/<id>` 形态下的权威归属，直接交给 `bot_id_of_row()` 读，不往
    `metadata.bot_id` 里写——那个字段是写入方的自述，塞进去就分不清
    「命名空间说的」与「写入方说的」。
    """

    __slots__ = ("namespace", "content", "layer", "memory_metadata", "created_at", "origin", "id")

    def __init__(self, payload: dict[str, Any], namespace: str) -> None:
        self.namespace = namespace
        meta = payload.get("metadata") or {}
        self.memory_metadata = dict(meta) if isinstance(meta, dict) else {}
        self.content = str(payload.get("content") or "")
        self.layer = payload.get("layer") or "Context"
        self.created_at = payload.get("created_at")
        self.origin = payload.get("origin")
        self.id = payload.get("id")


def _window(body: CompatConsolidate) -> tuple[datetime, datetime]:
    """秒级窗口 → `(since, until)`。

    `since=0` / `until=0` 是 **Unix 纪元**，是调用方明确给的值，不是「没给」。
    旧实现用 `if body.until` / `if body.since` 判假值，`0` 会被静默换成
    「现在 / 24 小时前」——调用方要「从最早开始」却拿到一个窄窗口，
    巩固统计少算且没有任何提示。这里只判 `None`。
    """
    until = (
        datetime.fromtimestamp(body.until, tz=timezone.utc)
        if body.until is not None
        else datetime.now(timezone.utc)
    )
    since = (
        datetime.fromtimestamp(body.since, tz=timezone.utc)
        if body.since is not None
        else until - timedelta(seconds=DEFAULT_WINDOW_SECONDS)
    )
    if since > until:
        raise api_error(422, "since must not be after until")
    return since, until


async def compat_consolidate_impl(
    body: CompatConsolidate,
    session: AsyncSession,
    *,
    actor: str = "memory-compat",
    soft_delete: Any = None,
) -> dict[str, Any]:
    """`POST /v1/memory/consolidate` → `{facts, merged, superseded, dryRun, window}`。

    只在 crew 命名空间内工作（`dsh-memory/bot` 与 `bot/*`）；默认 dry-run。
    """
    since, until = _window(body)
    rows = list(
        (
            await session.execute(
                select(Memory).where(
                    Memory.deleted_at.is_(None),
                    or_(Memory.namespace == CREW_NAMESPACE, Memory.namespace.like(f"{CREW_NAMESPACE_PREFIX}%")),
                    Memory.created_at >= since,
                    Memory.created_at <= until,
                )
            )
        ).scalars()
    )

    crew_rows = [row for row in rows if bot_id_of_row(row)]
    # `facts` = **这次调用提炼出的事实数**。本层不跑 LLM 蒸馏（见模块 docstring），
    # 所以恒为 0。窗口内存量的已蒸馏行数是另一件事，单独叫 `existingFacts`：
    # 把存量当产出上报，客户端日志就会写「本次巩固提炼了 N 条」，而它一条都没提炼。
    facts = 0
    existing_facts = sum(
        1
        for row in crew_rows
        if str(getattr(row, "origin", None) or "") in DISTILL_ORIGINS
    )
    superseded = sum(
        1
        for row in crew_rows
        if isinstance(getattr(row, "memory_metadata", None), dict)
        and (row.memory_metadata or {}).get("supersedes")
    )
    pairs = find_merge_pairs(crew_rows)

    merged = 0
    if body.apply and soft_delete is not None:
        import uuid as _uuid

        for pair in pairs:
            try:
                await soft_delete(
                    session,
                    memory_id=_uuid.UUID(pair.drop_id),
                    actor=actor,
                    reason=f"memory-compat merge (cos={pair.similarity:.3f}) into {pair.keep_id}",
                )
                merged += 1
            except Exception as exc:  # noqa: BLE001 — 单对失败跳过，不让一次巩固整体失败
                logger.warning("compat merge %s failed: %s", pair.drop_id, type(exc).__name__)
        if merged:
            await session.commit()

    logger.info(
        "compat consolidate window=%s..%s scanned=%d existing_facts=%d pairs=%d merged=%d apply=%s",
        since.isoformat(),
        until.isoformat(),
        len(crew_rows),
        existing_facts,
        len(pairs),
        merged,
        body.apply,
    )
    return {
        "facts": facts,
        "merged": merged,
        "superseded": superseded,
        "dryRun": not body.apply,
        "candidateMerges": len(pairs),
        "scanned": len(crew_rows),
        "existingFacts": existing_facts,
        "window": {"since": int(since.timestamp()), "until": int(until.timestamp())},
    }


# ---------------------------------------------------------------------------
# 路由注册（与 memory_graph_routes / hub_metrics 同款：显式传 session_type）
# ---------------------------------------------------------------------------


def register_memory_compat_routes(router: APIRouter, *, session_type: Any = None) -> None:
    """把 `/memory/search` 与 `/memory/consolidate` 挂到给定的 `/v1` router 上。

    注册顺序无关（两条都是字面路径，不与 `/memories/{id}` 冲突）。
    """
    if session_type is None:
        from .database import get_session

        session_type = Annotated[AsyncSession, Depends(get_session)]
    Session = session_type
    # `from __future__ import annotations` 让路由签名里的 Session 以字符串存进
    # __annotations__；FastAPI 请求期在模块 globals 求值，必须在此播种。
    globals()["Session"] = Session

    @router.post("/memory/search")
    async def compat_search(body: CompatSearch, request: Request, session: Session) -> dict[str, Any]:
        return await compat_search_impl(
            body, session, actor=str(getattr(request.state, "actor", "unknown") or "unknown")
        )

    @router.post("/memory/consolidate")
    async def compat_consolidate(
        body: CompatConsolidate, request: Request, session: Session
    ) -> dict[str, Any]:
        from .memory_delete import soft_delete_memory

        return await compat_consolidate_impl(
            body,
            session,
            actor=str(getattr(request.state, "actor", "unknown") or "unknown"),
            soft_delete=soft_delete_memory,
        )
