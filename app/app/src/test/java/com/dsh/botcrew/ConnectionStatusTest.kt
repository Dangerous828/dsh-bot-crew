package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 连接状态三档 + 摘要文案 + 启动命令。
 *
 * 这些是纯函数，放进 JVM 单测钉住——因为它们是「能不能冒充已连接」的唯一判据：
 * 拉回首份数据前、或已知有错时，界面绝不能显示绿色「已连接」。
 */
class ConnectionStatusTest {

    // ── statusTone：绿只在真正 OK 时 ──

    @Test
    fun loadingIsNeverGreen() {
        assertEquals(Tone.WAIT, statusTone(loading = true, problem = null))
        assertEquals(Tone.WAIT, statusTone(loading = true, problem = ""))
    }

    @Test
    fun problemIsAlwaysRedAndOutranksLoading() {
        assertEquals(Tone.PROBLEM, statusTone(loading = false, problem = "connection refused"))
        // 即便还在 loading，只要已拿到一个错因，就是红而不是灰。
        assertEquals(Tone.PROBLEM, statusTone(loading = true, problem = "boom"))
    }

    @Test
    fun onlySettledNoProblemIsOk() {
        assertEquals(Tone.OK, statusTone(loading = false, problem = null))
        assertEquals(Tone.OK, statusTone(loading = false, problem = ""))
    }

    // ── summaryText：一行人话 ──

    @Test
    fun loadingSummaryDoesNotClaimConnected() {
        val s = summaryText(route = "局域网", loading = true, problem = null)
        assertEquals("正在连接…", s)
        assertTrue("加载中不得出现「已连接」", !s.contains("已连接"))
    }

    @Test
    fun problemSummaryShowsProblemAndNoGreen() {
        val s = summaryText(route = "局域网", loading = false, problem = "timed out")
        assertEquals("连不上 · timed out", s)
        assertTrue(!s.contains("已连接"))
    }

    @Test
    fun longProblemIsTruncated() {
        val long = "x".repeat(80)
        val s = summaryText(route = "", loading = false, problem = long)
        assertTrue(s.length <= "连不上 · ".length + 41)
        assertTrue(s.endsWith("…"))
    }

    @Test
    fun connectedShowsRoute() {
        assertEquals("已连接 · 隧道已连接（12ms）", summaryText("隧道已连接（12ms）", loading = false, problem = null))
    }

    @Test
    fun connectedWithBlankRouteJustSaysConnected() {
        assertEquals("已连接", summaryText(route = "", loading = false, problem = null))
        assertEquals("已连接", summaryText(route = "   ", loading = false, problem = null))
    }

    // ── shortSummary：紧凑顶栏那一行 ──

    @Test
    fun compactChipsDownToShortWords() {
        assertEquals("局域网", shortSummary("局域网", loading = false, problem = null))
        assertEquals("隧道", shortSummary("隧道已连接（12ms）", loading = false, problem = null))
        assertEquals("公网", shortSummary("公网中转", loading = false, problem = null))
        assertEquals("已连接", shortSummary("", loading = false, problem = null))
    }

    @Test
    fun compactLoadingNeverSaysConnected() {
        assertEquals("连接中", shortSummary("局域网", loading = true, problem = null))
        assertEquals("连不上", shortSummary("局域网", loading = false, problem = "boom"))
    }

    @Test
    fun compactUnknownRouteIsTruncated() {
        assertEquals("一些很奇怪的东西".take(6), shortSummary("一些很奇怪的东西", loading = false, problem = null))
    }

    // ── 健康点语义绿：不随分拣台红棕 accent 变红 ──

    @Test
    fun healthyDotGreenIsFixedPerThemeNotPaletteAccent() {
        // 亮底取深绿 #3E6B62，暗底取亮绿 #5FBFA8——都是固定语义绿，
        // 与传入 palette 的 accent 无关（分拣台 accent 是红棕，复用会把健康画成红）。
        assertEquals(androidx.compose.ui.graphics.Color(0xFF3E6B62), greenFor(dark = false))
        assertEquals(androidx.compose.ui.graphics.Color(0xFF5FBFA8), greenFor(dark = true))
    }

    @Test
    fun greenForIsStableRegardlessOfCallerPalette() {
        // 两次同参数必须同色，证明它不看外部 palette 状态。
        assertEquals(greenFor(false), greenFor(false))
        assertEquals(greenFor(true), greenFor(true))
    }

    // ── 启动命令：逐字钉住，防止文案漂移 ──

    @Test
    fun startCommandIsExact() {
        assertEquals(
            "cd /Users/cpuser/Code/dsh-bot-crew && python3 backend/scripts/dsh-superagent start --profile superagent",
            ConnectionGuidance.START_COMMAND,
        )
    }

    @Test
    fun startCommandUsesStartNotRestart() {
        // 日常只在服务停止时跑一次 start；restart 会打断在跑的服务。
        assertTrue(ConnectionGuidance.START_COMMAND.contains(" start "))
        assertTrue(!ConnectionGuidance.START_COMMAND.contains("restart"))
    }
}
