package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 「地址跟着寻址走」这层的纯逻辑。
 *
 * 配对那一刻存下的局域网地址是网段相关的：电脑换个 Wi-Fi、IP 全变，它就是另一台
 * 甚至不存在。刷新只认 mDNS 的 crew 指纹（stateDir 派生，与网卡无关），地址一律取
 * 当次广播的现值；认不出就不猜。这段不涉及 Android / NSD，所以能直接在 JVM 上钉住。
 */
class CrewRefreshTest {

    private val paired = PairedCrew(
        deviceId = "dev-1",
        token = "tok-1",
        base = "http://192.168.31.127:43499",
        fallbackBase = "https://crew.example.top",
        p2pAddr = "tcpOLD",
        crew = "fingerprint-7",
    )

    private fun beacon(
        crew: String = "fingerprint-7",
        base: String = "http://192.168.31.127:43499",
        publicBase: String = "",
        p2pAddr: String = "",
    ) = CrewBeacon("dsh-crew-1", base, publicBase, p2pAddr, crew)

    // 同一台换了局域网地址：只更新 base，凭据与另外两条路原样保留。
    @Test
    fun theSameCrewOnANewAddressRefreshesOnlyTheLanBase() {
        val back = CrewNearby.refresh(paired, beacon(base = "http://10.0.0.9:43499"))
        assertEquals("http://10.0.0.9:43499", back?.base)
        assertEquals(paired.deviceId, back?.deviceId)
        assertEquals(paired.token, back?.token)
        assertEquals(paired.fallbackBase, back?.fallbackBase)
        assertEquals(paired.p2pAddr, back?.p2pAddr)
        assertEquals(paired.crew, back?.crew)
    }

    // 指纹对不上（同网段另一台队伍）：绝不把别人的地址写进来。
    @Test
    fun aDifferentCrewNeverOverwritesThePairing() {
        assertNull(CrewNearby.refresh(paired, beacon(crew = "another-crew", base = "http://10.0.0.9:43499")))
    }

    // 任一侧没指纹就不猜：手输地址配对的、或广播没带 crew 的，都保持原样。
    @Test
    fun aMissingFingerprintOnEitherSideRefreshesNothing() {
        assertNull(CrewNearby.refresh(paired.copy(crew = ""), beacon(base = "http://10.0.0.9:43499")))
        assertNull(CrewNearby.refresh(paired, beacon(crew = "", base = "http://10.0.0.9:43499")))
    }

    // 广播的地址与已存的一样（只是写法不同）：归一化后没有变化，不该写盘、不该重建连接。
    @Test
    fun anUnchangedAddressIsNotAChange() {
        assertNull(CrewNearby.refresh(paired, beacon(base = "192.168.31.127:43499/")))
        assertNull(CrewNearby.refresh(paired, beacon(base = "http://192.168.31.127:43499")))
    }

    // 电脑重启后换了公网入口和隧道地址：按当次广播更新，别抱着旧的。
    @Test
    fun aRotatedPublicOrTunnelRouteFollowsTheBroadcast() {
        val back = CrewNearby.refresh(
            paired,
            beacon(publicBase = "https://new.example.top", p2pAddr = "tcpNEW"),
        )
        assertEquals("https://new.example.top", back?.fallbackBase)
        assertEquals("tcpNEW", back?.p2pAddr)
    }

    // 一次短暂广播缺了 pub / p2p：不能把已经存好的、出门唯一能走的那两条路抹掉。
    @Test
    fun aBroadcastWithoutPublicRoutesNeverWipesTheSavedOnes() {
        val back = CrewNearby.refresh(paired, beacon(base = "http://10.0.0.9:43499"))
        assertEquals("https://crew.example.top", back?.fallbackBase)
        assertEquals("tcpOLD", back?.p2pAddr)
    }

    // 地址归一化：少 scheme、带尾斜杠都算同一个地址，不会触发空转。
    @Test
    fun aHandWrittenAddressShapeIsNormalisedBeforeComparison() {
        val refreshed = CrewNearby.refresh(paired, beacon(base = "10.0.0.9:43499/"))
        assertEquals("http://10.0.0.9:43499", refreshed?.base)
        // 再刷一次同样的地址：已归一化，返回 null，不会反复重建。
        assertNull(CrewNearby.refresh(refreshed!!, beacon(base = "10.0.0.9:43499/")))
    }

    // 发现流的去重签名：完全相同的重复上报是一条，地址或路由变了必须是新的一条。
    @Test
    fun aChangedAddressProducesANewDiscoverySignature() {
        val first = CrewNearby.signature(beacon(base = "http://192.168.31.127:43499"))
        assertEquals(first, CrewNearby.signature(beacon(base = "http://192.168.31.127:43499")))
        org.junit.Assert.assertNotEquals(
            first,
            CrewNearby.signature(beacon(base = "http://10.0.0.9:43499")),
        )
    }

    @Test
    fun aChangedPublicOrTunnelRouteAlsoProducesANewSignature() {
        val first = CrewNearby.signature(beacon())
        org.junit.Assert.assertNotEquals(first, CrewNearby.signature(beacon(publicBase = "https://new.example.top")))
        org.junit.Assert.assertNotEquals(first, CrewNearby.signature(beacon(p2pAddr = "tcpNEW")))
        org.junit.Assert.assertNotEquals(first, CrewNearby.signature(beacon(crew = "other")))
    }

    // A→B→A：调用方必须拿「上一次已应用的配对」当比较基准，不能一直拿最初的 A。
    // 否则第三条与旧 A 相等会被判「无变化」，磁盘与入口表永久停在 B。
    @Test
    fun aReturnToTheOriginalAddressIsStillAChange() {
        val a = beacon(base = "http://192.168.31.127:43499")
        val b = beacon(base = "http://10.0.0.9:43499")
        val toB = CrewNearby.refresh(paired, b)!!
        assertEquals("http://10.0.0.9:43499", toB.base)
        val backToA = CrewNearby.refresh(toB, a)
        assertEquals("http://192.168.31.127:43499", backToA?.base)
        // 重复广播同一条：已应用过就是无变化，不写盘、不换表。
        assertNull(CrewNearby.refresh(toB, b))
    }
}
