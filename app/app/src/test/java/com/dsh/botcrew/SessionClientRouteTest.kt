package com.dsh.botcrew

import java.net.InetAddress
import java.net.ServerSocket
import java.util.Collections
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

private data class Request(val method: String, val path: String, val body: String)

/** 回一条响应并把这次请求记下来。body 长度由 Content-Length 给出，读不到就当没有。 */
private fun serveOne(
    server: ServerSocket,
    status: Int,
    body: String,
    seen: AtomicReference<Request>,
) {
    server.accept().use { socket ->
        socket.soTimeout = 5_000
        // 按字节读 header 与 body：Content-Length 是字节数。用 BufferedReader 读 CharArray
        // 时中文 UTF-8 一个字占 3 字节，服务端会一直等那几个不存在的字符，
        // 客户端则等响应 —— 那是测试脚手架的死锁，不是被测逻辑的问题。
        val input = socket.getInputStream().buffered()
        fun line(): String {
            val text = StringBuilder()
            while (true) {
                val byte = input.read()
                if (byte < 0 || byte == '\n'.code) break
                if (byte != '\r'.code) text.append(byte.toChar())
            }
            return text.toString()
        }
        val start = line().split(" ")
        var length = 0
        while (true) {
            val header = line()
            if (header.isEmpty()) break
            if (header.startsWith("Content-Length:", ignoreCase = true)) {
                length = header.substringAfter(':').trim().toInt()
            }
        }
        val payload = ByteArray(length)
        var read = 0
        while (read < length) {
            val count = input.read(payload, read, length - read)
            require(count > 0)
            read += count
        }
        seen.set(Request(start[0], start[1], String(payload, Charsets.UTF_8)))
        val bytes = body.toByteArray()
        socket.getOutputStream().apply {
            write("HTTP/1.1 $status Reply\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
            write(bytes)
            flush()
        }
    }
}

/**
 * 真发一次请求，看 request line 上的那条路径（契约 §1）。
 *
 * 用本地 socket 起一个只说不的手机面，不碰运行中服务、不碰网络：
 * 默认/显式 main 逐字不变，非 main 才出现 `?session_id=`。
 * 多请求序列用一台 [PhoneServer]；连续 POST 用 [capture] 每次一台独立 server ——
 * JDK 的 HttpURLConnection 会复用 keep-alive 连接，那与被测的路径规则无关，
 * 让每条 POST 独占一个端口才是稳定的观测点。
 */
class SessionClientRouteTest {

    /** 每条请求按顺序回一个固定响应。replies 为空时不 accept（本地拒绝的用例用它）。 */
    private class PhoneServer(private val replies: List<Pair<Int, String>>) : AutoCloseable {
        private val server = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        private val seen = Collections.synchronizedList(mutableListOf<Request>())
        private val recorded = AtomicReference<Request>()
        private val executor = Executors.newSingleThreadExecutor()
        val client = CrewClient(listOf("http://127.0.0.1:${server.localPort}"), "test-token")

        init {
            server.soTimeout = 5_000
            executor.submit {
                for ((status, body) in replies) {
                    try {
                        serveOne(server, status, body, recorded)
                        seen.add(checkNotNull(recorded.get()))
                        recorded.set(null)
                    } catch (_: Exception) {
                        return@submit
                    }
                }
            }
        }

        fun requests(): List<Request> = seen.toList()

        override fun close() {
            server.close()
            executor.shutdownNow()
        }
    }

    /** 一条请求、一台独立 server：不给 keep-alive 留任何串台的可能。 */
    private fun capture(
        response: String = "{}",
        status: Int = 200,
        call: suspend (CrewClient) -> Unit,
    ): Request {
        val server = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        server.soTimeout = 5_000
        val seen = AtomicReference<Request>()
        val executor = Executors.newSingleThreadExecutor()
        val future = executor.submit { serveOne(server, status, response, seen) }
        try {
            runBlocking { call(CrewClient(listOf("http://127.0.0.1:${server.localPort}"), "test-token")) }
            future.get(5, TimeUnit.SECONDS)
        } finally {
            server.close()
            executor.shutdownNow()
        }
        return checkNotNull(seen.get()) { "请求没有到达本地手机面" }
    }

    private fun reply(body: String = "{}", status: Int = 200) = status to body
    private fun replies(count: Int, body: String = "{}"): List<Pair<Int, String>> = List(count) { reply(body) }

    @Test
    fun aDefaultOrExplicitMainTimelineKeepsTheExactPath() {
        PhoneServer(replies(3)).use { phone ->
            runBlocking {
                phone.client.timeline()
                phone.client.timeline("main")
                phone.client.timeline("work")
            }
            assertEquals(
                listOf(
                    "/api/mobile/timeline",
                    "/api/mobile/timeline",
                    "/api/mobile/timeline?session_id=work",
                ),
                waitForPaths(phone, 3),
            )
        }
    }

    @Test
    fun everySessionOperationAppendsTheQueryOnlyForNonMain() {
        val nonMain = listOf(
            capture { it.send("你好", emptyList(), "r1", sessionId = "work") },
            capture { it.reportRead("m1", sessionId = "work") },
            capture { it.withdraw("r1", sessionId = "work") },
            capture { it.steer("t1", "r1", sessionId = "work") },
            capture { it.steerText("t1", "r2", "插一句", sessionId = "work") },
        )
        for (request in nonMain) assertTrue(request.path, request.path.endsWith("?session_id=work"))
        assertEquals(
            setOf("/api/mobile/send", "/api/mobile/read", "/api/mobile/withdraw", "/api/mobile/steer"),
            nonMain.map { it.path.substringBefore('?') }.toSet(),
        )
        val bare = listOf(
            capture { it.send("你好", emptyList(), "r1") },
            capture { it.reportRead("m1") },
            capture { it.withdraw("r1") },
            capture { it.steer("t1", "r1") },
            capture { it.steerText("t1", "r2", "插一句") },
        )
        for (request in bare) assertFalse(request.path, request.path.contains("session_id"))
    }

    @Test
    fun bareCallsNeverCarryASessionEvenRightAfterAnExplicitNonMainOne() {
        // 契约 §4：缺省严格「不带 query」，客户端不持有会偷偷改写路径的全局会话。
        PhoneServer(replies(3)).use { phone ->
            runBlocking {
                phone.client.timeline("work")
                phone.client.timeline()
                phone.client.timeline("main")
            }
            assertEquals(
                listOf(
                    "/api/mobile/timeline?session_id=work",
                    "/api/mobile/timeline",
                    "/api/mobile/timeline",
                ),
                waitForPaths(phone, 3),
            )
        }
    }

    @Test
    fun sessionListCallsUseTheirOwnExactPathsAndCarryNoSessionId() {
        PhoneServer(listOf(
            reply("""{"sessions":["main","work"],"default_session_id":"main","session_api":1}"""),
            reply("""{"id":"work","sessions":["main","work"],"session_api":1}"""),
        )).use { phone ->
            runBlocking {
                val listed = phone.client.sessions()
                assertEquals(listOf("main", "work"), listed.sessions.map { it.id })
                assertTrue(listed.sessionApi)
                val created = phone.client.createSession("work")
                assertEquals("work", created.createdId)
                assertEquals("main", created.defaultSessionId)
            }
            val requests = waitFor(phone, 2)
            assertEquals("GET", requests[0].method)
            assertEquals("/api/mobile/sessions", requests[0].path)
            assertEquals("POST", requests[1].method)
            assertEquals("/api/mobile/sessions", requests[1].path)
            assertEquals("work", org.json.JSONObject(requests[1].body).getString("id"))
        }
    }

    @Test
    fun nonSessionOperationsNeverCarryASessionId() {
        val body = """{"providers":[],"current":null,"bot_models":{},"failures":[],"state":"live","items":[],"counts":{}}"""
        PhoneServer(replies(3, body)).use { phone ->
            runBlocking {
                phone.client.timeline("work")
                phone.client.models()
                phone.client.routines()
            }
            val requests = waitFor(phone, 3)
            assertTrue(requests[0].path, requests[0].path.endsWith("?session_id=work"))
            // 同一个 client 刚发过非 main 请求，与会话无关的接口仍一个参数都不带。
            for (request in requests.drop(1)) assertFalse(request.path, request.path.contains("session_id"))
        }
    }

    @Test
    fun anExplicit404OnASecondEntryWinsOverAnEarlierNetworkError() {
        // 第一条入口连不上、第二条明确回 404：能力位先验要说「老后端」，不能降级成链路故障。
        val server = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        server.soTimeout = 5_000
        val executor = Executors.newSingleThreadExecutor()
        val future = executor.submit {
            serveOne(server, 404, """{"error":"Unknown operation"}""", AtomicReference<Request>())
        }
        try {
            val client = CrewClient(listOf("http://127.0.0.1:1", "http://127.0.0.1:${server.localPort}"), "test-token")
            val error = assertThrows(SessionsUnavailable::class.java) { runBlocking { client.sessions() } }
            assertEquals(404, error.status)
            future.get(5, TimeUnit.SECONDS)
        } finally {
            server.close()
            executor.shutdownNow()
        }
    }

    @Test
    fun sessionsFailuresKeepTheirHttpStatusForAnHonestNote() {
        for ((status, expected) in listOf(404 to 404, 409 to 409, 503 to 503)) {
            PhoneServer(listOf(reply("""{"error":"x"}""", status))).use { phone ->
                val error = assertThrows(SessionsUnavailable::class.java) {
                    runBlocking { phone.client.sessions() }
                }
                assertEquals(expected, error.status)
            }
        }
        // 200 但缺能力位：不是异常，交给状态机判成老后端。
        PhoneServer(listOf(reply("""{"sessions":["main"]}"""))).use { phone ->
            assertFalse(runBlocking { phone.client.sessions() }.sessionApi)
        }
    }

    @Test
    fun aNetworkFailureIsReportedAsAnUnreadableListInsteadOfAnEmptyOne() {
        val error = assertThrows(SessionsUnavailable::class.java) {
            runBlocking { CrewClient(listOf("http://127.0.0.1:1"), "test-token").sessions() }
        }
        assertEquals(0, error.status)
    }

    @Test
    fun anIllegalCreateIdNeverTouchesTheNetwork() {
        PhoneServer(emptyList()).use { phone ->
            assertThrows(IllegalArgumentException::class.java) {
                runBlocking { phone.client.createSession("Work") }
            }
            assertTrue(phone.requests().isEmpty())
        }
    }

    private fun waitFor(phone: PhoneServer, count: Int): List<Request> {
        val deadline = System.currentTimeMillis() + 5_000
        while (System.currentTimeMillis() < deadline && phone.requests().size < count) Thread.sleep(10)
        assertEquals(count, phone.requests().size)
        return phone.requests()
    }

    private fun waitForPaths(phone: PhoneServer, count: Int): List<String> = waitFor(phone, count).map { it.path }
}
