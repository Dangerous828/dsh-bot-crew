package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 审批答复的同题互斥与阶段反馈：
 * - 同一张票任一阶段在途就不再放行（挡住 A/B 并发、挡住重复点）；
 * - HTTP 成功只叫「已受理」，继续锁，等时间线收敛才解锁；
 * - 409 stale 锁住刷新，刷新失败只给「重试读取」，不立刻解锁；
 * - 收敛判定：签名变了或票没了才解锁。
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
    fun staleStaysLocked() {
        val stale = ApprovalGate.stale()
        assertEquals(ApprovalGate.Phase.Stale, stale.phase)
        assertTrue(stale.busy)
        assertFalse(ApprovalGate.canSubmit(stale))
        assertEquals("这张问题卡已更新，请按最新的那张再答", stale.note)
    }

    @Test
    fun staleLocksAndPointsToRefreshThenLatest() {
        // 409 旧卡：锁住，文案指向「按最新的那张再答」——刷新由调用方触发（onSent），
        // 收敛靠新签名解锁。不另设一个未接线的「刷新失败」死态。
        val stale = ApprovalGate.stale()
        assertEquals(ApprovalGate.Phase.Stale, stale.phase)
        assertTrue(stale.busy)
        assertFalse(ApprovalGate.canSubmit(stale))
        assertEquals(ApprovalGate.STALE, stale.note)
        // 签名未变继续锁；刷新出新签名才解锁。
        assertFalse(ApprovalGate.converged(stale.phase, "s", "s"))
        assertTrue(ApprovalGate.converged(stale.phase, "s", "s2"))
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
        // stale 同理只在签名变/票没了时收敛。
        assertFalse(ApprovalGate.converged(ApprovalGate.Phase.Stale, "sig", "sig"))
        assertTrue(ApprovalGate.converged(ApprovalGate.Phase.Stale, "sig", "sig2"))
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
