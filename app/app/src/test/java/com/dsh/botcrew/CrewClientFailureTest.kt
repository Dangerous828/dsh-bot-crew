package com.dsh.botcrew

import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 入口表上的「连续失败计数」。
 *
 * 为什么需要它：死掉的局域网地址不会被踢出表，它只是每次都先白等一次连接超时再退回公网。
 * 界面要说「局域网地址已失效」，就得有个「它已经连着不通几次」的事实可读 ——
 * 猜不出来，只能数出来。
 *
 * 关键是**只有真的没连上才算失败**：401 和 404 都证明这条地址是通的（能连上才可能被拒），
 * 把它们记成失败会让人白改一次配对。
 */
class CrewClientFailureTest {

    /** 在一条已经 accept 好的连接上答一次。 */
    private fun serveOnce(socket: ServerSocket, status: Int, body: String) {
        socket.accept().use { client ->
            client.soTimeout = 5_000
            val input = client.getInputStream().buffered()
            fun line(): String {
                val text = StringBuilder()
                while (true) {
                    val byte = input.read()
                    if (byte < 0 || byte == '\n'.code) break
                    if (byte != '\r'.code) text.append(byte.toChar())
                }
                return text.toString()
            }
            line()
            var length = 0
            while (true) {
                val header = line()
                if (header.isEmpty()) break
                if (header.startsWith("Content-Length:", ignoreCase = true)) {
                    length = header.substringAfter(':').trim().toInt()
                }
            }
            repeat(length) { input.read() }
            val bytes = body.toByteArray()
            client.getOutputStream().apply {
                write(
                    ("HTTP/1.1 $status Reply\r\nContent-Length: ${bytes.size}\r\n" +
                        "Connection: close\r\n\r\n").toByteArray(),
                )
                write(bytes)
                flush()
            }
        }
    }

    /** 一个只答一次、然后关掉的本地服务。 */
    private fun server(status: Int, body: String = "{}"): ServerSocket =
        ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).also { socket ->
            socket.soTimeout = 5_000
            Executors.newSingleThreadExecutor().apply {
                submit { runCatching { serveOnce(socket, status, body) } }
                shutdown()
            }
        }

    /** 一个端口上没人听：连上去立刻被拒，是「真的没连上」。 */
    private fun closedPort(): Int = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { it.localPort }

    // 连不上的入口每失败一次就加一，并且加到一个门槛就停 —— 界面上不需要一个无界的数。
    @Test
    fun eachFailedConnectionRaisesTheCountUpToTheThreshold() {
        val dead = "http://127.0.0.1:${closedPort()}"
        val client = CrewClient(listOf(dead), "tok-1")
        assertEquals(0, client.failureCount(dead))
        for (expected in 1..CrewLanHealth.FAILURES) {
            assertThrows(java.io.IOException::class.java) {
                runBlocking { client.timeline() }
            }
            assertEquals(expected, client.failureCount(dead))
        }
        // 再失败几次也不越过门槛：判定只看有没有到，不关心到了几次。
        assertThrows(java.io.IOException::class.java) { runBlocking { client.timeline() } }
        assertEquals(CrewLanHealth.FAILURES, client.failureCount(dead))
    }

    // 同一条入口重新能连上（这次回 401，但连上了）就把失败作废：
    // 「连续失败」在「连上了」那一刻断了链，界面不该继续挂着「地址已失效」。
    @Test
    fun reachingThatEntryAgainClearsItsFailures() {
        // 先占一个端口再放掉：拿到一个确定没人听的端口号，后面还能原地重开。
        val port = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { it.localPort }
        val entry = "http://127.0.0.1:$port"
        val client = CrewClient(listOf(entry), "tok-1")
        assertThrows(java.io.IOException::class.java) { runBlocking { client.timeline() } }
        assertEquals(1, client.failureCount(entry))

        // 同一个端口上开一个会答话的服务：能连上就说明这条地址是活的。
        val back = ServerSocket(port, 1, InetAddress.getByName("127.0.0.1"))
        back.soTimeout = 5_000
        val worker = Executors.newSingleThreadExecutor()
        worker.submit { runCatching { serveOnce(back, 401, """{"error":"bad token"}""") } }
        try {
            assertThrows(java.io.IOException::class.java) { runBlocking { client.timeline() } }
            assertEquals(0, client.failureCount(entry))
        } finally {
            back.close()
            worker.shutdownNow()
        }
    }

    // 另一条入口成功，不替这一条洗白：A 的失败是 A 的证据，网络恢复了 A 才该被清。
    @Test
    fun aSuccessOnAnotherEntryDoesNotClearThisOnesFailures() {
        val dead = "http://127.0.0.1:${closedPort()}"
        val live = server(200)
        val client = CrewClient(listOf(dead, "http://127.0.0.1:${live.localPort}"), "tok-1")
        try {
            runBlocking { client.timeline() }
            assertEquals(1, client.failureCount(dead))
            assertEquals(0, client.failureCount("http://127.0.0.1:${live.localPort}"))
        } finally {
            live.close()
        }
    }

    // 401 说明地址是通的（能连上才可能被拒）：不计失败。
    @Test
    fun aRejectedCredentialDoesNotCountAsAnUnreachableAddress() {
        val server = server(401, """{"error":"bad token"}""")
        val entry = "http://127.0.0.1:${server.localPort}"
        val client = CrewClient(listOf(entry), "tok-1")
        try {
            assertThrows(java.io.IOException::class.java) { runBlocking { client.timeline() } }
            assertEquals(0, client.failureCount(entry))
        } finally {
            server.close()
        }
    }

    // 404 同理：对端答了话，地址没错。把它记成「地址失效」会让人白改一次配对。
    @Test
    fun anHttpStatusResponseDoesNotCountAsAnUnreachableAddress() {
        val server = server(404, """{"error":"no such route"}""")
        val entry = "http://127.0.0.1:${server.localPort}"
        val client = CrewClient(listOf(entry), "tok-1")
        try {
            assertThrows(java.io.IOException::class.java) { runBlocking { client.timeline() } }
            assertEquals(0, client.failureCount(entry))
        } finally {
            server.close()
        }
    }

    // 计数按归一化后的地址存：人可能把 `192.168.31.127:43499` 原样存进去，
    // 拿另一种写法去问也必须读到同一个数，否则界面永远读不到那个失败。
    @Test
    fun theCountIsKeyedByTheNormalisedEntry() {
        val dead = "http://127.0.0.1:${closedPort()}"
        val client = CrewClient(listOf(dead), "tok-1")
        assertThrows(java.io.IOException::class.java) { runBlocking { client.timeline() } }
        // 少了 scheme、多了尾斜杠都该读到同一个计数。
        assertEquals(1, client.failureCount(dead.removePrefix("http://") + "/"))
        // 没见过的入口读成 0，不抛错。
        assertEquals(0, client.failureCount("http://10.0.0.9:43499"))
    }

    // 换表之后旧地址的计数不影响新地址：换了地址就是另一条路。
    @Test
    fun aReplacedTableStartsWithFreshCountsForTheNewAddress() {
        val dead = "http://127.0.0.1:${closedPort()}"
        val client = CrewClient(listOf(dead), "tok-1")
        assertThrows(java.io.IOException::class.java) { runBlocking { client.timeline() } }
        assertEquals(1, client.failureCount(dead))
        val other = "http://127.0.0.1:${closedPort()}"
        client.replaceEntries(listOf(other))
        assertEquals(0, client.failureCount(other))
        assertTrue(client.routeOrder().contains(other))
    }

    // ── 主动探测 ──────────────────────────────────────────────────────────
    //
    // `read()` 从「当前在用的那条」开始绕一圈，一旦落到公网，死掉的局域网地址就再也不会
    // 被尝试 —— 它的失败计数会永远停在冷启动那一趟，界面上也就永远说不出「地址已失效」。
    // 所以要有一条主动去敲的路径，而且它**不许**改「现在用哪条」。

    // 敲不通就记一次失败，而且不影响在用的那条入口。
    @Test
    fun probingADeadEntryCountsAFailureWithoutSwitchingRoutes() {
        val dead = "http://127.0.0.1:${closedPort()}"
        val public = "https://crew.example.top"
        val client = CrewClient(listOf(dead, public), "tok-1")
        client.promote(public)
        assertEquals(public, client.currentEntry())
        repeat(CrewLanHealth.FAILURES) {
            val ok = runBlocking { client.probeEntry(dead) }
            assertFalse("死地址不该被探通", ok)
        }
        assertEquals(CrewLanHealth.FAILURES, client.failureCount(dead))
        // 探一条不通的路不该把「现在走哪条」改掉：那是换路逻辑的事，不是探测的副作用。
        assertEquals(public, client.currentEntry())
    }

    // 敲得通就把失败清掉 —— 地址活了，界面不该继续挂着「已失效」。
    @Test
    fun probingALiveEntryClearsItsFailures() {
        val port = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { it.localPort }
        val entry = "http://127.0.0.1:$port"
        val client = CrewClient(listOf(entry), "tok-1")
        // 先让它失败两次（端口上没人听）。
        repeat(CrewLanHealth.FAILURES) { runBlocking { client.probeEntry(entry) } }
        assertEquals(CrewLanHealth.FAILURES, client.failureCount(entry))

        // 同一个端口上开一个服务：探通了，计数清零。
        val back = ServerSocket(port, 1, InetAddress.getByName("127.0.0.1"))
        back.soTimeout = 5_000
        val worker = Executors.newSingleThreadExecutor()
        worker.submit { runCatching { serveOnce(back, 404, """{"error":"no such route"}""") } }
        try {
            assertTrue("对端答了话就是活的", runBlocking { client.probeEntry(entry) })
            assertEquals(0, client.failureCount(entry))
        } finally {
            back.close()
            worker.shutdownNow()
        }
    }

    // 探测认 401/404 为「活着」：能连上才可能被拒，把这两种记成地址失效会让人白改一次配对。
    @Test
    fun probingTreatsAnAnsweredRejectionAsAlive() {
        for (status in listOf(401, 404)) {
            val server = server(status, """{"error":"nope"}""")
            val entry = "http://127.0.0.1:${server.localPort}"
            val client = CrewClient(listOf(entry), "tok-1")
            try {
                assertTrue("HTTP $status 说明地址是活的", runBlocking { client.probeEntry(entry) })
                assertEquals(0, client.failureCount(entry))
            } finally {
                server.close()
            }
        }
    }

    // 空入口不探：它不指向任何地方，敲它只会得出一个假的「失效」。
    @Test
    fun probingABlankEntryIsANoOp() {
        val client = CrewClient(listOf("http://a:1"), "tok-1")
        assertFalse(runBlocking { client.probeEntry("") })
        assertFalse(runBlocking { client.probeEntry("   ") })
        assertEquals(0, client.failureCount(""))
        assertEquals(listOf("http://a:1"), client.routeOrder())
    }
}
