package com.dsh.botcrew

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** 连一段对话。base 形如 http://10.0.2.2:18882（模拟器里 10.0.2.2 是宿主机）。 */
class CrewClient(private val base: String, private val token: String) {

    /** 拉整段对话。失败时抛出带人话的异常，界面直接显示。 */
    suspend fun timeline(): Conversation = withContext(Dispatchers.IO) {
        val connection = open("/timeline", "GET", null)
        try {
            val body = connection.inputStream.bufferedReader().use { it.readText() }
            CrewWire.parseTimeline(body)
        } finally {
            connection.disconnect()
        }
    }

    /** 发一条消息。requestId 由调用方生成并保留，重试时沿用。 */
    suspend fun send(text: String, mentions: List<String>, requestId: String) = withContext(Dispatchers.IO) {
        val connection = open("/send", "POST", CrewWire.sendBody(text, mentions, requestId))
        try {
            connection.inputStream.bufferedReader().use { it.readText() }
            Unit
        } finally {
            connection.disconnect()
        }
    }

    private fun open(path: String, method: String, body: String?): HttpURLConnection {
        val url = try {
            URL(base + path)
        } catch (error: Exception) {
            throw IOException("队伍地址不对：$base")
        }
        val connection = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15_000
            readTimeout = 20_000
            setRequestProperty("X-GW-Token", token)
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
