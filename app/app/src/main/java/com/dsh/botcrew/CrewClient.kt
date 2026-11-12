package com.dsh.botcrew

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URLEncoder
import java.net.URL

/**
 * 连一段对话。
 *
 * [entries] 是按优先级排好的入口，由 [CrewRoute] 拼出来：P2P 代理 → 局域网 → 公网。
 * 走哪条不是配置出来的，是**试出来的**：先用当前这条，连不上就按顺序试下一条。
 * 同一 Wi-Fi 下局域网直连更快，出门之后局域网那条根本不存在 ——
 * 与其让人去设置里开关，不如让它自己认。
 *
 * 入口表可以在运行期重排（[promote]）：P2P 那条是后台接上的，接通之前这张表里没有它。
 */
class CrewClient(
    entries: List<String>,
    private val token: String,
    /** 队伍自己签发的设备凭据。独立监听那道门认它，不认网关 token。 */
    private val deviceId: String? = null,
    /** 换了入口并真的成功之后才回调：上层据此把「现在在哪条路上」说出来。 */
    private val onRouteSwitched: ((String) -> Unit)? = null,
) {
    /**
     * 试的顺序。空串在这里没有意义，构造时就丢掉。
     *
     * 重排时整张表换成一个新值，不原地改：一条请求跑到一半时表被换掉，它手里那份仍然完整。
     */
    @Volatile
    private var order: List<String> = entries.map(CrewPairing::normalize).filter(String::isNotBlank)

    /**
     * 当前在用的入口。存地址而不是下标 —— 表一旦重排，同一个下标指的就是另一条路了。
     */
    @Volatile
    private var current: String = order.firstOrNull().orEmpty()

    /** 现在在用的入口。语音与播报那两条直连的请求也走它。 */
    private val base: String get() = current.ifEmpty { order.firstOrNull().orEmpty() }

    /** 现在会按什么顺序试。给测试和日志看。 */
    fun routeOrder(): List<String> = order

    /**
     * 把一条**已经确认可用**的入口提到队首。
     *
     * P2P 是后台接上的：接通前这张表里只有局域网和公网，探通之后不提上来，这一整次会话
     * 就都还在绕远路。表与「在用的那条」在同一个锁里一起换，读的人不会看到只换了一半的状态。
     */
    fun promote(entry: String) {
        val clean = CrewPairing.normalize(entry)
        if (clean.isEmpty()) return
        synchronized(this) {
            order = listOf(clean) + order.filter { it != clean }
            current = clean
        }
    }

    /**
     * 发一次请求并把正文读回来。每个接口只差路径、方法与 body，
     * 连接的开合收在这一处：漏一次 disconnect 就是一条泄漏的 socket。
     *
     * 换路只发生在「连不上」的时候：先当前这条，再按表上的顺序绕一圈。401 不换路：
     * 那是凭据问题，换一条同样进不去，只会让人多等一次超时，还把错误说成「连不上」。
     *
     * 记住「哪条通」是为了不再重蹈：出门之后每条请求都先试一遍不存在的局域网地址，
     * 就是每次都要多等一次超时。代价是 P2P 断了之后要等下次启动才会被重新拣起来 ——
     * 隧道重连本身在库内部做，真的恢复了也是一次新的请求周期。
     */
    private suspend fun read(path: String, method: String, body: String? = null): String =
        withContext(Dispatchers.IO) {
            // 这一趟用自己拿到的那份表：中途被 promote 换掉，它照旧按旧表跑完。
            val table = order
            if (table.isEmpty()) throw IOException("队伍地址不对：没有可用的入口")
            // 从当前在用的那条开始绕一圈；current 不在表里（不该发生）就从第一条起。
            val start = table.indexOf(current).coerceAtLeast(0)
            var failure: IOException? = null
            for (step in table.indices) {
                val entry = table[(start + step) % table.size]
                try {
                    val text = attempt(entry, path, method, body)
                    // 表没被换过才把「现在用哪条」写回去。换过说明 P2P 刚升级上来，
                    // 这一次成功走的是旧路，不该把「当前入口」改回旧的那条。
                    if (entry != current && table === order) {
                        current = entry
                        onRouteSwitched?.invoke(entry)
                    }
                    return@withContext text
                } catch (error: CrewRejected) {
                    throw error
                } catch (error: IOException) {
                    // 报出去的仍是第一条路的错：那才是人最先遇到的那个现象。
                    if (failure == null) failure = error
                }
            }
            throw failure ?: IOException("队伍地址不对：没有可用的入口")
        }

    private fun attempt(entry: String, path: String, method: String, body: String?): String {
        val connection = open(entry, path, method, body)
        return try {
            connection.inputStream.bufferedReader().use { it.readText() }
        } finally {
            connection.disconnect()
        }
    }

    /**
     * 把读回来的正文解析成对象，放在后台线程做。
     *
     * read() 的网络已经在 IO 线程上，但解析（上面每个 wire 的 parse）原来落在调用方
     * 所在的那条线程 —— 也就是主线程。时间线越长，一次 parseTimeline 就要在主线程上
     * 建几十上百个 JSONObject 和同样多的 data class，正卡在人滑动的那一帧上。
     * 解析是纯函数（只读字符串、不碰任何界面状态），挪到 Default 上去做的事一模一样，
     * 只是不再占主线程的时间片。
     *
     * 用 Default 而不是 IO：IO 那一池是给「等着」的活（网络、磁盘）留的，
     * 解析是实打实吃 CPU 的，占着 IO 线程会让下一次请求排队。
     */
    private suspend fun <T> parse(body: String, decode: (String) -> T): T =
        withContext(Dispatchers.Default) { decode(body) }

    /** 拉整段对话。失败时抛出带人话的异常，界面直接显示。 */
    suspend fun timeline(): Conversation =
        parse(read("/api/mobile/timeline", "GET"), CrewWire::parseTimeline)

    /**
     * 上报已读位置：进对话屏时把主人读到的最后一条回话 id 交给后端（契约 §5.6）。
     *
     * 失败不该打断主人看消息：这是一次「记水位」的后台小事，网络抖一下下次进屏再报就是。
     * 所以这里吞掉异常，只做尽力而为 —— 后端记不住水位时，`unread_replies` 会退回 unknown，
     * 那是三态里正当的一格，不是错误。
     */
    suspend fun reportRead(lastReadId: String) {
        if (lastReadId.isBlank()) return
        try {
            read("/api/mobile/read", "POST", CrewWire.readBody(lastReadId))
        } catch (_: java.io.IOException) {
            // 尽力而为：下次进屏再报。
        }
    }

    /** 发一条消息。requestId 由调用方生成并保留，重试时沿用。 */
    suspend fun send(text: String, mentions: List<String>, requestId: String) {
        read("/api/mobile/send", "POST", CrewWire.sendBody(text, mentions, requestId))
    }

    /** 撤回一条还在排队、没被队伍读走的消息。已经读走/回复的由后端拒绝。 */
    suspend fun withdraw(requestId: String) {
        read("/api/mobile/withdraw", "POST", JSONObject().put("request_id", requestId).toString())
    }

    /** 插队：把排队中的一条直接交给正在跑的工单，它在下一步边界先读。 */
    suspend fun steer(ticketId: String, requestId: String) {
        read("/api/mobile/steer", "POST",
            JSONObject().put("ticket", ticketId).put("request_id", requestId).toString())
    }

    /** 发送即插队：新写的一句不进队列，直接交给正在跑的工单。 */
    suspend fun steerText(ticketId: String, requestId: String, text: String) {
        read("/api/mobile/steer", "POST",
            JSONObject().put("ticket", ticketId).put("request_id", requestId).put("text", text).toString())
    }

    /** 可选模型目录：能连的 provider、每种的模型，以及每位成员当前的路由。 */
    suspend fun models(): ModelCatalog =
        parse(read("/api/mobile/models", "GET"), ModelWire::parseCatalog)

    /** 某个模型的推理档位。拉不到就抛错，界面照实说，不自己编档位。 */
    suspend fun efforts(provider: String, model: String): Efforts {
        val query = "?provider=" + URLEncoder.encode(provider, "UTF-8") + "&model=" + URLEncoder.encode(model, "UTF-8")
        return parse(read("/api/mobile/efforts$query", "GET"), ModelWire::parseEfforts)
    }

    /**
     * 一次切模型。provider 必填，光有模型名不知道往哪连。
     * botId 为空是全员；`model` 为空且带 botId 表示这一位改回跟随全员。
     */
    suspend fun switchModel(
        provider: String,
        model: String,
        botId: String? = null,
        reasoningEffort: String? = null,
    ) {
        val body = JSONObject().put("provider", provider).put("model", model)
        if (!botId.isNullOrBlank()) body.put("bot_id", botId)
        if (!reasoningEffort.isNullOrBlank()) body.put("reasoningEffort", reasoningEffort)
        read("/api/mobile/model", "POST", body.toString())
    }

    /** 一张工单下的代理树。客户端只读，不据此维护状态。 */
    suspend fun agents(ticketId: String): List<AgentNode> =
        parse(read("/api/mobile/agents?ticket=" + URLEncoder.encode(ticketId, "UTF-8"), "GET"), AgentWire::parse)

    /** 一张工单是怎么做出来的。读不到不算错：后台栏空着比报错好。 */
    suspend fun work(ticketId: String): List<WorkStep> =
        parse(read("/api/mobile/work?ticket=" + URLEncoder.encode(ticketId, "UTF-8"), "GET"), WorkWire::parse)

    /** 它此刻的屏幕：有活动快照就显示快照，没有时后端会给理由，界面照着写，不自己编。 */
    suspend fun screen(ticketId: String?): ScreenView {
        val query = if (ticketId.isNullOrBlank()) "" else "?ticket=" + URLEncoder.encode(ticketId, "UTF-8")
        return parse(read("/api/mobile/screen$query", "GET"), ScreenWire::parse)
    }

    /**
     * 一张工单交出来的东西（契约 §5.4）。消息结果条只读这一张票 ——
     * 票号由消息自己带着，读不到也不去问别的票。
     */
    suspend fun outputs(ticketId: String): OutputsView {
        val query = "?ticket=" + URLEncoder.encode(ticketId, "UTF-8")
        return parse(read("/api/mobile/outputs$query", "GET"), OutputsWire::parse)
    }

    /**
     * 常规任务：主人写下的定时账本（契约 §5.5）。
     *
     * 只有这一条读的接口，没有写接口 —— 加 / 改 / 开关 / 删这一轮都还没有定由谁来写，
     * 所以客户端不拿本地状态去凑一份「改过了」的样子。
     */
    suspend fun routines(): RoutinesView = RoutinesWire.parse(read("/api/mobile/routines", "GET"))

    /** 新建一条常规任务。校验交给后端，错误原样带回去显示。 */
    suspend fun createRoutine(title: String, cycle: String, botId: String, enabled: Boolean) {
        read("/api/mobile/routines", "POST", RoutinesWrite.createBody(title, cycle, botId, enabled))
    }

    /** 改一条常规任务。 */
    suspend fun editRoutine(id: String, title: String, cycle: String, botId: String, enabled: Boolean) {
        read("/api/mobile/routines", "POST", RoutinesWrite.editBody(id, title, cycle, botId, enabled))
    }

    /** 删一条常规任务。 */
    suspend fun removeRoutine(id: String) {
        read("/api/mobile/routines", "POST", RoutinesWrite.removeBody(id))
    }

    /**
     * 记忆：队伍长期记得的事。
     *
     * 不带 `bot` 读全队；带就读那一位的。三态由后端给（live / empty / unavailable），
     * 客户端不拿空列表冒充「没有」。
     */
    suspend fun memory(botId: String? = null): MemoryView {
        val query = if (botId.isNullOrBlank()) "" else "?bot=" + URLEncoder.encode(botId, "UTF-8")
        return parse(read("/api/mobile/memory$query", "GET"), MemoryWire::parse)
    }

    /**
     * 语音输入：把一段 WAV 交给后端，换回一句话。
     *
     * body 就是录音本身，不 base64、不包 JSON —— 多一层编码就多一次「为什么是乱码」的机会。
     * 识别不了时后端回一个带 `available: false` 的 JSON，这里原样读成 VoiceResult。
     */
    suspend fun voice(wav: ByteArray): VoiceResult = withContext(Dispatchers.IO) {
        val connection = (URL(base + "/api/mobile/voice").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            // 录一分钟要认一会儿：读超时比别处长。
            connectTimeout = 15_000
            readTimeout = 60_000
            setRequestProperty("Content-Type", "audio/wav")
            setRequestProperty("X-GW-Token", token)
            deviceId?.let { setRequestProperty("x-crew-device", it) }
            if (deviceId != null) setRequestProperty("x-crew-credential", token)
        }
        try {
            connection.outputStream.use { it.write(wav) }
            val text = connection.inputStream.bufferedReader().use { it.readText() }
            VoiceWire.parse(text)
        } catch (error: Exception) {
            VoiceResult(available = false, text = "", reason = error.message ?: "语音没发出去")
        } finally {
            connection.disconnect()
        }
    }

    /**
     * 播报：把一句话念成 WAV。
     *
     * 念不出来时后端回的是 JSON（带 `reason`），念出来时回的是音频字节 ——
     * 所以先看响应头，别把一段 JSON 当 WAV 交给播放器。
     */
    suspend fun speak(text: String): SpeechResult = withContext(Dispatchers.IO) {
        val connection = URL(base + "/api/mobile/speak").openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 8_000
            // 念一段话可能要几秒；`say` 本身很快，但要把转码算进去。
            connection.readTimeout = 60_000
            connection.doOutput = true
            connection.setRequestProperty("content-type", "application/json")
            connection.setRequestProperty("authorization", "Bearer " + token)
            val payload = JSONObject().put("text", text).toString().toByteArray()
            connection.setFixedLengthStreamingMode(payload.size)
            connection.outputStream.use { it.write(payload) }
            val code = connection.responseCode
            val type = connection.contentType ?: ""
            if (code !in 200..299 || !type.startsWith("audio/")) {
                val body = (connection.errorStream ?: connection.inputStream)?.bufferedReader()?.use { it.readText() } ?: ""
                return@withContext SpeechWire.parseFailure(body)
            }
            val bytes = connection.inputStream.use { it.readBytes() }
            SpeechResult(
                available = true,
                wav = bytes,
                seconds = connection.getHeaderField("x-speech-seconds")?.toDoubleOrNull() ?: 0.0,
                truncated = connection.getHeaderField("x-speech-truncated") == "1",
                reason = "",
            )
        } finally {
            connection.disconnect()
        }
    }

    /** 逐条用量：这张票每一步用的谁、多少、上下文还剩多少。 */
    suspend fun replySpends(ticketId: String): ReplySpends =
        parse(read("/api/mobile/reply-spend?ticket=" + URLEncoder.encode(ticketId, "UTF-8"), "GET"), ReplySpendWire::parse)

    /** 忘掉一条记忆。只翻状态，不删行。 */
    suspend fun forgetMemory(name: String) {
        read("/api/mobile/memory", "POST", MemoryWire.forgetBody(name))
    }

    /** 改一条记忆的正文。 */
    suspend fun editMemory(name: String, description: String, body: String) {
        read("/api/mobile/memory", "POST", MemoryWire.editBody(name, description, body))
    }

    /** 接手：把这个工单停下来。停不下来就抛错，界面照实说，不假装点过了。 */
    suspend fun takeover(ticketId: String) {
        read("/api/mobile/takeover", "POST", JSONObject().put("ticket", ticketId).toString())
    }

    /** 停一下。只有后端确认成功且给出执行器作用域才更新界面。 */
    suspend fun pause(ticketId: String?): String {
        val body = if (ticketId.isNullOrBlank()) "{}" else JSONObject().put("ticket", ticketId).toString()
        return parse(read("/api/mobile/pause", "POST", body)) { text ->
            val receipt = JSONObject(text)
            if (receipt.opt("ok") != true || receipt.opt("scope") != "executor") {
                throw IOException("暂停未确认：队伍回执不完整")
            }
            "executor"
        }
    }

    /** 恢复执行器：HTTP 成功还须有明确的恢复回执。 */
    suspend fun resume(): String = parse(read("/api/mobile/resume", "POST", "{}")) { text ->
        val receipt = JSONObject(text)
        if (receipt.opt("ok") != true || receipt.opt("resumed") != true || receipt.opt("scope") != "executor") {
            throw IOException("继续执行未确认：队伍回执不完整")
        }
        "executor"
    }

    /** 加一位 Bot。id 不合规或重名由后端判，错误原样带回去显示。 */
    suspend fun createBot(botId: String, name: String, persona: String = "") {
        read("/api/mobile/bots", "POST", BotsWire.createBody(botId, name, persona))
    }

    /**
     * 改一位的名字与人设。bot_id 不动 —— 记忆命名空间挂在它上面。
     *
     * 走 POST + action：消息面由 DSH 的 Connection 转发，它只放行 GET/POST，
     * PUT/DELETE 根本到不了插件（上一步就是这么静默失败的）。
     */
    suspend fun editBot(botId: String, name: String, persona: String) {
        read("/api/mobile/bots", "POST", BotsWire.editBody(botId, name, persona))
    }

    /** 撤一位。后端会把 default 顺延给下一位。 */
    suspend fun removeBot(botId: String) {
        read("/api/mobile/bots", "POST", BotsWire.removeBody(botId))
    }

    /** 让一张失败/卡住的票再跑一次。走消息面：手机到不了管理面（它要求本机同源）。 */
    suspend fun retry(ticketId: String) {
        read("/api/mobile/retry?ticket=" + URLEncoder.encode(ticketId, "UTF-8"), "POST")
    }

    private fun open(entry: String, path: String, method: String, body: String?): HttpURLConnection {
        val url = try {
            // 路径都带 /api/mobile 前缀：那是消息面的位置，独立监听与插件路由都只认它。
            URL(entry + path)
        } catch (error: Exception) {
            throw IOException("队伍地址不对：$entry")
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
            // 专用类型：凭据不对时不许换路重试，见 read()。
            if (status == 401) throw CrewRejected("队伍拒绝了这次请求：token 不对")
            if (status >= 300) {
                val detail = connection.errorStream?.bufferedReader()?.use { it.readText() }?.take(200).orEmpty()
                throw IOException("队伍返回 $status：$detail")
            }
        } catch (error: IOException) {
            connection.disconnect()
            throw error
        } catch (error: Exception) {
            connection.disconnect()
            throw IOException("连不上队伍（$entry）：${error.message}")
        }
        return connection
    }
}

/** 对端明确拒绝了凭据：地址是通的，换一条路也一样进不去。 */
private class CrewRejected(message: String) : IOException(message)
