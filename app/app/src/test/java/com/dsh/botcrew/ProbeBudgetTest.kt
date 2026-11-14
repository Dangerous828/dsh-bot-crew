package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 探测预算的边界。这条纯函数存在的唯一理由是一个实测过的坑：
 * 预算耗尽时若返回 0，`HttpURLConnection.readTimeout = 0` 是**无限等待**，
 * 探测会永久挂住，连带主线程上的调试口与界面一起卡死（真机上表现为全黑屏）。
 */
class ProbeBudgetTest {

    private val ms = 1_000_000L

    @Test
    fun `预算充足时用等待上限`() {
        // 还剩 100 秒，单步上限 15 秒：取小的那个，即 15 秒。
        assertEquals(15_000, probeBudget(deadlineNanos = 100_000 * ms, nowNanos = 0, waitMs = 15_000))
    }

    @Test
    fun `预算比等待上限少时用预算`() {
        // 只剩 3 秒，而单步上限 15 秒：只能用 3 秒，不能傻等 15 秒。
        assertEquals(3_000, probeBudget(deadlineNanos = 3_000 * ms, nowNanos = 0, waitMs = 15_000))
    }

    @Test
    fun `预算耗尽返回负一而不是零`() {
        // 这是那条坑本身：返回 0 会被当成「无限等待」。
        assertEquals(-1, probeBudget(deadlineNanos = 0, nowNanos = 5 * ms, waitMs = 15_000))
        assertEquals(-1, probeBudget(deadlineNanos = 0, nowNanos = 0, waitMs = 15_000))
    }

    @Test
    fun `剩不到一毫秒也算耗尽`() {
        // 亚毫秒余量向下取整成 0 会变成「无限等待」，必须归到 -1。
        assertEquals(-1, probeBudget(deadlineNanos = 500_000L, nowNanos = 0, waitMs = 15_000))
    }
}
