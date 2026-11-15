package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 设备接收链（#23）在 App 侧的两条纯逻辑：
 * 1. `NoticesWire.parse` —— 后端回的那份怎么读；
 * 2. `NoticeRecord` —— 落本地那份怎么去重、有界、幂等。
 *
 * 真机持久化（SharedPreferences 的 commit）在 `NoticeStore` 包里，读写在 `NoticeRecord`；
 * 这里钉的是「去重 / 幂等 / 有界 / 坏值不崩」这几处真正会出错的地方，无需 Context。
 */
class NoticeRecordTest {

    private fun notice(id: String, body: String = "b-$id") =
        CrewNotice(id = id, title = "t", body = body, kind = "followup", at = "2026-11-14T21:00:00.000Z")

    @Test
    fun parsesThePeekResponse() {
        val view = NoticesWire.parse(
            """{"device":"d021","items":[{"id":"a","title":"有事","body":"等你","kind":"followup"}],"counts":{"pending":1,"seen":0}}""",
        )
        assertTrue(view.available)
        assertEquals(1, view.pending)
        assertEquals(1, view.items.size)
        assertEquals("a", view.items[0].id)
        assertEquals("等你", view.items[0].body)
    }

    @Test
    fun unavailableHostIsNotTheSameAsNoNotices() {
        val view = NoticesWire.parse("""{"items":[],"counts":{"pending":0,"seen":0},"state":"unavailable","reason":"后端还没有接入设备接收链"}""")
        assertEquals(false, view.available)
    }

    @Test
    fun dropsItemsWithoutAStableId() {
        // 没有稳定 id 的条目没法去重、也没法 ACK，留着只会让前后端对不上账。
        val view = NoticesWire.parse("""{"items":[{"body":"没有id"},{"id":"ok","body":"有id"}],"counts":{"pending":1,"seen":0}}""")
        assertEquals(listOf("ok"), view.items.map { it.id })
    }

    @Test
    fun mergeDedupesAndReportsOnlyNewIds() {
        val first = NoticeRecord.merge(emptyMap<String, Any?>(), listOf(notice("a"), notice("b")))
        assertEquals(listOf("a", "b"), first.second)
        // 同一条再来一次：不新增、不重复显示（重试不重复）。
        val again = NoticeRecord.merge(mapOf(NoticeRecord.NOTICES to first.first), listOf(notice("a"), notice("b")))
        assertEquals(emptyList<String>(), again.second)
        // 掺一条新的：只报这一条。
        val more = NoticeRecord.merge(mapOf(NoticeRecord.NOTICES to first.first), listOf(notice("a"), notice("c")))
        assertEquals(listOf("c"), more.second)
        // 读回来是 a, b, c（新的在前 → a 之后插 c，顺序按 added+have 去重）。
        val ids = NoticeRecord.read(mapOf(NoticeRecord.NOTICES to more.first)).map { it.id }
        assertEquals(setOf("a", "b", "c"), ids.toSet())
    }

    @Test
    fun newestFirstThenBounded() {
        var values: Map<String, *> = emptyMap<String, Any?>()
        for (index in 0 until NoticeRecord.CAP + 20) {
            values = mapOf(NoticeRecord.NOTICES to NoticeRecord.merge(values, listOf(notice("id$index"))).first)
        }
        val kept = NoticeRecord.read(values)
        assertEquals(NoticeRecord.CAP, kept.size)
        // 最新的那条一定还在最前；最旧的尾巴被截掉。
        assertEquals("id${NoticeRecord.CAP + 19}", kept.first().id)
        assertTrue(kept.none { it.id == "id0" })
    }

    @Test
    fun aBrokenValueReadsAsEmptyAndDoesNotThrow() {
        assertEquals(emptyList<CrewNotice>(), NoticeRecord.read(mapOf(NoticeRecord.NOTICES to "not json")))
        assertEquals(emptyList<CrewNotice>(), NoticeRecord.read(emptyMap<String, Any?>()))
    }

    @Test
    fun bodyWithoutTextIsDroppedOnParse() {
        // 空正文的推送没有意义，解析层直接丢（与后端 deliver 拒空 body 同一条口径）。
        val view = NoticesWire.parse("""{"items":[{"id":"a","body":""}],"counts":{"pending":0,"seen":0}}""")
        assertEquals(emptyList<CrewNotice>(), view.items)
    }
}
