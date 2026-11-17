package com.dsh.botcrew

import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.Executors
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 答复控件的客户端契约（task-12）：审批卡的答复走专用 POST /api/mobile/answer，
 * body 只带必要三项（ticket / text / attention_id），**不带**任何可伪造的 actor；
 * 409（旧卡过期/票已结束/这句不是一个可执行的答复）单独抛 [AnswerStale]，
 * 并带上服务端 `{"error": "…"}` 的原话 —— 界面照实转述，不再一律说成「这张卡已更新」。
 *
 * 这条不再拼 `@某人 选项` 发 /send —— 那会让引擎起一段新活，而不是回这张卡的审批。
 */
class CrewClientAnswerTest {

    /** 收一次请求，记下方法、目标路径与 body 原文，然后按给定状态答话。 */
    private class Capture(status: Int, reply: String) {
        val path = java.util.concurrent.atomic.AtomicReference<String>("")
        val method = java.util.concurrent.atomic.AtomicReference<String>("")
        val body = java.util.concurrent.atomic.AtomicReference<String>("")
        val socket: ServerSocket = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).also { s ->
            s.soTimeout = 5_000
            Executors.newSingleThreadExecutor().apply {
                submit {
                    runCatching {
                        s.accept().use { c ->
                            c.soTimeout = 5_000
                            val input = c.getInputStream().buffered()
                            fun line(): String {
                                val t = StringBuilder()
                                while (true) {
                                    val b = input.read()
                                    if (b < 0 || b == '\n'.code) break
                                    if (b != '\r'.code) t.append(b.toChar())
                                }
                                return t.toString()
                            }
                            val requestLine = line().split(" ")
                            method.set(requestLine.getOrElse(0) { "" })
                            path.set(requestLine.getOrElse(1) { "" })
                            var length = 0
                            while (true) {
                                val h = line()
                                if (h.isEmpty()) break
                                if (h.startsWith("Content-Length:", ignoreCase = true)) {
                                    length = h.substringAfter(':').trim().toInt()
                                }
                            }
                            val bytes = ByteArray(length)
                            var read = 0
                            while (read < length) {
                                val n = input.read(bytes, read, length - read)
                                if (n < 0) break
                                read += n
                            }
                            body.set(String(bytes, 0, read, Charsets.UTF_8))
                            val out = reply.toByteArray()
                            c.getOutputStream().apply {
                                write(("HTTP/1.1 $status Reply\r\nContent-Length: ${out.size}\r\n" +
                                    "Connection: close\r\n\r\n").toByteArray())
                                write(out)
                                flush()
                            }
                        }
                    }
                }
                shutdown()
            }
        }
        val entry: String get() = "http://127.0.0.1:${socket.localPort}"
        fun close() = socket.close()
    }

    // 审批答复打到 /api/mobile/answer，body 只有 ticket/text/attention_id，绝不带 actor。
    @Test
    fun answerPostsToTheApprovalEndpointWithOnlyThreeFields() {
        val cap = Capture(200, """{"ok":true,"answer":"go","ticket":"tk-1","attention_id":"attention-approval-tk-1"}""")
        try {
            val client = CrewClient(listOf(cap.entry), "tok-1")
            runBlocking { client.answer("tk-1", "去改首页", "attention-approval-tk-1") }
            assertEquals("POST", cap.method.get())
            assertTrue("应打到 /api/mobile/answer，实际 ${cap.path.get()}", cap.path.get().endsWith("/api/mobile/answer"))
            val json = org.json.JSONObject(cap.body.get())
            assertEquals("tk-1", json.getString("ticket"))
            assertEquals("去改首页", json.getString("text"))
            assertEquals("attention-approval-tk-1", json.getString("attention_id"))
            assertTrue("body 不该出现 actor（身份只能由服务端认证）", !json.has("actor"))
        } finally {
            cap.close()
        }
    }

    // 409 → AnswerStale：绝不冒充成功，并且把服务端那句原话带出来（界面照实转述）。
    @Test
    fun a409BecomesAnswerStaleNotSuccess() {
        val cap = Capture(409, """{"error":"这张问题卡已经过期（票或请求已变），请刷新后再答"}""")
        try {
            val client = CrewClient(listOf(cap.entry), "tok-1")
            val error = assertThrows(AnswerStale::class.java) {
                runBlocking { client.answer("tk-1", "去改首页", "stale-id") }
            }
            assertEquals("这张问题卡已经过期（票或请求已变），请刷新后再答", error.reason)
        } finally {
            cap.close()
        }
    }

    // 409 的原因不止「卡过期」：认不出这句话也是 409，这时**不能**说成「卡已更新」。
    @Test
    fun a409ForAnUnrecognisedAnswerKeepsTheServersOwnWords() {
        val cap = Capture(409, """{"error":"这句不是一个可执行的答复"}""")
        try {
            val client = CrewClient(listOf(cap.entry), "tok-1")
            val error = assertThrows(AnswerStale::class.java) {
                runBlocking { client.answer("tk-1", "不用做了", "attention-connection-b27d050c") }
            }
            assertEquals("这句不是一个可执行的答复", error.reason)
            assertTrue("不该替服务端说成「已更新」", !error.reason.contains("已更新"))
        } finally {
            cap.close()
        }
    }

    // 409 的错误体读不出人话时，退回一句确定的兜底，不编原因。
    @Test
    fun a409WithoutAReadableErrorBodyFallsBackToTheKnownFact() {
        val cap = Capture(409, "not json at all")
        try {
            val client = CrewClient(listOf(cap.entry), "tok-1")
            val error = assertThrows(AnswerStale::class.java) {
                runBlocking { client.answer("tk-1", "去改首页", "attention-connection-x") }
            }
            assertEquals(AnswerStale.UNKNOWN, error.reason)
        } finally {
            cap.close()
        }
    }

    @Test
    fun errorReasonReadsOnlyTheErrorField() {
        assertEquals("这句不是一个可执行的答复", CrewWire.errorReason("""{"error":"这句不是一个可执行的答复"}"""))
        // 前后空白不算内容；空串与缺失都当没有。
        assertEquals("票已结束", CrewWire.errorReason("""{"error":"  票已结束  "}"""))
        assertEquals(null, CrewWire.errorReason("""{"error":"   "}"""))
        assertEquals(null, CrewWire.errorReason("""{"ok":false}"""))
        assertEquals(null, CrewWire.errorReason("""{"error":42}"""))
        assertEquals(null, CrewWire.errorReason(""))
        assertEquals(null, CrewWire.errorReason("<html>502</html>"))
    }

    // 别的失败（如 400/网络）不是过期：保持普通 IOException 语义，可重试同一事件。
    @Test
    fun otherFailuresAreNotTreatedAsStale() {
        val cap = Capture(400, """{"error":"text is required"}""")
        try {
            val client = CrewClient(listOf(cap.entry), "tok-1")
            val error = assertThrows(java.io.IOException::class.java) {
                runBlocking { client.answer("tk-1", "x", "attention-approval-tk-1") }
            }
            assertTrue("400 不该被当成过期（AnswerStale）", error !is AnswerStale)
        } finally {
            cap.close()
        }
    }
}
