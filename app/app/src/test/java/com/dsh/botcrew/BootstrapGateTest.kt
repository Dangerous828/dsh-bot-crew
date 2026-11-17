package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * BootstrapGate：bootstrap 准入的纯函数判定。
 *
 * 核心是被 lead 点名的那条红线：**空 savedCrew 绝不 bootstrap 发 token**，不能拿 build 预期值
 * 伪装成已登记身份；预期不符 / 配置为空 / 已有 fallback 一律 0 请求（allowed=false）。
 */
class BootstrapGateTest {

    private val base = "https://crew.kentonnie.top"
    private val crew = "0kvcc5t"

    @Test
    fun emptySavedCrew_neverBootstraps() {
        val d = BootstrapGate.decide(savedCrew = "", injectedBase = base, expectedCrew = crew, savedFallback = "")
        assertFalse(d.allowed)
        // 即使 expected 配了值，也不能用 expected 冒充 savedCrew
        assertTrue(d.reason.contains("空 savedCrew"))
    }

    @Test
    fun savedCrewMismatch_rejected() {
        val d = BootstrapGate.decide(savedCrew = "other1", injectedBase = base, expectedCrew = crew, savedFallback = "")
        assertFalse(d.allowed)
        assertTrue(d.reason.contains("不符"))
    }

    @Test
    fun genericEmptyConfig_neverBootstraps() {
        // generic 包：injectedBase / expectedCrew 默认空 → 即使 savedCrew 有值也不联网 bootstrap。
        val noBase = BootstrapGate.decide(savedCrew = crew, injectedBase = "", expectedCrew = crew, savedFallback = "")
        assertFalse(noBase.allowed)
        val noExpect = BootstrapGate.decide(savedCrew = crew, injectedBase = base, expectedCrew = "", savedFallback = "")
        assertFalse(noExpect.allowed)
    }

    @Test
    fun existingFallback_noBootstrap() {
        val d = BootstrapGate.decide(savedCrew = crew, injectedBase = base, expectedCrew = crew, savedFallback = "https://old.example")
        assertFalse(d.allowed)
        assertTrue(d.reason.contains("已有公网入口"))
    }

    @Test
    fun allMatch_allowsWithParams() {
        val d = BootstrapGate.decide(savedCrew = crew, injectedBase = base, expectedCrew = crew, savedFallback = "")
        assertTrue(d.allowed)
        assertEquals(base, d.base)
        assertEquals(crew, d.expectCrew)
    }

    // ---- UploadEndpoint：上传入口只从可信 HTTPS 取，绝不硬编码 crew 域名 ----

    @Test
    fun upload_prefersServerPublicBase() {
        val d = UploadEndpoint.decide("https://crew.kentonnie.top", "https://old.example", crew, "", crew)
        assertEquals("https://crew.kentonnie.top", d.url)
        assertEquals("serverPublicBase", d.reason)
    }

    @Test
    fun upload_fallsBackToHttpsFallback() {
        val d = UploadEndpoint.decide("", "https://old.example", crew, "", crew)
        assertEquals("https://old.example", d.url)
    }

    @Test
    fun upload_diagBaseOnlyWhenCrewMatches() {
        val ok = UploadEndpoint.decide("", "", crew, "https://crew.kentonnie.top", crew)
        assertEquals("https://crew.kentonnie.top", ok.url)
        // crew 不匹配 → 拒绝（不拿预期值伪装身份）
        val bad = UploadEndpoint.decide("", "", "other", "https://crew.kentonnie.top", crew)
        assertEquals("", bad.url)
        // savedCrew 空 → 拒绝
        val empty = UploadEndpoint.decide("", "", "", "https://crew.kentonnie.top", crew)
        assertEquals("", empty.url)
    }

    @Test
    fun upload_rejectsNonHttpsAndUserinfo() {
        assertEquals("", UploadEndpoint.decide("http://crew.x", "", "", "", "").url)
        assertEquals("", UploadEndpoint.decide("https://u:p@crew.x", "", "", "", "").url)
        assertEquals("", UploadEndpoint.decide("https://crew.x?t=1", "", "", "", "").url)
    }

    @Test
    fun upload_noSourceAtAll_empty() {
        val d = UploadEndpoint.decide("", "", crew, "", crew)
        assertEquals("", d.url)
        assertTrue(d.reason.contains("no_trusted"))
    }
}
