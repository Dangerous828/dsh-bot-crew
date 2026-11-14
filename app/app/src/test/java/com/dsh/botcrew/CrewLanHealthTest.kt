package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「配对记录里那条局域网地址还活着吗」的判定与文案。
 *
 * 这一层的存在理由：死地址不会被踢出入口表，它只是每次都先白等一次连接超时再退回公网，
 * 而界面上只写「公网中转」——人看不出「本来该走局域网、现在为什么没走」。
 *
 * 判失效要两条证据同时成立：连续连不上，**且**这条地址与手机当前网络不在同一网段。
 * 只成立一条时说的话不一样，这样临时故障不会被说成地址失效（那会让人白改一次配对）。
 */
class CrewLanHealthTest {

    private val mac = "192.168.31.127"
    private val dead = "192.168.113.134"

    // ── 失效判定 ──────────────────────────────────────────────────────────

    // 跨网段 + 连续失败 = 地址失效。这就是 issue 里的真实现场：
    // 配对存的是 192.168.113.134，Mac 现在在 192.168.31.0/24。
    @Test
    fun aDeadAddressOnAnotherSubnetIsStale() {
        val report = CrewLanHealth.judge(
            lanBase = "http://$dead:43499",
            failures = CrewLanHealth.FAILURES,
            localAddresses = listOf(mac),
            inUse = false,
        )
        assertEquals(CrewLanHealth.Verdict.STALE, report.verdict)
        assertEquals(dead, report.host)
        assertEquals("192.168.113", report.subnet)
        assertEquals("局域网地址已失效（电脑可能换过 IP）", CrewLanHealth.sentence(report))
    }

    // 同一网段里连不上：地址本身没错，只是这台电脑现在没应答。不能报「已失效」——
    // 那会让人跑去重配对，而真正该做的是等电脑开机。
    @Test
    fun anUnreachableAddressOnTheSameSubnetIsNotStale() {
        val report = CrewLanHealth.judge(
            lanBase = "http://$mac:43499",
            failures = CrewLanHealth.FAILURES,
            localAddresses = listOf("192.168.31.55"),
            inUse = false,
        )
        assertEquals(CrewLanHealth.Verdict.UNREACHABLE, report.verdict)
        assertEquals("局域网地址连不上", CrewLanHealth.sentence(report))
    }

    // 一次失败不算数：电脑刚重启、Wi-Fi 抖一下都会让第一条请求超时。
    @Test
    fun oneFailureIsNotEnoughToJudge() {
        val report = CrewLanHealth.judge(
            lanBase = "http://$dead:43499",
            failures = CrewLanHealth.FAILURES - 1,
            localAddresses = listOf(mac),
            inUse = false,
        )
        assertEquals(CrewLanHealth.Verdict.OK, report.verdict)
        assertEquals("", CrewLanHealth.sentence(report))
    }

    // 正在用这条 LAN 就不可能是失效：网络恢复之后计数还没清的时序，不能反过来把好路说成坏的。
    @Test
    fun theEntryInUseIsNeverReportedAsStale() {
        val report = CrewLanHealth.judge(
            lanBase = "http://$dead:43499",
            failures = 99,
            localAddresses = listOf(mac),
            inUse = true,
        )
        assertEquals(CrewLanHealth.Verdict.OK, report.verdict)
    }

    // 不知道手机在哪个网段时只说「连不上」：判失效要两条证据，缺一条就不下这个结论。
    @Test
    fun anUnknownLocalSubnetNeverYieldsStale() {
        val report = CrewLanHealth.judge(
            lanBase = "http://$dead:43499",
            failures = CrewLanHealth.FAILURES,
            localAddresses = emptyList(),
            inUse = false,
        )
        assertEquals(CrewLanHealth.Verdict.UNREACHABLE, report.verdict)
    }

    // 手机同时有多个地址（wlan0 + 虚拟网卡）时，命中任意一段就算同网段。
    @Test
    fun anyOfThePhonesOwnSubnetsCountsAsTheSameNetwork() {
        val report = CrewLanHealth.judge(
            lanBase = "http://$dead:43499",
            failures = CrewLanHealth.FAILURES,
            localAddresses = listOf("10.10.10.3", dead),
            inUse = false,
        )
        assertEquals(CrewLanHealth.Verdict.UNREACHABLE, report.verdict)
    }

    // 域名、IPv6、手输坏掉的地址都不参与网段判断：拿它们比只会得出错误结论。
    @Test
    fun anEntryWithoutAnIpv4LiteralIsNeverJudged() {
        for (base in listOf(
            "https://crew.example.top",
            "http://[::1]:43499",
            "http://10.0.0.9x:43499",
            "",
        )) {
            val report = CrewLanHealth.judge(base, CrewLanHealth.FAILURES, listOf(mac), inUse = false)
            assertEquals("不该判 $base", CrewLanHealth.Verdict.OK, report.verdict)
        }
    }

    // ── 界面文案 ──────────────────────────────────────────────────────────

    // 走公网且地址已失效：整句说清「为什么绕了远路」，而不是只写「公网中转」让人以为本来就该这样。
    @Test
    fun thePublicRouteLineExplainsWhyItIsNotLocal() {
        val report = CrewLanHealth.judge(
            lanBase = "http://$dead:43499",
            failures = CrewLanHealth.FAILURES,
            localAddresses = listOf(mac),
            inUse = false,
        )
        assertEquals(
            "局域网地址已失效（电脑可能换过 IP），现在走公网中转",
            CrewLanHealth.routeLine("公网中转", report, CrewRoute.Way.PUBLIC),
        )
    }

    // 地址有效时不误报：公网那条仍写「公网中转」，一个字都不多。
    @Test
    fun aHealthyLanAddressAddsNothingToThePublicLine() {
        val report = CrewLanHealth.judge("http://$mac:43499", 0, listOf("192.168.31.55"), inUse = false)
        assertEquals("公网中转", CrewLanHealth.routeLine("公网中转", report, CrewRoute.Way.PUBLIC))
    }

    // 走 P2P 时不追加：隧道是网域无关的主路，局域网那条失效在这里不是问题，
    // 挂在界面上只会让人以为出了故障。
    @Test
    fun theTunnelLineIsNeverDecoratedWithTheLanVerdict() {
        val stale = CrewLanHealth.judge(
            lanBase = "http://$dead:43499",
            failures = CrewLanHealth.FAILURES,
            localAddresses = listOf(mac),
            inUse = false,
        )
        assertEquals("隧道已连接（18ms）", CrewLanHealth.routeLine("隧道已连接（18ms）", stale, CrewRoute.Way.P2P))
    }

    // 走局域网时也不追加：正在用它，说明它通。
    @Test
    fun theLanLineIsNeverDecoratedWithItsOwnVerdict() {
        val unreachable = CrewLanHealth.judge(
            lanBase = "http://$mac:43499",
            failures = CrewLanHealth.FAILURES,
            localAddresses = listOf("192.168.31.55"),
            inUse = false,
        )
        assertEquals("局域网", CrewLanHealth.routeLine("局域网", unreachable, CrewRoute.Way.LAN))
    }

    // 认不出来的入口（手输了一个没见过的地址）也要说清局域网那条的状态，但不假装知道走的是哪条路。
    @Test
    fun anUnknownRouteKeepsItsLabelAndAppendsTheVerdict() {
        val stale = CrewLanHealth.judge(
            lanBase = "http://$dead:43499",
            failures = CrewLanHealth.FAILURES,
            localAddresses = listOf(mac),
            inUse = false,
        )
        assertEquals(
            "自定义地址 · 局域网地址已失效（电脑可能换过 IP）",
            CrewLanHealth.routeLine("自定义地址", stale, null),
        )
    }

    // ── 地址解析 ──────────────────────────────────────────────────────────

    @Test
    fun theHostIsTakenOutOfAnyEntryShape() {
        assertEquals("192.168.31.127", CrewLanHealth.hostOf("http://192.168.31.127:43499"))
        assertEquals("192.168.31.127", CrewLanHealth.hostOf("192.168.31.127:43499"))
        assertEquals("192.168.31.127", CrewLanHealth.hostOf("http://192.168.31.127:43499/api/mobile/timeline"))
        assertEquals("192.168.31.127", CrewLanHealth.hostOf("  192.168.31.127  "))
        assertEquals("192.168.31.127", CrewLanHealth.hostOf("http://192.168.31.127"))
        assertEquals("", CrewLanHealth.hostOf("https://crew.example.top"))
        assertEquals("", CrewLanHealth.hostOf("http://[::1]:43499"))
        assertEquals("", CrewLanHealth.hostOf(""))
    }

    @Test
    fun theSubnetIsTheFirstThreeOctets() {
        assertEquals("192.168.31", CrewLanHealth.subnetOf("192.168.31.127"))
        assertEquals("192.168.113", CrewLanHealth.subnetOf("192.168.113.134"))
        assertEquals("", CrewLanHealth.subnetOf("crew.example.top"))
        // 每段都必须在 0..255：`10.0.0.999` 是坏地址，不该被当成一段网段。
        assertEquals("", CrewLanHealth.subnetOf("10.0.0.999"))
    }

    // 门槛是个具体的数，不是「一个比较小的数」：连续两次连不上才算数。
    @Test
    fun theThresholdIsTwoConsecutiveFailures() {
        assertEquals(2, CrewLanHealth.FAILURES)
        val one = CrewLanHealth.judge("http://$dead:43499", 1, listOf(mac), inUse = false)
        val two = CrewLanHealth.judge("http://$dead:43499", 2, listOf(mac), inUse = false)
        assertEquals(CrewLanHealth.Verdict.OK, one.verdict)
        assertEquals(CrewLanHealth.Verdict.STALE, two.verdict)
        assertTrue(two.failures >= CrewLanHealth.FAILURES)
    }
}
