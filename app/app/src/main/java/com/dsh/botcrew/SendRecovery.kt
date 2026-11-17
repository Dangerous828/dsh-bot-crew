package com.dsh.botcrew

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * 一条**结果待确认**的发送。
 *
 * 为什么整条 envelope 都要落盘，而不是只存 request_id：POST 一旦发出，服务端可能已经收了。
 * 进程被系统回收之后，光有 id 无法重建「我刚才到底想发什么」—— 那正是「一次交代变成两条消息」
 * 和「不敢重试只能重打一遍」的来源。正文、收件人、@ 都在这条里，恢复时用的就是同一份。
 *
 * [requestId] 是幂等键：恢复/重试沿用同一个，服务端因此最多产生一条消息。
 */
data class UncertainSend(
    val requestId: String,
    val sessionKey: String,
    val text: String,
    val mentions: List<String> = emptyList(),
    val recipientId: String = "",
    val at: Long = 0L,
) {
    /** 「刚才那条」在界面上怎么指认：原文首行截断，够认出来又不占屏。 */
    fun excerpt(): String {
        val head = text.lineSequence().firstOrNull()?.trim().orEmpty()
        if (head.isEmpty()) return "（空白内容）"
        return if (head.length <= 24) head else head.take(23) + "…"
    }

    /** 同一个幂等键只能对应同一份意图。payload 不一致 = 不是同一次发送。 */
    fun sameIntent(other: UncertainSend): Boolean =
        requestId == other.requestId && sessionKey == other.sessionKey &&
            text == other.text && mentions == other.mentions && recipientId == other.recipientId
}

/**
 * 未确定发送的纯函数层：盘上那份 `Map` ↔ [UncertainSend] 列表。
 *
 * 四条硬规则（都对应真实损失）：
 * 1. **同会话允许多条**：改字重发会生成新的 request_id，旧那条不能因此消失。
 * 2. **只有明确成功才删对应那一条**：删的是 request_id 精确相等的那条，不是整个会话。
 * 3. **同 id 不允许换 payload**：那不是「更新」，是另一份意图 —— 保留原件、返回冲突，调用方不得 POST。
 * 4. **读坏不覆盖**：[read] 给出 CORRUPT，写操作一律拒绝并让调用方停工 + 可见提示。
 */
object SendRecoveryRecord {
    const val SENDS = "uncertain"

    /**
     * 同一份意图**已经**在盘上时，返回它（沿用原 request_id）；否则 null。
     *
     * 「同一份意图」= 会话 + 正文 + @ 名单 + 收件人全等。只比正文是不够的：
     * 同一句话改了收件人就是另一件事，复用旧 id 会被 [put] 判成 CONFLICT，
     * 于是新的一次正常发送被盘上那条旧记录挡住。
     */
    fun reuse(
        existing: List<UncertainSend>,
        sessionKey: String,
        text: String,
        mentions: List<String>,
        recipientId: String,
    ): UncertainSend? = existing.firstOrNull {
        it.requestId.isNotEmpty() && it.sessionKey == sessionKey && it.text == text &&
            it.mentions == mentions && it.recipientId == recipientId
    }

    /** 同 id 换 payload 时的结果：调用方必须放弃这次发送，不能覆盖原件。 */
    enum class PutResult { WRITTEN, CONFLICT, CORRUPT }

    fun read(values: Map<String, *>): RecordRead<UncertainSend> =
        recordRead(values[SENDS] as? String) { raw -> decode(raw) }

    /**
     * 记一条。同 request_id 只更新时间，**不覆盖** session/text/mentions/recipient；
     * payload 不同即 [PutResult.CONFLICT]。
     *
     * @return 写回的新串（null = 不写）。
     */
    fun put(values: Map<String, *>, send: UncertainSend): Pair<PutResult, String?> {
        val current = read(values)
        if (current.corrupt) return PutResult.CORRUPT to null
        val existing = current.items.firstOrNull { it.requestId == send.requestId }
        if (existing != null) {
            if (!existing.sameIntent(send)) return PutResult.CONFLICT to null
            // 同一份意图：只把时间往前推（别的字段原样）。
            val kept = current.items.filter { it.requestId != send.requestId }
            return PutResult.WRITTEN to encode(kept + send.copy(at = maxOf(send.at, existing.at)))
        }
        return PutResult.WRITTEN to encode(current.items + send)
    }

    /** 明确成功（或对账证明服务端已有）：只清 request_id 相等的那一条。 */
    fun remove(values: Map<String, *>, requestId: String): String? {
        val current = read(values)
        if (current.corrupt) return null
        return encode(current.items.filter { it.requestId != requestId })
    }

    fun find(values: Map<String, *>, requestId: String): UncertainSend? =
        read(values).items.firstOrNull { it.requestId == requestId }

    fun forSession(values: Map<String, *>, sessionKey: String): List<UncertainSend> =
        read(values).items.filter { it.sessionKey == sessionKey }.sortedBy { it.at }

    private fun decode(raw: String): List<UncertainSend> {
        val array = JSONArray(raw)
        val rows = mutableListOf<UncertainSend>()
        for (index in 0 until array.length()) {
            val row = array.optJSONObject(index) ?: continue
            val requestId = row.optString("id").trim()
            if (requestId.isEmpty()) continue
            val mentions = row.optJSONArray("m")?.let { list ->
                (0 until list.length()).map { list.optString(it) }.filter { it.isNotBlank() }
            }.orEmpty()
            rows.add(
                UncertainSend(
                    requestId = requestId,
                    sessionKey = row.optString("s").trim().ifEmpty { SessionRoute.MAIN },
                    text = row.optString("t"),
                    mentions = mentions,
                    recipientId = row.optString("r"),
                    at = row.optLong("at", 0L),
                ),
            )
        }
        return rows
    }

    private fun encode(sends: List<UncertainSend>): String {
        val array = JSONArray()
        for (send in sends.sortedBy { it.at }) {
            array.put(JSONObject().apply {
                put("id", send.requestId)
                put("s", send.sessionKey)
                put("t", send.text)
                if (send.mentions.isNotEmpty()) put("m", JSONArray(send.mentions))
                if (send.recipientId.isNotEmpty()) put("r", send.recipientId)
                if (send.at > 0L) put("at", send.at)
            })
        }
        return array.toString()
    }
}

/**
 * 未确定发送落盘。与 [DraftStore] 同一个 crew 命名空间、不同 prefs 文件。
 *
 * 写盘用 `commit()`：调用方要拿到「真的记下去了」才发 POST —— 记不住就别发，
 * 那正是重启后无法对账的根因。
 */
class SendRecoveryStore(context: Context, paired: PairedCrew?) {
    private val store = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val identity: String = CrewNamespace.key(paired)

    init {
        CrewNamespace.adopt(context, PREFS, identity)
    }

    private val key: String = "$identity|${SendRecoveryRecord.SENDS}"

    fun snapshot(): RecordRead<UncertainSend> =
        SendRecoveryRecord.read(mapOf<String, String>(SendRecoveryRecord.SENDS to store.getString(key, "").orEmpty()))

    fun all(): List<UncertainSend> = snapshot().items

    fun forSession(sessionKey: String): List<UncertainSend> =
        SendRecoveryRecord.forSession(mapOf(SendRecoveryRecord.SENDS to store.getString(key, "")), sessionKey)

    fun find(requestId: String): UncertainSend? =
        SendRecoveryRecord.find(mapOf(SendRecoveryRecord.SENDS to store.getString(key, "")), requestId)

    /**
     * 发 POST **之前**记下来。返回 false 时调用方不得发：这条账记不住，重启后就再也对不上。
     * payload 与已存记录冲突时同样返回 false（那份意图已经发出去了，不能再当新发送）。
     */
    fun record(send: UncertainSend): Boolean {
        val (result, next) = SendRecoveryRecord.put(
            mapOf(SendRecoveryRecord.SENDS to store.getString(key, "")), send,
        )
        if (result != SendRecoveryRecord.PutResult.WRITTEN || next == null) return false
        return store.edit().putString(key, next).commit()
    }

    /** 明确成功（或对账证明服务端已有）：只清这一条。 */
    fun done(requestId: String) {
        val next = SendRecoveryRecord.remove(
            mapOf(SendRecoveryRecord.SENDS to store.getString(key, "")), requestId,
        ) ?: return
        store.edit().putString(key, next).apply()
    }

    /**
     * 行内那个「不再重试，移除本机记录」：**只删这一条**，同会话别的未确认发送原样留着
     * （删整批会让 B、C 跟着 A 一起从界面消失，盘上还在、界面找不到，比不删更坏）。
     */
    fun forget(requestId: String) = done(requestId)

    internal fun clearForTests() {
        store.edit().remove(key).apply()
    }

    private companion object {
        /** 与 `CrewNamespace.adopt` 传的名字必须一致。 */
        const val PREFS = "crew-sends"
    }
}

/**
 * 一次发送的结果归属。**按 requestId 记账、按会话分组、可以有多条**。
 *
 * 为什么不是一格：A 失败、改字发 B 成功时，B 的成功不能顺手把 A 的失败抹掉（那会让 A 悄悄消失），
 * 也不能让 A 的失败继续冒充「刚才那条失败了」（B 明明发出去）。两条各记各的，各自带原文片段。
 */
object SendNoteBook {

    /** 同 requestId 覆盖，不同 requestId 并存。丢的永远是最旧的**提示**，未确认的 envelope 仍在盘上。 */
    fun put(notes: Map<String, List<SendNote>>, sessionKey: String, note: SendNote): Map<String, List<SendNote>> {
        val current = notes[sessionKey].orEmpty().filter { it.requestId != note.requestId }
        return notes + (sessionKey to (current + note).takeLast(CAP))
    }

    /** 成功只清匹配 requestId 的那一条；其它请求的提示原样留着。 */
    fun clear(notes: Map<String, List<SendNote>>, sessionKey: String, requestId: String): Map<String, List<SendNote>> {
        val current = notes[sessionKey].orEmpty().filter { it.requestId != requestId }
        return if (current.isEmpty()) notes - sessionKey else notes + (sessionKey to current)
    }

    fun of(notes: Map<String, List<SendNote>>, sessionKey: String): List<SendNote> =
        notes[sessionKey].orEmpty()

    private const val CAP = 4
}

/**
 * 「结果待确认」这件事该怎么说。
 *
 * **不写「没发出去」**：POST 已发出但没收到响应时，服务端可能已经收了 —— 包括超时、连接被掐、
 * 读到半个响应。说成没发出去，人就再发一次，于是同一次交代变成两条消息。真实状态是「不知道」。
 *
 * 只有「**请求还没发出去**」才是确定性失败（[notSent]）：落盘失败、本地校验没过、没入口可走。
 */
object SendCopy {
    /** 已发起 POST、结果未知。detail 只是当时的现象，不改这句话的性质。 */
    fun uncertain(excerpt: String, detail: String? = null): String {
        val why = detail?.takeIf { it.isNotBlank() }
        return if (why == null) "发送结果待确认：$excerpt" else "发送结果待确认（$why）：$excerpt"
    }

    /** 确定没发出去：请求根本没有离开这台手机。 */
    fun notSent(excerpt: String, detail: String? = null): String {
        val why = detail?.takeIf { it.isNotBlank() } ?: "请求没能发出"
        return "这条没有发出（$why）：$excerpt"
    }

    /**
     * 一次发送尝试失败时该说哪句。
     *
     * [posted] 由调用方在**真正发出 POST 之前**置位后传进来 —— 这是唯一的事实来源，
     * 不能靠异常类型猜（超时与「连接被拒」在用户眼里都是「不知道」）。
     */
    fun noteFor(excerpt: String, detail: String?, posted: Boolean): String =
        if (posted) uncertain(excerpt, detail) else notSent(excerpt, detail)

    /** 本机记录的操作：不能叫「取消发送」—— 那听起来像能撤回服务端已收到的消息。 */
    const val FORGET = "不再重试，移除本机记录"
    const val RETRY = "用原内容重试"
    const val STALE = "状态暂未同步"

    /** 盘上那份记录读坏了：一条可见提示，不静默、不覆盖。 */
    fun corruptRecord(): String = "本机的发送记录读不出来，先不动它：请把这台手机的记录导出后再继续发送"
}
