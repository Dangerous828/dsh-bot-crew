package com.dsh.botcrew

/**
 * 「看详情」展开后那块原文的排版规则。
 *
 * 实机上它是一堵墙：一整块 2000 字的原文直接铺进卡片（y=1903 起，951px 高），
 * 里面是 `mcp__messages__send_message({"channel":...` 这种原始协议，和正文同字号同色，
 * 一路压到卡片底部。
 *
 * 这一块存在的意义是**原样核对**，所以内容一个字都不改：这里只决定「怎么摆」——
 * 按空行分节、等宽小字、限高滚动。除了分节用的那个空行，别的字符（字面 `\n`、JSON、路径、
 * 全角括号）一律照录。
 */
object DetailsCopy {

    /** 详情区最多这么高；再长就在这一块里滚动，不把卡片撑成一面墙。 */
    const val MAX_HEIGHT_DP = 240

    /** 详情区的字号（比正文 13sp 小一号，等宽）。 */
    const val FONT_SP = 10

    /**
     * 按空行分节。
     *
     * 认两种空行：
     *  - 真空行（`\n` 之间只有空格/制表/全角空格）—— 人写的多段文字；
     *  - 字面 `\n\n`（反斜杠 + n 两个字符连写两遍）—— 后端把换行转义进字符串后就是这种形状，
     *    实机那块原文正是这样：`to：m82\n\n这条审批原样记录：\n要通过消息…`。
     *
     * 分节符本身不显示（它变成了节与节之间的间隔），其余字符逐字保留。
     * 一整块没有任何空行时返回单节 —— 由 [MAX_HEIGHT_DP] 那道上限负责不让它撑爆卡片。
     */
    fun sections(text: String): List<String> {
        val normalized = text.replace("\r\n", "\n").replace('\r', '\n')
        if (normalized.isBlank()) return emptyList()
        val out = mutableListOf<String>()
        var start = 0
        var index = 0
        while (index < normalized.length) {
            val blank = blankAt(normalized, index)
            if (blank == null) {
                index++
                continue
            }
            push(out, normalized.substring(start, blank.from))
            start = blank.to
            index = blank.to
        }
        push(out, normalized.substring(start))
        return out
    }

    /** 一段分隔符在原串里的区间：`[from, to)`。 */
    private data class Blank(val from: Int, val to: Int)

    /** 从 [index] 起是不是一个空行（真空行或字面 `\n\n`）；是就返回它占的区间。 */
    private fun blankAt(text: String, index: Int): Blank? {
        realBlankAt(text, index)?.let { return it }
        return literalBlankAt(text, index)
    }

    /** 真空行：`\n` + 若干空白 + `\n`。 */
    private fun realBlankAt(text: String, index: Int): Blank? {
        if (text[index] != '\n') return null
        var cursor = index + 1
        while (cursor < text.length && isGap(text[cursor])) cursor++
        if (cursor >= text.length || text[cursor] != '\n') return null
        return Blank(index, cursor + 1)
    }

    /** 字面空行：`\n`（反斜杠 + n）+ 若干空白 + 再一个 `\n`。 */
    private fun literalBlankAt(text: String, index: Int): Blank? {
        if (!text.startsWith(LITERAL_NEWLINE, index)) return null
        var cursor = index + LITERAL_NEWLINE.length
        while (cursor < text.length && isGap(text[cursor])) cursor++
        if (!text.startsWith(LITERAL_NEWLINE, cursor)) return null
        return Blank(index, cursor + LITERAL_NEWLINE.length)
    }

    private fun isGap(char: Char): Boolean = char == ' ' || char == '\t' || char == '　'

    private const val LITERAL_NEWLINE = "\\n"

    /**
     * 收一节：只剪掉贴着分隔符的换行与行尾空白（那本来就是分隔符的一部分），中间一个字不动；
     * 空节不画。
     *
     * 开头只剪换行、**不剪空格**：这一段可能是一块代码，缩进是内容的一部分。
     */
    private fun push(out: MutableList<String>, section: String) {
        val trimmed = section.trimEnd('\n', ' ', '\t', '　').trimStart('\n')
        if (trimmed.isNotEmpty()) out.add(trimmed)
    }
}
