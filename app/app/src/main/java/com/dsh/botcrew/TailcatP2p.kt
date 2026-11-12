package com.dsh.botcrew

import android.util.Log
import java.io.IOException
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

internal fun acceptsProbeStatus(status: Int, latency: Boolean): Boolean =
    status in 200..299 || (latency && status == 404)

/**
 * 手机这一侧的 tailcat 代理：在回环上开一个监听，进来的每条 TCP 都转进隧道。
 *
 * 为什么代理的是 TCP 而不是让 CrewClient 认识隧道：电脑侧 serve 出来的就是一条真 TCP 流，
 * HTTP/1.1 直接跑。把「往哪走」收在这一层之后，base 写成本机端口就等于走了 P2P，
 * 上面所有接口、所有界面代码都不用知道隧道存在。
 *
 * 为什么绑回环而不是 0.0.0.0：局域网地址会变（换 Wi-Fi、开热点、地址被 DHCP 换掉），
 * 而隧道那一侧把它当固定入口；绑在 127.0.0.1 上，App 自己永远是同一个 base，
 * 外面也连不进来一个能替你发消息的端口。
 */
object TailcatP2p {
    private const val TAG = "CrewP2p"

    /**
     * 电脑侧 `tailcat serve --key=default <端口>` 暴露进隧道的那个端口。
     * 改电脑那边的参数就得同步改这里，否则 dial 会连到一个没人听的口。
     */
    const val SERVE_PORT = 43499

    /** 真正建连接时的期限：注册与路径发现要时间，但也不该让请求无限等。 */
    private const val DIAL_TIMEOUT_MS = 20_000

    /**
     * 探测默认等这么久。
     *
     * 真机实测：手机经 DERP 引导的首连要 5–15 秒（DERP 注册 + 打洞升级），比局域网慢一个量级。
     * 按局域网那套几百毫秒去等，会把本来能通的隧道判死；等多久由调用方给，
     * 这个默认值是探测在后台跑、不挡人的前提下给的。
     */
    private const val DEFAULT_PROBE_WAIT_MS = 15_000

    /** 本地把写端关了之后等远端收尾的上限：远端一直不发 FIN 时不能把这条连接永远挂着。 */
    private const val LINGER_MS = 15_000L

    /**
     * 计时用的路径：它一定不存在，服务端只回一个 404，路由之外几乎不做事 ——
     * 这样量到的主要是路的往返，而不是服务器拼 JSON 的时间。不带凭据也照样会被路由拦下来。
     */
    private const val LATENCY_PATH = "/api/mobile/__latency"

    /** 计时打两次取最小值：一次可能恰好赶上重建连接，两次都赶上的概率小得多。 */
    private const val TIMING_ATTEMPTS = 2

    private const val CHUNK = 16 * 1024

    /** 现在的状态：监听在哪个端口（没起来是 null），以及为什么没起来。 */
    data class State(val listening: Int?, val detail: String)

    @Volatile private var proxy: Proxy? = null

    /** 最近一次没起来/没通的说明，给界面那一行字和日志用。 */
    @Volatile private var detail: String = ""

    fun state(): State = State(proxy?.let { it.port }, detail)

    /**
     * 开始代理到 [address] 那台电脑，返回本地端口；起不来返回 null（原因见 [state]）。
     *
     * 这里只管把监听开起来，隧道通不通要另外探一次（[probe]）—— 监听绑在回环上永远不会失败，
     * 它说明不了对面在不在。
     */
    @Synchronized
    fun start(address: String): Int? {
        stop()
        detail = ""
        val clean = CrewRoute.cleanAddress(address)
        if (clean.isEmpty()) {
            detail = "这台电脑没有公布 P2P 地址"
            return null
        }
        val missing = TailcatNative.unavailable
        if (missing != null) {
            detail = missing
            Log.i(TAG, "这台上没有 P2P 通道：$missing")
            return null
        }
        val server = try {
            ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
        } catch (error: IOException) {
            detail = error.message ?: "回环端口开不出来"
            Log.w(TAG, "回环监听失败：$detail")
            return null
        }
        return try {
            val client = TailcatNative.nativeClientNew(clean)
            val started = Proxy(client, server)
            proxy = started
            started.serve()
            Log.i(TAG, "本地代理在 127.0.0.1:${started.port} 上等连接")
            started.port
        } catch (error: Throwable) {
            // 地址里内嵌的是密钥，日志里只留长度，不落原文。
            detail = error.message ?: "建不了隧道客户端"
            Log.w(TAG, "起代理失败（地址长度 ${clean.length}）：$detail")
            runCatching { server.close() }
            null
        }
    }

    @Synchronized
    fun stop() {
        proxy?.close()
        proxy = null
    }

    /** 延迟完成的旧协程只释放自己那一份代理。 */
    @Synchronized
    fun stop(port: Int) {
        if (proxy?.port == port) stop()
    }

    /**
     * 探测结果。[ok] 是「隧道能承载真请求」，[millis] 是同一条连接上一个来回的耗时。
     *
     * 两者分开是因为它们是两件事：通不通看 [ok]，快不快看 [millis]。打洞没成功时
     * tailcat 会退到 DERP 中继，请求照常通，但一个来回是 137ms 而不是 1.4ms ——
     * 界面按 [millis] 说实话，不拿「通」冒充「直连」。
     */
    data class Probe(val ok: Boolean, val millis: Long = -1)

    /**
     * 探一次这条路：隧道能不能承载真请求（[ok]），以及它有多快（[millis]）。
     *
     * 分两步。第一步带凭据请求 `/api/mobile/timeline`，证明隧道能跑真接口 —— 认证、路由、正文都对，
     * 但**不计时**：第一次连接要经过注册、DERP 引导、打洞升级，量出来是秒级，
     * 拿它当延迟会把 1.4ms 的直连报成中继。
     *
     * 第二步在**同一条连接**上（HTTP keep-alive，不再握手）打一个必然 404 的小路径，
     * 服务端除了路由几乎不做事，剩下的就是一个来回。打两次取最小值：连接池万一没复用，
     * 那一次会多出一次重建，最小值不受它影响 —— 而且会话已经建立，重建也只是一个来回的量，
     * 不会把 1.4ms 的直连算成几十毫秒。
     *
     * 为什么不用 `tc_client_ping`：头文件写明它量的是 the DERP path ——「到中继」那条，
     * 不是这条连接实际走的路，拿它判直连会得出相反的结论。为什么不用 `tc_info`：
     * 它对 client 只回 public_key，没有 direct/derp 字段。所以往返时间是眼下唯一看得见的证据。
     *
     * 探不通只是「这次不行」，不负责收摊：代理留在那儿，下一次请求照样可以试它。
     */
    fun probe(port: Int, token: String, deviceId: String?, waitMs: Int = DEFAULT_PROBE_WAIT_MS): Probe {
        // 第一步：证明隧道能跑真接口。这一步输了就没有后面可谈。
        // 它的耗时只进日志（首连要注册、DERP 引导、握手，通常秒级），不参与判直连还是中继。
        val warm = request(port, "/api/mobile/timeline", token, deviceId, waitMs)
            ?: return Probe(ok = false)

        // 第二步：同一条连接上量一个来回，取两次里小的那次。
        var best = Long.MAX_VALUE
        repeat(TIMING_ATTEMPTS) {
            val spent = request(port, LATENCY_PATH, token, deviceId, waitMs) ?: return@repeat
            if (spent < best) best = spent
        }
        // 计时那两次都没成：隧道刚才明明是通的，多半是代理这一头刚好收摊。当作没探通。
        if (best == Long.MAX_VALUE) return Probe(ok = false)
        // 首连那一段单独记：它大是正常的（注册 + 引导），拿它判断路径会把直连误报成中继。
        Log.i(TAG, "隧道首连 ${warm}ms，稳态一个来回 ${best}ms")
        return Probe(ok = true, millis = best)
    }

    /**
     * 发一个请求并把正文读干净，返回从发出到正文读完的毫秒数；没拿到回应返回 null。
     *
     * timeline 必须成功通过认证；延迟专用的不存在路径允许 404。401、重定向与服务错误均不升级。
     *
     * 故意不调 `disconnect()`：那会把这条件连接关掉，下一次计时请求就得重新握手，
     * 正好把要量的东西盖掉。读完就关流，连接自然回连接池。
     */
    private fun request(port: Int, path: String, token: String, deviceId: String?, waitMs: Int): Long? {
        val startedAt = System.nanoTime()
        return try {
            val connection = (URL("http://127.0.0.1:$port$path").openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                // 连的是本机，连接瞬间就成；真正要等的是隧道那头，所以期限记在读超时上。
                connectTimeout = 2_000
                readTimeout = waitMs
                setRequestProperty("X-GW-Token", token)
                deviceId?.let { setRequestProperty("x-crew-device", it) }
                if (deviceId != null) setRequestProperty("x-crew-credential", token)
            }
            connection.instanceFollowRedirects = false
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            stream?.use { it.readBytes() }
            if (!acceptsProbeStatus(status, path == LATENCY_PATH)) {
                detail = "隧道请求返回 HTTP $status"
                null
            } else {
                (System.nanoTime() - startedAt) / 1_000_000
            }
        } catch (error: IOException) {
            detail = error.message ?: "经过隧道没拿到回应"
            Log.i(TAG, "探测没通（$path）：$detail")
            null
        }
    }

    /** 一个已经在回环上听着的代理，加一个隧道客户端句柄。 */
    private class Proxy(private val client: Long, private val server: ServerSocket) {
        val port: Int get() = server.localPort

        private val closed = AtomicBoolean(false)

        fun serve() {
            thread(name = "tailcat-accept", isDaemon = true) { acceptLoop() }
        }

        private fun acceptLoop() {
            while (!closed.get()) {
                val socket = try {
                    server.accept()
                } catch (error: IOException) {
                    // 收摊时 accept 必然抛一次，那是正常收尾，不是故障。
                    if (!closed.get()) Log.w(TAG, "accept 断了：${error.message}")
                    return
                }
                // 一条连接一个线程：HTTP/1.1 下同时只有几条，且每条都会长时间阻塞在读上，
                // 放进固定大小的池子里只会互相占住。
                thread(name = "tailcat-conn", isDaemon = true) { session(socket) }
            }
        }

        private fun session(socket: Socket) {
            val conn = try {
                socket.tcpNoDelay = true
                TailcatNative.nativeDial(client, SERVE_PORT, DIAL_TIMEOUT_MS)
            } catch (error: Throwable) {
                // 隧道这条不通时不往上抛：上层探测过就会退回局域网/公网，这里别把连接挂住。
                Log.w(TAG, "dial 没成：${error.message}")
                runCatching { socket.close() }
                return
            }
            Tunnel(socket, conn).run()
        }

        fun close() {
            if (!closed.compareAndSet(false, true)) return
            runCatching { server.close() }
            // 关客户端会连带关掉它名下的连接，并打断还阻塞在 read/write 里的调用。
            runCatching { TailcatNative.nativeClose(client) }
        }
    }

    /** 一条已经建立起来的连接：本地 socket 与隧道连接各一头，两边对着搬字节。 */
    private class Tunnel(private val socket: Socket, private val conn: Long) {
        private val done = AtomicBoolean(false)

        fun run() {
            thread(name = "tailcat-down", isDaemon = true) { down() }
            thread(name = "tailcat-up", isDaemon = true) { up() }
        }

        /** 隧道 → 本地。这一步结束就整条关掉：本地那条流没有别的来源了。 */
        private fun down() {
            val buffer = ByteArray(CHUNK)
            try {
                val out = socket.getOutputStream()
                while (!done.get()) {
                    val count = TailcatNative.nativeRead(conn, buffer)
                    if (count < 0) break
                    out.write(buffer, 0, count)
                    // 立刻吐出去：HTTP 回应的第一段可能就是人正在等的那一屏。
                    out.flush()
                }
            } catch (error: Throwable) {
                if (!done.get()) Log.i(TAG, "隧道读结束：${error.message}")
            } finally {
                shutdown()
            }
        }

        /**
         * 本地 → 隧道。本地把写端关了就先关隧道写端，让远端知道请求结束了，再等它回完 ——
         * 这正是 HTTP 的节奏：请求写完（FIN），回应还可能继续来。
         */
        private fun up() {
            val buffer = ByteArray(CHUNK)
            try {
                val input = socket.getInputStream()
                while (!done.get()) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    TailcatNative.nativeWrite(conn, buffer, count)
                }
                runCatching { TailcatNative.nativeCloseWrite(conn) }
                // 远端可能再也不发东西（比如它回了半截就卡住），给一段宽限，到点照样收摊。
                linger()
            } catch (error: Throwable) {
                if (!done.get()) Log.i(TAG, "本地读结束：${error.message}")
                shutdown()
            }
        }

        private fun linger() {
            thread(name = "tailcat-linger", isDaemon = true) {
                try {
                    Thread.sleep(LINGER_MS)
                } catch (interrupted: InterruptedException) {
                    return@thread
                }
                shutdown()
            }
        }

        /**
         * 收尾。只做一次：两头都可能走到这里，而重复关同一个句柄虽然被原生层容错，
         * 反复进 JNI 没有意义。
         */
        private fun shutdown() {
            if (!done.compareAndSet(false, true)) return
            runCatching { socket.close() }
            runCatching { TailcatNative.nativeClose(conn) }
        }
    }
}
