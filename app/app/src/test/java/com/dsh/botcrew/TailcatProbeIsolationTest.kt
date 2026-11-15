package com.dsh.botcrew

import java.io.Closeable
import java.io.IOException
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 探测（[TailcatP2p.probe]）与业务 GET 各用各的物理连接，绝不共享 keep-alive 池。
 *
 * 这是真机 `tc_conn_read 失败（status=2）：use of closed network connection` 的**第二根因**：
 * 探测和 [CrewClient] 都打 `127.0.0.1:<代理端口>`，`HttpURLConnection` 的全局 `KeepAliveCache`
 * 按 host:port 分桶 → 二者共享物理连接。探测超时那句 `disconnect()` 会关掉业务正复用的连接，
 * 反之亦然。修复后探测请求带 `Connection: close`、用完即弃，绝不进池。
 *
 * 台架起一个模拟「隧道那头」的本地 server（应答 timeline 200 / latency 404 / notices 200），
 * 在上面**并发**跑探测与业务 GET，断言两条都成、且探测连接带 `Connection: close`。
 */
class TailcatProbeIsolationTest {

    /**
     * 模拟隧道那头的 server：记录每条连接收到的 `Connection:` 头，统计新建连接数。
     * 默认行为若客户端要求 `close` 就在应答后主动关；否则保持连接等下一个请求（keep-alive）。
     */
    private class FakeTunnel : Closeable {
        private val server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        private val running = AtomicBoolean(true)
        private val open = ConcurrentHashMap.newKeySet<Socket>()
        val connectionsOpened = AtomicInteger(0)
        /** 探测路径（latency）上收到的 Connection 头取值；用于确认探测没走 keep-alive。 */
        val latencyConnHeaders = ConcurrentHashMap.newKeySet<String>()

        val port: Int get() = server.localPort

        init {
            thread(isDaemon = true, name = "fake-tunnel-accept") {
                while (running.get()) {
                    val socket = try {
                        server.accept()
                    } catch (error: IOException) {
                        return@thread
                    }
                    connectionsOpened.incrementAndGet()
                    open.add(socket)
                    thread(isDaemon = true, name = "fake-tunnel-conn") { serve(socket) }
                }
            }
        }

        private fun serve(socket: Socket) {
            try {
                socket.soTimeout = 5_000
                val input = socket.getInputStream().buffered()
                while (running.get()) {
                    val head = readHead(input) ?: return
                    val firstLine = head.lineSequence().firstOrNull().orEmpty()
                    val path = firstLine.split(' ').getOrNull(1) ?: "/"
                    val connHeader = head.lineSequence()
                        .firstOrNull { it.startsWith("Connection:", ignoreCase = true) }
                        ?.substringAfter(":")?.trim()?.lowercase().orEmpty()
                    if (path.startsWith("/api/mobile/__latency")) latencyConnHeaders.add(connHeader)

                    val status = when {
                        path.startsWith("/api/mobile/timeline") -> 200
                        path.startsWith("/api/mobile/notices") -> 200
                        path.startsWith("/api/mobile/__latency") -> 404
                        else -> 404
                    }
                    val body = if (status == 200) """{"items":[]}""" else """{"error":"nf"}"""
                    val bytes = body.toByteArray()
                    val close = connHeader == "close"
                    val out = socket.getOutputStream()
                    val head2 = "HTTP/1.1 $status X\r\nContent-Length: ${bytes.size}\r\n" +
                        "Content-Type: application/json\r\n" +
                        (if (close) "Connection: close\r\n" else "") + "\r\n"
                    out.write(head2.toByteArray()); out.write(bytes); out.flush()
                    if (close) return
                }
            } catch (_: IOException) {
            } finally {
                open.remove(socket)
                runCatching { socket.close() }
            }
        }

        private fun readHead(input: java.io.BufferedInputStream): String? {
            val sb = StringBuilder()
            while (!sb.endsWith("\r\n\r\n")) {
                val b = input.read()
                if (b < 0) return null
                sb.append(b.toChar())
            }
            return sb.toString()
        }

        override fun close() {
            running.set(false)
            runCatching { server.close() }
            open.forEach { runCatching { it.close() } }
            open.clear()
        }
    }

    /** 业务侧的一次 GET（与 [CrewClient.attempt] 同语义：读完 disconnect）。 */
    private fun businessGet(port: Int, path: String): String {
        val connection = URL("http://127.0.0.1:$port$path").openConnection() as HttpURLConnection
        return try {
            connection.connectTimeout = 2_000
            connection.readTimeout = 5_000
            connection.inputStream.bufferedReader().use { it.readText() }
        } finally {
            connection.disconnect()
        }
    }

    /**
     * 核心：探测与业务并发时互相不打断。修复前探测的 keep-alive 连接进池后被业务复用/disconnect，
     * 或探测 disconnect 关掉业务的连接，会随机报 closed；修复后两条各用各的，全部成功。
     */
    @Test
    fun probeAndBusinessNeverShareAPhysicalConnection() {
        FakeTunnel().use { tunnel ->
            val failures = ConcurrentHashMap<String, Int>()
            // 探测 + 业务各跑若干轮，尽量让它们在同一个 host:port 桶上交错。
            val workers = (1..6).map { index ->
                thread(isDaemon = true, name = "iso-$index") {
                    repeat(6) { round ->
                        try {
                            if ((index + round) % 2 == 0) {
                                val p = TailcatP2p.probe(tunnel.port, "tok", null, waitMs = 4_000, budgetMs = 6_000)
                                if (!p.ok) failures.merge("probe", 1, Int::plus)
                            } else {
                                businessGet(tunnel.port, "/api/mobile/notices")
                            }
                        } catch (error: Exception) {
                            failures.merge(if ((index + round) % 2 == 0) "probe-ex" else "business-ex", 1, Int::plus)
                        }
                    }
                }
            }
            workers.forEach { it.join(30_000) }

            assertEquals("并发探测+业务出现了失败：$failures", 0, failures.values.sum())
            assertTrue("探测应该真的跑过并建了连接", tunnel.connectionsOpened.get() > 0)
            // 探测命中 latency 的每个连接都必须是 Connection: close（不进共享池）。
            assertTrue("探测连接没有带 Connection: close：${tunnel.latencyConnHeaders}",
                tunnel.latencyConnHeaders.isNotEmpty() && tunnel.latencyConnHeaders.all { it == "close" })
        }
    }
}
