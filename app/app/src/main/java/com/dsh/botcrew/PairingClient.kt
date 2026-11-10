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

/** 配好之后存下来的东西。存在本机，下次开 App 直接用。 */
data class PairedCrew(val deviceId: String, val token: String, val base: String)
