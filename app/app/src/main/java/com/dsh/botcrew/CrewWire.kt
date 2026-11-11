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
data class Message(
    val id: String,
    val fromBot: Boolean,
    val botId: String?,
    val text: String,
    val at: String,
    /** 自己发的消息的幂等键；撤回排队中的消息要用它。 */
    val requestId: String = "",
    /** 这条消息带的代码片段；没有就是 null。字段名后端可能给 code 也可能给 diff。 */
    val code: CodeBlock? = null,
)

/** 一条消息里的代码片段：文件名、增删行数、逐行内容与类别。 */
data class CodeBlock(
    val path: String,
    val added: Int,
    val removed: Int,
    val lines: List<CodeLine>,
)

/** 代码里的一行。kind 取 added / removed / 空。 */
data class CodeLine(val text: String, val kind: String)

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
    /** 队伍读过但决定不动手的消息，连理由一起。没有它，屏幕上分不清「还在想」和「不会回」。 */
    val declined: List<Declined> = emptyList(),
)

/** 一条被读过、但不打算动手的消息。 */
data class Declined(val requestId: String, val reason: String)

/**
 * 消息面的线上格式。只说两件事：把回话读成对话，把一句话写成请求。
 * 解析是宽容的：不认识的字段跳过，不因为多一个字段就整段失败。
 */
object CrewWire {
    /** 配对入口挂在这里，调用方不用记是哪个 object 管这一段。 */
    fun parseReach(body: String): List<ReachAddress> = PairingWire.parseReach(body)
    fun parseCredential(body: String): Credential? = PairingWire.parseCredential(body)


    private fun parseCode(item: JSONObject): CodeBlock? {
        val block = item.optJSONObject("code") ?: item.optJSONObject("diff") ?: return null
        val raw = block.optJSONArray("lines") ?: JSONArray()
        val lines = mutableListOf<CodeLine>()
        for (i in 0 until raw.length()) {
            val line = raw.optJSONObject(i) ?: continue
            lines.add(CodeLine(line.optString("text"), line.optString("kind")))
        }
        // 没有行内容就只有个文件名，画出来是张空卡 —— 不如不画。
        if (lines.isEmpty()) return null
        return CodeBlock(
            path = block.optString("path"),
            added = block.optInt("added"),
            removed = block.optInt("removed"),
            lines = lines,
        )
    }

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
                    requestId = item.optString("request_id"),
                    code = parseCode(item),
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
                    // 老后端没有这两个字段：按终态词表兜底，行为与以前一致。
                    open = if (task.has("open")) task.optBoolean("open", true)
                        else task.optString("state") !in setOf("completed", "merged", "closed", "dropped", "stopped"),
                    retryable = task.optBoolean("retryable", false),
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
        val declinedJson = root.optJSONArray("declined") ?: JSONArray()
        val declined = (0 until declinedJson.length()).mapNotNull { index ->
            val row = declinedJson.optJSONObject(index) ?: return@mapNotNull null
            val requestId = row.optString("request_id")
            if (requestId.isBlank()) return@mapNotNull null
            Declined(requestId, row.optString("reason", ""))
        }
        return Conversation(messages, bots, root.optString("default_bot_id"), tickets, status, queued, declined)
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
    fun mentionsIn(text: String, bots: List<BotCard>): List<String> =
        bots.filter { bot ->
            listOf("@${bot.id}", if (bot.name.isNotEmpty()) "@${bot.name}" else "").any { needle ->
                needle.length > 1 && named(text, needle)
            }
        }.map { it.id }

    /** 命中必须落在词的边界：队里有 a 和 ab 时，@ab 不能同时点名 a。 */
    private fun named(text: String, needle: String): Boolean {
        var from = 0
        while (true) {
            val at = text.indexOf(needle, from)
            if (at < 0) return false
            val next = text.getOrNull(at + needle.length)
            if (next == null || !(next.isLetterOrDigit() || next == '_' || next == '-')) return true
            from = at + 1
        }
    }
}

/** 一条工单在本地的样子。它是后台的只读投影，客户端不据此维护状态机。 */
data class WorkTicket(
    val id: String,
    val title: String,
    val state: String,
    val botId: String,
    val needsPerson: String,
    /** 还没结束。页签归属看它，不要自己解释 state 的词表。 */
    val open: Boolean = true,
    /** 后端说可以重试（卡在 failed/blocked，或投递失败）。 */
    val retryable: Boolean = false,
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
 * 空态里那个主按钮与分段切换的说法。
 *
 * 「加第一位」现在有真接口（POST /api/mobile/bots），按下去展开内联表单；
 * 分段切换的「后台」仍然没有可看的东西：队伍空着就没有队列，按下去只说这一句。
 */
object EmptyCopy {
    /** 分段切换的「后台」。 */
    const val NO_BACKEND_YET = "队伍还空着，后台没有可看的队列"

    /** 内联表单上的三句提示。 */
    const val ID_HINT = "id（小写字母、数字、- 或 _）"
    const val NAME_HINT = "显示名"
    const val PERSONA_HINT = "人设（可选）"

    /** id 不合规时的原话。与后端、手机端共用的形状一致：^[a-z0-9_-]+$。 */
    const val ID_INVALID = "id 只能用 a-z、0-9、- 和 _"
}

/**
 * 工作区页的文字。读屏接口现在如实回「没有画面源」，所以这一页不再自己编一句
 * 「还没接上」—— 后端说什么就写什么，说不了才落到兜底那句。
 *
 * 纯函数，测试直接钉住每一个断面。
 */
object WorkspaceCopy {
    /** 读屏接口本身读不到时的兜底：仍然说清是「读不到」，不是「没有」。 */
    const val SCREEN_UNREAD = "读不到它的画面"

    /** 接手的说明。它说的是设计里的约定（接手后 Bot 停在原地），不是此刻在发生的事。 */
    const val TAKEOVER_NOTE = "接手后它就不动了，把手机放下才算还给它"

    /** 顶栏的副行。 */
    const val SUBTITLE = "这不是你的屏幕，是它的"

    /** 全屏那个按钮还没有接口：按下去只说实话。 */
    const val FULLSCREEN_NOTE = "全屏还没接上"

    /** 接手成功。工单真的停了才这么说。 */
    const val TAKEOVER_DONE = "已接手，这个工单停了"

    /** 它手上没有在跑的票：没有可接的活，别假装接成功了。 */
    const val TAKEOVER_IDLE = "它手上没有活儿"

    /**
     * 停一下成功。scope 如实来自后端：现在只有执行器的全局暂停，
     * 恢复要去面板 —— 把这句话说出来，省得人在手机上找恢复按钮。
     */
    fun pauseDone(scope: String): String =
        if (scope == "executor") "已让它停一下（全局执行器，恢复要去面板）" else "已让它停一下"

    /** 动作失败时的原话。detail 来自后端错误体，直译，不粉饰。 */
    fun failed(detail: String?): String = "没做成：${detail?.takeIf { it.isNotBlank() } ?: "队伍没回话"}"

    /** 画面块里那一行：优先写后端给的理由，没理由才落到兜底。 */
    fun screenText(reason: String?): String = reason?.takeIf { it.isNotBlank() } ?: SCREEN_UNREAD

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

/** 它执行过的一行：命令 / 输出 / 回话 / 状态。 */
data class ScreenLine(val at: String, val kind: String, val text: String)

/**
 * 读屏接口的回答。live 时 lines 是它刚做了什么；unavailable 时 reason 就是手机该显示的那句话。
 * 这里不是像素截帧：worker 干的是终端活，手机看的是那件事本身。
 */
data class ScreenView(
    val state: String,
    val reason: String,
    val kind: String = "",
    val cwd: String = "",
    val lines: List<ScreenLine> = emptyList(),
) {
    val live: Boolean get() = state == "live"
}

object ScreenWire {
    fun parse(body: String): ScreenView {
        val root = JSONObject(body)
        val lines = root.optJSONArray("lines")
        return ScreenView(
            state = root.optString("state", "unavailable"),
            reason = root.optString("reason", ""),
            kind = root.optString("kind", ""),
            cwd = root.optString("cwd", ""),
            lines = buildList {
                if (lines != null) for (index in 0 until lines.length()) {
                    val line = lines.optJSONObject(index) ?: continue
                    val text = line.optString("text", "")
                    if (text.isNotBlank()) add(ScreenLine(line.optString("at", ""), line.optString("kind", ""), text))
                }
            },
        )
    }
}

/** 事件时间缩成时分秒；读不出来就原样留着，不编时间。与桌面端同一规矩。 */
fun screenClock(at: String): String = try {
    Instant.parse(at).atZone(ZoneId.systemDefault()).toLocalTime()
        .format(DateTimeFormatter.ofPattern("HH:mm:ss"))
} catch (_: DateTimeParseException) { at }

object BotsWire {
    /** 与后端 crew/directory.ts 的 BOT_ID、以及 TeamConfig 的 schema 同一形状。 */
    val ID = Regex("^[a-z0-9_-]+$")

    // 花名册的读走 timeline（它本来就带 bots），这里只负责写：加一位 Bot。
    fun createBody(botId: String, name: String, persona: String): String {
        val body = JSONObject().put("bot_id", botId).put("name", name)
        // 空人设不上送：后端会把空串写成 persona: ""，配置里多一个没用的键。
        if (persona.isNotBlank()) body.put("persona", persona)
        return body.toString()
    }

    /** 改人设：和新建不同，空人设要显式上送 —— 那是「把他说的话删掉」，不是「没填」。 */
    fun editBody(botId: String, name: String, persona: String): String =
        JSONObject().put("action", "edit").put("bot_id", botId).put("name", name).put("persona", persona).toString()

    /** 撤一位：同样走 action，因为 Connection 只认 POST。 */
    fun removeBody(botId: String): String = JSONObject().put("action", "remove").put("bot_id", botId).toString()
}

/** 一条模型路由：provider 决定去哪儿，reasoningEffort 是可选档位。 */
data class ModelChoice(val provider: String, val model: String, val reasoningEffort: String? = null)

data class ModelOption(val id: String, val name: String, val description: String? = null)
data class ModelProvider(val id: String, val name: String, val models: List<ModelOption>)

/** 读不出来的 provider：让人知道「这家连不上」，而不是以为它本来就没有模型。 */
data class ModelFailure(val id: String, val name: String)

data class ModelCatalog(
    val current: ModelChoice?,
    val botModels: Map<String, ModelChoice>,
    val providers: List<ModelProvider>,
    val failures: List<ModelFailure>,
) {
    /** 这个作用域现在用的路由：botId 为空是全员，否则是这一位；没单配就跟随全员。 */
    fun choiceFor(botId: String?): ModelChoice? = if (botId.isNullOrEmpty()) current else botModels[botId] ?: current

    /** 这一位是不是没有自己的路由，跟着全员走。 */
    fun followsCrew(botId: String?): Boolean = !botId.isNullOrEmpty() && botModels[botId] == null
}

/** 一个推理档位。id 是提交给后端的那一个，name 只用来给人看。 */
data class EffortOption(val id: String, val name: String)
data class Efforts(val efforts: List<EffortOption>, val default: String? = null)

object ModelWire {
    private fun choice(value: JSONObject?): ModelChoice? {
        if (value == null) return null
        val provider = value.optString("provider").orEmpty()
        val model = value.optString("model").orEmpty()
        if (provider.isEmpty() || model.isEmpty()) return null
        val effort = value.optString("reasoningEffort").takeIf { it.isNotEmpty() }
        return ModelChoice(provider, model, effort)
    }

    fun parseCatalog(body: String): ModelCatalog {
        val root = JSONObject(body)
        val providers = mutableListOf<ModelProvider>()
        val groups = root.optJSONArray("providers") ?: JSONArray()
        for (index in 0 until groups.length()) {
            val group = groups.optJSONObject(index) ?: continue
            val models = mutableListOf<ModelOption>()
            val options = group.optJSONArray("models") ?: JSONArray()
            for (position in 0 until options.length()) {
                val option = options.optJSONObject(position) ?: continue
                val id = option.optString("id").takeIf { it.isNotEmpty() } ?: continue
                models.add(ModelOption(id, option.optString("name", id),
                    option.optString("description").takeIf { it.isNotEmpty() }))
            }
            providers.add(ModelProvider(group.optString("id"), group.optString("name", group.optString("id")), models))
        }
        val failures = mutableListOf<ModelFailure>()
        val broken = root.optJSONArray("failures") ?: JSONArray()
        for (index in 0 until broken.length()) {
            val item = broken.optJSONObject(index) ?: continue
            val id = item.optString("id").takeIf { it.isNotEmpty() } ?: continue
            failures.add(ModelFailure(id, item.optString("name", id)))
        }
        val botModels = mutableMapOf<String, ModelChoice>()
        root.optJSONObject("bot_models")?.let { saved ->
            for (id in saved.keys()) choice(saved.optJSONObject(id))?.let { botModels[id] = it }
        }
        return ModelCatalog(choice(root.optJSONObject("current")), botModels, providers, failures)
    }

    fun parseEfforts(body: String): Efforts {
        val root = JSONObject(body)
        val list = mutableListOf<EffortOption>()
        val options = root.optJSONArray("efforts") ?: JSONArray()
        for (index in 0 until options.length()) {
            val item = options.optJSONObject(index) ?: continue
            val id = item.optString("id").takeIf { it.isNotEmpty() } ?: continue
            list.add(EffortOption(id, item.optString("name", id)))
        }
        return Efforts(list, root.optString("default").takeIf { it.isNotEmpty() })
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
