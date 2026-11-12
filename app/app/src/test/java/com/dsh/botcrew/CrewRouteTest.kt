package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 三条路怎么排、现在走的是哪条。
 *
 * 这张表决定的是「连哪」，错一格的表现往往不是报错而是慢和绕：P2P 排在局域网后面
 * 就要每次白等隧道注册，死入口留在最前面就每个请求先卡一次超时。所以顺序、去重、
 * 以及「认不出地址时说什么」都钉在这里。
 *
 * 只测纯逻辑：真连一条隧道要原生库、要电脑在线，不在 JVM 单测里跑。
 */
class CrewRouteTest {

    /** 形状像真的 tc-addr：`tcp` 后面跟一长串 base64url。密钥是电脑的事，这里只关心形状。 */
    private val tunnel = "tcp" + "Aa0_-".repeat(12)

    private val paired = PairedCrew(
        deviceId = "dev-1",
        token = "tok-1",
        base = "http://192.168.31.127:43499",
        fallbackBase = "https://crew.example.top",
        p2pAddr = tunnel,
    )

    // 回环端口就是 App 自己的入口：P2P 通不通不改变它长什么样。
    @Test
    fun theProxyAddressIsTheLoopbackOnThePortWeWereGiven() {
        assertEquals("http://127.0.0.1:43001", CrewRoute.proxyBase(43001))
        assertEquals("http://127.0.0.1:1", CrewRoute.proxyBase(1))
    }

    // 不是 tc-addr 的东西一律当「没公布」：TXT 是纯文本，拿半截字符串去建客户端只会换来一句难懂的库错误。
    @Test
    fun anAddressThatIsNotATailcatOneIsDroppedInsteadOfUsed() {
        assertEquals(tunnel, CrewRoute.cleanAddress("  $tunnel \n"))
        assertEquals("", CrewRoute.cleanAddress(""))
        assertEquals("", CrewRoute.cleanAddress("   "))
        assertEquals("", CrewRoute.cleanAddress(null))
        assertEquals("", CrewRoute.cleanAddress("https://crew.example.top"))
        // 只有前缀：形状就不对，拿去建客户端只会换来一句难懂的库错误。
        assertEquals("", CrewRoute.cleanAddress("tcp"))
        // 被截断的 TXT（长度不够）和两格粘在一起（中间有空白）都当没公布。
        assertEquals("", CrewRoute.cleanAddress(tunnel.take(20)))
        assertEquals("", CrewRoute.cleanAddress("$tunnel $tunnel"))
    }

    // 顺序是 P2P → 局域网 → 公网。这条顺序不随「上次哪条通」改写，否则更快的路会被排到后面。
    @Test
    fun theRoutesAreTriedP2pThenLocalNetworkThenPublic() {
        assertEquals(
            listOf(
                "http://127.0.0.1:43001",
                "http://192.168.31.127:43499",
                "https://crew.example.top",
            ),
            CrewRoute.entries(paired, proxyPort = 43001),
        )
    }

    // 代理没起来时不能留一条死入口在最前面：那等于每个请求都先白等一次超时。
    @Test
    fun aTunnelThatIsNotUpLeavesNoEntryBehind() {
        assertEquals(
            listOf("http://192.168.31.127:43499", "https://crew.example.top"),
            CrewRoute.entries(paired, proxyPort = null),
        )
    }

    // 没配外网入口的电脑只有附近能用：两条路，不是三条，也不补一个空串进来。
    @Test
    fun aCrewWithoutAPublicEntryHasOnlyTwoRoutes() {
        val nearOnly = paired.copy(fallbackBase = "")
        assertEquals(
            listOf("http://127.0.0.1:43001", "http://192.168.31.127:43499"),
            CrewRoute.entries(nearOnly, proxyPort = 43001),
        )
    }

    // 人可能把公网地址直接填进了电脑地址那一栏：同一条地址试两遍只是多等一次超时。
    @Test
    fun theSameAddressConfiguredTwiceIsOnlyTriedOnce() {
        val twice = paired.copy(base = "https://crew.example.top/")
        assertEquals(
            listOf("http://127.0.0.1:43001", "https://crew.example.top"),
            CrewRoute.entries(twice, proxyPort = 43001),
        )
    }

    // 地址写法不同（没协议、带尾斜杠）也要认得出是同一条路。
    @Test
    fun theWayInUseIsRecognisedFromTheAddress() {
        assertEquals(CrewRoute.Way.P2P, CrewRoute.kindOf("http://127.0.0.1:43001", paired, 43001))
        assertEquals(CrewRoute.Way.LAN, CrewRoute.kindOf("192.168.31.127:43499", paired, 43001))
        assertEquals(CrewRoute.Way.LAN, CrewRoute.kindOf("http://192.168.31.127:43499/", paired, 43001))
        assertEquals(CrewRoute.Way.PUBLIC, CrewRoute.kindOf("https://crew.example.top", paired, 43001))
        // 代理没起来时，回环那个地址也不该被认成 P2P —— 那是上一次会话留下的字符串。
        assertNull(CrewRoute.kindOf("http://127.0.0.1:43001", paired, null))
        // 手输了一个没见过的地址：认不出来就说认不出来，不乱猜。
        assertNull(CrewRoute.kindOf("http://10.0.0.9:43499", paired, 43001))
    }

    // 人可能把公网地址直接填进「电脑地址」那一栏（见去重那条测试）。按位置判就会把它说成局域网；
    // fallback 是电脑自己公布的出门地址，命中它就该说公网 —— 不管它在哪一格里出现过。
    @Test
    fun aPublicAddressFilledIntoTheBaseSlotIsStillPublic() {
        val swapped = paired.copy(base = "https://crew.example.top/")
        assertEquals(CrewRoute.Way.PUBLIC, CrewRoute.kindOf("https://crew.example.top", swapped, null))
    }

    // 一格地址都没配时，别拿空串碰上空串就说「这是局域网 / 公网」。
    @Test
    fun emptyPairingSlotsDoNotClaimARoute() {
        val empty = PairedCrew("dev-1", "tok-1", "", "", "")
        assertNull(CrewRoute.kindOf("", empty, null))
    }

    // 界面上那一行说的是「这条路是什么」，不是「连接正常」。
    @Test
    fun theLineOnScreenNamesTheWay() {
        assertEquals("隧道已连接", CrewRoute.label(CrewRoute.Way.P2P))
        assertEquals("局域网", CrewRoute.label(CrewRoute.Way.LAN))
        assertEquals("公网中转", CrewRoute.label(CrewRoute.Way.PUBLIC))
        assertEquals("自定义地址", CrewRoute.label(null))
    }

    @Test
    fun retryWaitGrowsAndStaysBounded() {
        assertEquals(listOf(1000L, 2000L, 4000L, 8000L, 16000L, 30000L, 30000L),
            (0..6).map(CrewRoute::retryDelay))
        assertEquals(1000L, CrewRoute.retryDelay(-1))
        assertEquals(30000L, CrewRoute.retryDelay(Int.MAX_VALUE))
    }

    @Test
    fun probeRequiresAuthenticatedTimelineAndOnlyAllows404ForLatency() {
        assertEquals(true, acceptsProbeStatus(200, false))
        assertEquals(false, acceptsProbeStatus(404, false))
        assertEquals(true, acceptsProbeStatus(404, true))
        for (status in listOf(301, 401, 403, 429, 500)) {
            assertEquals(false, acceptsProbeStatus(status, false))
            assertEquals(false, acceptsProbeStatus(status, true))
        }
    }

    // 一条地址都没有时（配对存下来的东西坏了）不能拼出一个空入口。
    @Test
    fun aCrewWithNoAddressAtAllYieldsNoEntries() {
        val empty = PairedCrew("dev-1", "tok-1", "", "", "")
        assertEquals(emptyList<String>(), CrewRoute.entries(empty, proxyPort = null))
    }

    // 隧道只说「连上了」加实测往返。RTT 快慢证明不了是直连还是 DERP 中继，
    // 所以不再拿它断言路径：1ms 和 137ms 用同一种措辞，只差那个实测数。
    @Test
    fun theTunnelLineReportsOnlyConnectionAndMeasuredLatency() {
        assertEquals("隧道已连接（1ms）", CrewRoute.tunnelLabel(1))
        assertEquals("隧道已连接（12ms）", CrewRoute.tunnelLabel(12))
        assertEquals("隧道已连接（40ms）", CrewRoute.tunnelLabel(40))
        assertEquals("隧道已连接（137ms）", CrewRoute.tunnelLabel(137))
        assertEquals("隧道已连接（146ms）", CrewRoute.tunnelLabel(146))
        // 没量到时间也只说连上了，不补一句没根据的「直连」。
        assertEquals("隧道已连接", CrewRoute.tunnelLabel(null))
    }

    // 那一行字只给隧道带实测值：换到局域网/公网之后，隧道那个数字跟这句话无关，不能顺手带出来。
    @Test
    fun theRouteLineCarriesTheMeasurementOnlyOnTheTunnel() {
        assertEquals("隧道已连接（3ms）", CrewRoute.label(CrewRoute.Way.P2P, 3))
        assertEquals("隧道已连接（137ms）", CrewRoute.label(CrewRoute.Way.P2P, 137))
        assertEquals("局域网", CrewRoute.label(CrewRoute.Way.LAN, 137))
        assertEquals("公网中转", CrewRoute.label(CrewRoute.Way.PUBLIC, 137))
        // 补的那句话仍然接在括号里，和实测值不打架。
        assertEquals("局域网（P2P 没通）", CrewRoute.label(CrewRoute.Way.LAN, null, "P2P 没通"))
        assertEquals("隧道已连接（137ms）", CrewRoute.label(CrewRoute.Way.P2P, 137, ""))
    }
}
