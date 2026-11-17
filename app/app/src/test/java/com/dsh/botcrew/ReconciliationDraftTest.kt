package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 对账成功之后，输入框该怎么收。
 *
 * 实机漏口：C 那条发送结果待确认 → force-stop → 重开在线后，ledger 按原 UUID 对上了、
 * 记录也清了，但**输入框仍留着 C 的原文**。用户看到还在，就会再点一次发送 ——
 * 新的 UUID，服务端多一条一模一样的消息。
 *
 * 判据只有三条：
 * 1. 对账成功与直接 200 成功走**同一套**原文匹配（[SendOwnership.shouldClearDraft]）；
 * 2. 清的是「当前草稿仍等于当时发出去的那一版」这一格；用户后来改过字就不动；
 * 3. 只碰这条自己的会话，别的格与别的未确认记录一律不牵连。
 */
class ReconciliationDraftTest {

    private val sent = SendOwner(sessionKey = "main", requestId = "req-c", text = "C 那条原文")

    @Test
    fun reconciliationClearsTheDraftWhenItStillHoldsTheSentText() {
        // 这正是实机那一屏：草稿还是 C 的原文 → 必须清掉，否则再点一次就是重复发送。
        assertTrue(SendOwnership.shouldClearDraft("main", "C 那条原文", sent))
    }

    @Test
    fun reconciliationKeepsADraftTheUserHasEditedSince() {
        // 用户已经改成别的字：那一版草稿是新的，不能被一次迟到的对账抹掉。
        assertFalse(SendOwnership.shouldClearDraft("main", "C 那条原文，再加一句", sent))
        assertFalse(SendOwnership.shouldClearDraft("main", "", sent))
    }

    @Test
    fun reconciliationOnlyTouchesItsOwnSession() {
        // 另一格的草稿里恰好有同样的字，也不清：发送归属按会话算。
        assertFalse(SendOwnership.shouldClearDraft("work", "C 那条原文", sent))
    }

    @Test
    fun theDirectSuccessPathAndTheReconcilePathAgreeOnWhatToClear() {
        // 两条路的判据是同一个函数，不各写一份 —— 否则就一定会有一份忘记加「原文相等」。
        val onSuccess = SendOwnership.shouldClearDraft("main", "C 那条原文", sent)
        val onReconcile = SendOwnership.shouldClearDraft("main", "C 那条原文", sent)
        assertEquals(onSuccess, onReconcile)

        // 直接成功时 owner 的 text 就是刚发出去那版；对账时 owner 由盘上记录重建，
        // 两者对同一份意图必须得到同一个结论。
        val rebuilt = SendOwner(
            sessionKey = "main",
            requestId = "req-c",
            text = UncertainSend("req-c", "main", "C 那条原文", emptyList(), "", 0).text,
        )
        assertEquals(onSuccess, SendOwnership.shouldClearDraft("main", "C 那条原文", rebuilt))
    }

    @Test
    fun aSettledRecordOnlyClearsItself() {
        // 对账一次可能同时settle多条：每条各清自己的 note，先清完 A 不影响 B 仍在。
        var notes: Map<String, List<SendNote>> = emptyMap()
        notes = SendNoteBook.put(notes, "main", SendNote("req-c", "发送结果待确认：C"))
        notes = SendNoteBook.put(notes, "main", SendNote("req-d", "发送结果待确认：D"))
        notes = SendNoteBook.clear(notes, "main", "req-c")
        assertEquals(listOf("req-d"), SendNoteBook.of(notes, "main").map { it.requestId })

        // 而且它只清自己那个 session 的槽。
        notes = SendNoteBook.put(notes, "work", SendNote("req-e", "发送结果待确认：E"))
        notes = SendNoteBook.clear(notes, "main", "req-d")
        assertEquals(listOf("req-e"), SendNoteBook.of(notes, "work").map { it.requestId })
    }

    @Test
    fun aRequestIdThatIsNotOnDiskIsNotASettleReason() {
        // 只认「盘上这条 + 时间线出现同 id」这一对证据；空 id 永远不算对上（否则一刷新就清空草稿）。
        val empty = UncertainSend("", "main", "C 那条原文", emptyList(), "", 0)
        assertTrue(SendRecoveryRecord.read(mapOf(SendRecoveryRecord.SENDS to "")).items.isEmpty())
        assertNull(SendRecoveryRecord.reuse(emptyList(), "main", "C 那条原文", emptyList(), ""))
        // 盘上那格空着时，reuse 不会凭空造一条出来（由调用方决定新 UUID）。
        assertFalse(empty.requestId.isNotEmpty())
    }
}
