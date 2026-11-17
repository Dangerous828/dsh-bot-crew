package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「等你决定」卡正文的解析与排版。
 *
 * 实机上那张旧卡把 `mcp_messages_send_message({...})` 整段当正文画出来：字面量 `\n`、
 * Markdown 星号、反引号、超长本地路径全裸着。这里的判据就是那次的形状：
 *
 * - 只解**认出来的那段 JSON 字面量**（JSON.parse 级别），不解全局转义 ——
 *   `%2F`、URL、JSON 之外的 `\n` 都是内容本身；
 * - 认不出、解析失败就逐字退回原行为，不猜、不用正则硬抠半个字符串；
 * - 排版（分段 / 加粗 / 行内代码 / 折叠 / 长 token 折行）全在纯函数里，可单测。
 */
class QuestionBodyTest {

    private fun ticket(question: String) = WorkTicket(
        id = "tk-body",
        title = "等一句",
        state = "person",
        botId = "lead",
        needsPerson = "answer",
        question = question,
    )

    /** 投影压回纯文本，方便断言「画出来的是这些字」。 */
    private fun flat(body: QuestionBody): String =
        body.full.joinToString("\n\n") { paragraph -> paragraph.spans.joinToString("") { it.text } }

    /**
     * 最长的一段「没有折行机会」的连续字符。
     *
     * 空白与零宽空格是机会；中文和全角标点本身就能在任意字间断行（CJK 规则），
     * 也算机会 —— 否则「十镜已…，`制作成果/…mp4`」会被误判成一整条不可断的串。
     */
    private fun longestRun(text: String): Int =
        text.split(Regex("[\\s\\u200B\\u3000-\\u303f\\u4e00-\\u9fff\\uff00-\\uffef]+"))
            .maxOfOrNull { it.length } ?: 0

    // ---- 解析：工具调用参数被塞进 question ----

    @Test
    fun aToolCallInTheMiddleOfASentenceIsDecodedOnceAndTheLiteralNewlineBecomesReal() {
        val raw =
            """要在这条对话里发一句，等你确认：mcp_messages_send_message({"channel":"main","to":"m82","text":"第一行\n第二行 50%2F 与 **重点** 和 `code`"})"""

        val decoded = ApiQuestionCopy.decode(raw)
        assertNotNull(decoded)
        val text = decoded ?: ""
        // 调用前的中文保留，人话字段接在后面。
        assertTrue(text.startsWith("要在这条对话里发一句，等你确认"))
        // 字面 \n 被 JSON 解析成真换行 —— 这是唯一合法的反转义。
        assertTrue(text.contains("第一行\n第二行"))
        assertFalse(text.contains("\\n"))
        // %2F 在 JSON 之外，是内容，不是编码。
        assertTrue(text.contains("50%2F"))
        // 工具名与参数不再出现在正文里。
        assertFalse(text.contains("mcp_messages_send_message"))
        assertFalse(text.contains("\"channel\""))

        val card = ticket(raw)
        val body = AnswerCopy.body(card)
        assertTrue(body.startsWith("要在这条对话里发一句，等你确认"))
        assertTrue(body.contains("第一行\n第二行"))

        // 星号/反引号在渲染层成为样式，不再裸着。
        val view = ApiQuestionCopy.present(raw)
        val spans = view.full.flatMap { it.spans }
        assertTrue(spans.any { it.kind == InlineKind.Bold && it.text == "重点" })
        assertTrue(spans.any { it.kind == InlineKind.Code && it.text == "code" })
        assertFalse(flat(view).contains("**"))
        assertFalse(flat(view).contains("`"))

        // 原始 question 一个字不少地留在「看详情」里。
        assertEquals(raw, AnswerCopy.details(card))
    }

    @Test
    fun aJsonWrappedInFullWidthParenthesesOrStandingAloneIsDecodedToo() {
        val wrapped = """要发这条吗？（{"text":"第一行\n第二行"}）"""
        assertEquals("要发这条吗？\n\n第一行\n第二行", ApiQuestionCopy.decode(wrapped))

        // 句首就是裸 JSON：同样取人话字段。
        assertEquals("就这一句", ApiQuestionCopy.decode("""{"message":"就这一句"}"""))

        // 数组里包着对象也认（工具参数常见形状）。
        assertEquals("就这一句", ApiQuestionCopy.decode("""[{"content":"就这一句"}]"""))
    }

    @Test
    fun jsonEscapesAreDecodedButLiteralBackslashNOutsideJsonIsNot() {
        // JSON 里的转义按 JSON.parse 解：\" → 引号，你 → 你。
        val raw = """确认一下：mcp_x({"text":"他说\"好\"你"})"""
        val decoded = ApiQuestionCopy.decode(raw) ?: ""
        assertTrue(decoded.contains("他说\"好\"你"))
        assertFalse(decoded.contains("\\\""))

        // JSON 之外的字面 \n（两个字符）是内容本身：老行为一个字都不改。
        val plain = """他说\n这里要换行吗？mcp_x({"text":"人话"})"""
        val mixed = ApiQuestionCopy.decode(plain) ?: ""
        assertTrue(mixed.startsWith("""他说\n这里要换行吗？"""))
        assertTrue(mixed.contains("人话"))

        // 完全没有人话字段又不是 JSON 的文本：原样显示，绝不反转义。
        assertEquals("""他说\n这里""", AnswerCopy.body(ticket("""他说\n这里""")))
    }

    @Test
    fun trailingWordsAfterTheCallStayInTheBody() {
        val raw = """要发这条吗？mcp_x({"text":"第一行\n第二行"})，你回一句就行"""
        val decoded = ApiQuestionCopy.decode(raw) ?: ""
        assertTrue(decoded.startsWith("要发这条吗"))
        assertTrue(decoded.contains("第一行\n第二行"))
        assertTrue(decoded.endsWith("你回一句就行"))
    }

    @Test
    fun aBodyExactlyAtTheBriefBoundaryDoesNotFold() {
        val exact = (1..QuestionBodyCopy.BRIEF_LINES).joinToString("\n") { "第 $it 行" }
        val view = QuestionBodyCopy.present(exact)
        assertFalse(view.folds)
        assertEquals(exact, flat(view))
    }

    @Test
    fun aBrokenJsonFallsBackToTheOldTitleWithoutThrowing() {
        // 半截 JSON：配不到右括号 → 不猜，退回老行为。
        val raw = """mcp_messages_send_message({"channel":"main","text":"半截"""
        assertNull(ApiQuestionCopy.decode(raw))

        val card = ticket(raw)
        assertEquals(ApiQuestionCopy.FALLBACK_TITLE, AnswerCopy.body(card))
        val view = AnswerCopy.bodyView(card)
        assertTrue(view.folds)
        assertTrue(view.fallbackTitle)
        // 正文只剩一句标题：不能再给一个点了没反应的「展开全文」，原文在「看详情」里。
        assertFalse(view.expandable)
        assertEquals(raw, AnswerCopy.details(card))
    }

    @Test
    fun jsonThatParsesButCarriesNoHumanFieldStillFoldsToATitle() {
        val raw = """{"channel":"main","to":"m82","count":3}"""
        assertNull(ApiQuestionCopy.decode(raw))
        assertEquals(ApiQuestionCopy.FALLBACK_TITLE, AnswerCopy.body(ticket(raw)))
    }

    // ---- 不解析：纯人话 ----

    @Test
    fun aPlainQuestionIsDisplayedWithoutAnyParsing() {
        val raw = "首页先改哪一块？"
        assertNull(ApiQuestionCopy.decode(raw))
        assertEquals(raw, AnswerCopy.body(ticket(raw)))

        val view = ApiQuestionCopy.present(raw)
        assertFalse(view.folds)
        assertFalse(view.fallbackTitle)
        assertEquals(raw, flat(view))
        assertTrue(view.full.single().spans.all { it.kind == InlineKind.Plain })
    }

    @Test
    fun chineseThatMerelyStartsWithABracketIsNotMistakenForJson() {
        val raw = "[紧急] 这份要不要现在发？"
        assertFalse(ApiQuestionCopy.looksStructured(raw))
        assertNull(ApiQuestionCopy.decode(raw))
        assertEquals(raw, AnswerCopy.body(ticket(raw)))
        assertNull(AnswerCopy.details(ticket(raw)))
    }

    @Test
    fun unmatchedMarkersStayLiteral() {
        val raw = "单个 * 与半个 ` 原样"
        assertEquals(raw, QuestionBodyCopy.plain(QuestionBodyCopy.paragraphs(raw)))
        assertEquals(raw, AnswerCopy.body(ticket(raw)))
    }

    // ---- 排版 ----

    @Test
    fun paragraphsAreSeparatedByBlankLinesAndKeepInnerNewlines() {
        val text = "第一段第一行\n第一段第二行\n\n第二段"
        val view = QuestionBodyCopy.present(text)
        assertEquals(2, view.full.size)
        assertEquals("第一段第一行\n第一段第二行", view.full[0].text)
        assertEquals("第二段", view.full[1].text)
        assertFalse(view.folds)
    }

    @Test
    fun aLongBodyFoldsToTheFirstLinesAndExpandsToEverything() {
        val long = (1..10).joinToString("\n") { "第 $it 行" }
        val view = QuestionBodyCopy.present(long)
        assertTrue(view.folds)
        // 真被截短了才有「展开全文」可点。
        assertTrue(view.expandable)
        assertEquals(QuestionBodyCopy.BRIEF_LINES, QuestionBodyCopy.lineCount(view.brief))
        assertEquals(10, QuestionBodyCopy.lineCount(view.full))
        assertTrue(view.full.single().text.endsWith("第 10 行"))
    }

    @Test
    fun aSingleParagraphWithNoNewlinesStillFoldsByLength() {
        // 一整块没有换行的长文按行算只有「一行」：只按行折叠的话它会整段铺满卡片。
        val wall = "就这一句" + "很长".repeat(400)
        val view = QuestionBodyCopy.present(wall)
        assertTrue(view.folds)
        assertTrue(QuestionBodyCopy.plain(view.brief).length <= QuestionBodyCopy.BRIEF_CHARS)
        // 展开后一个字都不少。
        assertEquals(wall, QuestionBodyCopy.plain(view.full))

        // 短正文不受字数闸影响：实机那张 438 字的卡仍按行判定，不折。
        val short = "第一段\n\n第二段"
        assertFalse(QuestionBodyCopy.present(short).folds)
    }

    @Test
    fun aVeryLongPathWrapsInsteadOfStretchingTheCard() {
        val path = "/Users/cpuser/Code/dsh-bot-crew/app/app/src/main/java/com/dsh/botcrew/CrewUi.kt"
        val view = ApiQuestionCopy.present("要改的是 $path 这一处")
        val text = flat(view)
        // 内容没变：去掉零宽空格仍是原来的路径。
        assertTrue(text.replace("\u200B", "").contains(path))
        assertTrue(longestRun(text) <= QuestionBodyCopy.TOKEN_RUN)
        // 零宽空格只是渲染辅助：纯文本投影（摘要、比较、通知）里不留。
        assertFalse(AnswerCopy.body(ticket("要改的是 $path 这一处")).contains("\u200B"))
        assertFalse(AnswerCopy.compact(ticket("要改的是 $path 这一处")).contains("\u200B"))

        // 连断点都没有的长串也要能被切开。
        val blob = "a".repeat(120)
        assertTrue(longestRun(QuestionBodyCopy.soften(blob)) <= QuestionBodyCopy.TOKEN_RUN)
    }

    @Test
    fun aDecodedBodyLongerThanTheBriefFolds() {
        val raw = """要确认：mcp_x({"text":"${(1..10).joinToString("\\n") { "第 $it 行" }}"})"""
        val view = ApiQuestionCopy.present(raw)
        assertTrue(view.folds)
        assertTrue(flat(view).startsWith("要确认"))
        assertFalse(flat(view).contains("mcp_x"))
    }

    @Test
    fun theRealCardPreviewRendersAsParagraphsWithStyles() {
        // 实机卡面原文（节选）：空行分段、单换行留在段内、**加粗**、`行内代码`、长路径。
        val preview = """
            视频这边在做的就一集：咕嘎加滚滚 EP005（`/Users/cpuser/Code/kTool/video-remake/咕嘎加滚滚/剧集/EP005`）。

            - EP005：v3 十镜已**全部出片**，`制作成果/视频/EP005-001…010.mp4` 22:00 取回。
            - EP004《圆圆的一天》：**声音 6/6 不合格**，三条路还需你拍板。

            本机当前没在跑渲染，出片都在 win-desktop 那台跑。
        """.trimIndent()

        val view = QuestionBodyCopy.present(preview)
        // 4 行，不到 BRIEF_LINES：这张实机卡不该出现「展开全文」。
        assertEquals(4, QuestionBodyCopy.lineCount(view.full))
        assertFalse(view.folds)
        assertEquals(3, view.full.size)
        assertEquals(2, view.full[1].text.lines().size)
        val spans = view.full.flatMap { it.spans }
        assertTrue(spans.any { it.kind == InlineKind.Bold && it.text == "全部出片" })
        // 代码片段里的零宽空格只是折行点：去掉之后仍是那条路径。
        assertTrue(
            spans.any {
                it.kind == InlineKind.Code &&
                    it.text.replace("\u200B", "") == "/Users/cpuser/Code/kTool/video-remake/咕嘎加滚滚/剧集/EP005"
            },
        )
        assertFalse(flat(view).contains("**"))
        assertTrue(longestRun(flat(view)) <= QuestionBodyCopy.TOKEN_RUN)

        // 同样的文本挂到 approval.preview 上：正文逐字取 preview 的排版，原文仍进详情。
        val card = WorkTicket(
            id = "tk-real", title = "t", state = "person", botId = "lead", needsPerson = "answer",
            question = "做一次外部改动",
            attentionId = "a-real",
            approval = TicketApproval(kind = "connection", action = "做一次外部改动", preview = preview),
        )
        assertEquals(preview, AnswerCopy.body(card))
        assertFalse(AnswerCopy.bodyView(card).folds)

        // 同一形态长到超过 BRIEF_LINES 才折：阈值只管行数，不管来源。
        val longer = WorkTicket(
            id = "tk-real-long", title = "t", state = "person", botId = "lead", needsPerson = "answer",
            question = "做一次外部改动",
            attentionId = "a-real-long",
            approval = TicketApproval(
                kind = "connection", action = "做一次外部改动",
                preview = preview + "\n\n" + preview,
            ),
        )
        val long = AnswerCopy.bodyView(longer)
        assertTrue(long.folds)
        assertEquals(QuestionBodyCopy.BRIEF_LINES, QuestionBodyCopy.lineCount(long.brief))
        assertEquals(8, QuestionBodyCopy.lineCount(long.full))
    }

    // ---- 既有约定：preview 优先 ----

    @Test
    fun aPreviewOnTheApprovalBeatsEveryNewRule() {
        val raw = """mcp_messages_send_message({"text":"不该出现的内容"})"""
        val preview = "第一行\n第二行 50%2F 原样"
        val card = WorkTicket(
            id = "tk-preview",
            title = "t",
            state = "person",
            botId = "lead",
            needsPerson = "answer",
            question = raw,
            attentionId = "a-preview",
            approval = TicketApproval(kind = "connection", action = "发送消息", preview = preview),
        )

        // 正文逐字取 preview：不做工具调用解析、不二次解码。
        assertEquals(preview, AnswerCopy.body(card))
        assertEquals(preview, flat(AnswerCopy.bodyView(card)))
        assertFalse(flat(AnswerCopy.bodyView(card)).contains("不该出现"))
        // 原文仍在详情里，没有被 preview 顶掉。
        assertEquals(raw, AnswerCopy.details(card))
        assertEquals("发送消息", AnswerCopy.actionLine(card))
    }

    // ---- 列表里的一行摘要 ----

    @Test
    fun theCompactRowIsOneReadableLine() {
        val raw = """要发吗：mcp_x({"text":"第一行\n第二行"})"""
        val line = AnswerCopy.compact(ticket(raw))
        assertFalse(line.contains("\n"))
        assertFalse(line.contains("{"))
        assertTrue(line.startsWith("要发吗"))

        // 列表里没有样式可落：Markdown 记号与零宽空格都不能出现在这一行里。
        val styled = WorkTicket(
            id = "tk-compact", title = "t", state = "person", botId = "lead", needsPerson = "answer",
            question = "做一次外部改动",
            attentionId = "a-compact",
            approval = TicketApproval(
                kind = "connection", action = "做一次外部改动",
                preview = "十镜已**全部出片**，`制作成果/EP005.mp4` 取回",
            ),
        )
        val styledLine = AnswerCopy.compact(styled)
        assertFalse(styledLine.contains("**"))
        assertFalse(styledLine.contains("`"))
        assertFalse(styledLine.contains("\u200B"))
        assertTrue(styledLine.contains("全部出片"))

        // 空 question 的旧卡仍只说「为什么在等」，不补一个空问题。
        val waiting = WorkTicket(
            id = "tk-wait", title = "t", state = "person", botId = "lead", needsPerson = "review",
        )
        assertEquals(AnswerCopy.waitingWord("review"), AnswerCopy.compact(waiting))
    }
}
