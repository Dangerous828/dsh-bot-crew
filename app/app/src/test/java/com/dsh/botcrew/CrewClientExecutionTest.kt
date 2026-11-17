package com.dsh.botcrew

import org.junit.Test
import java.io.IOException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue

/**
 * CrewClient 执行层 seam 测试：断言 `read()` **真正从 plan.order[0] 起手**，不被旧 current 旋转覆盖。
 *
 * 用 attemptSpy 记录真实 attempt 入口顺序、attemptOverride 构造「P2P/LAN 黑洞、PUBLIC 通」等场景。
 * 这是「执行层没遵守 policy」那个真根因的回归锁：current=P2P 且网络切 cellular 后，首个真实 attempt 必须是 PUBLIC。
 */
class CrewClientExecutionTest {

    private val p2p = "http://127.0.0.1:43499"
    private val lan = "http://192.168.31.127:43499"
    private val pub = "https://crew.kentonnie.top"

    private fun client(entries: List<String>, paired: PairedCrew): CrewClient {
        val c = CrewClient(entries, "tok", "dev")
        c.attachPairing(paired, 43499)
        return c
    }

    private fun paired() = PairedCrew("dev", "tok", lan, fallbackBase = pub, crew = "0kvcc5t")

    @Test
    fun currentP2P_thenCellular_firstAttemptIsPublic_notRotatedToP2P() = runBlocking {
        val c = client(listOf(p2p, lan, pub), paired())
        val order = ArrayList<String>()
        c.attemptSpy = { order.add(it) }
        // P2P/LAN 黑洞（不可路由/拒连），PUBLIC 通。用 override 模拟。
        c.attemptOverride = { entry, _, _, _ ->
            when (entry) {
                pub -> """{"items":[],"bots":[],"session_id":"main"}"""
                else -> throw IOException("黑洞 $entry")
            }
        }
        // 先让 current 落成 P2P（第一趟：P2P 通）
        c.attemptOverride = { entry, _, _, _ ->
            if (entry == p2p) """{"items":[],"bots":[],"session_id":"main"}""" else throw IOException("x")
        }
        c.timeline(null)
        assertEquals(p2p, c.currentEntry()) // 已记最近成功=P2P

        // 网络切 cellular（清健康证据）+ P2P/LAN 变黑洞、PUBLIC 通
        c.networkKindProvider = "cellular"
        c.onNetworkChanged()
        order.clear()
        c.attemptOverride = { entry, _, _, _ ->
            when (entry) {
                pub -> """{"items":[],"bots":[],"session_id":"main"}"""
                else -> throw IOException("黑洞 $entry")
            }
        }
        c.timeline(null)
        // 真根因断言：首个真实 attempt 必须是 PUBLIC，不能先撞死 P2P/LAN。
        assertEquals("首个 attempt 应为 PUBLIC（不按旧 current 旋转）", pub, order.first())
        assertEquals("应 PUBLIC 一次成功，不先试 P2P/LAN", listOf(pub), order)
    }

    @Test
    fun healthySticky_executionOrderHonorsPlan() = runBlocking {
        // WiFi 下 P2P 成功 → 健康；下一趟 current=P2P，plan 应把健康 P2P 排首（sticky），执行亦从 P2P 起。
        val c = client(listOf(p2p, lan, pub), paired())
        c.attemptOverride = { entry, _, _, _ ->
            if (entry == p2p) """{"items":[],"bots":[],"session_id":"main"}""" else throw IOException("x")
        }
        c.timeline(null)
        val order = ArrayList<String>()
        c.attemptSpy = { order.add(it) }
        c.timeline(null)
        assertEquals("健康 P2P sticky → 执行从 P2P 起", p2p, order.first())
    }

    @Test
    fun failedEntryCooldown_executionSkipsToNextHealthy() = runBlocking {
        // 第一趟 P2P 失败两次进冷却；LAN 通。下一趟执行应先 LAN（P2P 冷却）。
        val c = client(listOf(p2p, lan, pub), paired())
        // 让 P2P 失败、LAN 通
        c.attemptOverride = { entry, _, _, _ ->
            if (entry == lan) """{"items":[],"bots":[],"session_id":"main"}""" else throw IOException("dead $entry")
        }
        // 两趟让 P2P 连续失败到冷却
        c.timeline(null); c.timeline(null)
        val order = ArrayList<String>()
        c.attemptSpy = { order.add(it) }
        c.timeline(null)
        // P2P 冷却排后；执行从 LAN 或 PUBLIC 起，不应先试 P2P（P2P 若在表里应排后）
        assertTrue("应跳过冷却的 P2P，先从非 P2P 起", order.first() != p2p)
    }
}
