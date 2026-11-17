package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 工作区暂停按钮按一下到底发出什么。
 *
 * 这一层以前没有用例：`pauseLabel` 测了（`paused=True` → 「继续执行」），`setPaused` 的动作
 * 也测了（true 走 pause / false 走 resume），但**两者之间那句「按钮传出去的第一个参数」**
 * 没人验。于是出现过「标签对、动作反」——真机上 `paused=False` 时按「让它停一下」，
 * 实际执行 resume，`paused` 一直不翻（#19 第 3 项实屏抓到）。
 *
 * 判据不是「调用了 onSetPaused」，而是：传出去的目标与按钮那一刻说的那句话一致 ——
 * 说「暂停全队」就必须传 true，说「恢复全队」就必须传 false。
 */
class PausePressTest {

    @Test
    fun theButtonSendsTheOppositeOfTheCurrentStateNotTheStateItself() {
        // 现在没暂停 → 按钮写「让它停一下」→ 传出去的目标必须是 true（pause）。
        val idle = pausePress(paused = false, preview = null, ticket = null)
        assertEquals("暂停全队", WorkspaceCopy.pauseLabel(paused = false))
        assertEquals(true, idle.target)

        // 现在已暂停 → 按钮写「继续执行」→ 传出去的目标必须是 false（resume）。
        val paused = pausePress(paused = true, preview = null, ticket = null)
        assertEquals("恢复全队", WorkspaceCopy.pauseLabel(paused = true))
        assertEquals(false, paused.target)
    }

    /**
     * 反向钉：目标必须与「当前状态」相反。这一条单独写，是为了让「把当前状态直接当目标传」
     * 这种错（曾经的真 bug）必定变红，而不是靠上面那条的正向断言顺带照到。
     */
    @Test
    fun theTargetIsNeverTheCurrentState() {
        for (current in listOf(false, true)) {
            assertEquals(
                "paused=$current 时按钮传出去的目标不能等于当前状态，否则按下去方向就反了",
                !current,
                pausePress(paused = current, preview = null, ticket = null).target,
            )
        }
    }

    @Test
    fun thePressActsOnTheTicketOnScreen() {
        // 从代码卡进来时看的是那一张，作用对象就是它，不是 Bot 手上另一张。
        assertEquals(
            "t-9",
            pausePress(paused = false, preview = "t-9", ticket = "t-1").ticketId,
        )
        // 没有 preview 时落到 Bot 手上那张。
        assertEquals("t-1", pausePress(paused = false, preview = null, ticket = "t-1").ticketId)
        // 手上没有票就是全局停：null 交给后端，后端如实回 scope。
        assertNull(pausePress(paused = false, preview = null, ticket = null).ticketId)
    }
}
