package com.dsh.botcrew

/**
 * 一次被服务端拒掉的答复：答的是**哪张票**、界面上**哪一张问题卡**。
 *
 * 只记这两个 id，不记时间戳、不记文案 —— 判定「有没有更新的那张」靠的是时间线里的
 * attention id 对比，不是本地记的先后。本地时间戳只能证明「我答得晚」，证明不了
 * 「服务端换了一张」。
 */
data class AnsweredCard(val ticketId: String, val attentionId: String)

/** 409 之后「这张卡到底有没有被换成更新的一张」的判定结果。 */
sealed interface Supersede {
    /**
     * 判不出来 / 没有更新的 attention。**一个字都不提示**。
     *
     * 一条指向不存在的卡的指引比没有提示更糟：人照着找，找不到，就不知道该信谁了。
     */
    data object Unknown : Supersede

    /** 确实拿到了更新的 attention：同一张票上换了一张新卡。 */
    data class Newer(val ticketId: String, val attentionId: String) : Supersede
}

/**
 * 「这张问题卡已更新」这句提示的唯一判定处。
 *
 * 从前的做法是：`POST /api/mobile/answer` 只要回 409 就弹「这张问题卡已更新，请按最新的那张再答」。
 * 但 409 有四种完全不同的来源（见 `backend/src/app/runtime.ts` 的 `answerTicket`）：
 *
 *  1. 没有这张票 / 票已结束；
 *  2. `attention_id` 与当前 `ticket.attention.id` 不符（这才是真的「换了新卡」）；
 *  3. 这句不是任何选项标签、也不是 revise —— **人在自由输入里随手写了一句**；
 *  4. `pendingApproval.status === 'revise'` 但这句话还是认不出。
 *
 * 实机那张卡就是第 3 种：人在「自己写一句」里打了「不用做了」按「回」，服务端如实回
 * 「这句不是一个可执行的答复」，客户端却把它当成「卡更新了」。而全系统只有那一张待决卡，
 * 所谓「最新的那张」根本不存在 —— 于是卡片锁死、提示永远挂着、出路为零。
 *
 * 所以判定只认**证据**：时间线刷新回来后，同一张票（同一 request）上出现了一个**不同的**
 * `attention_id`，且这张票还在等人。判得出来才提示，并且提示一定能指到那张卡；判不出来就不提示。
 *
 * 别的票上的 attention 不算「这张的更新版」：那是另一件事，把它指过去等于张冠李戴。
 */
object AttentionSupersede {

    /** 提示条标题：只说事实，不说「请按最新的那张」这种要人自己去找的话。 */
    const val BANNER = "这张卡的问题已经换了"

    /** 最新那张就是当前这张卡自己（同一张票换了一张新卡，刷新后画在原位）。 */
    const val ON_THIS_CARD = "下面这张就是最新的那张"

    /** 最新那张不在这张卡上：得给出一个真能过去的入口。 */
    const val ELSEWHERE = "最新那张在下面「另有待决定」里"

    /** 跳转入口的字。 */
    const val JUMP = "逐项看"

    /** 就是这张卡时，那条提示条的收尾动作。 */
    const val DISMISS = "知道了"

    /**
     * 判定这次 409 有没有拿到更新的 attention。
     *
     * @param answered 刚被拒的那一次答复答的是哪张票、哪一张卡。
     * @param tickets 刷新回来的时间线（[Conversation.tickets]）。
     */
    fun judge(answered: AnsweredCard, tickets: List<WorkTicket>): Supersede {
        // 老后端不下发 attention_id：这张票根本走不了审批通道，谈不上「更新」，不提示。
        if (answered.ticketId.isBlank() || answered.attentionId.isBlank()) return Supersede.Unknown
        // 只看同一张票（同一 request）。票没了 = 后端把它结掉/换掉了，没有「最新那张」可指。
        val same = tickets.firstOrNull { it.id == answered.ticketId } ?: return Supersede.Unknown
        val current = same.attentionId.trim()
        // 时间线里还是同一张卡：服务端没换卡，这次 409 是别的原因（认不出这句话/票已结束）。
        // 这时**绝不**说「已更新」—— 说了就是让人去找一张不存在的卡。
        if (current.isEmpty() || current == answered.attentionId.trim()) return Supersede.Unknown
        // 新卡在，但这张票已经不等人了：没有「再答一次」的对象，同样不提示。
        if (!same.open || same.needsPerson.isEmpty()) return Supersede.Unknown
        return Supersede.Newer(same.id, current)
    }

    /**
     * 提示条的副句：最新那张在不在这张卡上。
     *
     * 这句话只说事实，不说「请按最新的那张再答」—— 后者要人自己去找，找不到就没了出路。
     */
    fun bannerDetail(onThisCard: Boolean): String = if (onThisCard) ON_THIS_CARD else ELSEWHERE

    /** 提示条的动作：就是这张卡 → 收掉；在别处 → 给一个真能过去的入口。 */
    fun bannerAction(onThisCard: Boolean): String = if (onThisCard) DISMISS else JUMP
}
