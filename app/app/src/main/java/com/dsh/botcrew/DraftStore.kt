package com.dsh.botcrew

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * 一个会话的草稿：正文 + 收件人 + 最后改动时间。
 *
 * 收件人事実上是从正文里的 @ 派生的（[Recipient]），这里把它一起存下来的理由只有一个：
 * 冷启动时花名册还没拉回来，正文里那个 `@林` 认不出是谁，输入区仍要说得清「发给谁」。
 * 它是**快照**，不是第二份真源 —— 花名册回来后仍以 [CrewWire.mentionsIn] 的实算为准。
 */
data class Draft(val sessionKey: String, val text: String, val recipientId: String = "", val at: Long = 0L)

/**
 * 草稿的纯函数层：盘上那份 `Map` ↔ [Draft] 列表。
 *
 * 与 [NoticeRecord] / [PermissionRecord] 同一条规矩：判据放在没有 Context 的纯函数里才好被 JVM 单测钉住，
 * 读写盘由 [DraftStore] 包一层。
 *
 * **不设任意会话数上限**：没发出去的字是用户输入，不是可被淘汰的缓存。空草稿（用户自己删光）不写盘。
 *
 * **读坏不覆盖**：解析失败时 [read] 给出 [RecordState.CORRUPT]，[put]/[remove] 一律拒绝写回，
 * 原串原样留在盘上等人看。把损坏当成空再 put 回去，正好会把还没发出去的字抹掉。
 */
object DraftRecord {
    /** 盘上唯一的键：一个 JSON 数组，元素 `{s,t,r,at}`。 */
    const val DRAFTS = "drafts"

    fun read(values: Map<String, *>): RecordRead<Draft> =
        recordRead(values[DRAFTS] as? String) { raw -> decode(raw) }

    /** 写一格。@return `null` 表示盘上那份已经坏了 —— 调用方不得覆盖，并要给出可见提示。 */
    fun put(values: Map<String, *>, draft: Draft): String? {
        val current = read(values)
        if (current.corrupt) return null
        // 用户把字删光是明确的清空；不是「丢了一条未发内容」。
        if (draft.text.isEmpty()) return encode(current.items.filter { it.sessionKey != draft.sessionKey })
        val kept = current.items.filter { it.sessionKey != draft.sessionKey }
        return encode(kept + draft)
    }

    /** 明确发送成功：只清那一版正文（用户之后又打的新字不动）。损坏时不动盘。 */
    fun clearIfText(values: Map<String, *>, sessionKey: String, text: String): String? {
        val current = read(values)
        if (current.corrupt) return null
        val here = current.items.firstOrNull { it.sessionKey == sessionKey }
        if (here != null && here.text != text) return encode(current.items)
        return encode(current.items.filter { it.sessionKey != sessionKey })
    }

    private fun decode(raw: String): List<Draft> {
        val array = JSONArray(raw)
        val rows = mutableListOf<Draft>()
        for (index in 0 until array.length()) {
            val row = array.optJSONObject(index) ?: continue
            val session = row.optString("s").trim()
            if (!SessionRoute.validId(session)) continue
            val text = row.optString("t")
            if (text.isEmpty()) continue
            rows.add(Draft(session, text, row.optString("r"), row.optLong("at", 0L)))
        }
        return rows
    }

    private fun encode(drafts: List<Draft>): String {
        val array = JSONArray()
        for (draft in drafts.sortedBy { it.at }) {
            array.put(JSONObject().apply {
                put("s", draft.sessionKey)
                put("t", draft.text)
                if (draft.recipientId.isNotEmpty()) put("r", draft.recipientId)
                if (draft.at > 0L) put("at", draft.at)
            })
        }
        return array.toString()
    }
}

/**
 * 草稿落盘。按 crew 命名空间隔离（见 [CrewNamespace]），会话之间互不影响。
 *
 * 与 `crew-pairing` / `crew-notices` / `ota` 都不同文件：`PairingStore.save()` 会 clear 整个
 * `crew-pairing` 文件（不看键名），草稿住那儿会被一次 mDNS 广播抹掉。
 */
class DraftStore(context: Context, paired: PairedCrew?) {
    private val store = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val identity: String = CrewNamespace.key(paired)

    init {
        // 身份从 `o:…`（首次还没指纹）变成 `c:…` 时把旧格搬过来，只搬一次。不丢未发内容。
        if (CrewNamespace.adopt(context, PREFS, identity)) Unit
    }

    private val key: String = "$identity|${DraftRecord.DRAFTS}"

    fun snapshot(): RecordRead<Draft> =
        DraftRecord.read(mapOf<String, String>(DraftRecord.DRAFTS to store.getString(key, "").orEmpty()))

    fun all(): List<Draft> = snapshot().items

    fun of(sessionKey: String): Draft? = all().firstOrNull { it.sessionKey == sessionKey }

    /** @return 写下去了没有。false = 盘上那份已损坏，未覆盖。 */
    fun save(draft: Draft): Boolean {
        val next = DraftRecord.put(mapOf(DraftRecord.DRAFTS to store.getString(key, "")), draft) ?: return false
        store.edit().putString(key, next).apply()
        return true
    }

    /** 明确发送成功：只清那一版正文。@return 清下去了没有（损坏时 false）。 */
    fun clearIfText(sessionKey: String, text: String): Boolean {
        val next = DraftRecord.clearIfText(mapOf(DraftRecord.DRAFTS to store.getString(key, "")), sessionKey, text)
            ?: return false
        store.edit().putString(key, next).apply()
        return true
    }

    /**
     * 「重新配对」**不**调这一格：那个入口的意思是换台电脑/重连，不是删还没发出去的字。
     * 命名空间按 crew 隔离，同一台电脑重配之后草稿原样回来；换一台是另一格，互不干扰。
     */
    internal fun clearForTests() {
        store.edit().remove(key).apply()
    }

    private companion object {
        /** 与 `CrewNamespace.adopt` 传的名字必须一致。 */
        const val PREFS = "crew-drafts"
    }
}
