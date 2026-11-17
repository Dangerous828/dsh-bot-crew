package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 409 之后「这张卡到底有没有被换成更新的一张」的判定。
 *
 * 钉住的核心事实：**只有单张卡时绝不出现「已更新」这句提示**。
 * 实机上就是这一条失效了 —— 全系统只有一张待决卡，客户端却弹「请按最新的那张再答」，
 * 而那张不存在，卡片锁死、出路为零。
 *
 * 关于「两张」的读法：这里的两张是**同一张票上先后两张问题卡**（旧 attention + 新 attention，
 * 后者才是「上层/最新」那张），不是两张互不相干的票。别的票上的 attention 是另一件事，
 * 把它指过去等于张冠李戴 —— 那种情况一律判「不知道」，一个字都不提示。
 */
class AttentionSupersedeTest {

    private fun ticket(
        id: String,
        attentionId: String,
        open: Boolean = true,
        needsPerson: String = "answer",
        question: String = "要发这条消息吗？",
    ) = WorkTicket(
        id = id,
        title = "ticket $id",
        state = if (open) "working" else "completed",
        botId = "m82",
        needsPerson = needsPerson,
        open = open,
        question = question,
        attentionId = attentionId,
    )

    @Test
    fun singleCardWhoseAttentionDidNotChangeNeverClaimsUpdated() {
        // 实机现场：一张卡，attention 没变，服务端只是没认那句话。
        val answered = AnsweredCard("tk-1", "attention-connection-tk-1-sig-a")
        val result = AttentionSupersede.judge(answered, listOf(ticket("tk-1", "attention-connection-tk-1-sig-a")))
        assertEquals(Supersede.Unknown, result)
    }

    @Test
    fun singleCardWithANewerAttentionPointsAtTheNewOne() {
        // 「两张」= 同一张票上先后两张卡：旧的那张被换成新的那张，提示指向新的。
        val answered = AnsweredCard("tk-1", "attention-connection-tk-1-sig-a")
        val result = AttentionSupersede.judge(answered, listOf(ticket("tk-1", "attention-connection-tk-1-sig-b")))
        assertEquals(Supersede.Newer("tk-1", "attention-connection-tk-1-sig-b"), result)
    }

    @Test
    fun withTwoCardsItPointsAtThisTicketNewerAttentionNotTheOtherPendingOne() {
        // 时间线里还有另一张待决卡：它不是「这张的更新版」，不能被指过去。
        val answered = AnsweredCard("tk-1", "att-1-old")
        val tickets = listOf(
            ticket("tk-2", "att-2", question = "另一件事，要不要做？"),
            ticket("tk-1", "att-1-new"),
        )
        val result = AttentionSupersede.judge(answered, tickets)
        assertEquals(Supersede.Newer("tk-1", "att-1-new"), result)
    }

    @Test
    fun whenTheAnsweredTicketIsGoneNothingIsClaimed() {
        // 票被结掉了：没有「最新那张」可指，绝不提示。
        val answered = AnsweredCard("tk-1", "att-1")
        assertEquals(Supersede.Unknown, AttentionSupersede.judge(answered, listOf(ticket("tk-2", "att-2"))))
        assertEquals(Supersede.Unknown, AttentionSupersede.judge(answered, emptyList()))
    }

    @Test
    fun oldBackendWithoutAttentionNeverClaimsUpdated() {
        // 没有 attention_id 的票走不了审批通道，谈不上「更新」。
        assertEquals(Supersede.Unknown, AttentionSupersede.judge(AnsweredCard("tk-1", ""), listOf(ticket("tk-1", ""))))
        assertEquals(
            Supersede.Unknown,
            AttentionSupersede.judge(AnsweredCard("", "att-1"), listOf(ticket("tk-1", "att-2"))),
        )
    }

    @Test
    fun newerAttentionThatNoLongerWaitsForAPersonIsNotAPrompt() {
        // 新卡在，但票已经不等人了：没有「再答一次」的对象。
        val answered = AnsweredCard("tk-1", "att-1")
        assertEquals(
            Supersede.Unknown,
            AttentionSupersede.judge(answered, listOf(ticket("tk-1", "att-2", open = false))),
        )
        assertEquals(
            Supersede.Unknown,
            AttentionSupersede.judge(answered, listOf(ticket("tk-1", "att-2", needsPerson = ""))),
        )
    }

    @Test
    fun bannerSaysWhatHappenedAndAlwaysOffersAWayOut() {
        // 文案不许再出现「请按最新的那张再答」这种要人自己去找的话。
        assertEquals("这张卡的问题已经换了", AttentionSupersede.BANNER)
        assertTrue(
            "副句不该再指挥人去找一张卡",
            AttentionSupersede.bannerDetail(true).none { it == '请' },
        )
        // 就是这张卡 → 收掉；在别处 → 给一个真能过去的入口。
        assertEquals(AttentionSupersede.DISMISS, AttentionSupersede.bannerAction(true))
        assertEquals(AttentionSupersede.JUMP, AttentionSupersede.bannerAction(false))
        assertEquals(AttentionSupersede.ON_THIS_CARD, AttentionSupersede.bannerDetail(true))
        assertEquals(AttentionSupersede.ELSEWHERE, AttentionSupersede.bannerDetail(false))
    }

    @Test
    fun theOldDeadEndCopyIsGoneFromTheGate() {
        // 从前后端回 409 就把这句挂在卡片上：它在单张卡的现场是一条找不到出路的指引。
        val note = ApprovalGate.rejected("这句不是一个可执行的答复").note
        assertEquals(AnswerCopy.answerFailed("这句不是一个可执行的答复"), note)
        assertTrue("409 的回执不该再说「已更新」", note?.contains("已更新") != true)
        assertTrue("409 的回执不该再指一张卡", note?.contains("最新的那张") != true)
    }
}
