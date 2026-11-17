package com.dsh.botcrew

/**
 * 收件人：把「跟谁说话」这件事收敛成纯函数。
 *
 * 不存在第二份收件人真源 —— 谁收到这条话，最终只由 [CrewWire.mentionsIn] 从正文里
 * 认出来。这里只做两件事：
 *  1. 名片上「跟他说话」时，把某一位落成"这句话发给谁"（显式切换）；
 *  2. 告诉界面「这句话现在会发给谁」，用于输入框里的可见提示。
 *
 * 三条硬规矩：
 * - **未知 @ 原样保留**：正文里 @ 了一个不在花名册上的名字，不动它、不吞、不当成收件人。
 * - **显式切换只动已识别的收件人**：把当前被认作收件人的已知成员 @ 收掉，把目标提到最前，
 *   正文其余（含非成员的 @ 记号）一个字不动。不是"叠一个"，也不会重复冒出目标 @。
 * - **选定即路由**：切换后 `mentionsIn(新草稿).firstOrNull() == 目标.id` 恒成立 —— 不改
 *   [CrewWire.mentionsIn] 的排序协议，由本 helper 自己保证目标排在最前被认到。
 */
object Recipient {

    /** 名片「跟他说话」时用的那个名字：名片上的名字优先，空着退回 id（与 @ 的规矩一致）。 */
    fun label(bot: BotCard): String = bot.name.trim().ifEmpty { bot.id.trim() }

    /**
     * 显式选定 [bot] 作为收件人后的新草稿。
     *
     * 结果保证：`CrewWire.mentionsIn(out, bots).firstOrNull() == bot.id`（[bots] 里含 [bot] 且其 label 非空时）。
     *
     * 做法（最小且确定）：
     * 1. 先算出目前被认作收件人的**已知成员**（mentionsIn 的实算结果，含按 id 命中的，如 `@lead`）；
     * 2. 把这些已知成员的 @token 从正文里移除（只移除这些"已识别收件人"，未知 @ 不动）；
     * 3. 清掉因此产生的多余空白，把 `@label ` 放到最前面，正文其余原样接上。
     *
     * 这样无论原来有 0 个、1 个还是多个已知成员被 @，切换后都只有目标一个收件人排在最前，
     * 不会重复 @目标，也不会误伤正文里引用的未知 @。
     */
    fun select(draft: String, bot: BotCard, bots: List<BotCard>): String {
        val target = label(bot)
        if (target.isEmpty()) return draft
        // 先把所有已知成员的 @token 从正文里拿掉（含按 name 与按 id 两种命中）。
        var body = draft
        for (other in knownMembers(draft, bots)) {
            body = stripMention(body, other)
        }
        body = body.trimStart()
        return if (body.isEmpty()) "@$target " else "@$target $body"
    }

    /**
     * 这句话现在会发给谁（用于输入框提示「发给X」）。只看实际的第一收件人。
     *
     * 完全从正文派生：`mentionsIn` 认到的成员按它给的顺序取**第一个**的名字。
     * 返回 null = 没点名，会走群默认那一位（由调用方决定怎么显示）。
     * 不把其余被 @ 的成员列出来 —— 界面说"发给谁"只说实话：真正接活的是第一个。
     */
    fun primaryRecipient(draft: String, bots: List<BotCard>): String? {
        if (draft.isBlank()) return null
        val id = CrewWire.mentionsIn(draft, bots).firstOrNull() ?: return null
        return bots.firstOrNull { it.id == id }?.let { label(it) }?.takeIf { it.isNotEmpty() }
    }

    // 正文里被 @ 的已知成员（mentionsIn 的同一套实算口径）。
    private fun knownMembers(draft: String, bots: List<BotCard>): List<BotCard> {
        val ids = CrewWire.mentionsIn(draft, bots).toSet()
        return bots.filter { it.id in ids }
    }

    /**
     * 把正文里 `@name` 与 `@id`（词边界命中）两处都移除。返回移除后的正文（不改其它字符）。
     * 目标成员自己那一份也一起移除 —— 由调用方统一在最前面重放一个 `@label`，避免重复。
     */
    private fun stripMention(text: String, bot: BotCard): String {
        var out = text
        for (token in listOf(bot.name.trim(), bot.id.trim()).filter { it.isNotEmpty() }.distinct()) {
            out = replaceOrRemove(out, token, null)
        }
        return out
    }

    /**
     * 把正文里所有 `@[from]`（词边界命中）替换成 [to] 对应的 @token；[to] 为 null 时删除该 @token。
     * 与 [CrewWire.mentionsIn] 的词边界口径一致：`@ab` 不误伤 `@a`。
     */
    private fun replaceOrRemove(text: String, from: String, to: String?): String {
        if (from.isEmpty()) return text
        val needle = "@$from"
        if (needle == "@") return text
        val out = StringBuilder()
        var from0 = 0
        while (true) {
            val at = text.indexOf(needle, from0)
            if (at < 0) { out.append(text, from0, text.length); break }
            val after = at + needle.length
            val next = text.getOrNull(after)
            val bounded = next == null || !(next.isLetterOrDigit() || next == '_' || next == '-')
            if (!bounded) { out.append(text, from0, after); from0 = after; continue }
            out.append(text, from0, at)
            if (to != null) out.append('@').append(to)
            from0 = after
        }
        return out.toString()
    }
}
