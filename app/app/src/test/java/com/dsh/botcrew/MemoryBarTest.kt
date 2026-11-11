package com.dsh.botcrew

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 记忆契约：`GET/POST /api/mobile/memory`。
 *
 * 钉住三件事：三态不混（读不到 ≠ 没有）、坏行只丢那一条、忘掉的条目不消失（不删行）。
 */
class MemoryBarTest {

    private val live = """
        {
          "state": "live",
          "items": [
            {"name": "bot-lead-report-style", "bot_id": "lead", "description": "先说结论",
             "body": "他习惯先看 error 数量。\n\n次段不该出现在卡片上。", "type": "feedback",
             "importance": 5, "state": "active", "created": 1794000000, "updated": 1794000000,
             "origin": "person:owner", "to_hub": false},
            {"name": "bot-lead-old", "bot_id": "lead", "description": "旧的写法",
             "body": "已经忘掉的那条。", "type": "project", "importance": 2, "state": "forgotten",
             "created": 1793000000, "updated": 1793000000, "origin": "ticket:t1", "to_hub": false},
            {"name": "broken", "body": "   "}
          ],
          "counts": {"active": 1, "forgotten": 1, "superseded": 0}
        }
    """.trimIndent()

    @Test
    fun `reads items and skips a row it cannot recognise`() {
        val view = MemoryWire.parse(live)
        assertEquals(2, view.items.size)
        assertTrue(view.live)
        assertEquals("bot-lead-report-style", view.items[0].name)
        assertEquals("lead", view.items[0].botId)
        assertTrue(view.items[0].active)
        assertFalse(view.items[1].active)
    }

    @Test
    fun `counts come from the backend, not recounted on this side`() {
        val view = MemoryWire.parse(live)
        assertEquals(1, view.counts.active)
        assertEquals(1, view.counts.forgotten)
        assertEquals(0, view.counts.superseded)
    }

    @Test
    fun `an answer without state falls to unavailable, never to empty`() {
        // 说「读不到」是实话；缺字段读成「没有」就是替队伍编一句话。
        assertEquals("unavailable", MemoryWire.parse("""{"items": []}""").state)
        assertFalse(MemoryWire.parse("""{"items": []}""").live)
    }

    @Test
    fun `an explicit empty state is not treated as live`() {
        val view = MemoryWire.parse("""{"state": "empty", "items": [], "counts": {"active": 0, "forgotten": 0, "superseded": 0}}""")
        assertFalse(view.live)
        assertEquals("empty", view.state)
    }

    @Test
    fun `a row without a state defaults to active`() {
        val view = MemoryWire.parse("""{"state": "live", "items": [{"name": "n", "body": "b"}]}""")
        assertTrue(view.items[0].active)
    }

    @Test
    fun `title falls back to the first line of the body`() {
        val view = MemoryWire.parse(live)
        assertEquals("先说结论", MemoryCopy.title(view.items[0]))
        val untitled = MemoryWire.parse("""{"state": "live", "items": [{"name": "n", "body": "第一句\n第二句"}]}""")
        assertEquals("第一句", MemoryCopy.title(untitled.items[0]))
    }

    @Test
    fun `detail names who remembers it and where it came from`() {
        val view = MemoryWire.parse(live)
        assertTrue(MemoryCopy.detail(view.items[0]).startsWith("lead 你说的"))
        assertTrue(MemoryCopy.detail(view.items[1]).contains("工单结论"))
        assertEquals("1 月 1 日", MemoryCopy.date(1767225600))
        // 没有时间就不给日期，不写 1970。
        assertEquals("", MemoryCopy.date(0))
    }

    @Test
    fun `summary counts what is alive, forgotten and replaced`() {
        assertEquals("记得 1 条 · 忘掉 1", MemoryCopy.summary(MemoryWire.parse(live)))
        assertEquals("记得 3 条", MemoryCopy.summary(MemoryWire.parse("""{"state": "live", "items": [],
            "counts": {"active": 3, "forgotten": 0, "superseded": 0}}""")))
    }

    @Test
    fun `forget and edit bodies carry the action and the name`() {
        val forget = JSONObject(MemoryWire.forgetBody("bot-lead-x"))
        assertEquals("forget", forget.getString("action"))
        assertEquals("bot-lead-x", forget.getString("name"))
        val edit = JSONObject(MemoryWire.editBody("bot-lead-x", "新标题", "新正文"))
        assertEquals("edit", edit.getString("action"))
        assertEquals("新标题", edit.getString("description"))
        assertEquals("新正文", edit.getString("body"))
    }
}
