package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 后台三档的分桶。
 *
 * 这条测试是为一个真实的 bug 写的：`needsPerson` 的类型是 `String` 而不是 `String?`，
 * 后端没给这个字段时它是空串。分桶时写成 `needsPerson == null` 永远不成立，
 * 「进行中」那一栏因此整栏为空 —— 编译通过、不报错，只是少了一屏内容。
 */
class TicketTabTest {

    private fun ticket(
        id: String,
        state: String = "running",
        needsPerson: String = "",
    ) = WorkTicket(
        id = id,
        title = "票 $id",
        state = state,
        botId = "",
        needsPerson = needsPerson,
    )

    /** 与 CrewUi 里的分桶保持一致。 */
    private fun bucket(tickets: List<WorkTicket>, tab: Int): List<String> = tickets.filter { ticket ->
        val waiting = ticket.needsPerson.isNotEmpty()
        when (tab) {
            1 -> waiting
            2 -> ticket.state == "done"
            else -> ticket.state != "done" && !waiting
        }
    }.map { it.id }

    private val sample = listOf(
        ticket("a", state = "running"),
        ticket("b", state = "running", needsPerson = "等你确认合同"),
        ticket("c", state = "done"),
        ticket("d", state = "failed"),
    )

    @Test
    fun inProgressHoldsTicketsNeitherDoneNorWaiting() {
        // 在跑的、失败但没在等人的，都算「进行中」。
        assertEquals(listOf("a", "d"), bucket(sample, 0))
    }

    @Test
    fun waitingHoldsOnlyOnesAskingForAPerson() {
        assertEquals(listOf("b"), bucket(sample, 1))
    }

    @Test
    fun doneHoldsFinishedOnes() {
        assertEquals(listOf("c"), bucket(sample, 2))
    }

    @Test
    fun aRunningTicketWithNoNeedsPersonIsNotTreatedAsWaiting() {
        // 这一条正是 bug 的形状：空串不等于「在等人」。
        val running = ticket("e", state = "running", needsPerson = "")
        assertEquals(listOf("e"), bucket(listOf(running), 0))
        assertEquals(emptyList<String>(), bucket(listOf(running), 1))
    }
}
