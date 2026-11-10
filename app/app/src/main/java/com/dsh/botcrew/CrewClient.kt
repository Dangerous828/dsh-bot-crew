package com.dsh.botcrew

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
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

    /** 拉整段对话。失败时抛出带人话的异常，界面直接显示。 */
    suspend fun timeline(): Conversation = withContext(Dispatchers.IO) {
        val connection = open("/api/mobile/timeline", "GET", null)
        try {
            val body = connection.inputStream.bufferedReader().use { it.readText() }
            CrewWire.parseTimeline(body)
        } finally {
            connection.disconnect()
        }
    }

    /** 发一条消息。requestId 由调用方生成并保留，重试时沿用。 */
    suspend fun send(text: String, mentions: List<String>, requestId: String) = withContext(Dispatchers.IO) {
        val connection = open("/api/mobile/send", "POST", CrewWire.sendBody(text, mentions, requestId))
        try {
            connection.inputStream.bufferedReader().use { it.readText() }
            Unit
        } finally {
            connection.disconnect()
        }
    }

    /** 一次切模型。provider 必填，光有模型名不知道往哪连。 */
    suspend fun switchModel(provider: String, model: String) = withContext(Dispatchers.IO) {
        val connection = open("/api/mobile/model", "POST", """{"provider":"$provider","model":"$model"}""")
        try {
            connection.inputStream.bufferedReader().use { it.readText() }
            Unit
        } finally {
            connection.disconnect()
        }
    }

    /** 一张工单下的代理树。客户端只读，不据此维护状态。 */
    suspend fun agents(ticketId: String): List<AgentNode> = withContext(Dispatchers.IO) {
        val connection = open("/api/mobile/agents?ticket=" + URLEncoder.encode(ticketId, "UTF-8"), "GET", null)
        try {
            AgentWire.parse(connection.inputStream.bufferedReader().use { it.readText() })
        } finally {
            connection.disconnect()
        }
    }

    /** 一张工单是怎么做出来的。读不到不算错：后台栏空着比报错好。 */
    suspend fun work(ticketId: String): List<WorkStep> = withContext(Dispatchers.IO) {
        val connection = open("/api/mobile/work?ticket=" + URLEncoder.encode(ticketId, "UTF-8"), "GET", null)
        try {
            WorkWire.parse(connection.inputStream.bufferedReader().use { it.readText() })
        } finally {
            connection.disconnect()
        }
    }

    /** 让一张失败的票再跑一次。走管理面，不是消息面。 */
    suspend fun retry(ticketId: String) = withContext(Dispatchers.IO) {
        val url = URL(base.trimEnd('/') + "/orchestrator/api/tickets/" + URLEncoder.encode(ticketId, "UTF-8") + "/retry")
        val connection = url.openConnection() as HttpURLConnection
        connection.requestMethod = "POST"
        connection.connectTimeout = 8_000
        connection.readTimeout = 15_000
        // 管理面只认本机同源请求。
        connection.setRequestProperty("x-orchestrator-request", "1")
        try {
            val code = connection.responseCode
            if (code !in 200..299) {
                val text = connection.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
                throw IllegalStateException(text.ifBlank { "HTTP $code" })
            }
            Unit
        } finally {
            connection.disconnect()
        }
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
