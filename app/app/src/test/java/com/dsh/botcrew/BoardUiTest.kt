package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 事务板 / 分拣台的分桶口径：只按后端给的 open、needsPerson、queued 反查做投影。
 * UI 层一行条目都不许编，所以这些边界必须在纯函数上钉住。
 */
class BoardUiTest {

    private fun ticket(
        id: String,
        open: Boolean = true,
        needsPerson: String = "",
        state: String = "working",
    ) = WorkTicket(
        id = id,
        title = "票 $id",
        state = state,
        botId = "",
        needsPerson = needsPerson,
        open = open,
    )

    private fun message(id: String, requestId: String = "", text: String = "一句话") = Message(
        id = id,
        fromBot = false,
        botId = null,
        text = text,
        at = "",
        requestId = requestId,
    )

    private fun conversation(
        tickets: List<WorkTicket> = emptyList(),
        messages: List<Message> = emptyList(),
        queued: List<String> = emptyList(),
    ) = Conversation(
        messages = messages,
        bots = emptyList(),
        defaultBotId = "",
        tickets = tickets,
        queued = queued,
    )

    @Test
    fun noTimelineIsUnavailableNotAnEmptyBoard() {
        // 还没读到时间线时 UI 要说「正在读」/「读不到」，不是「还没有事务」。
        assertNull(boardGroups(null))
        assertEquals(0, boardUnread(null))
    }

    @Test
    fun groupsFollowOpenAndNeedsPersonOnly() {
        val groups = boardGroups(
            conversation(
                tickets = listOf(
                    ticket("running"),
                    ticket("deciding", needsPerson = "answer"),
                    ticket("finished", open = false, state = "working"),
                    ticket("failed", state = "failed", needsPerson = "blocked"),
                ),
            ),
        )!!
        assertEquals(listOf("running"), groups.running.map { it.id })
        assertEquals(listOf("deciding", "failed"), groups.deciding.map { it.id })
        assertEquals(listOf("finished"), groups.done.map { it.id })
        assertEquals(emptyList<BoardWaiting>(), groups.waiting)
    }

    @Test
    fun queuedOnlyBecomesWaitingWhenRequestIdResolves() {
        val groups = boardGroups(
            conversation(
                messages = listOf(message("m1", requestId = "q1", text = "现在几点了\n第二行"), message("m2")),
                queued = listOf("q1", "q-missing"),
            ),
        )!!
        // 反查不到的 request_id 整条跳过；取正文第一行，不把整段消息塞进列表。
        assertEquals(listOf("现在几点了"), groups.waiting.map { it.text })
        assertEquals(listOf("m1"), groups.waiting.map { it.messageId })
    }

    @Test
    fun blankMessageIsSkipped() {
        val groups = boardGroups(
            conversation(messages = listOf(message("m1", requestId = "q1", text = "  \n  ")), queued = listOf("q1")),
        )!!
        assertEquals(emptyList<BoardWaiting>(), groups.waiting)
    }

    @Test
    fun unreadCountsWaitingWordsAndDecisions() {
        val value = boardUnread(
            conversation(
                tickets = listOf(ticket("running"), ticket("deciding", needsPerson = "answer"), ticket("done", open = false)),
                messages = listOf(message("m1", requestId = "q1")),
                queued = listOf("q1", "q-missing"),
            ),
        )
        // 一条还没回的话 + 一张等你拍板；在跑、办完、反查不到的都不算未读。
        assertEquals(2, value)
    }

    @Test
    fun emptyBoardHasNoRows() {
        val groups = boardGroups(conversation())!!
        assertEquals(emptyList<BoardWaiting>(), groups.waiting)
        assertEquals(emptyList<WorkTicket>(), groups.running)
        assertEquals(emptyList<WorkTicket>(), groups.deciding)
        assertEquals(emptyList<WorkTicket>(), groups.done)
    }
}
