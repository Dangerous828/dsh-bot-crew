package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 收件人从正文派生、显式切换只动已识别收件人、未知 @ 原样保留，且**切换后一定路由到目标**：
 * `mentionsIn(新草稿).firstOrNull() == 目标.id`。覆盖 name / id / 多已知成员 / 目标已在列表 /
 * 未知 @ / 正文保留。
 */
class RecipientSelectionTest {

    private fun bot(id: String, name: String) = BotCard(id = id, name = name, role = "", persona = "")

    private val big = bot("big", "大哥")
    private val writer = bot("writer", "写手")
    private val coder = bot("coder", "码农")
    private val bots = listOf(big, writer, coder)

    private fun first(draft: String): String? = CrewWire.mentionsIn(draft, bots).firstOrNull()

    @Test
    fun selectIntoEmptyDraftRoutesToTarget() {
        val out = Recipient.select("", writer, bots)
        assertEquals("@写手 ", out)
        assertEquals("writer", first(out))
    }

    @Test
    fun selectKeepsBodyAndRoutesToTarget() {
        val out = Recipient.select("帮我润色这段", writer, bots)
        assertEquals("@写手 帮我润色这段", out)
        assertEquals("writer", first(out))
        assertTrue(out.contains("帮我润色这段"))
    }

    @Test
    fun switchingFromOneKnownMentionRoutesToTargetAndPreservesBody() {
        // 已 @ 大哥，改选写手：@大哥 收掉，写手排最前，正文不动，不重复。
        val out = Recipient.select("@大哥 在桌面写 ok.txt", writer, bots)
        assertEquals("@写手 在桌面写 ok.txt", out)
        assertEquals("writer", first(out))
    }

    @Test
    fun switchingWhenTargetAlreadyMentionedStillMakesTargetFirst() {
        // draft 里已有 @写手 但排在 @大哥 之后：此前实现会早退原样，mentionsIn.first 仍是大哥。
        // 现在必须让写手排最前成为第一收件人。
        val draft = "@大哥 @写手 一起做"
        val out = Recipient.select(draft, writer, bots)
        assertEquals("writer", first(out))
        assertTrue(out.contains("一起做"))
        // 不重复 @写手。
        assertEquals(1, Regex("@写手").findAll(out).count())
    }

    @Test
    fun switchingAcrossMultipleKnownMentionsOnlyTargetRemainsRecipient() {
        val draft = "@大哥 @写手 把这段发给 @码农"
        val out = Recipient.select(draft, coder, bots)
        assertEquals("coder", first(out))
        // 大哥、写手 的 @ 被收掉；码农只出现一次（排最前）。
        assertEquals(0, Regex("@大哥").findAll(out).count())
        assertEquals(0, Regex("@写手").findAll(out).count())
        assertEquals(1, Regex("@码农").findAll(out).count())
        assertTrue(out.contains("把这段发给"))
    }

    @Test
    fun unknownMentionUntouchedAndBodyKept() {
        val draft = "@大哥 把这段发给 @张三 看"
        val out = Recipient.select(draft, coder, bots)
        assertEquals("coder", first(out))
        assertTrue(out.contains("@张三"))       // 未知 @ 原样保留
        assertTrue(out.contains("把这段发给"))
        assertEquals(0, Regex("@大哥").findAll(out).count())
    }

    @Test
    fun idStyleMentionIsAlsoRecognizedAndStripped() {
        // 后端/桌面可能按 id @（如 @lead）。切换时也要认到并收掉按 id 的 @。
        val lead = bot("lead", "带头")
        val crew = listOf(lead, writer)
        val draft = "@lead 拟个提纲"
        val out = Recipient.select(draft, writer, crew)
        assertEquals("writer", CrewWire.mentionsIn(out, crew).firstOrNull())
        assertEquals(0, Regex("@lead").findAll(out).count())
        assertEquals(1, Regex("@写手").findAll(out).count())
        assertTrue(out.contains("拟个提纲"))
    }

    @Test
    fun secondaryMentionsAreNotListedAsRecipient() {
        // 展示只说实话：说"发给谁"只看第一收件人，不把后续被 @ 的成员都当接活的。
        assertEquals("大哥", Recipient.primaryRecipient("@大哥 @写手 一起", bots))
        assertEquals(null, Recipient.primaryRecipient("没点名", bots))
        // 未知 @ 不算收件人。
        assertEquals(null, Recipient.primaryRecipient("@张三 hi", bots))
    }

    @Test
    fun wordBoundaryDoesNotMisfire() {
        val a = bot("a", "a")
        val ab = bot("ab", "ab")
        val crew = listOf(a, ab)
        assertEquals(listOf("ab"), CrewWire.mentionsIn("@ab hello", crew))
        // 改选 a：@ab 收掉，@a 排最前。
        val out = Recipient.select("@ab hello", a, crew)
        assertEquals("a", CrewWire.mentionsIn(out, crew).firstOrNull())
        assertEquals(0, Regex("@ab").findAll(out).count())
    }
}
