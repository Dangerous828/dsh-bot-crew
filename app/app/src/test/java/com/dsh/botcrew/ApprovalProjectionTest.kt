package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 审批卡的人读投影（契约 `tasks[].approval`）。
 *
 * 判据围绕实机上那个真 bug：卡里直接把 `mcp_messages_send_message({...})` 画成正文，
 * 字面量 `\n`、Markdown 星号、被截断的 JSON 全在屏幕上。
 *
 * 三条不能破的底线：
 * - `preview` 是字段解码后的真实正文，**不再做任何反转义**（用户原文含 `%2F`、URL、`\n` 要原样）；
 * - 全部字段可选：老后端没有 approval 时逐字退回原行为；
 * - 细节默认折叠，正文只放人读的预览。
 */
class ApprovalProjectionTest {

    private fun timeline(task: String): Conversation = CrewWire.parseTimeline(
        """{"items":[],"bots":[],"tasks":[$task]}""",
    )

    @Test
    fun theApprovalFieldsProjectTheCardWithoutTouchingTheText() {
        val conversation = timeline(
            """
            {"id":"tk1","title":"给 main 发一条消息","state":"person","needs_person":"answer",
             "bot_id":"lead","attention_id":"a-1",
             "question":"要往当前对话发一条消息，等你确认",
             "approval":{"kind":"connection","action":"发送消息","target":"当前对话",
                         "preview":"第一行\n第二行 50%2F 与 C:\\tmp\\a 的 \\n 原样保留",
                         "details":"mcp_messages_send_message"},
             "options":[{"id":"go","label":"发送这一次"},{"id":"stop","label":"取消此次操作"}]}
            """.trimIndent(),
        )
        val ticket = conversation.tickets.single()
        val approval = ticket.approval!!
        assertEquals("connection", approval.kind)
        assertEquals("发送消息", approval.action)
        assertEquals("当前对话", approval.target)
        // 真实换行留着；%2F 与字面量 \n 都不许被二次解码/反转义。
        assertEquals("第一行\n第二行 50%2F 与 C:\\tmp\\a 的 \\n 原样保留", approval.preview)
        assertEquals("mcp_messages_send_message", approval.details)
        // 卡片正文用 preview，不是 question、更不是 stringify(args)。
        assertEquals(approval.preview, AnswerCopy.body(ticket))
        assertEquals("发送消息 · 当前对话", AnswerCopy.actionLine(ticket))
        // 两个选项原样读出来（中文 label 由后端给，客户端不翻译、不猜）。
        assertEquals(listOf("发送这一次", "取消此次操作"), ticket.options.map { it.label })
    }

    @Test
    fun anOldBackendWithoutApprovalBehavesExactlyAsBefore() {
        val conversation = timeline(
            """
            {"id":"tk2","title":"旧卡","state":"person","needs_person":"answer","bot_id":"lead",
             "question":"这份要不要现在就发？",
             "options":[{"id":"a","label":"发"},{"id":"b","label":"先别发"}]}
            """.trimIndent(),
        )
        val ticket = conversation.tickets.single()
        assertNull(ticket.approval)
        assertEquals("这份要不要现在就发？", AnswerCopy.body(ticket))
        assertNull(AnswerCopy.actionLine(ticket))
        // 没有 approval 时 details 只有「question 比正文多出东西」才给，这里相等 → 不画。
        assertNull(AnswerCopy.details(ticket))
    }

    @Test
    fun aJsonShapedQuestionIsFoldedInsteadOfPastedIntoTheCard() {
        val raw = "mcp_messages_send_message({\"channel\":\"main\",\"to\":\"m82\",\"text\":\"第一行\\n第二行\"})"
        val conversation = timeline(
            """
            {"id":"tk3","title":"工具卡","state":"person","needs_person":"answer","bot_id":"lead",
             "question":${org.json.JSONObject.quote(raw)},"attention_id":"a-3",
             "options":[{"id":"a","label":"做吧"},{"id":"b","label":"先别做"}]}
            """.trimIndent(),
        )
        val ticket = conversation.tickets.single()
        assertTrue(ApiQuestionCopy.looksStructured(ticket.question))
        assertTrue(ApiQuestionCopy.folds(ticket.question))
        // 正文换成一句人话，原文进折叠。
        assertEquals("这条要你确认（原文已折叠，展开可看）", AnswerCopy.body(ticket))
        assertEquals(ticket.question, AnswerCopy.details(ticket))
    }

    @Test
    fun aLongPlainQuestionKeepsItsFirstLinesAndFoldsTheRest() {
        val long = (1..12).joinToString("\n") { "第 $it 行说明" }
        val head = ApiQuestionCopy.headline(long)
        assertTrue(head.startsWith("第 1 行说明"))
        assertEquals(ApiQuestionCopy.HEADLINE_LINES + 1, head.lines().size) // 末尾一个「…」
        assertTrue(head.endsWith("…"))
        assertTrue(ApiQuestionCopy.folds(long))
        // 短句保持原样，一个字符都不动。
        assertEquals("发不发？\n（这条很短）", ApiQuestionCopy.headline("发不发？\n（这条很短）"))
        assertFalse(ApiQuestionCopy.folds("发不发？"))
    }

    @Test
    fun theCancelConsequenceIsDifferentForAConnectionAndForATask() {
        assertEquals("只拒绝这一次操作，这张任务还会继续", AnswerCopy.cancelConsequence("connection"))
        assertEquals("会结束这张任务", AnswerCopy.cancelConsequence("task"))
    }

    @Test
    fun approvalIsPartOfTheAnswerSignatureSoALateAnswerCannotLandOnANewCard() {
        val one = timeline(
            """{"id":"tk4","title":"t","state":"person","needs_person":"answer","bot_id":"lead",
                "attention_id":"a-4","approval":{"kind":"connection","action":"发送消息","preview":"第一版"},
                "options":[{"id":"go","label":"发送这一次"},{"id":"stop","label":"取消此次操作"}]}""",
        ).tickets.single()
        val two = timeline(
            """{"id":"tk4","title":"t","state":"person","needs_person":"answer","bot_id":"lead",
                "attention_id":"a-4","approval":{"kind":"connection","action":"发送消息","preview":"第二版"},
                "options":[{"id":"go","label":"发送这一次"},{"id":"stop","label":"取消此次操作"}]}""",
        ).tickets.single()
        assertFalse(CrewWire.answerSignature(one) == CrewWire.answerSignature(two))
    }

    @Test
    fun aCardWithApprovalButNoQuestionStillKeepsItsOptions() {
        val ticket = timeline(
            """{"id":"tk5","title":"t","state":"person","needs_person":"answer","bot_id":"lead",
                "attention_id":"a-5","approval":{"kind":"connection","action":"发送消息","preview":"正文"},
                "options":[{"id":"go","label":"发送这一次"},{"id":"stop","label":"取消此次操作"}]}""",
        ).tickets.single()
        assertEquals(2, ticket.options.size)
        assertEquals("正文", AnswerCopy.body(ticket))
    }
}
