package com.dsh.botcrew

import java.io.Closeable
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 整轮探测的**墙钟**上限，以及到点之后连接与线程是不是真的被放掉。
 *
 * 这组用例照着 #20 的实测现场写：`readTimeout` 是**每次 read** 的期限，对端只要在期限内
 * 持续吐字节，就没有任何一次 read 会超时 —— 于是整步长度由「字节数 × 每字节间隔」决定，
 * 与预算无关。真实产品实测 800ms/字节 拖到 81.64 秒，没有上界。
 *
 * 因此判据有两条，缺一不可：
 * 1. 墙钟落在预算内（不是「调用方不等了」，是这条路真的被收口）；
 * 2. 收口之后对端那条连接被关掉、守护线程退出 —— 只 `Future.get` 超时或 `withTimeout`
 *    包住阻塞 read，会留下永远在 read 的线程和一条永远在传字节的连接。
 *
 * 预算压到几百毫秒，不把 20 秒的默认值每例跑满。
 */
class TailcatProbeDeadlineTest {

    /** 台架允许的调度抖动：够宽，但仍能抓住「2.2 秒 vs 0.4 秒」那个量级的差别。 */
    private val toleranceMs = 800L

    private fun elapsedSince(startedAt: Long) = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAt)

    // 核心用例：慢滴对端不能把整轮拖过预算。
    @Test
    fun aDrippingPeerCannotOutlastTheProbeBudget() {
        SlowPeer(Mode.DRIP, dripMs = 20).use { peer ->
            val startedAt = System.nanoTime()
            val probe = TailcatP2p.probe(peer.port, "tok-1", null, waitMs = 15_000, budgetMs = 400)
            val wall = elapsedSince(startedAt)
            // 慢到不可用就是没探通，不能报成「通」。
            assertFalse("慢滴被当成了探通：millis=${probe.millis}", probe.ok)
            assertTrue("墙钟 ${wall}ms 越过了 400ms 预算（容差 ${toleranceMs}ms）", wall < 400 + toleranceMs)
        }
    }

    // 对端收下请求永不回应：预算必须在整轮上生效，而不是靠单步 readTimeout 碰巧生效。
    @Test
    fun aSilentPeerIsCappedByTheBudgetToo() {
        SlowPeer(Mode.HANG).use { peer ->
            val startedAt = System.nanoTime()
            val probe = TailcatP2p.probe(peer.port, "tok-1", null, waitMs = 15_000, budgetMs = 400)
            val wall = elapsedSince(startedAt)
            assertFalse(probe.ok)
            assertTrue("墙钟 ${wall}ms 越过了 400ms 预算（容差 ${toleranceMs}ms）", wall < 400 + toleranceMs)
        }
    }

    // 反向：慢但仍在预算内的对端必须照样算「通」—— 收口不能把正常探测误杀成失败。
    @Test
    fun aPeerSlowerThanOneReadButWithinBudgetStillCountsAsUp() {
        SlowPeer(Mode.DELAY, delayMs = 150).use { peer ->
            val probe = TailcatP2p.probe(peer.port, "tok-1", null, waitMs = 15_000, budgetMs = 5_000)
            assertTrue("150ms 的对端在 5 秒预算内必须算通", probe.ok)
            assertTrue("量到的往返该在 150ms 量级：${probe.millis}", probe.millis >= 100)
        }
    }

    // 反向：正常快回的对端不受墙钟影响，探测照常成功且能报出一个来回。
    @Test
    fun aFastPeerStillProbesThrough() {
        SlowPeer(Mode.FAST).use { peer ->
            val startedAt = System.nanoTime()
            val probe = TailcatP2p.probe(peer.port, "tok-1", null, waitMs = 15_000, budgetMs = 20_000)
            val wall = elapsedSince(startedAt)
            assertTrue("快回的对端必须探通", probe.ok)
            assertTrue("稳态一个来回该是个非负数：${probe.millis}", probe.millis >= 0)
            assertTrue("快回不该拖到 ${wall}ms", wall < 5_000)
        }
    }

    // 连续超时：每一轮都要把对端那条连接关掉，也不能攒下一堆还在 read 的守护线程。
    // 这是「只 join 超时」与「真关连接」的分界线 —— 前者会让台架这边的写入端一直有接收方。
    //
    // 判据必须落在**探测返回的那一刻**：慢滴对端自己滴完也会关连接，只看「最终有没有关」
    // 会把「我们关了」和「它滴完了」混成同一件事（实测：去掉 disconnect 也照样绿）。
    // 所以这里用慢到远超预算的滴速，并要求探测刚返回时连接就已经不在了。
    @Test
    fun repeatedTimeoutsReleaseTheConnectionAndTheGuardThread() {
        val rounds = 6
        // 200ms/字节 × 约 150 字节 ≈ 30 秒，远长于 300ms 预算：连接只可能被我们关掉。
        SlowPeer(Mode.DRIP, dripMs = 200).use { peer ->
            repeat(rounds) { round ->
                val startedAt = System.nanoTime()
                val probe = TailcatP2p.probe(peer.port, "tok-1", null, waitMs = 15_000, budgetMs = 300)
                val wall = elapsedSince(startedAt)
                assertFalse("第 $round 轮慢滴被当成了探通", probe.ok)
                assertTrue("第 $round 轮墙钟 ${wall}ms 越过 300ms 预算", wall < 300 + toleranceMs)
                // 对端要等下一次写入才发现对端关了，所以给一小段窗口 —— 但它远短于
                // 「滴完 30 秒」，所以这条断言只可能被「我们主动关了连接」满足。
                assertTrue(
                    "第 $round 轮探测返回 1.5 秒后对端仍有 ${peer.openConnections()} 条连接在传字节",
                    waitFor("连接没被我们关掉", timeoutMs = 1_500) { peer.openConnections() == 0 },
                )
            }
            // 守护线程不许按轮累积：收口时该退出。
            val leaked = waitFor("守护线程没有随探测退出") { guardThreads() <= 2 }
            assertTrue("${rounds} 轮超时后仍留着 ${guardThreads()} 个 tailcat-probe 线程", leaked)
        }
    }

    private fun guardThreads(): Int =
        Thread.getAllStackTraces().keys.count { it.isAlive && it.name.startsWith("tailcat-probe") }

    /** 轮询到条件成立或超时；返回条件最终是否成立。 */
    private fun waitFor(what: String, timeoutMs: Long = 2_000, condition: () -> Boolean): Boolean {
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        while (System.nanoTime() < deadline) {
            if (condition()) return true
            Thread.sleep(20)
        }
        return condition()
    }

    private enum class Mode { FAST, HANG, DRIP, DELAY }

    /**
     * 一个可控的「隧道那头」：快回、收下不回、逐字节慢滴。
     *
     * 与 `docs/review/i20/probe_server.py` 同构，但跑在测试进程里，好顺带数连接与线程。
     * 每个响应都带 `Connection: close` 并在发完正文后立刻关 —— `probe()` 读到 EOF 才返回，
     * keep-alive 会凭空造出延迟，把用例全污染成假超时（台架第一版踩过）。
     */
    private class SlowPeer(
        private val mode: Mode,
        private val dripMs: Long = 20,
        private val delayMs: Long = 150,
    ) : Closeable {
        private val server = ServerSocket(0, 32, InetAddress.getByName("127.0.0.1"))
        private val open = ConcurrentHashMap.newKeySet<Socket>()
        private val running = AtomicBoolean(true)

        val port: Int get() = server.localPort

        init {
            thread(isDaemon = true, name = "slow-peer-accept") {
                while (running.get()) {
                    val socket = try {
                        server.accept()
                    } catch (error: IOException) {
                        return@thread
                    }
                    open.add(socket)
                    thread(isDaemon = true, name = "slow-peer-conn") { serve(socket) }
                }
            }
        }

        fun openConnections(): Int = open.size

        private fun serve(socket: Socket) {
            try {
                socket.soTimeout = 5_000
                val input = socket.getInputStream().buffered()
                val head = StringBuilder()
                while (!head.endsWith("\r\n\r\n")) {
                    val byte = input.read()
                    if (byte < 0) return
                    head.append(byte.toChar())
                }
                val path = head.toString().split(' ').getOrNull(1) ?: "/"
                when (mode) {
                    Mode.HANG -> while (running.get()) Thread.sleep(200)
                    Mode.FAST -> socket.getOutputStream().apply {
                        write(response(path))
                        flush()
                    }
                    Mode.DELAY -> {
                        Thread.sleep(delayMs)
                        socket.getOutputStream().apply {
                            write(response(path))
                            flush()
                        }
                    }
                    Mode.DRIP -> {
                        val out = socket.getOutputStream()
                        for (byte in response(path)) {
                            Thread.sleep(dripMs)
                            out.write(byte.toInt())
                            out.flush()
                        }
                    }
                }
            } catch (error: IOException) {
                // 对端把连接关了（这正是我们要观察的行为），不是故障。
            } catch (interrupted: InterruptedException) {
                Thread.currentThread().interrupt()
            } finally {
                open.remove(socket)
                runCatching { socket.close() }
            }
        }

        private fun response(path: String): ByteArray {
            val ok = path.startsWith("/api/mobile/timeline")
            val status = if (ok) 200 else 404
            val body = if (ok) """{"items":[]}""" else """{"error":"not found"}"""
            val bytes = body.toByteArray()
            val head = "HTTP/1.1 $status X\r\nContent-Length: ${bytes.size}\r\n" +
                "Content-Type: application/json\r\nConnection: close\r\n\r\n"
            return head.toByteArray() + bytes
        }

        override fun close() {
            running.set(false)
            runCatching { server.close() }
            open.forEach { runCatching { it.close() } }
            open.clear()
        }
    }
}
