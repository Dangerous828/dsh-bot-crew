package com.dsh.botcrew

import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 隧道一条连接（[Tunnel]）的**半关闭**语义：一个方向读到 EOF 只说明对面不再往这边发，
 * 不代表另一方向在途的请求可以被打断。
 *
 * 这一组用例照着真机现场写：主 APK 的 notices 轮询偶发
 * `tc_conn_read 失败（status=2 TC_CLOSED）：use of closed network connection`。
 * 根因在 [Tunnel]：`down()`（隧道→本地）读到服务端 FIN 后**立即整条 `nativeClose(conn)`**，
 * 把 `up()`（本地→隧道）还在写进同一 conn 的**下一个 keep-alive 请求**一并掐断 —— 报错落在
 * 那次新请求的 read 上，看起来像「隧道自己断了」，其实是本进程另一条线程关的。
 *
 * 用例用假 [TunnelConn] 精确复现：谁 close、close 之后另一方向还剩不剩活。
 */
class TailcatTunnelTest {

    /**
     * 假隧道连接：读侧由一个可控队列喂数据（EOF 表示对端不再发），写侧记录收到的字节并
     * 在**被关闭之后**再写就抛 `use of closed network connection`（与真 native 同义）。
     */
    private class FakeConn : TunnelConn {
        private val closed = AtomicBoolean(false)
        @Volatile private var eofSent = false
        private val inbound = ArrayDeque<ByteArray>()
        private val readUnblocks = CountDownLatch(1)
        val written = StringBuilder()
        val closeCount = AtomicInteger(0)
        val closeWriteCount = AtomicInteger(0)

        /** 让 down() 的下一次 nativeRead 返回 -1（服务端 FIN）。 */
        fun feedEof() {
            eofSent = true
            readUnblocks.countDown()
        }

        /** 喂一段「服务端还会继续发」的数据。 */
        fun feed(bytes: ByteArray) {
            synchronized(inbound) { inbound.addLast(bytes) }
            readUnblocks.countDown()
        }

        override fun read(buffer: ByteArray): Int {
            // 先给已排队的数据；没有就等 feedEof/feed，或等被关闭。
            while (true) {
                synchronized(inbound) {
                    val head = inbound.removeFirstOrNull()
                    if (head != null) {
                        val n = minOf(head.size, buffer.size)
                        System.arraycopy(head, 0, buffer, 0, n)
                        return n
                    }
                }
                if (eofSent) return -1
                if (closed.get()) return -1
                readUnblocks.await(50, TimeUnit.MILLISECONDS)
                readUnblocks.countDown() // 允许后续再次进入循环判断
            }
        }

        override fun write(buffer: ByteArray, length: Int): Int {
            check(!closed.get()) { "use of closed network connection" }
            synchronized(written) { written.append(String(buffer, 0, length)) }
            return length
        }

        override fun closeWrite() {
            closeWriteCount.incrementAndGet()
        }

        override fun close() {
            closeCount.incrementAndGet()
            closed.set(true)
            readUnblocks.countDown()
        }
    }

    /** 本地那头的 socket：从配对端读（模拟客户端），向配对端写（客户端收到的响应）。 */
    private fun socketPair(): Pair<Socket, Socket> {
        val server = ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"))
        val a = Socket("127.0.0.1", server.localPort)
        val b = server.accept() // a 是 Tunnel 持有的那端，b 是客户端那端
        server.close()
        return a to b
    }

    /**
     * **核心复现**：服务端（down）先发 FIN，随后客户端（up）在同一连接上发下一个请求字节 ——
     * 修复前：down 的 EOF 触发整条 `nativeClose`，up 的 next write 立刻抛
     * `use of closed network connection`，那个新请求彻底丢失。
     * 修复后：down 的 EOF 只做半关闭（本地 socket shutdownOutput，让客户端知道回应结束），
     * 不碰 conn；up 仍能把客户端的后续字节写进隧道（在 up 自然结束或被 linger 收口之前）。
     */
    @Test
    fun aServerFinMustNotAbortAnInFlightRequestOnTheSameConnection() {
        val (tunnelSide, clientSide) = socketPair()
        val conn = FakeConn()
        val tunnel = Tunnel(tunnelSide, conn, lingerMs = 30_000)

        val downDone = CountDownLatch(1)
        tunnel.run(onDownFinished = { downDone.countDown() })

        // 服务端（隧道那头）发完响应就关自己的写端：down() 会读到 EOF。
        conn.feedEof()
        assertTrue("down 线程该读到 EOF 并结束", downDone.await(2, TimeUnit.SECONDS))

        // 客户端此刻在**同一连接**上发下一个 keep-alive 请求（本地→隧道）。
        val request = "GET /api/mobile/notices HTTP/1.1\r\nHost: x\r\n\r\n".toByteArray()
        val writer = thread(isDaemon = true) {
            try { clientSide.getOutputStream().apply { write(request); flush() } } catch (_: IOException) {}
        }
        writer.join(1_000)

        // 给它一点时间让 up() 把字节写进 conn。
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
        while (System.nanoTime() < deadline && conn.written.length < request.size) Thread.sleep(20)

        assertEquals(
            "down 读到 EOF 后，up 仍必须能把同一连接上的下一个请求写进隧道（修复前这里是 0/抛 closed）",
            request.size,
            conn.written.length,
        )
        assertFalse("down 读到 EOF 不应整条 close 连接", conn.closeCount.get() > 0 && conn.written.isEmpty())

        tunnel.close()
        runCatching { clientSide.close() }
    }

    /** 反向对照：客户端（up）先关写端，down 仍能继续把服务端余下的响应搬给本地。 */
    @Test
    fun aClientHalfCloseStillLetsTheServerFinishItsResponse() {
        val (tunnelSide, clientSide) = socketPair()
        val conn = FakeConn()
        conn.feed("partial-response".toByteArray())
        val tunnel = Tunnel(tunnelSide, conn, lingerMs = 30_000)
        tunnel.run()

        // 客户端关自己的写端（请求发完，等回应）。
        clientSide.shutdownOutput()
        // 服务端继续吐完剩下的响应。
        conn.feed("more".toByteArray())

        val received = StringBuilder()
        val reader = thread(isDaemon = true) {
            try {
                val buf = ByteArray(64)
                val input = clientSide.getInputStream()
                // 读到足够多或对端收口为止
                val dd = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
                while (System.nanoTime() < dd) {
                    val n = input.read(buf)
                    if (n < 0) break
                    received.append(String(buf, 0, n))
                    if (received.length >= "partial-response".length + 4) break
                }
            } catch (_: IOException) { }
        }
        reader.join(2_000)
        assertTrue("up 半关闭后 down 仍应把服务端余下响应搬到本地：收到 '$received'",
            received.startsWith("partial-response"))

        tunnel.close()
        runCatching { clientSide.close() }
    }
}
