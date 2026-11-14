package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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

    // ── 老配对记录（没有 crew 指纹）──────────��─────────────────────────────
    //
    // `crew` 是后加的字段。加之前配好的记录里没有它，于是这条地址永远不会自更新 ——
    // 那正是 issue 里「死地址一直绕公网」的第一环。真机上这份记录就是这样：
    // 只有 deviceId/token/base/fallbackBase/p2pAddr，没有 crew。

    // 老记录 + 广播里隧道地址逐字相同 = 同一台。tc-addr 里内嵌的是这台电脑的密钥，
    // 两台机器撞不上，所以这是硬证据，不是猜。地址跟着更新，并把指纹补进去。
    @Test
    fun anOldRecordWithoutAFingerprintStillFollowsTheSameMachine() {
        val old = paired.copy(crew = "")
        val back = CrewNearby.refresh(old, beacon(base = "http://192.168.31.127:43499", p2pAddr = "tcpOLD"))
        assertEquals("http://192.168.31.127:43499", back?.base)
        // 这次认出来了，指纹顺手补上：下次走强判据，不必再靠隧道地址。
        assertEquals("fingerprint-7", back?.crew)
        // 凭据一个字都不动。
        assertEquals(old.deviceId, back?.deviceId)
        assertEquals(old.token, back?.token)
    }

    // 老记录 + 广播里的隧道地址**不同** = 不是同一台（或这台电脑换了密钥）：
    // 这时绝不猜，保持原样。宁可让人重配对，也不能把别人的地址写进来。
    @Test
    fun anOldRecordWithADifferentTunnelAddressIsNotTheSameMachine() {
        val old = paired.copy(crew = "")
        assertNull(CrewNearby.refresh(old, beacon(base = "http://10.0.0.9:43499", p2pAddr = "tcpSOMEONE_ELSE")))
    }

    // 老记录 + 广播里没有隧道地址（P2P 没起）：没有可比的证据，不猜。
    @Test
    fun anOldRecordWithNoComparableEvidenceIsLeftAlone() {
        val old = paired.copy(crew = "")
        assertNull(CrewNearby.refresh(old, beacon(base = "http://10.0.0.9:43499", p2pAddr = "")))
    }

    // 老记录 + 自己也没存隧道地址（手工输地址配的）：两边都空，同样不猜。
    @Test
    fun anOldRecordWithNoTunnelAddressAtAllIsLeftAlone() {
        val old = paired.copy(crew = "", p2pAddr = "")
        assertNull(CrewNearby.refresh(old, beacon(base = "http://10.0.0.9:43499", p2pAddr = "tcpNEW")))
    }

    // 配对记录有指纹、但这次广播没带：仍然按指纹认（正路），不退回隧道地址 ——
    // 一条缺项的广播不该把判据换掉。
    @Test
    fun aRecordWithAFingerprintDoesNotFallBackToTheTunnelAddress() {
        // 指纹相同、隧道地址不同（电脑重启后换了密钥）：还是同一台，照旧更新。
        val back = CrewNearby.refresh(paired, beacon(base = "http://10.0.0.9:43499", p2pAddr = "tcpNEW"))
        assertEquals("http://10.0.0.9:43499", back?.base)
        // 指纹不同、隧道地址相同：指纹说不是同一台，就不动 —— 指纹是正路，优先级更高。
        assertNull(
            CrewNearby.refresh(
                paired,
                beacon(crew = "another-crew", base = "http://10.0.0.9:43499", p2pAddr = "tcpOLD"),
            ),
        )
    }

    // 这条配对记录能不能自更新，界面要能提前说清：不能的时候，电脑下次换 IP 只能人工重配对。
    @Test
    fun selfUpdateCapabilityIsDecidedByWhichIdentityClueExists() {
        assertTrue("有指纹就能自更新", CrewNearby.canSelfUpdate(paired))
        assertTrue("只有隧道地址也能自更新", CrewNearby.canSelfUpdate(paired.copy(crew = "")))
        assertFalse(
            "两样都没有：只能人工重配对",
            CrewNearby.canSelfUpdate(paired.copy(crew = "", p2pAddr = "")),
        )
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
