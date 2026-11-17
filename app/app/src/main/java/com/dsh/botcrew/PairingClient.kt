package com.dsh.botcrew

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL

/**
 * 连回电脑的配对。
 *
 * 方向是电脑 → 手机：主人在电脑上点一下，屏幕上出六位码，手机只负责把码提交上去。
 * 手机从不向电脑要码 —— 那需要一个「还没配对也能访问」的口子，等于把门敞开。
 *
 * 提交走消息面的 `/api/mobile/pair`：Connection 已经验过签名凭据，那是手机唯一到得了的入口。
 * 配对面（路径以 /api/remote 开头的那几条）只认本机，是给电脑自己用的。
 */
class PairingClient(private val base: String) {

    /**
     * 带着凭据从局域网进来时先过这里。它不看 Host，只看凭据，所以局域网可达。
     * 配好之后每次启动都该先调它：凭据可能已经被电脑那边撤掉了。
     */
    suspend fun enter(deviceId: String, token: String) = withContext(Dispatchers.IO) {
        call("/api/remote/enter", "POST", "{\"deviceId\":\"$deviceId\",\"token\":\"$token\"}")
        Unit
    }

    /** 该连哪个地址。只在「手动填地址」那条路上用，正常配对不需要它。 */
    suspend fun reach(): List<ReachAddress> = withContext(Dispatchers.IO) {
        val body = call("/api/remote/reach", "GET", null)
        CrewWire.parseReach(body)
    }

    /**
     * 这个地址现在通不通。**只用来在提交配对码之前确认那一行还活着**（#31）。
     *
     * 为什么需要它：mDNS 的 `onServiceLost` 在 Android 13/14 上对「进程被 kill、没有
     * goodbye 包」的情形实测要 75–90 秒才回调（那是系统缓存 TTL，不是我们漏处理）。
     * 这段时间里列表上那一行还在，点它填进地址框、提交配对码，必然失败。
     *
     * 修法不是「猜它死了就删掉」—— 同网段里正常的再播间隔可以拉到 81 秒，
     * 按时长删行会误删一台活着的队伍。这里只做一次**可证伪**的确认：
     * TCP 握得上就是活着，握不上就是现在连不上。结论交给调用方去说，不写回列表。
     *
     * 用的是配对本身会走的那个地址和同一条 `call`，所以「通」这个结论与「配对能不能成」
     * 走的是同一条路，不是另开一个探针。对端回任何 HTTP 状态码都算通 —— 能答话就说明在。
     */
    suspend fun reachable(connectTimeoutMs: Int = 3_000): Boolean = withContext(Dispatchers.IO) {
        val target = base.trimEnd('/')
        if (target.isEmpty()) return@withContext false
        try {
            val connection = URL(target + "/api/mobile/__latency").openConnection() as HttpURLConnection
            connection.requestMethod = "GET"
            connection.connectTimeout = connectTimeoutMs
            connection.readTimeout = connectTimeoutMs
            try {
                // 不看状态码：401 / 404 都说明这台电脑在答话。
                connection.responseCode
                true
            } finally {
                connection.disconnect()
            }
        } catch (error: java.io.IOException) {
            false
        }
    }

    /** 用一支码换凭据。走消息面，拿不到 token 就是没配成。 */
    suspend fun pair(code: String, deviceId: String, name: String, platform: String): Credential =
        withContext(Dispatchers.IO) {
            val body = call("/api/mobile/pair", "POST", pairingBody(deviceId, name, platform).let {
                org.json.JSONObject(it).put("code", code).toString()
            })
            CrewWire.parseCredential(body) ?: throw IllegalStateException("配对被拒绝，检查验证码是否过期")
        }

    private fun call(path: String, method: String, body: String?): String {
        val connection = URL(base.trimEnd('/') + path).openConnection() as HttpURLConnection
        connection.requestMethod = method
        connection.connectTimeout = 8_000
        connection.readTimeout = 15_000
        if (body != null) {
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.outputStream.use { it.write(body.toByteArray()) }
        }
        try {
            val stream = if (connection.responseCode in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (connection.responseCode !in 200..299) throw IllegalStateException(text.ifBlank { "HTTP ${connection.responseCode}" })
            return text
        } finally {
            connection.disconnect()
        }
    }
}

/**
 * 配好之后存下来的东西。存在本机，下次开 App 直接用。
 *
 * 三条路各占一格，角色固定，谁也不顶替谁：
 *
 * - [base] 是配对那一刻的局域网地址（同一 Wi-Fi 下最快的一条）；
 * - [fallbackBase] 是电脑的出门地址（`https://...`，配对时由 mDNS 的 `pub` 一并带过来）；
 * - [p2pAddr] 是电脑的隧道地址（tc-addr，配对时由 `p2p` 带过来），它是直连，比中转快得多。
 * - [crew] 是 stateDir 指纹（mDNS 的 `crew`），与网卡、网段都无关，用来在重新发现时认出同一台。
 *
 * 后三格可空的都是空串而不是 null：空串就是「这台电脑没有这项」，那不是错误，
 * 只是那个场景下走不通。三格分开存是为了让选路顺序（P2P → 局域网 → 公网）永远成立 ——
 * 把「上次哪条通」写回 base 会让下一次启动先试公网，把更快的路排到后面。
 * 网段相关的只有 base；重新发现同一台时按 crew 更新它，而不是记住旧网段的 IP。
 *
 * [session] 是上次停在哪个会话（契约 §3）。它不参与选路：只是启动时恢复的那一格，
 * 名单本身每次启动从 `GET /sessions` 拉。缺键回落 `main`，老装机逐字兼容。
 */
data class PairedCrew(
    val deviceId: String,
    val token: String,
    val base: String,
    val fallbackBase: String = "",
    val p2pAddr: String = "",
    val crew: String = "",
    val session: String = SessionRoute.MAIN,
    /**
     * 服务器身份指纹（来自 timeline/pair 的 `server.crew`，与 mDNS TXT `crew` 同源）。
     *
     * 空串表示「还没登记过可信身份」——首次配对或老记录。用来**精确比对**「这个公网入口是不是
     * 同一台后端」，而不是拿任意 200 当身份。它和 [crew]（mDNS 广播给的指纹）语义相同，
     * 但 [crew] 可能因为老记录/未发现而为空；这里存的是**服务端自己报的**，更可靠。
     */
    val serverCrew: String = "",
    /** 服务端自报的**可信**公网入口（timeline `server.public_base`，真实 HTTPS 或空）。 */
    val serverPublicBase: String = "",
)
