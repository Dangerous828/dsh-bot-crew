package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * RoutePolicy 的纯逻辑：healthy sticky / 失败冷却 / 短 LAN 快速切域名 / 网络切换清证据。
 *
 * 这些是「每请求先撞死 LAN 15s」根因修复的核心判据；必须独立钉死，不靠现场。
 */
class RoutePolicyTest {

    private val now = 1_000_000L
    private val lan = "http://192.168.31.127:43499"
    private val p2p = "http://127.0.0.1:43499"
    private val pub = "https://crew.kentonnie.top"

    private fun kind(entry: String): RoutePolicy.Kind = when (entry) {
        p2p -> RoutePolicy.Kind.P2P
        lan -> RoutePolicy.Kind.LAN
        pub -> RoutePolicy.Kind.PUBLIC
        else -> RoutePolicy.Kind.UNKNOWN
    }

    private fun health(entry: String, success: Long = 0, failAt: Long = 0, fails: Int = 0, gen: Int = 0) =
        RoutePolicy.Health(entry, kind(entry), lastSuccessAt = success, lastFailureAt = failAt,
            consecutiveFailures = fails, netGen = gen)

    @Test
    fun healthyEntry_isStickyAndUsesDefaultTimeout() {
        // 公网刚成功过：健康，排最前，默认超时。
        val heaths = mapOf(pub to health(pub, success = now - 5_000), lan to health(lan, failAt = now - 1_000, fails = 3))
        val plan = RoutePolicy.plan(listOf(lan, pub), ::kind, { heaths[it] }, now)
        // 健康公网排到 LAN 前
        assertEquals(pub, plan.order.first())
        assertEquals(RoutePolicy.DEFAULT_CONNECT_MS, plan.connectTimeoutFor[pub])
    }

    @Test
    fun deadLanFailsTwice_entersCooldown_andSortedLast() {
        val deadLan = health(lan, failAt = now - 1_000, fails = RoutePolicy.FAIL_TO_COOLDOWN)
        assertTrue(RoutePolicy.coolingDown(deadLan, now))
        val heaths = mapOf(lan to deadLan, pub to health(pub))
        val plan = RoutePolicy.plan(listOf(lan, pub), ::kind, { heaths[it] }, now)
        // 冷却中的 LAN 排到最后，公网在前
        assertEquals(pub, plan.order.first())
        assertEquals(lan, plan.order.last())
    }

    @Test
    fun publicHealthy_deadLanGetsShortTimeout_noBlocking15s() {
        // 公网健康、LAN 不健康 → LAN 用短超时，避免每请求 15s。
        val heaths = mapOf(pub to health(pub, success = now - 1_000), lan to health(lan))
        val plan = RoutePolicy.plan(listOf(pub, lan), ::kind, { heaths[it] }, now)
        assertEquals(RoutePolicy.SHORT_CONNECT_MS, plan.connectTimeoutFor[lan])
        // 健康公网无需 quickProbe（它已经健康且起手）
        assertFalse(plan.quickProbePublic)
    }

    @Test
    fun leadIsDeadLan_withPublicPresent_quickProbesPublic() {
        // 起手是死 LAN（未健康），表里有公网 → 应 quickProbePublic。
        val heaths = mapOf(lan to health(lan, failAt = now - 1_000, fails = 1), pub to health(pub))
        val plan = RoutePolicy.plan(listOf(lan, pub), ::kind, { heaths[it] }, now)
        assertTrue(plan.quickProbePublic)
    }

    @Test
    fun leadIsP2P_noQuickProbeNeeded() {
        val heaths = mapOf(p2p to health(p2p, success = now - 1_000), lan to health(lan), pub to health(pub))
        val plan = RoutePolicy.plan(listOf(p2p, lan, pub), ::kind, { heaths[it] }, now)
        assertFalse(plan.quickProbePublic)
        assertEquals(p2p, plan.order.first())
    }

    @Test
    fun cooldownExpires_afterWindow() {
        val old = health(lan, failAt = now - RoutePolicy.COOLDOWN_MS - 1, fails = 3)
        assertFalse(RoutePolicy.coolingDown(old, now))
    }

    @Test
    fun networkChanged_clearsEvidence() {
        val h = health(pub, success = now - 1_000, fails = 0)
        val cleared = RoutePolicy.onNetworkChanged(listOf(h), netGen = h.netGen + 1)
        assertEquals(0L, cleared.first().lastSuccessAt)
        assertEquals(0, cleared.first().consecutiveFailures)
        assertFalse(RoutePolicy.healthy(cleared.first(), now))
    }

    @Test
    fun onFailure_differentNetGen_restartsWith1() {
        val h = health(lan, fails = 3, gen = 0)
        val after = RoutePolicy.onFailure(h, now, netGen = 1) // 网络变了
        assertEquals(1, after.consecutiveFailures)
        assertEquals(0L, after.lastSuccessAt) // 成功证据作废
    }

    @Test
    fun emptyEntries_returnsEmptyPlan() {
        val plan = RoutePolicy.plan(emptyList(), ::kind, { null }, now)
        assertTrue(plan.order.isEmpty())
        assertFalse(plan.quickProbePublic)
    }

    // ---- 蜂窝跨网：WiFi 成功 → 切蜂窝（清健康）→ 首请求先公网短探，不先耗死 P2P/LAN ----

    @Test
    fun cellular_trustedPublicFirst_noRedundantProbe_shortTimeoutForBackups() {
        // 网络切到 cellular：健康证据已清（onNetworkChanged），P2P/LAN 均无健康、公网可信非冷却。
        val cleared = RoutePolicy.onNetworkChanged(
            listOf(health(p2p, success = now - 1_000), health(lan, success = now - 1_000), health(pub)),
            netGen = 1,
        )
        val byEntry = cleared.associateBy { it.entry }
        val plan = RoutePolicy.plan(listOf(p2p, lan, pub), ::kind, { byEntry[it] }, now, networkKind = "cellular")
        // 公网直接排最前起手 —— 不先耗死 P2P/LAN。
        assertEquals(pub, plan.order.first())
        // lead 口径：cellular 直走 public，不再对它多发一趟 quickProbe。
        assertFalse("蜂窝起手即公网，不该冗余 quickProbe", plan.quickProbePublic)
        // P2P/LAN 作为后备用短档，别耗满 15s。
        assertEquals(RoutePolicy.SHORT_CONNECT_MS, plan.connectTimeoutFor[lan])
        assertEquals(RoutePolicy.SHORT_CONNECT_MS, plan.connectTimeoutFor[p2p])
        // 公网本身用默认超时（它是真正要用的那条）。
        assertEquals(RoutePolicy.DEFAULT_CONNECT_MS, plan.connectTimeoutFor[pub])
    }

    @Test
    fun wifi_noForcedPublic_firstStaysByPriority() {
        val byEntry = listOf(health(p2p, success = now - 1_000), health(lan), health(pub)).associateBy { it.entry }
        val plan = RoutePolicy.plan(listOf(p2p, lan, pub), ::kind, { byEntry[it] }, now, networkKind = "wifi")
        // WiFi：健康 P2P 起手；不强制公网。
        assertEquals(p2p, plan.order.first())
        assertFalse(plan.quickProbePublic)
    }

    @Test
    fun cellular_butNoPublicEntry_doesNotForceProbe() {
        val byEntry = listOf(health(p2p), health(lan)).associateBy { it.entry }
        val plan = RoutePolicy.plan(listOf(p2p, lan), ::kind, { byEntry[it] }, now, networkKind = "cellular")
        assertFalse("无公网入口时无从 quickProbe", plan.quickProbePublic)
    }
}
