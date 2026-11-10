package com.dsh.botcrew

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URLEncoder
import java.net.URL

/** 连一段对话。base 形如 http://10.0.2.2:18882（模拟器里 10.0.2.2 是宿主机）。 */
class CrewClient(
    private val base: String,
    private val token: String,
    /** 队伍自己签发的设备凭据。独立监听那道门认它，不认网关 token。 */
    private val deviceId: String? = null,
) {

    /**
     * 发一次请求并把正文读回来。每个接口只差路径、方法与 body，
     * 连接的开合收在这一处：漏一次 disconnect 就是一条泄漏的 socket。
     */
    private suspend fun read(path: String, method: String, body: String? = null): String =
        withContext(Dispatchers.IO) {
            val connection = open(path, method, body)
            try {
                connection.inputStream.bufferedReader().use { it.readText() }
            } finally {
                connection.disconnect()
            }
        }

    /** 拉整段对话。失败时抛出带人话的异常，界面直接显示。 */
    suspend fun timeline(): Conversation = CrewWire.parseTimeline(read("/api/mobile/timeline", "GET"))

    /** 发一条消息。requestId 由调用方生成并保留，重试时沿用。 */
    suspend fun send(text: String, mentions: List<String>, requestId: String) {
        read("/api/mobile/send", "POST", CrewWire.sendBody(text, mentions, requestId))
    }

    /** 一次切模型。provider 必填，光有模型名不知道往哪连。 */
    suspend fun switchModel(provider: String, model: String) {
        read("/api/mobile/model", "POST", """{"provider":"$provider","model":"$model"}""")
    }

    /** 一张工单下的代理树。客户端只读，不据此维护状态。 */
    suspend fun agents(ticketId: String): List<AgentNode> =
        AgentWire.parse(read("/api/mobile/agents?ticket=" + URLEncoder.encode(ticketId, "UTF-8"), "GET"))

    /** 一张工单是怎么做出来的。读不到不算错：后台栏空着比报错好。 */
    suspend fun work(ticketId: String): List<WorkStep> =
        WorkWire.parse(read("/api/mobile/work?ticket=" + URLEncoder.encode(ticketId, "UTF-8"), "GET"))

    /** 它此刻的屏幕。现在后端只会回 unavailable 和理由，界面照着写，不自己编。 */
    suspend fun screen(ticketId: String?): ScreenView {
        val query = if (ticketId.isNullOrBlank()) "" else "?ticket=" + URLEncoder.encode(ticketId, "UTF-8")
        return ScreenWire.parse(read("/api/mobile/screen$query", "GET"))
    }

    /** 接手：把这个工单停下来。停不下来就抛错，界面照实说，不假装点过了。 */
    suspend fun takeover(ticketId: String) {
        read("/api/mobile/takeover", "POST", JSONObject().put("ticket", ticketId).toString())
    }

    /** 停一下。返回后端如实给出的 scope（现在只有 executor），界面据此解释恢复在哪。 */
    suspend fun pause(ticketId: String?): String {
        val body = if (ticketId.isNullOrBlank()) "{}" else JSONObject().put("ticket", ticketId).toString()
        return JSONObject(read("/api/mobile/pause", "POST", body)).optString("scope", "executor")
    }

    /** 加一位 Bot。id 不合规或重名由后端判，错误原样带回去显示。 */
    suspend fun createBot(botId: String, name: String, persona: String = "") {
        read("/api/mobile/bots", "POST", BotsWire.createBody(botId, name, persona))
    }

    /** 让一张失败/卡住的票再跑一次。走消息面：手机到不了管理面（它要求本机同源）。 */
    suspend fun retry(ticketId: String) {
        read("/api/mobile/retry?ticket=" + URLEncoder.encode(ticketId, "UTF-8"), "POST")
    }

    private fun open(path: String, method: String, body: String?): HttpURLConnection {
        val url = try {
            // 路径都带 /api/mobile 前缀：那是消息面的位置，独立监听与插件路由都只认它。
            URL(base + path)
        } catch (error: Exception) {
            throw IOException("队伍地址不对：$base")
        }
        val connection = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15_000
            readTimeout = 20_000
            setRequestProperty("X-GW-Token", token)
            // 走独立监听时，这道门要的是设备凭据；网关那套不认它，所以两样都带上，
            // 由对端决定认哪一个。
            deviceId?.let { setRequestProperty("x-crew-device", it) }
            if (deviceId != null) setRequestProperty("x-crew-credential", token)
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
            }
        }
        try {
            if (body != null) connection.outputStream.use { it.write(body.toByteArray()) }
            val status = connection.responseCode
            if (status == 401) throw IOException("队伍拒绝了这次请求：token 不对")
            if (status >= 300) {
                val detail = connection.errorStream?.bufferedReader()?.use { it.readText() }?.take(200).orEmpty()
                throw IOException("队伍返回 $status：$detail")
            }
        } catch (error: IOException) {
            connection.disconnect()
            throw error
        } catch (error: Exception) {
            connection.disconnect()
            throw IOException("连不上队伍（$base）：${error.message}")
        }
        return connection
    }
}
