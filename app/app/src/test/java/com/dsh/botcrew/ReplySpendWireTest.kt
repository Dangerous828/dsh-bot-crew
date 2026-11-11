package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 逐条用量：`GET /api/mobile/reply-spend`。
 *
 * 钉住一条：**不知道就不写**。编一个余量比不写更危险 —— 人会拿它做决定。
 */
class ReplySpendWireTest {

    private val body = """
        {
          "available": true,
          "replies": [
            {"route": "magpie/k3", "input_tokens": 1200, "output_tokens": 300, "total_tokens": 1500, "context_left": 126800, "context_window": 128000},
            {"route": "dsh/m1", "input_tokens": 10, "output_tokens": 5, "total_tokens": 15}
          ],
          "quota": {"tightest_left": 126800, "context_window": 128000, "used_ratio": 0.0094, "warn_ratio": 0.9}
        }
    """.trimIndent()

    @Test
    fun `reads every step with its route and cost`() {
        val view = ReplySpendWire.parse(body)
        assertEquals(2, view.replies.size)
        assertEquals("magpie/k3", view.replies[0].route)
        assertEquals(1200, view.replies[0].inputTokens)
        assertEquals(126800, view.replies[0].contextLeft)
    }

    @Test
    fun `leaves the context left out when the provider did not disclose a window`() {
        val view = ReplySpendWire.parse(body)
        // 第二条没有 context_left：不写，也不拿 0 或 -1 冒充。
        assertNull(view.replies[1].contextLeft)
    }

    @Test
    fun `an unavailable answer has no steps instead of a fake zero`() {
        val view = ReplySpendWire.parse("""{"available": false, "reason": "这张票没有可读的用量记录"}""")
        assertTrue(view.replies.isEmpty())
        assertNull(view.usedRatio)
    }

    @Test
    fun `the line leaves unknown parts out instead of printing a placeholder`() {
        val withWindow = ReplySpend("magpie/k3", 1200, 300, 126800)
        assertEquals("magpie/k3 · 进 1.2k 出 300 · 余 126.8k", ReplySpendCopy.line(withWindow))
        val without = ReplySpend("dsh/m1", 10, 5, null)
        assertEquals("dsh/m1 · 进 10 出 5", ReplySpendCopy.line(without))
    }

    @Test
    fun `compact writes numbers the way a person reads them`() {
        assertEquals("0", ReplySpendCopy.compact(0))
        assertEquals("999", ReplySpendCopy.compact(999))
        assertEquals("1.2k", ReplySpendCopy.compact(1200))
        assertEquals("1.5M", ReplySpendCopy.compact(1_500_000))
    }

    @Test
    fun `a warning is shown as-is and silence stays silent`() {
        val warned = ReplySpendWire.parse("""{"available": true, "replies": [], "quota": {}, "warning": "上下文用到 95%" }""")
        assertEquals("上下文用到 95%", ReplySpendCopy.warning(warned))
        // 不告急时不写一句「额度充足」占位置。
        assertEquals("", ReplySpendCopy.warning(ReplySpendWire.parse(body)))
    }
}
