package com.dsh.botcrew

import android.util.Log
import java.io.IOException
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

/**
 * 一轮探测里某一步还能用多少毫秒。
 *
 * **绝不返回 0**：`HttpURLConnection.readTimeout = 0` 的意思是「无限等待」，
 * 预算耗尽时把 0 传下去会让这次探测永远挂着 —— 实测过一次：断网后 app 全黑屏、
 * 调试口连续超时，根因就是这里传了 0。耗尽返回 -1，调用点据此直接放弃这一步。
 *
 * 抽成顶层纯函数是为了能单测：真实 probe 要开 socket，测不动。
 */
internal fun probeBudget(deadlineNanos: Long, nowNanos: Long, waitMs: Int): Int {
    val leftMs = (deadlineNanos - nowNanos) / 1_000_000L
    return if (leftMs <= 0) -1 else minOf(waitMs.toLong(), leftMs).toInt()
}

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
    /** 一整轮探测（warm + 两次计时）的总预算。超了就认这次没通，绝不把调用线程占满 45 秒。 */
    private const val PROBE_BUDGET_MS = 20_000L

    /** 本地把写端关了之后等远端收尾的上限：远端一直不发 FIN 时不能把这条连接永远挂着。 */
    private const val LINGER_MS = 15_000L

    /**
     * 计时用的路径：它一定不存在，服务端只回一个 404，路由之外几乎不做事 ——
     * 这样量到的主要是路的往返，而不是服务器拼 JSON 的时间。不带凭据也照样会被路由拦下来。
     */
    private const val LATENCY_PATH = "/api/mobile/__latency"

    /** 计时打两次取最小值：一次可能恰好赶上重建连接，两次都赶上的概率小得多。 */
    private const val TIMING_ATTEMPTS = 2

    /** 读正文的那个守护线程的名字。超时收口要能认出它，别去猜线程池里的东西。 */
    private const val PROBE_THREAD = "tailcat-probe"

    /** `disconnect()` 之后给阻塞中的 read 抛出并退出读线程的宽限。到点还活着就往下走，不再等。 */
    private const val ABORT_GRACE_MS = 500L

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
     * 第二步计时打两次取最小值：一次可能恰好赶上重建连接，两次都赶上的概率小得多。
     *
     * **探测与业务必须各用各的物理连接**（真机 `tc_conn_read ... closed network connection` 的第二根因）：
     * 探测和 [CrewClient] 都打 `127.0.0.1:<代理端口>` —— host:port 相同，`HttpURLConnection` 的全局
     * `KeepAliveCache` 会按 host:port 把它们放进**同一个桶**。于是探测超时那句 `disconnect()`
     * 能关掉业务请求正复用的池化连接，反之业务每请求一次的 `disconnect()` 也能关掉探测刚抓到、正在读
     * 的那条——谁 close 谁，全凭调度。修法：探测请求一律带 `Connection: close`，用完即弃，**绝不进池**，
     * 因此既不占用、也不关闭业务的连接；业务侧（[CrewClient]）本就每请求 `disconnect()`，不依赖池化复用。
     *
     * 为什么不用 `tc_client_ping`：头文件写明它量的是 the DERP path ——「到中继」那条，
     * 不是这条连接实际走的路，拿它判直连会得出相反的结论。为什么不用 `tc_info`：
     * 它对 client 只回 public_key，没有 direct/derp 字段。所以往返时间是眼下唯一看得见的证据。
     *
     * 探不通只是「这次不行」，不负责收摊：代理留在那儿，下一次请求照样可以试它。
     */
    fun probe(
        port: Int,
        token: String,
        deviceId: String?,
        waitMs: Int = DEFAULT_PROBE_WAIT_MS,
        budgetMs: Long = PROBE_BUDGET_MS,
    ): Probe {
        // 整轮探完的总预算。三步（warm + 两次计时）各自 waitMs 的话最坏要 3×15=45 秒，
        // 而 Wi-Fi 断连时隧道那头根本不回 —— 每次都要等满超时。探测循环在
        // repeatOnLifecycle 里跑，主线程上的调试口/界面就跟着排队等死
        // （实测：关 Wi-Fi 再开，app 全黑屏、state.dump 连续超时）。
        // 所以这里给整轮一个上限：超了就当这次没探通，下一轮再来，不把线程占住。
        val deadline = System.nanoTime() + budgetMs * 1_000_000L
        fun left(): Int = probeBudget(deadline, System.nanoTime(), waitMs)

        // 第一步：证明隧道能跑真接口。这一步输了就没有后面可谈。
        // 它的耗时只进日志（首连要注册、DERP 引导、握手，通常秒级），不参与判直连还是中继。
        val warmBudget = left()
        if (warmBudget <= 0) return Probe(ok = false)
        val warm = request(port, "/api/mobile/timeline", token, deviceId, warmBudget, deadline)
            ?: return Probe(ok = false)

        // 第二步：同一条连接上量一个来回，取两次里小的那次。
        var best = Long.MAX_VALUE
        repeat(TIMING_ATTEMPTS) {
            val budget = left()
            if (budget <= 0) return@repeat
            val spent = request(port, LATENCY_PATH, token, deviceId, budget, deadline) ?: return@repeat
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
     * **整步有墙钟上限，不只是每次 read 的期限。** `readTimeout` 是 per-read 的：对端只要在
     * 期限内持续吐字节，就没有任何一次 read 会超时，整步长度于是由「字节数 × 每字节间隔」
     * 决定 —— 实测 800ms/字节 拖到 81.64 秒，没有上界（#20）。所以正文放在独立线程上读，
     * 到 [deadlineNanos] 还没读完就 `disconnect()` 关掉这条**真实连接**：阻塞中的 read 立刻
     * 抛出来，读线程随之退出。只让调用方 `join` 超时而不关连接，会留下一个永远在 read 的
     * 线程和一条永远在传字节的连接。
     *
     * 顺利读完时**不**调 `disconnect()`：那会把这条件连接关掉，下一次计时请求就得重新握手，
     * 正好把要量的东西盖掉。读完就关流，连接自然回连接池。
     */
    private fun request(
        port: Int,
        path: String,
        token: String,
        deviceId: String?,
        waitMs: Int,
        deadlineNanos: Long,
    ): Long? {
        val connection = (URL("http://127.0.0.1:$port$path").openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            // 连的是本机，连接瞬间就成；真正要等的是隧道那头，所以期限记在读超时上。
            connectTimeout = 2_000
            readTimeout = waitMs
            // 探测请求用完即弃，绝不进 KeepAliveCache（见 probe() 的说明：共享池会让探测与业务互相
            // disconnect 对方的连接，是真机 closed network connection 的第二根因）。
            setRequestProperty("Connection", "close")
            useCaches = false
            setRequestProperty("X-GW-Token", token)
            deviceId?.let { setRequestProperty("x-crew-device", it) }
            if (deviceId != null) setRequestProperty("x-crew-credential", token)
        }
        connection.instanceFollowRedirects = false
        // 结果由读线程填，说明文字也一并带回来 —— 让读线程直接写 detail 会和下面的
        // 超时说明抢同一个字段：先被 disconnect 打断的那一方会把「为什么断」写歪。
        val outcome = AtomicReference<Outcome>()
        val reader = thread(name = PROBE_THREAD, isDaemon = true) {
            outcome.set(exchange(connection, path))
        }
        // join(0) 是「等到天荒地老」，预算已经耗尽时绝不能走进去。
        val leftMs = TimeUnit.NANOSECONDS.toMillis(deadlineNanos - System.nanoTime())
        try {
            if (leftMs > 0) reader.join(leftMs)
        } catch (interrupted: InterruptedException) {
            // 调用方（协程取消）不想等了：同样要把这条连接放掉再走。
            Thread.currentThread().interrupt()
            runCatching { connection.disconnect() }
            return null
        }
        outcome.get()?.let {
            it.note?.let { note -> detail = note }
            // 成功也 disconnect：探测是一次性的，绝不把这条连接留进池子里给别人复用/误关。
            runCatching { connection.disconnect() }
            return it.millis
        }
        detail = "探测到点，已断开这条连接（$path）"
        Log.i(TAG, detail)
        runCatching { connection.disconnect() }
        reader.interrupt()
        reader.join(ABORT_GRACE_MS)
        return null
    }

    /** 一步的结果：[millis] 是量到的往返，[note] 是给人看的失败说明（成功时为 null）。 */
    private class Outcome(val millis: Long?, val note: String?)

    /**
     * 真正的收发。跑在 [request] 起的读线程上，超时由调用方关连接来打断。
     *
     * 计时从这里开始：线程创建与 `openConnection()` 不是这条路的一个来回，
     * 算进去会把 1.4ms 的直连报成更大的数。
     */
    private fun exchange(connection: HttpURLConnection, path: String): Outcome = try {
        val startedAt = System.nanoTime()
        val status = connection.responseCode
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        stream?.use { it.readBytes() }
        if (acceptsProbeStatus(status, path == LATENCY_PATH)) {
            Outcome((System.nanoTime() - startedAt) / 1_000_000, null)
        } else {
            Outcome(null, "隧道请求返回 HTTP $status")
        }
    } catch (error: IOException) {
        val note = error.message ?: "经过隧道没拿到回应"
        Log.i(TAG, "探测没通（$path）：$note")
        Outcome(null, note)
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
                NativeTunnelConn(TailcatNative.nativeDial(client, SERVE_PORT, DIAL_TIMEOUT_MS))
            } catch (error: Throwable) {
                // 隧道这条不通时不往上抛：上层探测过就会退回局域网/公网，这里别把连接挂住。
                Log.w(TAG, "dial 没成：${error.message}")
                runCatching { socket.close() }
                return
            }
            Tunnel(socket, conn, LINGER_MS).run()
        }

        fun close() {
            if (!closed.compareAndSet(false, true)) return
            runCatching { server.close() }
            // 关客户端会连带关掉它名下的连接，并打断还阻塞在 read/write 里的调用。
            runCatching { TailcatNative.nativeClose(client) }
        }
    }
}

/** [Tunnel] 用的日志 TAG 与搬运块大小（原在 object 内，提到顶层后同值重放，避免跨作用域引用）。 */
private const val TUNNEL_TAG = "CrewP2p"
private const val TUNNEL_CHUNK = 16 * 1024

/**
 * 一条隧道连接的收发能力。抽成接口只有一个目的：让 [Tunnel] 的半关闭语义能在 JVM 上
 * 用一个假连接精确测出来（真实现走 JNI，见 [NativeTunnelConn]），而不是把并发收尾逻辑
 * 绑死在 native 上、只能靠真机现场碰运气复现。
 */
internal interface TunnelConn {
    /** 读一段隧道数据。返回字节数；-1 表示对端发了 FIN（这个方向读完了）。 */
    fun read(buffer: ByteArray): Int
    /** 写一段进隧道。连接已被关闭后再写要抛异常（与 native 同义）。 */
    fun write(buffer: ByteArray, length: Int): Int
    /** 关写端（发 FIN）而保留读。 */
    fun closeWrite()
    /** 释放整个连接。重复调用应安全。 */
    fun close()
}

/** [TunnelConn] 的真实现：转发到 [TailcatNative] 的 JNI 句柄。 */
internal class NativeTunnelConn(private val handle: Long) : TunnelConn {
    override fun read(buffer: ByteArray): Int = TailcatNative.nativeRead(handle, buffer)
    override fun write(buffer: ByteArray, length: Int): Int = TailcatNative.nativeWrite(handle, buffer, length)
    override fun closeWrite() = TailcatNative.nativeCloseWrite(handle)
    override fun close() = TailcatNative.nativeClose(handle)
}

/**
 * 一条已经建立起来的连接：本地 socket 与隧道连接各一头，两边对着搬字节。
 *
 * **半关闭不等于整条关闭**（真机 `tc_conn_read ... use of closed network connection` 的根因）：
 * 一条 TCP 连接被 [Tunnel] 拆成两个方向各自搬字节 —— `down`（隧道→本地）与 `up`（本地→隧道）。
 * 任一方向读到 EOF 只说明**那个方向**对面不再发东西，**不代表另一方向在途的请求可以被打断**。
 *
 * 旧实现里 `down()` 一读到服务端 FIN 就 `shutdown()`（`nativeClose(conn)`），会把 `up()` 正写进
 * 同一 conn 的**下一个 keep-alive 请求**掐断 —— 报错落在新请求的 read 上，看起来像隧道自己断了。
 * 现在：`down` 读到 EOF 只做本地的**半关闭**（`socket.shutdownOutput()`，让客户端知道回应结束），
 * 不碰 conn；整条连接只在**两个方向都结束**时才 `shutdown()` 释放 conn。`up` 读到本地 FIN 时
 * 先 `closeWrite`（把请求结束告诉远端）再宽限等待 down 收尾，也符合 HTTP 的节奏。
 */
internal class Tunnel(
    private val socket: Socket,
    private val conn: TunnelConn,
    /** down 结束后给 up 收尾的宽限；到点强制整体收口。测试可配短值。 */
    private val lingerMs: Long = 15_000L,
) {
    private val done = AtomicBoolean(false)
    /** 两个方向各自是否已经结束；都结束才释放 conn。 */
    private val downFinished = AtomicBoolean(false)
    private val upFinished = AtomicBoolean(false)

    fun run(onDownFinished: (() -> Unit)? = null) {
        thread(name = "tailcat-down", isDaemon = true) { down(); onDownFinished?.invoke() }
        thread(name = "tailcat-up", isDaemon = true) { up() }
    }

    /**
     * 隧道 → 本地。
     *
     * 读到 EOF（服务端 FIN）只做**本地半关闭**：让客户端知道这一轮回应结束，但**不关 conn** ——
     * up 这个方向可能还要把客户端的下一个 keep-alive 请求写进同一条连接。整条 conn 的释放交给
     * [maybeShutdown]：两个方向都结束后才发生。
     */
    private fun down() {
        val buffer = ByteArray(TUNNEL_CHUNK)
        try {
            val out = socket.getOutputStream()
            while (!done.get()) {
                val count = conn.read(buffer)
                if (count < 0) break
                out.write(buffer, 0, count)
                // 立刻吐出去：HTTP 回应的第一段可能就是人正在等的那一屏。
                out.flush()
            }
            // 服务端不再发数据：把本地写端关掉，客户端读到 EOF 即知回应结束。
            runCatching { socket.shutdownOutput() }
        } catch (error: Throwable) {
            if (!done.get()) Log.i(TUNNEL_TAG, "隧道读结束：${error.message}")
        } finally {
            downFinished.set(true)
            maybeShutdown()
        }
    }

    /**
     * 本地 → 隧道。本地把写端关了就先关隧道写端，让远端知道请求结束了，再等它回完 ——
     * 这正是 HTTP 的节奏：请求写完（FIN），回应还可能继续来。
     */
    private fun up() {
        val buffer = ByteArray(TUNNEL_CHUNK)
        try {
            val input = socket.getInputStream()
            while (!done.get()) {
                val count = input.read(buffer)
                if (count < 0) break
                conn.write(buffer, count)
            }
            runCatching { conn.closeWrite() }
            // 远端可能再也不发东西（比如它回了半截就卡住），给一段宽限，到点照样收摊。
            lingerOrWaitForDown()
        } catch (error: Throwable) {
            if (!done.get()) Log.i(TUNNEL_TAG, "本地读结束：${error.message}")
        } finally {
            upFinished.set(true)
            maybeShutdown()
        }
    }

    /**
     * 本地请求写完后（up 已 closeWrite）：
     * - 若 down 也已结束（回应已收全），直接收口；
     * - 否则给 down 一段宽限收尾，到点强制整体收口，避免半截卡死的连接永远挂着。
     */
    private fun lingerOrWaitForDown() {
        val deadline = System.nanoTime() + lingerMs * 1_000_000L
        while (!downFinished.get() && !done.get()) {
            if (System.nanoTime() >= deadline) return
            try {
                Thread.sleep(20)
            } catch (interrupted: InterruptedException) {
                Thread.currentThread().interrupt()
                return
            }
        }
    }

    /**
     * 整体收口。只在**两个方向都结束**时执行一次：`down` 先结束而 `up` 仍在写时绝不提前
     * `close conn`（那会掐断在途请求，是 `tc_conn_read closed` 的根因）。
     */
    private fun maybeShutdown() {
        if (!downFinished.get() || !upFinished.get()) return
        if (!done.compareAndSet(false, true)) return
        runCatching { socket.close() }
        runCatching { conn.close() }
    }

    /** 外部（代理收摊、配对重建）要立刻收掉这条连接时调用：两个方向都置结束再释放。 */
    fun close() {
        downFinished.set(true)
        upFinished.set(true)
        if (!done.compareAndSet(false, true)) return
        runCatching { socket.close() }
        runCatching { conn.close() }
    }
}
