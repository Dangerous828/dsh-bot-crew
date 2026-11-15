package com.dsh.botcrew

import android.content.Context
import org.json.JSONArray

/**
 * 设备收到的推送的**纯函数层**：怎么从盘上那份 `Map` 读出来、怎么并入新条目、怎么去重与截断。
 *
 * 与 [PermissionRecord] 一样，判据放在没有 Context 的纯函数里，才好被 JVM 单测钉住；
 * 读写盘由 [NoticeStore] 包一层。这样「去重 / 有界 / 幂等」这些真正会出错的地方能脱离真机测。
 */
object NoticeRecord {
    /** 盘上唯一的键：一条 JSON 数组，元素 `{id,title,body,kind,at,sessionId}`。 */
    const val NOTICES = "persisted"
    /** 本地最多留多少条：够覆盖一次离线窗口，又不会把盘撑大。与后端每设备上限同量级。 */
    const val CAP = 100

    /** 盘上那份 map → 已持久化条目（最新在前）。缺键 / 坏值一律当空，不因一次读坏卡住启动。 */
    fun read(values: Map<String, *>): List<CrewNotice> {
        val raw = values[NOTICES] as? String ?: return emptyList()
        return try {
            val array = JSONArray(raw)
            (0 until array.length()).mapNotNull { index ->
                val row = array.optJSONObject(index) ?: return@mapNotNull null
                val id = row.optString("id").takeIf(String::isNotBlank) ?: return@mapNotNull null
                val body = row.optString("body").takeIf(String::isNotBlank) ?: return@mapNotNull null
                CrewNotice(id, row.optString("title"), body, row.optString("kind"), row.optString("at"), row.optString("sessionId"))
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    /**
     * 并入新拉到的条目，返回 `(要写回的值, 本次真正新增的 id)`。
     *
     * - 按稳定 id 去重：同一条再来一次不新增、也不重复显示（重试不重复）。
     * - 新增的排在最前，整表按 [CAP] 截断（丢最旧的尾巴），盘不会无界长。
     * - 新增 id 只含**本次第一次见到**的：ACK 只报这些，已在本地的不必再删一遍。
     */
    fun merge(values: Map<String, *>, fresh: List<CrewNotice>): Pair<String, List<String>> {
        if (fresh.isEmpty()) return (values[NOTICES] as? String ?: "") to emptyList()
        val have = read(values)
        val known = have.mapTo(HashSet()) { it.id }
        val added = fresh.filter { it.id !in known }
        if (added.isEmpty()) return (values[NOTICES] as? String ?: "") to emptyList()
        val next = (added + have).distinctBy { it.id }.take(CAP)
        val array = JSONArray()
        for (notice in next) {
            array.put(org.json.JSONObject().apply {
                put("id", notice.id); put("title", notice.title); put("body", notice.body)
                put("kind", notice.kind); put("at", notice.at); put("sessionId", notice.sessionId)
            })
        }
        return array.toString() to added.map { it.id }
    }
}

/**
 * 设备收到的推送，落在应用私有存储里（SharedPreferences）。
 *
 * 为什么不用 `rememberSaveable`：那只是「配置变更/进程被系统回收」这一档的存活，**force-stop
 * 与冷启动后不保证**。#23 要求的是一条真的不丢件的接收链：拉到的每条先进这里落盘，落盘成功
 * 才算「设备已持久收到」，**落盘成功之后**才向后端 ACK（只删这些 id）。这一层就是那个「落盘」。
 *
 * 判据在 [NoticeRecord]（纯函数、可单测）；这里只负责把它接到盘上。写盘用 `commit()` 而不是
 * `apply()`：ACK 建立在这个返回值上，必须确认真的写下去了 —— 异步「可能还没落盘就先 ACK」正是要
 * 避免的那种丢件。这里记的是 **device-persisted**，不是「人眼读过」；真实人眼阅读另证。
 */
class NoticeStore(context: Context) {
    private val store = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** 本地已持久化的条目，最新的在前。 */
    fun all(): List<CrewNotice> = NoticeRecord.read(store.all)

    /**
     * 把新拉到的条目并进本地。返回**本次真正新增**的 id（只有这些需要 ACK）。先 commit 落盘，
     * 成功才返回这组 id —— 调用方据此 ACK，落盘没成就不 ACK。
     */
    fun merge(fresh: List<CrewNotice>): List<String> {
        val (value, added) = NoticeRecord.merge(store.all, fresh)
        if (added.isEmpty()) return emptyList()
        val wrote = store.edit().putString(NoticeRecord.NOTICES, value).commit()
        return if (wrote) added else emptyList()
    }

    /** 本地已持久化过的全部 id（用于 ACK 与 seen 账）。 */
    fun ids(): List<String> = all().map { it.id }

    private companion object {
        const val PREFS = "crew-notices"
    }
}
