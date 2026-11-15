package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 推送轮询健康度的可观察性（task-10 第三根因：notices 拉取失败被静默吞掉）。
 *
 * 用例钉住三点：失败要累加并留存原因、成功清零并标记曾成功、界面文案只在失败态出现且如实报次数。
 */
class NoticesHealthTest {

    @Test
    fun initialIsHealthyAndShowsNothing() {
        val health = NoticesHealth()
        assertFalse(health.failing)
        assertEquals("", health.line())
    }

    @Test
    fun oneFailureEntersFailingStateWithCountAndReason() {
        val health = NoticesHealth().onFailure("use of closed network connection")
        assertTrue(health.failing)
        assertEquals(1, health.consecutiveFailures)
        val line = health.line()
        assertTrue("文案要报次数：$line", line.contains("第 1 次"))
        assertTrue("文案要带原因：$line", line.contains("use of closed network connection"))
    }

    @Test
    fun consecutiveFailuresAccumulateInsteadOfMasking() {
        val health = NoticesHealth().onFailure("a").onFailure("b").onFailure("c")
        assertEquals(3, health.consecutiveFailures)
        assertTrue(health.line().contains("第 3 次"))
        assertEquals("c", health.lastError)
    }

    @Test
    fun oneSuccessClearsCountAndReturnsToNormal() {
        val health = NoticesHealth().onFailure("boom").onFailure("boom again").onSuccess()
        assertFalse("成功后不该还在失败态", health.failing)
        assertEquals("", health.line())
        assertTrue("成功过要记下来", health.everSucceeded)
        assertEquals(0, health.consecutiveFailures)
    }

    @Test
    fun blankReasonStillGetsFallbackLine() {
        val health = NoticesHealth().onFailure("")
        assertTrue(health.failing)
        assertEquals("推送拉取失败", health.lastError)
    }
}
