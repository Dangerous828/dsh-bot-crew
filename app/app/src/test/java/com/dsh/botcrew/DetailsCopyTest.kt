package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「看详情」那块原文的排版规则：分节 + 限高，但**内容一个字不改**。
 *
 * 实机上它是一整块 2000 字直接铺进卡片，和正文同字号同色，从 y=1903 压到卡片底部。
 * 这里钉住：分节只吃掉那个空行，别的字符（字面 `\n`、JSON、路径、全角括号）逐字保留。
 */
class DetailsCopyTest {

    @Test
    fun realBlankLinesSplitSections() {
        val sections = DetailsCopy.sections("第一段\n继续\n\n第二段\n\n\n第三段")
        assertEquals(listOf("第一段\n继续", "第二段", "第三段"), sections)
    }

    @Test
    fun escapedBlankLinesAlsoSplitSections() {
        // 实机那块原文就是这种形状：换行被转义成字面 `\n`，空行于是是 `\n\n`（反斜杠+n 连写两遍）。
        val raw = "to：m82\\n\\n这条审批原样记录：\\n要通过消息做改动（send_message），先问你一声。"
        assertEquals(
            listOf("to：m82", "这条审批原样记录：\\n要通过消息做改动（send_message），先问你一声。"),
            DetailsCopy.sections(raw),
        )
    }

    @Test
    fun oneLongBlockStaysOneSectionAndKeepsEveryCharacter() {
        // 没有空行的 2000 字就是一节：靠 MAX_HEIGHT_DP 那道上限不让它撑爆卡片，不靠删字。
        val wall = (1..2000).joinToString("") { ('a' + (it % 26)).toString() }
        val sections = DetailsCopy.sections(wall)
        assertEquals(1, sections.size)
        assertEquals(wall, sections.single())
        assertEquals(2000, sections.single().length)
    }

    @Test
    fun contentIsVerbatimApartFromTheSeparators() {
        val raw = "mcp__messages__send_message({\"channel\":\"main\",\"to\":\"m82\"})\\n\\n" +
            "路径 /Users/cpuser/Code/kTool 与 %2F 字面、`代码`、全角（）都不许动"
        val sections = DetailsCopy.sections(raw)
        assertEquals(2, sections.size)
        // 字面 \n 留在节内（没有被反转义成真换行）；%2F、反引号、全角括号都在。
        assertTrue(sections[1].contains("/Users/cpuser/Code/kTool"))
        assertTrue(sections[1].contains("%2F"))
        assertTrue(sections[1].contains("`代码`"))
        assertTrue(sections[1].contains("全角（）"))
        assertEquals(
            "mcp__messages__send_message({\"channel\":\"main\",\"to\":\"m82\"})",
            sections[0],
        )
        // 除了那个**分节用的空行**，别的一个字不少：两节拼回去 = 原文挖掉那个分隔符。
        assertEquals(raw.replace("\\n\\n", ""), sections.joinToString(""))
    }

    @Test
    fun leadingIndentationInsideASectionIsKept() {
        val sections = DetailsCopy.sections("标题\n\n    缩进的代码行\n    第二行")
        assertEquals(listOf("标题", "    缩进的代码行\n    第二行"), sections)
    }

    @Test
    fun blankTextHasNoSections() {
        assertEquals(emptyList<String>(), DetailsCopy.sections(""))
        assertEquals(emptyList<String>(), DetailsCopy.sections("   \n\n  "))
    }

    @Test
    fun heightCapIsBounded() {
        // 限高必须是个有限值：0 会让整块看不见，太大就等于没有上限。
        assertTrue(DetailsCopy.MAX_HEIGHT_DP in 120..320)
    }
}
