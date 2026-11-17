package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * PairingRecord.probeState：启动快照要真实区分 missing / loaded / parse_error，
 * 不能把「prefs 损坏」伪装成「没配对」。detail 只描述键名层面问题，不带凭据值。
 */
class PairingRecordProbeTest {

    @Test
    fun missing_whenNoKeys() {
        val s = PairingRecord.probeState(emptyMap())
        assertEquals(PairingRecord.ReadState.MISSING, s.state)
    }

    @Test
    fun loaded_whenAllValid() {
        val s = PairingRecord.probeState(mapOf(
            PairingRecord.DEVICE to "dev1",
            PairingRecord.TOKEN to "tok1",
            PairingRecord.BASE to "http://192.168.31.127:43499",
        ))
        assertEquals(PairingRecord.ReadState.LOADED, s.state)
    }

    // ---- 身份不丢：旧记录缺新增 server 字段无损读取；save 保留 device/token/crew/session；prefs 名/键稳定 ----

    @Test
    fun legacyRecordWithoutServerFields_readsLosslessly() {
        // 早于 server 字段的旧记录：只有 device/token/base（+ 可能 crew/session）
        val old = mapOf<String, Any?>(
            PairingRecord.DEVICE to "devX",
            PairingRecord.TOKEN to "tokX",
            PairingRecord.BASE to "http://192.168.31.127:43499",
            PairingRecord.CREW to "0kvcc5t",
        )
        val p = PairingRecord.read(old)
        assertEquals("devX", p!!.deviceId)
        assertEquals("tokX", p.token)          // 凭据不丢
        assertEquals("0kvcc5t", p.crew)
        assertEquals("", p.serverCrew)          // 新增字段缺省空，不报错
        assertEquals("", p.serverPublicBase)
        assertEquals(SessionRoute.MAIN, p.session)
    }

    @Test
    fun writeForSave_preservesIdentity_andCurrentSessionOverrides() {
        val p = PairedCrew(
            deviceId = "devX", token = "tokX", base = "http://192.168.31.127:43499",
            fallbackBase = "https://crew.kentonnie.top", p2pAddr = "tcp...", crew = "0kvcc5t",
            session = "main", serverCrew = "0kvcc5t", serverPublicBase = "https://crew.kentonnie.top",
        )
        // 盘上当前会话是 work：save 必须保留 work，不因传入 main 而回退
        val saved = PairingRecord.writeForSave(p, currentSession = "work")
        assertEquals("devX", saved[PairingRecord.DEVICE]) // 身份保留
        assertEquals("tokX", saved[PairingRecord.TOKEN])
        assertEquals("0kvcc5t", saved[PairingRecord.CREW])
        assertEquals("work", saved[PairingRecord.SESSION]) // 会话保留盘上现值
        // 新增 server 字段也落盘
        assertEquals("0kvcc5t", saved[PairingRecord.SERVER_CREW])
        assertEquals("https://crew.kentonnie.top", saved[PairingRecord.SERVER_PUBLIC_BASE])
    }

    @Test
    fun changeRouteOnly_preservesDeviceTokenCrew() {
        // 改 fallback（route 自愈）只动 fallbackBase，身份字段逐字不变
        val p = PairedCrew("devX", "tokX", "http://192.168.31.127:43499", crew = "0kvcc5t")
        val updated = p.copy(fallbackBase = "https://crew.kentonnie.top")
        val w0 = PairingRecord.write(p)
        val w1 = PairingRecord.write(updated)
        for (k in listOf(PairingRecord.DEVICE, PairingRecord.TOKEN, PairingRecord.CREW)) {
            assertEquals("改 route 不得动身份字段 $k", w0[k], w1[k])
        }
        assertEquals("https://crew.kentonnie.top", w1[PairingRecord.FALLBACK])
    }

    @Test
    fun prefsNameAndKeysAreStableContract() {
        // 这些是「新包能读到旧包写的凭据」的硬契约：文件名与键名不得变。
        assertEquals("crew-pairing", PairingRecord.PAIRING_PREFS)
        assertEquals("deviceId", PairingRecord.DEVICE)
        assertEquals("token", PairingRecord.TOKEN)
        assertEquals("base", PairingRecord.BASE)
        assertEquals("fallbackBase", PairingRecord.FALLBACK)
        assertEquals("p2pAddr", PairingRecord.P2P)
        assertEquals("crew", PairingRecord.CREW)
        assertEquals("session", PairingRecord.SESSION)
    }

    @Test
    fun parseError_whenBaseMissing() {
        val s = PairingRecord.probeState(mapOf(
            PairingRecord.DEVICE to "dev1",
            PairingRecord.TOKEN to "tok1",
            // 没有 BASE —— 有残留但不是完整配对
        ))
        assertEquals(PairingRecord.ReadState.PARSE_ERROR, s.state)
    }

    @Test
    fun parseError_whenBaseUnnormalizable() {
        val s = PairingRecord.probeState(mapOf(
            PairingRecord.DEVICE to "dev1",
            PairingRecord.TOKEN to "tok1",
            PairingRecord.BASE to "   ",
        ))
        assertEquals(PairingRecord.ReadState.PARSE_ERROR, s.state)
    }

    @Test
    fun parseError_whenValueWrongType() {
        val s = PairingRecord.probeState(mapOf(
            PairingRecord.DEVICE to 123,  // 不是字符串
            PairingRecord.TOKEN to "tok1",
            PairingRecord.BASE to "http://x:1",
        ))
        assertEquals(PairingRecord.ReadState.PARSE_ERROR, s.state)
    }

    @Test
    fun detail_doesNotLeakSecretValues() {
        val s = PairingRecord.probeState(mapOf(
            PairingRecord.DEVICE to "dev1",
            PairingRecord.TOKEN to "", // 空 → 问题
            PairingRecord.BASE to "http://x:1",
        ))
        assertEquals(PairingRecord.ReadState.PARSE_ERROR, s.state)
        // detail 只谈键名，不含任何值
        assertEquals(false, s.detail.contains("dev1"))
        assertEquals(false, s.detail.contains("http://x:1"))
    }
}
