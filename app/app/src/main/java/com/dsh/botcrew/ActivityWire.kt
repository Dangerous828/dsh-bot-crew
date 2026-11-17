package com.dsh.botcrew

import org.json.JSONObject

/**
 * 一条请求此刻的执行活动。与消息收据（`request_state`）是**两件事**：
 * 收据说「这条消息到没到、有没有回话」，活动说「队伍此刻在拿它干什么」。
 *
 * 全部字段来自后端，客户端不自己推。缺证据时后端给 `evaluating` / `unknown`，这里照实显示。
 */
data class ExecutionActivity(
    /** 取值见 [ActivityCopy.kind]：evaluating / model / tool / retrying / waiting_for_person / idle / ended / unknown。 */
    val kind: String,
    /** 当前活动起点。用于「已用时」。 */
    val since: String? = null,
    /** 最近一次事件时间。用于判断这份活动是不是陈的。 */
    val at: String? = null,
    /** 后端给的人读短词（如「读取文件」）。直接显示，不做二次加工。 */
    val label: String? = null,
)

/** 一条请求的活动条目。`request_id` 是把它挂回消息的唯一键。 */
data class RequestActivity(
    val requestId: String,
    val requestState: String? = null,
    val ticketRef: String? = null,
    val activity: ExecutionActivity? = null,
)

/**
 * `GET /api/mobile/activity` 的快照。
 *
 * [fresh] = `state == "live"`：只有 live 才当作「这一刻的事实」，其它值一律按「暂未同步」显示。
 * [supported] 来自错误码（[ActivityCapability]），为 false 时这一份根本不会被污染 UI。
 */
data class ActivitySnapshot(
    val sessionId: String,
    val items: List<RequestActivity>,
    /** 快照时间（不是活动时间）。 */
    val at: String? = null,
    val live: Boolean = false,
)

/**
 * 这项能力后端有没有。
 *
 * 三档而不是布尔：**不知道**（还没问过）与**没有**要分开 —— 前者不能提前关掉轮询，
 * 后者要关掉且不再刷错误；网络抖动则什么都不改，保留上一次的事实。
 */
enum class ActivityCapability { UNKNOWN, SUPPORTED, UNSUPPORTED }

/** 一次轻量活动请求的三种结局。 */
sealed interface ActivityResult {
    data class Live(val snapshot: ActivitySnapshot) : ActivityResult

    /** 还没接这项能力的后端：停掉轮询，退回旧节奏，**不**刷错误、伪造成「没有活动」。 */
    data object Unsupported : ActivityResult

    /**
     * 这一次没读到（断网、session 暂时不认、5xx）。
     * [detail] 只是现象；界面上要说「状态暂未同步」并保留上一次事实，不能当成「已结束」。
     */
    data class Unavailable(val detail: String) : ActivityResult
}

/** 活动协议的解析与文案。全字段可选：老后端缺字段不报错，只是没有那一层。 */
object ActivityWire {
    private const val SESSION_API = 1

    /**
     * 解析活动快照。
     *
     * @return null 表示**这不是本协议**（缺 `session_api:1`）—— 按 unsupported 处理，
     *   而不是当成「一份空活动」：空活动会让人以为队伍真的什么都没做。
     */
    fun parse(body: String): ActivitySnapshot? {
        val root = JSONObject(body)
        if ((root.opt("session_api") as? Number)?.toInt() != SESSION_API) return null
        val items = mutableListOf<RequestActivity>()
        val rows = root.optJSONArray("items") ?: org.json.JSONArray()
        for (index in 0 until rows.length()) {
            val row = rows.optJSONObject(index) ?: continue
            val requestId = row.optString("request_id").trim()
            if (requestId.isEmpty()) continue
            items.add(
                RequestActivity(
                    requestId = requestId,
                    requestState = row.optString("request_state").trim().takeIf { row.has("request_state") && it.isNotEmpty() },
                    ticketRef = row.optString("ticket_ref").trim().takeIf { row.has("ticket_ref") && it.isNotEmpty() },
                    activity = parseActivity(row.optJSONObject("activity")),
                ),
            )
        }
        return ActivitySnapshot(
            sessionId = root.optString("session_id").trim().takeIf(SessionRoute::validId) ?: SessionRoute.MAIN,
            items = items,
            at = root.optString("at").trim().takeIf(String::isNotBlank),
            live = root.optString("state").trim() == "live",
        )
    }

    private fun parseActivity(row: JSONObject?): ExecutionActivity? {
        if (row == null) return null
        val kind = row.optString("kind").trim()
        if (kind.isEmpty()) return null
        return ExecutionActivity(
            kind = kind,
            since = row.optString("since").trim().takeIf(String::isNotBlank),
            at = row.optString("at").trim().takeIf(String::isNotBlank),
            label = row.optString("label").trim().takeIf(String::isNotBlank),
        )
    }

    /** timeline item 上的可选 `activity` 对象（同一形状）。缺失/形状不对一律 null，不猜。 */
    fun activityOf(row: JSONObject?): ExecutionActivity? = parseActivity(row)

    /**
     * 把一个错误归类。**只有「这项能力不存在」才关掉轮询**，别的都是可恢复
     * （保留上次事实、标「状态暂未同步」）—— 因为「暂时读不到」与「没有这项能力」
     * 是两件事，混在一起会让一次网络抖动永久关掉状态显示。
     */
    fun outcomeOf(status: Int, body: String): ActivityResult = when {
        // 能力不存在：宿主没接投影，或宿主接了但网关没有 /meta（老网关）。
        status == 501 -> ActivityResult.Unsupported
        // 路由根本没注册（老后端）：lan-server 兜底 404 且**无 code**。
        status == 404 && !hasCode(body) -> ActivityResult.Unsupported
        // 会话非法：请求写错了，重试也不会变对。
        status == 400 && codeOf(body) == "invalid_session" -> ActivityResult.Unavailable("会话不存在")
        else -> ActivityResult.Unavailable(detailOf(status, body))
    }

    /** 兼容只拿到整句 message 的调用点（`CrewHttpStatus.message` 里带状态码与错误体）。 */
    fun outcomeOf(message: String?): ActivityResult {
        val text = message.orEmpty()
        val status = Regex("""队伍返回 (\d{3})""").find(text)?.groupValues?.getOrNull(1)?.toIntOrNull() ?: 0
        return if (status == 0) ActivityResult.Unavailable(text.ifBlank { "队伍没回话" }) else outcomeOf(status, text)
    }

    fun capabilityOf(status: Int, body: String): ActivityCapability =
        if (outcomeOf(status, body) is ActivityResult.Unsupported) ActivityCapability.UNSUPPORTED
        else ActivityCapability.SUPPORTED

    private fun codeOf(body: String): String = try {
        JSONObject(body).optString("code").trim()
    } catch (_: Exception) {
        ""
    }

    private fun hasCode(body: String): Boolean = codeOf(body).isNotBlank()

    /** 给人看的一句：后端 `error` 原文优先，没有就按状态码说。 */
    private fun detailOf(status: Int, body: String): String {
        val said = try {
            JSONObject(body).optString("error").trim()
        } catch (_: Exception) {
            ""
        }
        return said.ifEmpty { "队伍返回 $status" }
    }
}

/**
 * 轻量轮询的节奏。抽成纯函数是因为它最难在真机上验，却最容易写错成「一直在打」。
 *
 * 规则（对应契约「正常前台有活跃约 1 秒；无活跃/后台停止或降频」）：
 * - 能力位 UNSUPPORTED → 不轮询（走旧 timeline 节奏，不刷错误）；
 * - 不在前台 → 不轮询（后台由 timeline 的老节奏兜着，且系统会冻结进程）；
 * - 有活跃活动/有未确认发送 → 1 秒；
 * - 没有活跃 → 4 秒（比旧 6 秒略快，仍属于低频；只用来发现「突然又活了」）。
 */
object ActivityPoll {
    const val ACTIVE_MS = 1_000L
    const val IDLE_MS = 4_000L

    /** @return null = 这一轮不该发请求。 */
    fun intervalMs(capability: ActivityCapability, foreground: Boolean, active: Boolean): Long? = when {
        capability == ActivityCapability.UNSUPPORTED -> null
        !foreground -> null
        active -> ACTIVE_MS
        else -> IDLE_MS
    }

    /**
     * 这一刻算不算「有活跃活动」。
     *
     * `unknown` 也算活跃：说不知道的时候正是最该勤看一眼的时候，别让它停在旧画面上。
     * `ended` / `idle` 不算。
     */
    fun isActive(activity: ExecutionActivity?): Boolean = when (activity?.kind) {
        null, "ended", "idle" -> false
        else -> true
    }

    fun anyActive(items: Collection<RequestActivity>): Boolean = items.any { isActive(it.activity) }
}

/**
 * 活动与收据的文案。
 *
 * 分工：收据说消息到没到（[RequestStateCopy]），活动说队伍此刻在做什么（这里）。
 * 两行分开画，谁也不顶替谁 —— 这正是「已回复」不该被当成「已完成」的落点。
 */
object ActivityCopy {
    /** 活动类别 → 人话。未知值单独 label（「未知状态」），不并入「已发送」。 */
    fun kind(activity: ExecutionActivity?): String? {
        if (activity == null) return null
        return when (activity.kind) {
            "evaluating" -> "评估中"
            "model" -> "模型处理中"
            "tool" -> activity.label?.let { "使用工具 · $it" } ?: "使用工具"
            "retrying" -> "正在重试模型请求"
            "waiting_for_person" -> "需要你处理"
            "idle" -> "当前会话空闲"
            "ended" -> "已结束"
            "unknown" -> "未知状态"
            else -> "未知状态"
        }
    }

    /** 一行活动；`ended`/`idle` 也各有一行 —— 那是事实，不是没活动。 */
    fun line(activity: ExecutionActivity?): String? = kind(activity)

    /** 没有原生事件证据时后端会给 unknown；界面必须说得清「不知道」，而不是顺手写成「已发送」。 */
    fun isUnknown(activity: ExecutionActivity?): Boolean = activity?.kind == "unknown" || activity?.kind == null

    /** 状态新鲜度那一行。读不到时用它，不覆盖上一次事实。 */
    const val STALE = "状态暂未同步"
}
