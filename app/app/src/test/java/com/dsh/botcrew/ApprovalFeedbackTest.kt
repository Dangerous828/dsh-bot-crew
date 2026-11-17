package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 审批答复的同题互斥与阶段反馈：
 * - 同一张票任一阶段在途就不再放行（挡住 A/B 并发、挡住重复点）；
 * - HTTP 成功只叫「已受理」，继续锁，等时间线收敛才解锁；
 * - 409 **解锁**并如实转述服务端原话：它不再等于「这张卡已更新」（四种 409 来源里只有一种
 *   是换了卡，判不出来就不提示，见 [AttentionSupersedeTest]）；
 * - 收敛判定：签名变了或票没了才解锁；问题换了，旧卡上的回执一并作废。
 */
class ApprovalFeedbackTest {

    @Test
    fun beginOnlyFromIdle() {
        val gate = ApprovalGate
        assertTrue(gate.canSubmit(ApprovalGate.State()))
        val submitting = gate.begin()
        assertTrue(submitting.submitting)
        assertTrue(submitting.busy)
        // 提交中不放行第二次（同题互斥）。
        assertFalse(gate.canSubmit(submitting))
    }

    @Test
    fun acceptedIsLockedNotSubmitting() {
        val accepted = ApprovalGate.accepted()
        assertEquals(ApprovalGate.Phase.Accepted, accepted.phase)
        // 已经受理：不再叫「提交中」，但依然锁着不放行。
        assertFalse(accepted.submitting)
        assertTrue(accepted.busy)
        assertFalse(ApprovalGate.canSubmit(accepted))
        assertEquals("答复已受理，等待状态更新", accepted.note)
    }

    @Test
    fun failureReleasesToIdleAllowingRetry() {
        val failed = ApprovalGate.failed("网络断了")
        assertEquals(ApprovalGate.Phase.Idle, failed.phase)
        assertFalse(failed.busy)
        assertTrue(ApprovalGate.canSubmit(failed))
        assertEquals(AnswerCopy.answerFailed("网络断了"), failed.note)
    }

    @Test
    fun rejectionReleasesAndQuotesTheServerInsteadOfClaimingAnUpdate() {
        // 409：解锁并照实转述服务端原话。从前的「这张问题卡已更新，请按最新的那张再答」
        // 在只有一张卡的现场是一条找不到出路的指引 —— 这里钉住它不再回来。
        val rejected = ApprovalGate.rejected("这句不是一个可执行的答复")
        assertEquals(ApprovalGate.Phase.Idle, rejected.phase)
        assertFalse("409 之后必须能重新选一项，否则卡片就永久锁死", rejected.busy)
        assertTrue(ApprovalGate.canSubmit(rejected))
        assertEquals(AnswerCopy.answerFailed("这句不是一个可执行的答复"), rejected.note)
        assertFalse(rejected.note!!.contains("已更新"))
        assertFalse(rejected.note!!.contains("最新的那张"))
    }

    @Test
    fun rejectionWithoutAReasonStillSaysSomethingTrue() {
        val rejected = ApprovalGate.rejected(null)
        assertEquals(ApprovalGate.Phase.Idle, rejected.phase)
        assertEquals(AnswerCopy.answerFailed(ApprovalGate.REJECTED_UNKNOWN), rejected.note)
    }

    @Test
    fun convergenceUnlocksOnlyWhenSignatureChangesOrTicketGone() {
        // Idle / Submitting 不受收敛影响。
        assertFalse(ApprovalGate.converged(ApprovalGate.Phase.Idle, "sig", "other"))
        assertFalse(ApprovalGate.converged(ApprovalGate.Phase.Submitting, "sig", "other"))
        // Accepted 且签名没变 → 还没收敛，继续锁。
        assertFalse(ApprovalGate.converged(ApprovalGate.Phase.Accepted, "sig", "sig"))
        // Accepted 且签名变了 → 收敛。
        assertTrue(ApprovalGate.converged(ApprovalGate.Phase.Accepted, "sig", "sig2"))
        // 票没了（newSignature=null）→ 收敛。
        assertTrue(ApprovalGate.converged(ApprovalGate.Phase.Accepted, "sig", null))
    }

    @Test
    fun aNoteNeverSurvivesToADifferentQuestion() {
        // 旧卡上的「没答上：…」不该挂在新问题下面（409 之后换卡正是这条路径）。
        var sig = "q1|A|B"
        val holder = ApprovalGateHolder({ sig })
        assertTrue(holder.begin())
        holder.rejected("这句不是一个可执行的答复")
        assertEquals(AnswerCopy.answerFailed("这句不是一个可执行的答复"), holder.state.note)
        // 同一道题还在：回执留着（人还要看见它）。
        holder.reconcile()
        assertEquals(AnswerCopy.answerFailed("这句不是一个可执行的答复"), holder.state.note)
        // 问题换了：回执作废。
        sig = "q2|X|Y"
        holder.reconcile()
        assertEquals(null, holder.state.note)
        assertEquals(ApprovalGate.Phase.Idle, holder.state.phase)
    }

    @Test
    fun holderSerializesConcurrentAnswersOnSameTicket() {
        // 用可变签名模拟时间线。
        var sig = "q1|A|B"
        val holder = ApprovalGateHolder({ sig })
        assertTrue(holder.begin())
        // 第二次点（无论哪个选项）在被受理前就被拦下。
        assertFalse(holder.begin())
        // HTTP 成功 → 已受理，仍锁。
        holder.accepted()
        assertFalse(holder.begin())
        // 签名没变时 reconcile 不解锁。
        holder.reconcile()
        assertFalse(ApprovalGate.canSubmit(holder.state))
        // 时间线收敛（换了题）→ 解锁回 Idle。
        sig = "q2|X|Y"
        holder.reconcile()
        assertTrue(ApprovalGate.canSubmit(holder.state))
        assertTrue(holder.begin())
    }
}
