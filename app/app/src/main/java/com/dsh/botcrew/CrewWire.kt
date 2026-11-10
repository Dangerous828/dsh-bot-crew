package com.dsh.botcrew

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException

/** 一条消息。角色只有两种：人说的，和队伍里某个 Bot 说的。 */
data class Message(val id: String, val fromBot: Boolean, val botId: String?, val text: String, val at: String)

/**
 * 名片上能看到的那些字。它是呈现，不持有任何任务状态。
 *
 * since 是这个 Bot 最早那张工单的时间，回答「认识多久」。后台取不到时不返回这个字段，
 * 所以它可空且默认 null —— 缺失与「有值但读不懂」都落到同一档：这一行不显示。
 */
data class BotCard(
    val id: String,
    val name: String,
    val role: String,
    val persona: String,
    val since: String? = null,
)

data class Conversation(
    val messages: List<Message>,
    val bots: List<BotCard>,
    val defaultBotId: String,
    val tickets: List<WorkTicket> = emptyList(),
    val status: CrewStatus = CrewStatus("", "", false),
    /** 还没被回复的消息，也就是还能撤回的那几条。 */
    val queued: List<String> = emptyList(),
)

/**
 * 消息面的线上格式。只说两件事：把回话读成对话，把一句话写成请求。
 * 解析是宽容的：不认识的字段跳过，不因为多一个字段就整段失败。
 */
object CrewWire {
    /** 配对入口挂在这里，调用方不用记是哪个 object 管这一段。 */
    fun parseReach(body: String): List<ReachAddress> = PairingWire.parseReach(body)
    fun parseCredential(body: String): Credential? = PairingWire.parseCredential(body)


    fun parseTimeline(body: String): Conversation {
        val root = JSONObject(body)
        val messages = mutableListOf<Message>()
        val items = root.optJSONArray("items") ?: JSONArray()
        for (index in 0 until items.length()) {
            val item = items.optJSONObject(index) ?: continue
            val role = item.optString("role", "")
            // 网关只写 user / agent；别的值当作未知，直接跳过，不猜。
            if (role != "user" && role != "agent") continue
            val botId = item.optString("bot_id").takeIf { it.isNotEmpty() }
            messages.add(
                Message(
                    id = item.optString("id"),
                    fromBot = role == "agent",
                    botId = botId,
                    text = readable(item.optString("text")),
                    at = item.optString("at"),
                ),
            )
        }
        val bots = mutableListOf<BotCard>()
        val cards = root.optJSONArray("bots") ?: JSONArray()
        for (index in 0 until cards.length()) {
            val card = cards.optJSONObject(index) ?: continue
            bots.add(
                BotCard(
                    id = card.optString("id"),
                    name = card.optString("name"),
                    role = card.optString("role"),
                    persona = card.optString("persona"),
                    // 字段缺席时 optString 给空串；这里统一成 null，让「没有」只有一种形状。
                    since = card.optString("since").takeIf(String::isNotBlank),
                ),
            )
        }
        val tickets = mutableListOf<WorkTicket>()
        val tasks = root.optJSONArray("tasks") ?: JSONArray()
        for (index in 0 until tasks.length()) {
            val task = tasks.optJSONObject(index) ?: continue
            tickets.add(
                WorkTicket(
                    id = task.optString("id"),
                    title = task.optString("title"),
                    state = task.optString("state"),
                    botId = task.optString("bot_id"),
                    needsPerson = task.optString("needs_person"),
                ),
            )
        }
        val statusJson = root.optJSONObject("status")
        val status = CrewStatus(
            runtime = statusJson?.optString("runtime").orEmpty(),
            mobile = statusJson?.optString("mobile").orEmpty(),
            paused = statusJson?.optBoolean("paused") ?: false,
        )
        val queuedJson = root.optJSONArray("queued") ?: JSONArray()
        val queued = (0 until queuedJson.length()).mapNotNull { queuedJson.optString(it).takeIf(String::isNotBlank) }
        return Conversation(messages, bots, root.optString("default_bot_id"), tickets, status, queued)
    }

    /** 发消息的请求体。requestId 是幂等键，重试要沿用同一个。 */
    fun sendBody(text: String, mentions: List<String>, requestId: String): String {
        val mentionsJson = JSONArray()
        mentions.forEach { mentionsJson.put(it) }
        return JSONObject()
            .put("text", text)
            .put("request_id", requestId)
            .put("mentions", mentionsJson)
            .toString()
    }

    /** 从一句话里认出被 @ 的 Bot：名片上的名字和 id 都算。 */
    fun mentionsIn(text: String, bots: List<BotCard>): List<String> {
        val found = mutableListOf<String>()
        for (bot in bots) {
            val named = text.contains("@${bot.id}") || (bot.name.isNotEmpty() && text.contains("@${bot.name}"))
            if (named) found.add(bot.id)
        }
        return found
    }
}

/** 一条工单在本地的样子。它是后台的只读投影，客户端不据此维护状态机。 */
data class WorkTicket(
    val id: String,
    val title: String,
    val state: String,
    val botId: String,
    val needsPerson: String,
)

/** 队伍自己的健康状况。 */
data class CrewStatus(val runtime: String, val mobile: String, val paused: Boolean) {
    /** 能接活：在跑且没暂停。 */
    fun ready(): Boolean = runtime == "ready" && !paused
}

/** 工单下的一棵代理树。子代理还能再分子代理，所以这个形状必须能套自己。 */
data class AgentNode(
    val id: String,
    val label: String,
    val state: String,
    val children: List<AgentNode>,
)

/** 名片：人设是「他是谁」，和任务状态是两件事。 */
data class BotProfile(
    val id: String,
    val name: String,
    val persona: String,
)

/** 解析 /agents 返回的树。层数由数据决定，客户端不预设深度。 */
object AgentWire {
    fun parse(body: String): List<AgentNode> {
        val root = JSONObject(body)
        val agents = root.optJSONArray("agents") ?: return emptyList()
        return (0 until agents.length()).mapNotNull { node(agents.optJSONObject(it)) }
    }

    private fun node(value: JSONObject?): AgentNode? {
        value ?: return null
        val children = value.optJSONArray("children") ?: JSONArray()
        return AgentNode(
            id = value.optString("id"),
            label = value.optString("label"),
            state = value.optString("state"),
            children = (0 until children.length()).mapNotNull { node(children.optJSONObject(it)) },
        )
    }
}

/** 手机该连回哪个地址。url 已经带好 IPv6 的方括号，调用方拼端口就行。 */
data class ReachAddress(val address: String, val family: String, val url: String)

/** 配对换回来的凭据。只在配对成功那一刻出现一次。 */
data class Credential(val deviceId: String, val token: String)

/** 配对相关的解析。与消息面分开：还没有凭据时也得能用。 */
object PairingWire {
    fun parseReach(body: String): List<ReachAddress> {
        val addresses = JSONObject(body).optJSONArray("addresses") ?: return emptyList()
        return (0 until addresses.length()).mapNotNull { index ->
            val entry = addresses.optJSONObject(index) ?: return@mapNotNull null
            ReachAddress(
                address = entry.optString("address"),
                family = entry.optString("family"),
                url = entry.optString("url"),
            )
        }
    }

    /** null 表示没配成：响应里没有 token 就是拒绝，别把它当成已配对。 */
    fun parseCredential(body: String): Credential? {
        val root = JSONObject(body)
        val token = root.optString("token")
        val device = root.optString("deviceId")
        return if (token.isNotBlank() && device.isNotBlank()) Credential(device, token) else null
    }
}

/** 配对请求体。设备自报身份，服务端只认它发的码。 */
fun pairingBody(deviceId: String, name: String, platform: String): String =
    JSONObject().put("deviceId", deviceId).put("name", name).put("platform", platform).toString()

/** 要一个配对码；deviceId 是这台设备自己报的名字。 */
fun pairingCodeBody(deviceId: String): String = JSONObject().put("deviceId", deviceId).toString()

/** 一张工单是怎么做出来的：每次执行留下一句结论，按时间排开。 */
data class WorkStep(val at: String, val kind: String, val text: String)

object WorkWire {
    fun parse(body: String): List<WorkStep> {
        val steps = JSONObject(body).optJSONArray("steps") ?: return emptyList()
        return (0 until steps.length()).mapNotNull { index ->
            val step = steps.optJSONObject(index) ?: return@mapNotNull null
            WorkStep(
                at = step.optString("at"),
                kind = step.optString("kind"),
                // 没字的步骤不显示：那是噪声，不是进度。
                text = step.optString("text").takeIf(String::isNotBlank) ?: return@mapNotNull null,
            )
        }
    }
}

/** 名片上「认识多久」那一行的取值。 */
object BotSince {
    /** 只到日期：具体几点几分对「认识多久」没有意义，反而把行撑长。 */
    private val DATE = DateTimeFormatter.ofPattern("yyyy-MM-dd")

    /**
     * 后台给的是 UTC 的 ISO 时间，人看的是本地日子，所以先换成设备时区再取日期：
     * 直接截字符串会把东八区凌晨的单子记成前一天。
     *
     * 返回 null 表示这一行别画：没有字段、空串、以及读不懂的时间都算「不知道」，
     * 不拿「未知」占位 —— 那是把缺数据画成了数据。
     */
    fun label(raw: String?, zone: ZoneId = ZoneId.systemDefault()): String? {
        val at = instantOf(raw) ?: return null
        return "从 ${DATE.format(at.atZone(zone))} 起"
    }

    /**
     * 认两种写法：后台的 `2026-09-14T03:00:00.000Z`，以及不带时区的 `2026-09-14T03:00:00`。
     * 后者只能当本地时间读，这是唯一能猜的解读。
     */
    private fun instantOf(raw: String?): Instant? {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return null
        return try {
            OffsetDateTime.parse(text, DateTimeFormatter.ISO_OFFSET_DATE_TIME).toInstant()
        } catch (_: DateTimeParseException) {
            try {
                LocalDateTime.parse(text, DateTimeFormatter.ISO_LOCAL_DATE_TIME)
                    .atZone(ZoneId.systemDefault())
                    .toInstant()
            } catch (_: DateTimeParseException) {
                null
            }
        }
    }
}

/** 工作区页里那两个动作。名字就是画板上的字，界面和文案都从这一处取。 */
enum class WorkspaceAction(val label: String) {
    Takeover("接手操作"),
    Pause("让它停一下"),
}

/**
 * 工作区页上的状态。
 *
 * frames 是这个 Bot 现在正在看的浏览器画面，按出现顺序排；status 是它此刻的处境
 * （没在干活 / 在跑 / 在等你 / 失败了）。两者都可空：后端还没给，界面就得能画一个
 * 诚实的空 —— 不许拿一张假画面冒充它的屏幕。
 */
data class Workspace(
    val bot: BotCard,
    val frames: List<String> = emptyList(),
    val status: String = "",
)

/**
 * 工作区页的文字。画板画的是「屏幕已经接上」那一刻，实际后端还没有这条接口，
 * 所以这些函数的存在意义只有一个：把「现在没有」这件事说成一句人能懂的话，
 * 而不是画一块灰板让人以为在加载。
 *
 * 纯函数，测试直接钉住每一个断面。
 */
object WorkspaceCopy {
    /** 屏幕上还看不到东西时那一行。 */
    const val PLACEHOLDER = "画面还没接上"

    /**
     * 点一下入口时的实话。和桌面端（desktop/ui.go 里 screenReady 为 false 那一支）
     * 同一句话 —— 同一件事两端不该说两种话。
     *
     * 手机这边的入口是打开这一页，看见空位比一句一闪而过的提示更清楚，所以界面暂时没有
     * 引用它；留着是因为桌面端那句话要有可对照的源，测试也钉着它。
     */
    const val NOT_READY = "还看不到它的屏幕：这一步还没接上"

    /** 接手的说明。它说的是设计里的约定（接手后 Bot 停在原地），不是此刻在发生的事。 */
    const val TAKEOVER_NOTE = "接手后它就不动了，把手机放下才算还给它"

    /** 顶栏的副行。 */
    const val SUBTITLE = "这不是你的屏幕，是它的"

    /**
     * 动作按下去之后显示的那一行。
     *
     * 两个动作都还没有后端接口，所以一律落到「没接上」；这不等于按钮坏了 ——
     * 点了没有任何反馈才叫坏了。措辞里带动作名，人点哪个就知道哪件事没做。
     */
    fun actionNote(action: WorkspaceAction): String = "${action.label}这一步还没接上，先别指望它真的动"

    /** 标题。「林」加一个空格加「的屏幕」，和画板一致。名字来自线上数据，先去掉两头空白再拼。 */
    fun title(bot: BotCard): String = "${bot.name.trim()} 的屏幕"

    /** 头像块里的那个字。空名字不画方块，交给调用方决定。 */
    fun initial(bot: BotCard): String = bot.name.trim().take(1)

    /**
     * 它此刻在干什么，写成顶栏下面的一行。
     *
     * 没有状态就返回 null，让那一行整行不画 —— 和名片上「认识多久」同一个规矩：
     * 缺数据不画成「未知」，那是把「不知道」画成了一条事实。
     */
    fun situation(status: String): String? = when (status) {
        "work" -> "正在干活"
        "person" -> "在等你决定"
        "failed" -> "这一步失败了"
        "done" -> "这一轮做完了"
        "" -> null
        // 后端将来加新状态时，界面不该装作认识它。
        else -> null
    }
}

/** 独立监听那道门要的两样东西。 */
fun deviceBody(deviceId: String, token: String): JSONObject =
    JSONObject().put("deviceId", deviceId).put("token", token)

/**
 * 有些历史消息的正文是 URL 编码过的（`App%e5%8F%91` 就是「App发」）。
 * 那是某次发送时把编码后的字符串当正文发了进去，数据本身就是脏的。
 *
 * 只在「解出来确实不一样、且原来那串确实是编码形态」时才解，别把正常消息动坏。
 */
internal fun readable(raw: String): String {
    if ('%' !in raw) return raw
    // 至少要出现一次 %XX 才像编码，否则普通文本里的 % 不该被解释。
    if (!Regex("""%[0-9A-Fa-f]{2}""").containsMatchIn(raw)) return raw
    return try {
        val decoded = java.net.URLDecoder.decode(raw, "UTF-8")
        // 解不出来（含非法序列）就原样返回，不要吞掉原文。
        if (decoded.isBlank()) raw else decoded
    } catch (_: IllegalArgumentException) {
        raw
    }
}
