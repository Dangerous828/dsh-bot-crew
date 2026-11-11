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
    /**
     * 这条消息挂在哪张工单上。只读引用，前台不据此维护任务账（契约 §4）。
     * 代码块自己带了 ticket_ref 时以代码块为准；这里留着，是为了消息没带代码块时也读得出来。
     */
    val ticketRef: String = "",
)

/**
 * 一条消息里的代码片段：文件名、增删行数、逐行内容与类别。
 *
 * id 是这张卡在本次会话里的稳定标识：后端给了就用后端的，没给就用「票号|文件名」拼一个
 * （与桌面端 client.go 的 Code() 同一条规矩）。「采用中 / 已采用」与回执都按它各记各的 ——
 * 同一段对话里并排两张卡，结果不能串台。
 *
 * ticketRef 是这段改动属于哪张工单：卡片下面「看看改完的样子」只能看它。
 * 缺了就说缺了，绝不拿别的票顶替 —— 把 A 的活显示成 B 的结果，比不给看更糟。
 */
data class CodeBlock(
    val path: String,
    val added: Int,
    val removed: Int,
    val lines: List<CodeLine>,
    val id: String = "",
    val ticketRef: String = "",
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
    /**
     * 「未读」：人发出去、队伍还没读走的有几条（契约 §5.6）。
     *
     * 它是 null 表示这份时间线说不清（网关没有报告读走状态），与「确实是 0 条」不同。
     * 徽标只在非 null 且大于 0 时出现 —— 把说不清画成 0，等于替队伍说它都读过了。
     */
    val unread: Int? = null,
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


    /**
     * 消息上那个只读的票号引用。它只用来展示，不据此维护任何任务账。
     * 缺席或空白都算「没有」，让「没有」只有一种形状 —— 空串。
     */
    private fun ticketRefOf(item: JSONObject): String = item.optString("ticket_ref").trim()

    /**
     * 读出代码块。两种命名都认（`code` / `diff`），两种都读不出来就是没有。
     *
     * 三段顺序都是有意的：
     * 1. 没有 path 也没有行 → 不返回卡片。没有改动就没有「采用」，按钮也不该出现；
     *    而一个只有文件名的空卡画出来只是一块占位的白。
     * 2. 票号优先取代码块自己的，其次才取消息上的 `ticket_ref`（契约 §5：两处都可，代码块里的优先）。
     * 3. id 缺省时用「票号|文件名」拼一个稳定标识；两者都空时只剩文件名，也仍然稳定。
     */
    private fun parseCode(item: JSONObject): CodeBlock? {
        val block = item.optJSONObject("code") ?: item.optJSONObject("diff") ?: return null
        val raw = block.optJSONArray("lines") ?: JSONArray()
        val lines = mutableListOf<CodeLine>()
        for (i in 0 until raw.length()) {
            val line = raw.optJSONObject(i) ?: continue
            lines.add(CodeLine(line.optString("text"), line.optString("kind")))
        }
        val path = block.optString("path")
        // 没有行内容就只有个文件名，画出来是张空卡 —— 不如不画。
        if (lines.isEmpty()) return null
        val ticketRef = block.optString("ticket_ref").trim().ifEmpty { ticketRefOf(item) }
        val id = block.optString("id").trim().ifEmpty { ticketId(ticketRef, path) }
        return CodeBlock(
            path = path,
            added = block.optInt("added"),
            removed = block.optInt("removed"),
            lines = lines,
            id = id,
            ticketRef = ticketRef,
        )
    }

    /** 与桌面端 client.go 拼法一致：票号 + 竖线 + 文件名。 */
    private fun ticketId(ticketRef: String, path: String): String = "$ticketRef|$path"

    /**
     * 读出这张票的备选答案。
     *
     * 契约 §5 说得很死：`options` 只在有 `question` 时出现，2–4 条，id 唯一，label ≤80 字。
     * 这里逐条按契约收，宁可少一条也不画一条点不动的：
     * - 没有 question 就没有选项（没有要答的题，答案没有意义）；
     * - 没有 id 的丢（「这张卡上哪个按钮」认不出来，回执会串台）；
     * - 没有 label 的丢（画出来是一行空白，点下去发的是一句空话）；
     * - 同一句问题里 id 重复的只留第一条（两次点击会共用一个「正在发」，看着像没反应）；
     * - label 超长的不截断而是丢掉：截断后的那句话发出去就不是后端给的那个答案了。
     * 条数不足 2 条时不是「后端给了 1 个选项」，而是这组选项读不成 A/B，按空处理，
     * 让卡片走「只有一个自写框」那条路 —— 那才是诚实的退路。
     */
    private fun parseOptions(task: JSONObject): List<AttentionOption> {
        if (task.optString("question").isBlank()) return emptyList()
        val raw = task.optJSONArray("options") ?: return emptyList()
        val seen = mutableSetOf<String>()
        val options = mutableListOf<AttentionOption>()
        for (index in 0 until raw.length()) {
            val row = raw.optJSONObject(index) ?: continue
            val id = row.optString("id").trim()
            val label = row.optString("label").trim()
            if (id.isEmpty() || label.isEmpty() || label.length > OPTION_LABEL_MAX) continue
            if (!seen.add(id)) continue
            options.add(AttentionOption(id, label))
        }
        return if (options.size < 2) emptyList() else options
    }

    /** 契约 §5：label 是一句给人看的话，≤80 字。 */
    private const val OPTION_LABEL_MAX = 80

    /**
     * 这张卡此刻问的是哪一组：换了问题或换了选项，签名就跟着变。
     *
     * 「已按这个答了」只对得上同一组 —— 否则同一张票换了新题之后，
     * 上一道题的回执会挂在新问题下面（桌面端 answerSignature 钉的就是这条）。
     */
    fun answerSignature(ticket: WorkTicket): String = buildString {
        append(ticket.question)
        for (option in ticket.options) append('\u0000').append(option.id).append('\u0000').append(option.label)
    }

    /** 这张票上这个选项的键：正在发的那一下与结果回来时按它对应上。 */
    fun answerSlot(ticketId: String, optionId: String): String = "$ticketId|$optionId"

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
                    ticketRef = ticketRefOf(item),
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
                    question = task.optString("question").trim(),
                    options = parseOptions(task),
                    // 契约 §进度：两个字段要么一起出现，要么一起缺省。optInt 缺省给 0，
                    // 「没有计划」就落到 totalSteps = 0，正好是「不画进度条」那一档。
                    totalSteps = task.optInt("total_steps", 0),
                    stepsDone = task.optInt("steps_done", 0),
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
        return Conversation(messages, bots, root.optString("default_bot_id"), tickets, status, queued, declined,
            unreadOf(root))
    }

    /**
     * 「未读」的条数，读不出来时是 null（契约 §5.6）。
     *
     * 只认后端那个数：`count` 是整数且 `state == "live"` 才算数。两者缺一就是说不清 ——
     * 客户端不拿 `items` 自己数一遍，那是第二份口径，迟早和后端对不上。
     * `count` 是 0 时照实返回 0：读得到、确实没有未读，和读不出来不是一件事。
     */
    private fun unreadOf(root: JSONObject): Int? {
        val unread = root.optJSONObject("unread") ?: return null
        if (unread.optString("state") != "live") return null
        if (!unread.has("count") || unread.isNull("count")) return null
        return unread.optInt("count", -1).takeIf { it >= 0 }
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
    /**
     * 这张票此刻在等的那句话。只有 needs_person = answer 这类「等你回一句」才有；
     * delivery / review / blocked / failed 这几种「等你」没有问题，那时它是空串，
     * 卡片只说得清「为什么在等」，不得补一个空问题（契约 §5）。
     */
    val question: String = "",
    /**
     * 这句话的备选答案，按读的顺序。空表示只有一个自写框 ——
     * 前端不得自己编 A/B，也不得把 question 拆成选项。
     */
    val options: List<AttentionOption> = emptyList(),
    /**
     * 这张票计划里的总步数，来自 worker 自己写的待办清单（契约 §进度）。
     * 后端没下发计划时是 0 —— 没有分母就不画进度条，绝不拿读到的条数当分母。
     */
    val totalSteps: Int = 0,
    /**
     * 其中已经走完的几步。只在 [totalSteps] 同时出现时有意义；
     * 后端版本不一时可能越界，画之前由调用方夹一次（与桌面端 progressOf 同口径）。
     */
    val stepsDone: Int = 0,
)

/**
 * 这张票走到第几步 / 共几步。与桌面端 ui.go 的 progressOf 同一口径。
 *
 * 分子分母都来自后端下发的计划（worker 自己写的待办清单）：[WorkTicket.stepsDone] 与
 * [WorkTicket.totalSteps]。不数事件、不数报告 —— 那些不是计划，画出来的条会永远停在 100%。
 * 返回 (0, 0) 表示算不出来：没有 total_steps 就没有分母，进度条整条不画。
 *
 * 放在这里而不是 CrewUi.kt：和 AnswerCopy / readable 一样是纯文案与口径规则，
 * 单元测试不必把 Compose 拖进来。
 */
internal fun progressOf(ticket: WorkTicket): Pair<Int, Int> {
    if (ticket.totalSteps <= 0) return 0 to 0
    // 后端版本可能不一致：走完的步数自行夹到 [0, totalSteps]，宽度不超过 100%。
    val done = ticket.stepsDone.coerceIn(0, ticket.totalSteps)
    return done to ticket.totalSteps
}

/**
 * 概览行上的「第 N 步 / 共 N 步」。没有计划时不编一句出来 —— 那个 N 没有出处。
 *
 * 文案与桌面端 ui.go 的 stepOf 逐字相同：一步没走完说「共 N 步」，走完了说「第 N 步 / 共 N 步」。
 */
internal fun stepOf(ticket: WorkTicket): String {
    val (done, total) = progressOf(ticket)
    if (total <= 0) return ""
    // 一步没走完时说「共 N 步」，而不是「第 0 步」。
    return if (done > 0) "第 $done 步 / 共 $total 步" else "共 $total 步"
}

/**
 * 工单卡第二行：「在做 · 林 · 第 1 步 / 共 3 步」。
 *
 * 逐段拼、空的段不拼。后端不发 `bot_id` 时 owner 是空串（桌面端 client.go 那侧是 omitempty），
 * 直接插值会留下「在做 ·  · 共 3 步」这种悬空分隔符。桌面端 ui.go 的同一行也先判 `BotID != ""`。
 * 三段都可能缺：owner 缺、step 缺，或者两个都缺 —— 那时只剩状态词，不带尾巴。
 */
internal fun ticketDetail(state: String, owner: String, step: String): String = buildString {
    append(state)
    if (owner.isNotEmpty()) append(" · ").append(owner)
    if (step.isNotEmpty()) append(" · ").append(step)
}

/**
 * 「等你决定」卡上的一个答案。
 *
 * id 在这句问题内唯一且稳定（[a-z0-9_-]{1,40}），拿它当「正在发 / 已答过」的键；
 * label 是一句给人看的话（≤80 字），点下去就把这句原样当回答发回去 —— 选项只是呈现，
 * 不是审批：回答仍走 §3 的 POST /send，网关不解析选项。
 */
data class AttentionOption(val id: String, val label: String)

/** 队伍自己的健康状况。 */
data class CrewStatus(val runtime: String, val mobile: String, val paused: Boolean) {
    /** 能接活：在跑且没暂停。 */
    fun ready(): Boolean = runtime == "ready" && !paused
}

/**
 * 工单下的一棵代理树。子代理还能再分子代理，所以这个形状必须能套自己。
 *
 * elapsedSeconds 是「它跑了多久」，与桌面端 client.go 的 AgentNode.ElapsedSeconds 同一字段、
 * 同一含义。**后端今天还不发这个字段**：backend/src/app/work.ts 的 agentTree() 只填
 * id / label / state，会话 header 里也没有可用的起止时间。所以它是可空的：
 * 没有就是 null，界面上不画那一截 —— 宁可少一句「· 42 秒」，也不凭空算一个数出来。
 * 后端哪天把它加上，这里不用再改。
 */
data class AgentNode(
    val id: String,
    val label: String,
    val state: String,
    val elapsedSeconds: Double? = null,
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
            elapsedSeconds = elapsedOf(value),
            children = (0 until children.length()).mapNotNull { node(children.optJSONObject(it)) },
        )
    }

    /**
     * 读出 `elapsed_seconds`。缺席、null、以及读不成数的都算「没有」—— 一律 null。
     *
     * 这里不拦负数和离谱的大数：那些是「有值但读坏了」，与本字段缺席不是一回事，
     * 由 [AgentCopy.elapsed] 统一挡住（与桌面端同一个分界：解析只管有没有值，
     * 画不画由文案层定）。optDouble 缺席时给 NaN，正好可以拿来当「没有」。
     */
    private fun elapsedOf(value: JSONObject): Double? {
        if (!value.has("elapsed_seconds") || value.isNull("elapsed_seconds")) return null
        val seconds = value.optDouble("elapsed_seconds", Double.NaN)
        return if (seconds.isNaN()) null else seconds
    }
}

/**
 * 子代理那一行右侧那截话：状态词，跑完了的再补上耗时。
 *
 * 与桌面端 `desktop/ui.go` 的 `agentWord` / `agentStatus` / `elapsedSeconds` 是同一套词、
 * 同一套规矩，两端必须说出同一句话：
 * - 状态词用「在跑 / 已完成 / 已停下 / 已放弃」，**不是**工单卡上的「在做」——
 *   同一件事在两个语境里不是一个词，混用会有一边不像画板（画板 Desktop.dc.html:185）。
 * - 耗时只在后端真的给了才画。今天 agentTree() 不发这个字段，所以实际画出来的
 *   就是「已完成」三个字 —— 这是有意的：编一个「· 42 秒」出来，屏幕上那个数
 *   会被当成真的读过。
 * - 在跑的那个不画耗时：它还没跑完，这个数此刻不成立。
 */
object AgentCopy {

    /** 子代理那一行的状态词。零状态（后端没给）按在跑算，与桌面端兜底一致。 */
    fun word(state: String): String = when (state) {
        "work", "working" -> "在跑"
        "completed", "done", "merged", "closed" -> "已完成"
        "failed", "stopped" -> "已停下"
        "dropped" -> "已放弃"
        else -> "在跑"
    }

    /**
     * 一行右侧的整句话：状态，跑完了的再补上耗时。
     *
     * working 由调用方按 agentDone 算好传进来 —— 与桌面端 `agentStatus(node, working)`
     * 同一个分工：这里只负责说，不负责判断谁算收工。
     */
    fun status(node: AgentNode, working: Boolean): String {
        val line = word(node.state)
        // 在跑的那个没有「跑了多久」；后端没给也一样，不补一个空壳「· 」。
        if (working) return line
        val spent = elapsed(node.elapsedSeconds) ?: return line
        return "$line · $spent"
    }

    /**
     * 把秒数说成人话，量级跟画板一致（画板是「42 秒」）。
     *
     * 超过一分钟进到「1 分 5 秒」：一屏里出现「427 秒」没人算得过来。
     *
     * 返回 null 表示「这一截别画」：没有值、负数、NaN、无穷、超过一天 ——
     * 读坏了就整段不画，留着「已完成 · 」比不画更糟。上界也要挡住，
     * 与桌面端同一个理由：超大的数转成整数没有意义，画出来是个假数。
     */
    fun elapsed(seconds: Double?): String? {
        seconds ?: return null
        if (seconds.isNaN() || seconds.isInfinite() || seconds < 0 || seconds > MAX_SECONDS) return null
        // 四舍五入取整，与桌面端 `int(seconds + 0.5)` 同一个取法（值非负，截断即向下取整）。
        val total = (seconds + 0.5).toInt()
        if (total < 60) return "$total 秒"
        return "${total / 60} 分 ${total % 60} 秒"
    }

    /** 一天。再长就不是「这一轮跑了多久」，是数据坏了。 */
    private const val MAX_SECONDS = 24.0 * 60 * 60
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

/**
 * 认两种写法：后台的 `2026-09-14T03:00:00.000Z`，以及不带时区的 `2026-09-14T03:00:00`。
 * 后者只能当本地时间读，这是唯一能猜的解读。读不懂返回 null —— 不拿一个猜出来的时刻去填界面。
 *
 * 名片上「认识多久」和常规任务的「上次 / 下次跑」都读这套时间，两处各写一份迟早会走样。
 */
internal fun isoTimestamp(raw: String?): Instant? {
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
        val at = isoTimestamp(raw) ?: return null
        return "从 ${DATE.format(at.atZone(zone))} 起"
    }
}

/**
 * 「等你决定」卡与代码卡上的文字。
 *
 * 全是纯函数，测试直接钉住每一句 —— 这两张卡上最容易出错的地方不是画得丑，
 * 而是「说了句其实没发生的事」：编一个后端没给的选项、把 A 的工单显示成 B 的结果、
 * 或者把一次失败写成没反应。
 */
object AnswerCopy {
    /** 后端没给问题时，卡片只能说得清「为什么在等」。这五个词是后台的 stage.action。 */
    fun waitingWord(action: String): String = when (action) {
        "delivery" -> "上一轮回话没送到，需要你处理"
        "review" -> "活干完了，等你过目"
        "blocked" -> "做不下去，要你松开"
        "failed" -> "跑失败了，要你处理"
        // answer 以及将来新加的类别：都落在这一句上，至少说得清在等的是人。
        else -> "在等你回一句话"
    }

    /**
     * 卡片正文：有 question 就读 question，没有才退回 needs_person 的人话。
     * 与桌面端 pendingCard 同一句（「这张票卡在等你，原因：…」）。
     */
    fun body(ticket: WorkTicket): String =
        ticket.question.ifBlank { "这张票卡在等你，原因：" + waitingWord(ticket.needsPerson) }

    /** 选项左边那个字母：A、B、C…。后端最多给四个，超过 26 只是兜底。 */
    fun optionMark(index: Int): String = if (index in 0..25) ('A' + index).toString() else "${index + 1}"

    /** 答成功。 */
    const val ANSWER_DONE = "已按这个答了，队伍下一步会接上"

    /** 答失败。detail 是后端错误体的原文，直译，不粉饰。 */
    fun answerFailed(detail: String?): String = "没答上：${detail?.takeIf { it.isNotBlank() } ?: "队伍没回话"}"
}

/**
 * 代码卡下面那两个按钮的文字与去向。
 *
 * 两个按钮都不新开接口（契约 §5）：
 * - 采用 = 一次表态，走已有的 POST /send 发一句普通消息，点名写这段的那位 Bot；
 * - 看看改完的样子 = 按这段改动所属工单读 GET /api/mobile/screen?ticket=…。
 */
object CodeCopy {
    /** 没有 path 时，「采用」说的是哪一段。 */
    private const val THIS_CHANGE = "这段改动"

    /**
     * 「采用」发出去的那句话：点名写这段的 Bot，带上文件名与增删统计。
     *
     * 与桌面端 adoptText 逐字一致 —— 两端发出去的话不一样，Bot 读到的就是两件事：
     * `@coder（码农） 采用 login.tsx 这段改动，加 8 行、删 4 行，按这个改。`
     *
     * 点名用 bot_id：名字可以被改，id 不会；括号里附上人看的名字，两样都有。
     * 名字与 id 相同时只说一遍（`@coder（coder）` 读起来像写错了）。
     * 没有增删统计就只说采用了哪段，不编一个「加 0 行」。
     */
    fun adoptText(block: CodeBlock, botId: String?, botName: String?): String {
        val file = block.path.trim().ifEmpty { THIS_CHANGE }
        val where = buildString {
            if (!botId.isNullOrBlank()) {
                append('@').append(botId)
                val name = botName?.trim().orEmpty()
                if (name.isNotEmpty() && name != botId) append('（').append(name).append('）')
                append(' ')
            }
        }
        val summary = changeSummary(block).let { if (it.isEmpty()) "" else "，$it" }
        // 没有文件名时 file 已经就是「这段改动」，模板里再跟一句会拼成
        // 「采用 这段改动 这段改动，删 1 行」—— 同一个词说了两遍。
        val target = if (file == THIS_CHANGE) file else "$file 这段改动"
        return "${where}采用 $target$summary，按这个改。"
    }

    /** 增删行数说成人话；没有统计就什么也不说 —— 不编一个「加 0 行」。 */
    fun changeSummary(block: CodeBlock): String = when {
        block.added > 0 && block.removed > 0 -> "加 ${block.added} 行、删 ${block.removed} 行"
        block.added > 0 -> "加 ${block.added} 行"
        block.removed > 0 -> "删 ${block.removed} 行"
        else -> ""
    }

    const val ADOPT = "采用"
    const val ADOPTING = "采用中…"
    const val ADOPTED = "✓ 已采用"
    const val ADOPT_DONE = "已请它采用这段改动，下一步会按这个改"

    /** 采用失败。和「看看改完的样子」失败分开说，不混成一句。 */
    fun adoptFailed(detail: String?): String = "没采用成：${detail?.takeIf { it.isNotBlank() } ?: "队伍没回话"}"

    const val PREVIEW = "看看改完的样子"

    /**
     * 这段改动没带工单号。**绝不拿别的票顶替**（契约 §5）：宁可说看不了，
     * 也不把 A 的活显示成 B 的结果。与桌面端 preview 那句一致。
     */
    const val NO_TICKET = "这段改动没带工单号，看不到它改完的样子；让它再报一次就能看了"

    /** 有票号、读回来了，但这一轮没有可显示的活动。 */
    const val NO_ACTIVITY = "这张工单暂时没有可显示的活动"

    /** 读屏那条路本身失败了。 */
    fun previewFailed(detail: String?): String = "读不到「改完的样子」：${detail?.takeIf { it.isNotBlank() } ?: "队伍没回话"}"

    /**
     * 「看看改完的样子」拿到回答之后，卡片下面该写的那句话。
     *
     * 返回 null 表示真的读到了画面 —— 那时由调用方把快照画出来，不写这一行。
     * 三种「没有」要分开：链路失败、后端给了理由、后端什么都没给。
     */
    fun previewNote(view: ScreenView?): String? = when {
        view == null -> previewFailed(null)
        view.live && view.lines.isNotEmpty() -> null
        view.reason.isNotBlank() -> view.reason
        else -> NO_ACTIVITY
    }
}

/**
 * 消息里带的代码片段要不要配那两个按钮。
 *
 * 契约 §5：代码块缺失或为空（path 与 lines 都没有）时不画代码卡，也不画这两个按钮 ——
 * 没有改动就没有「采用」。按钮是这张卡的一部分，不为它单独下发状态或开关。
 */
object CodeCardRules {
    fun showsButtons(block: CodeBlock?): Boolean =
        block != null && (block.path.isNotBlank() || block.lines.isNotEmpty())
}

/**
 * 代码卡里那一行代码的分词着色。
 *
 * 规则与桌面端 `desktop/syntax.go` 是同一套，逐条对得上：改这里就是改那一边，
 * 两端的代码卡必须看起来是同一张卡。
 *
 * 为什么先做「分词」而不是接一个完整的高亮库：画板要的只有一件事 ——
 * 一行代码里「变了的部分」要看得见。画板 `Desktop.dc.html:133` 里，
 * 上下文行是暖灰 `#8A8377`，而值 `12px` 是赭色 `#96603A`；改动行整行是绿的。
 * 达到这个效果只需要认出「数字 / 字符串 / 注释」三类，不需要语法树。
 *
 * 这一层刻意不认识具体语言，也不做错误恢复：认不出来的就原样当普通文字，
 * 拼回去必须和原文逐字相同（见 `CodeSyntaxTest`）—— 高亮可以少，不能吃掉字符。
 *
 * 它不带颜色，也不碰 Compose：颜色由界面按主题给（亮暗两套赭不同值），
 * 这里只说「这一段是哪一类」。这样这一层能在 JVM 单测里直接跑，不用模拟器。
 */
internal object CodeSyntax {

    /** 一段文字属于哪一类。Plain 是普通文字，也是「认不出来」时的落点。 */
    enum class Kind {
        /** 普通文字：上下文行里的代码、前缀那两格、认不出来的东西。 */
        Plain,

        /** 数字字面量（含 12px 里的 12、0x1f、1.85）。 */
        Number,

        /** 引号里的内容，引号本身也算这一段：否则贴着引号的空格会被吃掉。 */
        Quoted,

        /** 行尾注释，一直吃到行尾。 */
        Comment,
    }

    /** 分词结果里的一段。text 原样取自输入，不做 trim。 */
    data class Token(val text: String, val kind: Kind)

    /**
     * 一行代码铺到屏幕上要切成几段。
     *
     * prefix 是行首那两格（上下文 "  " / 新增 "+ " / 删除 "- "）：它属于这一行，
     * 不属于某个词，所以单独成一段、跟着整行颜色走（与桌面端 codeSegments 的 prefix 一致）。
     *
     * 改动行整行一段、不拆词 —— 桌面端 highlight=false 就是这条：画板里改动的
     * 是**整行**，行内再分色反而看不出哪一行变了。上下文行才分词着色。
     *
     * 正文可能自带 + / - 前缀（后端两种写法都给过），先剥掉再按类别加，
     * 否则画出来是 `+ + gap: 16px;`。这一条是手机端原来就有的，保留。
     */
    fun segments(line: CodeLine): List<Token> {
        val body = line.text.trimStart().trimStart('+', '-').trimStart()
        val prefix = when (line.kind) {
            "added" -> "+ "
            "removed" -> "- "
            else -> "  "
        }
        // 改动行：整行一段，前缀与正文拼在一起，颜色由界面按行类别给一个色。
        if (line.kind == "added" || line.kind == "removed") {
            return listOf(Token(prefix + body, Kind.Plain))
        }
        val head = listOf(Token(prefix, Kind.Plain))
        return head + tokenize(body)
    }

    /**
     * 把一行代码切成若干段。
     *
     * 规则少到能一眼读完，这才是它敢用的原因：
     * - 双斜杠与块注释开头起的注释，吃到行尾；贴着行首或空白的双横杠同理；
     * - 双引号与单引号的字符串，到配对的引号为止（配不上就到行尾）；
     * - 连续的数字（允许夹一个小数点、跟着单位字母）算一个数字；
     * - 其余整段算普通文字。
     *
     * 逐字对齐 Go 的 tokenizeCode：按下标切子串，不动任何字符。
     */
    fun tokenize(text: String): List<Token> {
        val tokens = mutableListOf<Token>()
        val plain = StringBuilder()
        fun flush() {
            if (plain.isNotEmpty()) {
                tokens.add(Token(plain.toString(), Kind.Plain))
                plain.setLength(0)
            }
        }
        var i = 0
        while (i < text.length) {
            val c = text[i]
            when {
                isCommentStart(text, i) -> {
                    flush()
                    tokens.add(Token(text.substring(i), Kind.Comment))
                    i = text.length
                }
                c == '"' || c == '\'' -> {
                    flush()
                    var end = i + 1
                    while (end < text.length && text[end] != c) {
                        // 反斜杠转义：被转义的那个字符不算收尾的引号。
                        if (text[end] == '\\' && end + 1 < text.length) end++
                        end++
                    }
                    // 收尾那个引号一起算进来；配不上就吃到行尾。
                    if (end < text.length) end++
                    tokens.add(Token(text.substring(i, end), Kind.Quoted))
                    i = end
                }
                c in '0'..'9' -> {
                    flush()
                    var end = i
                    while (end < text.length && isNumberChar(text[end])) end++
                    tokens.add(Token(text.substring(i, end), Kind.Number))
                    i = end
                }
                else -> {
                    plain.append(c)
                    i++
                }
            }
        }
        flush()
        return tokens
    }

    /**
     * 判断 i 处是不是一段注释的开头。
     *
     * 双斜杠与双横杠要求前面不是内容字符：`i--` 是自减，不是注释。
     * 井号更严 —— 只有它前面整行都是空白才算（shell / yaml / python 的行首注释）。
     * 放宽到「前面是空格就算」，`color: #FFF` 的颜色值会被整行染灰，值就看不见了；
     * 宁可漏认一行 `x = 1 # 尾注`，也不能把颜色值认成注释。
     */
    private fun isCommentStart(text: String, i: Int): Boolean {
        val here = text[i]
        val next = if (i + 1 < text.length) text[i + 1] else '\u0000'
        return when {
            here == '/' && (next == '/' || next == '*') -> !hasContentBefore(text, i)
            here == '-' && next == '-' -> !hasContentBefore(text, i)
            here == '#' -> text.substring(0, i).all { it == ' ' || it == '\t' }
            else -> false
        }
    }

    /** 这之前有没有代码 —— 只有最后一个字符不是空白，才算「贴着内容」。 */
    private fun hasContentBefore(text: String, i: Int): Boolean {
        if (i == 0) return false
        val last = text[i - 1]
        return last != ' ' && last != '\t'
    }

    /**
     * 数字的一部分：数字、字母（认 0x1f 与 12px 的 px）、小数点。
     * px 跟着数字走，是为了让 12px 整段染成一个颜色 —— 画板里那一段正是赭色。
     */
    private fun isNumberChar(c: Char): Boolean =
        c in '0'..'9' || c in 'a'..'z' || c in 'A'..'Z' || c == '.'
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
 * 读屏接口的回答 —— 这张工单的**实景**：它此刻在干什么、这一段从几点开始、它刚做了什么。
 * live 时 lines 是它刚做了什么；unavailable 时 reason 就是手机该显示的那句话。
 * 这里不是像素截帧：worker 干的是终端活，手机看的是那件事本身（契约 §5.1）。
 */
data class ScreenView(
    val state: String,
    val reason: String,
    val kind: String = "",
    val cwd: String = "",
    val lines: List<ScreenLine> = emptyList(),
    /** 最后一条活动的时间。 */
    val at: String = "",
    /** 这次作业开工的时间；空表示没有在跑的作业。 */
    val since: String = "",
    /** 阶段机的原词：working / person / idle / ended。空表示读不出来。 */
    val stage: String = "",
    /** 它此刻在干什么，由后端推出来：running / thinking / waiting / idle / ended。空表示说不了。 */
    val activity: String = "",
    /** 有多少条事件没变成行；0 表示一条没丢。 */
    val hidden: Int = 0,
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
            // 这四个都是可选字段：缺着就是「这一格说不了」，不补默认词，也不当 0 条丢。
            at = root.optString("at", ""),
            since = root.optString("since", ""),
            stage = root.optString("stage", ""),
            activity = root.optString("activity", ""),
            hidden = root.optInt("hidden", 0).coerceAtLeast(0),
        )
    }
}

/**
 * 顶上那一行「它此刻在干什么」。**只照后端给的 activity 写**，不自己从 lines 重算 ——
 * 同一个词在两处各推一遍，迟早会一处说「在跑」一处说「在等」。
 *
 * 后端没给 activity（推不出来）就返回 null，让调用方整行不写；也不写「未知」，那是把
 * 「不知道」画成了一条事实。`paused` 是执行器被全局暂停，它压过其余状态。
 */
fun screenActivityWord(activity: String, paused: Boolean): String? {
    if (paused) return "停住了（执行器被暂停）"
    return when (activity) {
        "running" -> "正在干活"
        "thinking" -> "在想"
        "waiting" -> "在等你决定"
        "idle" -> "手上空着"
        "ended" -> "这张完了"
        else -> null
    }
}

/**
 * 「另有 N 条没展开」。0 或负数不写 —— 省略就是一条没丢（契约 §5.1 的 hidden）。
 */
fun screenHiddenNote(hidden: Int): String? = if (hidden > 0) "另有 $hidden 条没展开" else null

/** 事件时间缩成时分秒；读不出来就原样留着，不编时间。与桌面端同一规矩。 */
fun screenClock(at: String): String = try {
    Instant.parse(at).atZone(ZoneId.systemDefault()).toLocalTime()
        .format(DateTimeFormatter.ofPattern("HH:mm:ss"))
} catch (_: DateTimeParseException) { at }

/** 产出里的一份文件：worker 真的写过的那条路径。只列路径与次数，不下发内容（契约 §5.4）。 */
data class OutputItem(
    val id: String,
    val ticketId: String,
    val path: String,
    val title: String,
    val kind: String,
    val writes: Int,
)

/** 按类的条数。结果条上那句「两张图片」就是从这里来的，不在客户端自己数一遍。 */
data class OutputCounts(val file: Int, val image: Int)

/**
 * 一张（或一栏）产出的快照（契约 §5.4）。
 *
 * state 的三种取值不能混：live 有东西；empty 读得到、确实没有；unavailable 读不到。
 * 把读不到说成没有，就是替队伍编一句话。
 */
data class OutputsView(
    val items: List<OutputItem>,
    val state: String,
    val counts: OutputCounts = OutputCounts(0, 0),
    /** 只在 state 不是 live 时出现，是后端给的一句中文原因。 */
    val reason: String = "",
    /** 只在带 ?ticket= 查询时出现。 */
    val ticketId: String = "",
) {
    val live: Boolean get() = state == "live"
}

object OutputsWire {
    fun parse(body: String): OutputsView {
        val root = JSONObject(body)
        val items = mutableListOf<OutputItem>()
        val raw = root.optJSONArray("items")
        if (raw != null) for (index in 0 until raw.length()) {
            val item = raw.optJSONObject(index) ?: continue
            // 没有 id 的条目按契约不该出现；真出现了也不自己拼一个 —— 去重靠它。
            val id = item.optString("id").trim()
            if (id.isEmpty()) continue
            items.add(
                OutputItem(
                    id = id,
                    ticketId = item.optString("ticket_id").trim(),
                    path = item.optString("path"),
                    title = item.optString("title"),
                    kind = item.optString("kind"),
                    writes = item.optInt("writes", 0),
                ),
            )
        }
        val counts = root.optJSONObject("counts")
        return OutputsView(
            items = items,
            // 缺省时落到 unavailable（说「读不到」是实话，说「没有」是编的）；
            // 不认识的取值原样留着，界面只认 live —— 认不出的状态一律不画结果条。
            state = root.optString("state", "unavailable"),
            counts = OutputCounts(
                file = counts?.optInt("file", 0)?.coerceAtLeast(0) ?: 0,
                image = counts?.optInt("image", 0)?.coerceAtLeast(0) ?: 0,
            ),
            reason = root.optString("reason", ""),
            ticketId = root.optString("ticket_id", ""),
        )
    }
}

/**
 * 消息结果条（契约 §5.4 末节）：挂在一条消息下面那行「✓ 两张图片已放进产出」。
 *
 * 四条规则都在这里，界面只照着画：
 * 1. 消息必须带 ticket_ref（读消息上那个字段，不拿代码卡里的、也不按时间猜一张票）；
 * 2. 用 `GET /api/mobile/outputs?ticket=` 读那一张；
 * 3. 只有 state == live 且真有条目时才画，文案由 counts 拼；
 * 4. empty / unavailable / 请求失败一律不画 —— 结果条只在「有事发生」时出现，
 *    把「读不到」画成一条成果，等于把故障当成队伍的产出。
 *
 * 另有一条「挂在哪一条」的规矩，见 lastOfTicket：同一张票号只挂在最后一条回复上。
 */
object OutputsCopy {
    /** 这条消息该读哪张票。只认消息自己带的 `ticket_ref`；没有就是空串，绝不拿别的票顶替。 */
    fun barTicket(message: Message): String = message.ticketRef.trim()

    /**
     * 时间线上这一条，是不是这张票的「最后一条」—— 只有它才轮到挂结果条。
     *
     * 同一张票的票号会挂在好几条回复上（先一句「收到」、干完再一句「报结果」），
     * 两条各画一遍，屏幕上就是连着两条「1 个文件已放进产出」—— 看着像交了两回活。
     * 规则：同一张票号，只让时间线上最后一条带它的回复挂结果条，之前的同票号消息不画。
     *
     * 判法只有「从这一条往后找」一件事：后面没有第二条带同票号的回复，这一条就是最后一条。
     * 不倒着排序、不按 at 比时间、更不看 id —— 顺序就是列表给的顺序，两端都照它办，
     * 才不会因为时钟差一秒而让两端画出不一样的结果。
     *
     * 三条边界，与桌面端 lastOfTicket 逐条对齐：
     * - 自己发的话不挂结果条（两端都只在 Bot 的回复下面画），所以也不算「压住上面那条」；
     * - 没有票号的这一条永远 false —— 绝不因为「前后都没票号」就替它认一张票；
     * - 越界的下标返回 false，别让调用方一处写错就炸掉整屏。
     *
     * 单条判法留在这里是给测试与自查用的形状。界面不要按条调它：那是每条消息扫一遍
     * 尾巴，一屏十几条就是十几趟 O(n) —— 用 takeLastOfTicket 一次算完，见下面那个。
     */
    fun lastOfTicket(messages: List<Message>, index: Int): Boolean {
        if (index !in messages.indices) return false
        val message = messages[index]
        if (!message.fromBot) return false
        val ticket = barTicket(message)
        if (ticket.isEmpty()) return false
        for (later in index + 1..messages.lastIndex) {
            val other = messages[later]
            if (!other.fromBot) continue
            if (barTicket(other) == ticket) return false
        }
        return true
    }

    /**
     * 整条时间线一次算完：第 index 条该不该挂结果条（见上一段的规则）。
     *
     * 一行一趟倒着扫就够了：从后往前走，记下已经见过的票号，第一次见到的那个下标就是
     * 这张票的最后一条。与逐条调用 lastOfTicket 的结果逐条相同，只是从
     * 「每条各扫一遍尾巴」（n 条 O(n²)）变成「整列扫一遍」（O(n)）。
     *
     * 这个函数是纯的，不碰 Compose：调用方按时间线的版本记一次结果就够了，
     * 不要在每一帧、每一条里重算 —— 那一层见 CrewUi 里的 resultEnds。
     */
    fun takeLastOfTicket(messages: List<Message>): BooleanArray {
        val flags = BooleanArray(messages.size)
        // 已经见过票号的回复：从后往前，第一次见到的才是这张票的最后一条。
        val seen = HashSet<String>()
        for (index in messages.indices.reversed()) {
            val message = messages[index]
            // 自己发的话不挂结果条，也不算「压住上面那条」—— 与 lastOfTicket 同一条规矩。
            if (!message.fromBot) continue
            val ticket = barTicket(message)
            if (ticket.isEmpty()) continue
            if (seen.add(ticket)) flags[index] = true
        }
        return flags
    }

    /**
     * 结果条上那句话：「N 张图片已放进产出」/「N 个文件已放进产出」，两类都有就说全。
     * 逐字对齐桌面端 outputResultLine —— 两端同一句话，人才不会以为是两件事。
     */
    fun resultLine(view: OutputsView): String {
        val file = view.counts.file
        val image = view.counts.image
        return when {
            file > 0 && image > 0 -> "$file 个文件 · $image 张图片已放进产出"
            image > 0 -> "$image 张图片已放进产出"
            file > 0 -> "$file 个文件已放进产出"
            else -> ""
        }
    }

    /**
     * 这条消息下面该不该画、画哪句话。null 表示不画。
     *
     * view 为 null 是「读过了、读不到」或「还没读过」—— 两种情况都不画：
     * 前者把故障画成成果，后者会先闪一条空的再变成有内容的。
     */
    fun barLine(view: OutputsView?): String? {
        if (view == null || view.state != "live" || view.items.isEmpty()) return null
        return resultLine(view).ifEmpty { null }
    }
}

/**
 * 结果条按票的缓存：读过就记着，读不到的也记一笔。
 *
 * 「读不到」和「还没读」在界面上是同一件事 —— 都不画；但缓存必须分开：
 * 前者已经试过了，不该每帧重发请求，后者还该去读一次。桌面端 perTicket 的
 * 「值是 nil 表示读过了、读不到」就是这条，这里照同一套做。
 *
 * 另加一条桌面端没有的：每条记录都带「它是第几轮时间线读来的」。读到第 3 轮、
 * 而界面已经在第 4 轮时，这条照样算没读过、要重读 —— worker 可能只写了个文件、
 * 一句话都没多说，消息条数不变，但产出变了。按轮次认账，而不是靠清表，
 * 就也不需要在组合期间改状态（那会让 Compose 在画的过程中把状态写脏）。
 *
 * 这张表不是 Compose 的状态，读写都在主线程（组合里的 LaunchedEffect 回来那一刻）。
 * 某个票读完、界面要重画那一行时，由那一行自己的记号说了算 —— 不在这里发通知，
 * 免得一条读完就把整列消息行都重组一遍。
 */
class OutputsCache {
    /** 票号 → （这一轮的产出，读不到时是 null）。只有当前轮次的那条算数。 */
    private val read = mutableMapOf<String, Pair<Int, OutputsView?>>()
    /** 正在读的：票号 → 这一轮是第几轮。 */
    private val reading = mutableMapOf<String, Int>()

    /**
     * 这张票现在该不该发请求。空票号永远不发 —— 没有票号就没有结果条，
     * 不许拿别的票或最近的票顶替（契约 §5.4）。
     */
    fun need(ticket: String, epoch: Int): Boolean {
        if (ticket.isEmpty()) return false
        val cached = read[ticket]
        if (cached != null && cached.first == epoch) return false
        return reading[ticket] != epoch
    }

    /** 记下「这一轮已经在读了」，防止同一张票在同一轮里并发发两个请求。 */
    fun start(ticket: String, epoch: Int): Boolean {
        if (!need(ticket, epoch)) return false
        reading[ticket] = epoch
        return true
    }

    /**
     * 一次读取结束。view 为 null 表示读不到（请求失败、404 等），也照样记一笔，
     * 据此不再重发；结果条据此不画。
     *
     * 比手上这一轮旧的答案直接丢掉：刷新之后旧请求晚回来，不能把新轮次的账本
     * 改成旧数据，也不能把新轮次「正在读」的记号抹掉 —— 那会让这一轮
     * 永远停在「读过、没有」，结果条再也不出现。
     */
    fun finish(ticket: String, view: OutputsView?, epoch: Int) {
        val startedAt = reading[ticket]
        val current = read[ticket]?.first ?: 0
        if (epoch < maxOf(startedAt ?: 0, current)) return
        if (startedAt == epoch) reading.remove(ticket)
        read[ticket] = epoch to view
    }

    /**
     * 这一条读了一半被取消（消息滚出列表，它的 LaunchedEffect 会跟着走）：
     * 放掉「正在读」的记号就好，不记结果 —— 滚回来时该再读一次，
     * 否则那张票会永远停在「读过了、没有」，结果条再也不出现。
     */
    fun abandon(ticket: String, epoch: Int) {
        if (reading[ticket] == epoch) reading.remove(ticket)
    }

    /** 这张票下面该画的那句话。null 就是「不画」。上一轮的结果不算数。 */
    fun line(ticket: String, epoch: Int): String? {
        val cached = read[ticket] ?: return null
        if (cached.first != epoch) return null
        return OutputsCopy.barLine(cached.second)
    }

    /**
     * 这一轮还在读、还没有答案。界面据此在结果条的位置上先占一行高 ——
     * 读到之前与读到之后高度一样，列表就不会在读完那一刻被顶走一下。
     *
     * 读过了（有结果、或确实读不到）就是 false：那两种都不该再占着地方，
     * 尤其在「这张票本来就没有产出」时，占着就是一块永久的空白。
     */
    fun pending(ticket: String, epoch: Int): Boolean {
        if (ticket.isEmpty()) return false
        val cached = read[ticket]
        if (cached != null && cached.first == epoch) return false
        return true
    }

    /** 这一轮读过了没有（成功或失败都算）。测试与自查用。 */
    fun tried(ticket: String, epoch: Int): Boolean = read[ticket]?.first == epoch
}

/**
 * 子代理树按票的缓存（第一张工单派了谁）。
 *
 * 与 OutputsCache 同一套规矩：不是 Compose 的状态，读完由那一格自己的记号去重画；
 * 每一条记录都带「它是第几轮时间线读来的」，旧一轮的答案不算数。放在这里而不是界面里，
 * 是因为它和 OutputsCache 是同一类东西 —— 纯记账，可以单测。
 *
 * 为什么要缓存：这张卡画在消息列表**末尾**，从后台/工作区切回来时人第一眼看的就是它。
 * 缓存跟着页面重新组合的话，每次都要「一边出现一边拉数据」：几百毫秒里那块地方是空的，
 * 读到之后才长出来 —— 切屏第一帧看上去就是一次卡顿。
 */
class AgentsCache {
    /** 票号 →（这一轮读到的树，读不到时是 null）。 */
    private val read = mutableMapOf<String, Pair<Int, List<AgentNode>?>>()
    /** 正在读的：票号 → 这一轮是第几轮。 */
    private val reading = mutableMapOf<String, Int>()

    /** 这一轮该不该发请求。空票号永远不发（没有票就没有树可读）。 */
    fun need(ticket: String, epoch: Int): Boolean {
        if (ticket.isEmpty()) return false
        val cached = read[ticket]
        if (cached != null && cached.first == epoch) return false
        return reading[ticket] != epoch
    }

    /** 记下「这一轮已经在读」，防止同一张票在同一轮里并发发两个请求。 */
    fun start(ticket: String, epoch: Int): Boolean {
        if (!need(ticket, epoch)) return false
        reading[ticket] = epoch
        return true
    }

    /** 一次读取结束。nodes 为 null 表示读不到，也记一笔，这一轮不再重发。 */
    fun finish(ticket: String, nodes: List<AgentNode>?, epoch: Int) {
        val startedAt = reading[ticket]
        val current = read[ticket]?.first ?: 0
        // 比手上这一轮旧的答案丢掉：刷新之后旧请求晚回来，不能把新轮次的账改回去，
        // 也不能把新轮次「正在读」的记号抹掉。
        if (epoch < maxOf(startedAt ?: 0, current)) return
        if (startedAt == epoch) reading.remove(ticket)
        read[ticket] = epoch to nodes
    }

    /** 读了一半被取消（这一格被组合带走了）：放掉「正在读」，切回来再读一次。 */
    fun abandon(ticket: String, epoch: Int) {
        if (reading[ticket] == epoch) reading.remove(ticket)
    }

    /** 清掉这张票的账（按「重试」时用）：下一趟会当成没读过。 */
    fun forget(ticket: String) {
        read.remove(ticket)
        reading.remove(ticket)
    }

    /** 这一轮读到的树。没读过、或只有旧一轮的，都是 null。 */
    fun get(ticket: String, epoch: Int): List<AgentNode>? {
        val cached = read[ticket] ?: return null
        if (cached.first != epoch) return null
        return cached.second
    }

    /** 这一轮读过了没有（成功或失败都算）。测试与自查用。 */
    fun tried(ticket: String, epoch: Int): Boolean = read[ticket]?.first == epoch
}

/**
 * 账本里的一条常规任务（契约 §5.5）。
 *
 * 除了 id 与标题，其余全按「有没有」分档：`botId` 空就是没指定负责人、
 * `lastRun` 空就是没记过执行、`nextRun` 空就是这个时间读不懂。
 * 三种「没有」都不补一个假值 —— 补上去的那一格看上去和真数据一模一样。
 */
data class RoutineItem(
    val id: String,
    val title: String,
    /** hourly / daily / weekly；不认识的周期原样留着，界面照原词显示。 */
    val cycle: String,
    /** 负责的 Bot。账本允许不指定（谁有空谁接），所以是空串而不是 null。 */
    val botId: String = "",
    val enabled: Boolean = true,
    val createdAt: String = "",
    /** 账本里真记过一次执行才有；没有就是空串。 */
    val lastRun: String = "",
    /** 后端按周期算出来的下一次，不是「已经排好的作业」。读不懂就是空串。 */
    val nextRun: String = "",
    /** 算出来的时间已经过了。后端没有调度器，所以这只表示「该跑了，但没人跑」。 */
    val overdue: Boolean = false,
)

/** 开着的与关掉的各几条。用后端给的那一份，不在客户端再数一遍。 */
data class RoutineCounts(val enabled: Int = 0, val paused: Int = 0)

/**
 * 一栏常规任务的快照（契约 §5.5）。
 *
 * state 与产出（§5.4）同一套三态，不许合并：
 * - `live`：有账可列；
 * - `empty`：读得到、确实一条都没有；
 * - `unavailable`：读不到。这一档只能说「读不出来」，绝不能说「还没有常规任务」。
 *
 * `runner` 是这台后端现在有没有调度器：`live` 会到点真派单，`none` 只是账本。
 * 界面据此说「会不会自己跑」，认不出的值一律当 `none` —— 说少了是假装有人会跑。
 */
data class RoutinesView(
    val items: List<RoutineItem>,
    val state: String,
    val counts: RoutineCounts = RoutineCounts(),
    /** 只在 state 不是 live 时出现，是后端给的一句中文原因。 */
    val reason: String = "",
    val runner: String = "none",
) {
    /** 只有这一档才逐条画。认不出的 state 一律不当作 live。 */
    val live: Boolean get() = state == "live"
}

object RoutinesWire {
    /**
     * 读一份 `GET /api/mobile/routines` 的回答。
     *
     * 一条记录认不出来（没 id、没标题）就跳过那一条，不拿半个字段凑一行；
     * 缺 `cycle` 时留空串而不是丢掉这一条 —— 后端已经按周期算好了 `next_run`，
     * 客户端只负责「不认识的周期原样显示」，不替它判断这是不是一条真账。
     */
    fun parse(body: String): RoutinesView {
        val root = JSONObject(body)
        val items = mutableListOf<RoutineItem>()
        val raw = root.optJSONArray("items")
        if (raw != null) for (index in 0 until raw.length()) {
            val item = raw.optJSONObject(index) ?: continue
            val id = item.optString("id").trim()
            val title = item.optString("title").trim()
            // 没有 id 就没法指认，没有标题那一行就是一块空白：两种都不画。
            if (id.isEmpty() || title.isEmpty()) continue
            items.add(
                RoutineItem(
                    id = id,
                    title = title,
                    cycle = item.optString("cycle").trim(),
                    botId = item.optString("bot_id").trim(),
                    // 缺省是「开着」：后端只在真的关掉时才发 false，缺字段被读成关掉会凭空多一条「已关掉」。
                    enabled = item.optBoolean("enabled", true),
                    createdAt = item.optString("created_at").trim(),
                    lastRun = item.optString("last_run").trim(),
                    nextRun = item.optString("next_run").trim(),
                    overdue = item.optBoolean("overdue", false),
                ),
            )
        }
        val counts = root.optJSONObject("counts")
        return RoutinesView(
            items = items,
            // 缺省落到 unavailable：说「读不到」是实话，说「没有」是编的。
            // 不认识的取值原样留着，界面只认 live。
            state = root.optString("state", "unavailable"),
            counts = RoutineCounts(
                enabled = counts?.optInt("enabled", 0)?.coerceAtLeast(0) ?: 0,
                paused = counts?.optInt("paused", 0)?.coerceAtLeast(0) ?: 0,
            ),
            reason = root.optString("reason", ""),
            // 后端没发就按 none 走：保守地说「不会自己跑」，比假装排好了强。
            runner = root.optString("runner", "none").ifEmpty { "none" },
        )
    }
}

/**
 * 常规任务这一屏上的文字：周期、开关、上次 / 下次、栏头小结，以及三态各自那句话。
 *
 * 与桌面端 routinesPane / cycleName / routineSummary / routineWhenLine 逐句对齐：
 * 同一件事在手机和电脑上得是同一句话，人才不会以为是两回事。纯函数，测试直接钉住。
 */
object RoutinesCopy {
    /**
     * 这一栏必须说的那句实话（桌面端 noSchedulerNote，一字不改）。
     *
     * 是账不是调度器：让人以为放着它就会跑，比空着更糟。
     */
    const val NO_SCHEDULER = "这些账到点不会自己跑：后端还没有调度器，逾期只是提醒。"

    /** 有调度器时说的那句：会派，而且派到哪一目了然。 */
    const val SCHEDULED = "到点的会自己派给负责的那位，跑过就记上一次；逾期的只提醒，不替你补跑。"

    /** 请求已经发出、还没回来。不能说成「没有」，也不能说成「读不到」。 */
    const val READING = "正在读常规任务…"

    /** 读都读不到（请求失败）时的抬头。不是空态，绝不借用「还没有常规任务」。 */
    const val UNREADABLE_TITLE = "读不到常规任务"

    /** 后端没给原因时补的那半句：说的是「不知道为什么」，不是「没有」。 */
    const val UNREADABLE_BODY = "队伍没说原因，这一栏现在读不出来"

    /** 空态的抬头与正文（与桌面端 nav.go 的 emptyCopy 同一句）。 */
    const val EMPTY_TITLE = "还没有常规任务"
    const val EMPTY_BODY = "这里是定时要做的事的账本。一条都还没有；账本里的任务到点不会自己跑 —— 后端还没有调度器。"

    /** 每次进屏都先说一句开关按不动，免得人按了几下才发现它只是个显示。 */
    const val READ_ONLY = "开关只看不能按：这一版还没有改账本的接口。"

    /**
     * 周期的中文说法。认不出的原词原样显示：不猜成「每天」——
     * 猜错的那一格会让人以为它明天早上就会跑。
     */
    fun cycleName(cycle: String): String = when (cycle) {
        "hourly" -> "每小时"
        "daily" -> "每天"
        "weekly" -> "每周"
        else -> cycle
    }

    /** 开关的状态词。开着就是开着，关着就说关着，没有第三种写法。 */
    fun switchName(enabled: Boolean): String = if (enabled) "开着" else "关着"

    /** 栏头那行小结：开着几条、关掉几条。都为 0 时返回空串，调用方据此整行不画。 */
    fun summary(view: RoutinesView): String {
        val parts = mutableListOf<String>()
        if (view.counts.enabled > 0) parts.add("${view.counts.enabled} 条开着")
        if (view.counts.paused > 0) parts.add("${view.counts.paused} 条关着")
        return parts.joinToString(" · ")
    }

    /**
     * 后端时间裁成「01-02 15:04」；读不出来返回空串。
     * 认不出的时间不把原始串甩给人看 —— 那一串 ISO 对谁都不是一句人话。
     */
    fun time(at: String, zone: ZoneId = ZoneId.systemDefault()): String {
        val moment = isoTimestamp(at) ?: return ""
        return DateTimeFormatter.ofPattern("MM-dd HH:mm").format(moment.atZone(zone))
    }

    /**
     * 「上次跑」这一格。没有就是没有：只写「还没跑过」，不拿 created_at 冒充，
     * 也不补一个日期（契约 §5.5：这一版没有任何代码会自动写 last_run）。
     */
    fun lastRunLine(lastRun: String, zone: ZoneId = ZoneId.systemDefault()): String {
        val clock = time(lastRun, zone)
        return if (clock.isEmpty()) "还没跑过" else "上次 $clock"
    }

    /**
     * 「下次跑」这一格。
     *
     * - 关着的那条不算「下一次」，否则关着也像随时会跑；
     * - 逾期写「该跑了」而不是「下一次」，因为确实没有人会去跑它；
     * - 时间读不懂就整格不说，别把原始串甩给人看。
     */
    fun nextRunLine(item: RoutineItem, zone: ZoneId = ZoneId.systemDefault()): String {
        if (!item.enabled) return "关着，不算下一次"
        val clock = time(item.nextRun, zone)
        if (clock.isEmpty()) return ""
        return if (item.overdue) "该跑了（$clock）" else "按周期算下一次 $clock"
    }

    /**
     * 「上次」「下次」拼成一行。两截都不说时返回空串，调用方整行不画 ——
     * 一行只剩一个「 · 」比没有更难读。
     */
    fun whenLine(lastRun: String, nextRun: String): String = when {
        lastRun.isEmpty() && nextRun.isEmpty() -> ""
        nextRun.isEmpty() -> lastRun
        lastRun.isEmpty() -> nextRun
        else -> "$lastRun · $nextRun"
    }

    /** 第二行：周期 · 谁负责 · 开关。没指定负责人的那半句整个不写，不留下悬空的分隔符。 */
    fun detailLine(item: RoutineItem, botName: String = ""): String {
        val cycle = cycleName(item.cycle).ifEmpty { "周期没写" }
        val owner = botName.trim().ifEmpty { item.botId.trim() }
        val parts = mutableListOf(cycle)
        if (owner.isNotEmpty()) parts.add("$owner 负责")
        parts.add(switchName(item.enabled))
        return parts.joinToString(" · ")
    }

    /**
     * 列表底部那行脚注。
     *
     * 与桌面端 routinesPane 末尾同一条规则：`runner` 不是 `live` 就写 —— 认不出的 runner
     * （老后端、将来的新值）也一样写，说多了只是保守，说少了是假装有人会跑。
     * 还没读回来、读不到、空态时返回 null：那时清单不在，这句话该由空态那张卡自己说，
     * 不该在下面再叠一行「这些账」—— 会让人以为清单在下面、只是没显示出来。
     */
    fun footnote(view: RoutinesView?): String? {
        if (view == null || !view.live) return null
        return if (view.runner == "live") SCHEDULED else NO_SCHEDULER
    }
}

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

/**
 * 一条记忆：队伍长期记得的事。
 *
 * 与 `RoutineItem` 同形 —— 后端给什么就画什么，不认识的 `state` 一律不当活着的用。
 */
data class MemoryItem(
    val name: String,
    val botId: String,
    val description: String,
    val body: String,
    val type: String,
    val importance: Int,
    /** `active` / `forgotten` / `superseded`。 */
    val state: String,
    /** 秒级时间戳；0 表示后端没给。 */
    val created: Long,
    val updated: Long,
    val origin: String,
    val toHub: Boolean,
) {
    val active: Boolean get() = state == "active"
}

/** 记忆这一栏：三态与「常规任务」同一套，`unavailable` 绝不被画成「没有」。 */
data class MemoryView(
    val items: List<MemoryItem>,
    val state: String,
    val counts: MemoryCounts = MemoryCounts(),
    val reason: String = "",
) {
    val live: Boolean get() = state == "live"
}

data class MemoryCounts(val active: Int = 0, val forgotten: Int = 0, val superseded: Int = 0)

object MemoryWire {
    /**
     * 读一份 `GET /api/mobile/memory` 的回答。
     *
     * 一条记录认不出来（没名字、没正文）就跳过那一条；缺省 `state` 当成 `active`，
     * 因为后端只在真的忘掉 / 被替代时才写别的值，缺字段读成「已忘掉」会凭空少一条。
     */
    fun parse(body: String): MemoryView {
        val root = JSONObject(body)
        val items = mutableListOf<MemoryItem>()
        val raw = root.optJSONArray("items")
        if (raw != null) for (index in 0 until raw.length()) {
            val item = raw.optJSONObject(index) ?: continue
            val name = item.optString("name").trim()
            val text = item.optString("body")
            if (name.isEmpty() || text.isBlank()) continue
            items.add(
                MemoryItem(
                    name = name,
                    botId = item.optString("bot_id").trim(),
                    description = item.optString("description").trim(),
                    body = text,
                    type = item.optString("type", "project"),
                    importance = item.optInt("importance", 4),
                    state = item.optString("state", "active").ifEmpty { "active" },
                    created = item.optLong("created", 0L),
                    updated = item.optLong("updated", 0L),
                    origin = item.optString("origin").trim(),
                    toHub = item.optBoolean("to_hub", false),
                ),
            )
        }
        val counts = root.optJSONObject("counts")
        return MemoryView(
            items = items,
            // 缺省落到 unavailable：说「读不到」是实话，说「没有」是编的。
            state = root.optString("state", "unavailable"),
            counts = MemoryCounts(
                active = counts?.optInt("active", 0)?.coerceAtLeast(0) ?: 0,
                forgotten = counts?.optInt("forgotten", 0)?.coerceAtLeast(0) ?: 0,
                superseded = counts?.optInt("superseded", 0)?.coerceAtLeast(0) ?: 0,
            ),
            reason = root.optString("reason", ""),
        )
    }

    /** 忘掉一条：只翻状态，不删行。 */
    fun forgetBody(name: String): String = JSONObject().put("action", "forget").put("name", name).toString()

    /** 改一条的正文。 */
    fun editBody(name: String, description: String, body: String): String =
        JSONObject().put("action", "edit").put("name", name).put("description", description).put("body", body).toString()
}

/** 记忆这一屏上的文字。纯函数，测试直接钉住。 */
object MemoryCopy {
    const val READING = "正在读记忆…"
    const val UNREADABLE_TITLE = "读不到记忆"
    const val UNREADABLE_BODY = "账本打不开。这不等于没有记忆，稍后再试。"
    const val EMPTY_TITLE = "还没有记住什么"
    const val EMPTY_BODY = "它在这台机器上和队伍办完的事、你定下的规矩，会一条条记在这里。"
    const val LIVE_ONLY = "只有还活着的记忆会出现在它下一次开口时；忘掉的留在账本里，不删。"

    /** 栏头那句小结：几条活着、几条忘掉、几条被替代。 */
    fun summary(view: MemoryView): String {
        val c = view.counts
        val parts = mutableListOf<String>()
        parts.add("记得 ${c.active} 条")
        if (c.forgotten > 0) parts.add("忘掉 ${c.forgotten}")
        if (c.superseded > 0) parts.add("被替代 ${c.superseded}")
        return parts.joinToString(" · ")
    }

    /** 一条记忆的抬头：标题，没标题就退回正文第一句。 */
    fun title(item: MemoryItem): String =
        item.description.ifBlank { item.body.lineSequence().firstOrNull()?.trim().orEmpty() }.ifBlank { item.name }

    /** 副行：谁记得、谁写的、记于何时。 */
    fun detail(item: MemoryItem): String {
        val who = item.botId.ifBlank { "全队" }
        val from = when {
            item.origin.startsWith("person:") -> "你说的"
            item.origin.startsWith("ticket:") -> "工单结论"
            else -> "队伍记的"
        }
        val whens = item.updated.takeIf { it > 0 }?.let { "· " + MemoryCopy.date(it) } ?: ""
        return listOf(who, from, whens).filter { it.isNotEmpty() }.joinToString(" ")
    }

    /** 秒级时间戳转「几月几号」。读不出来就不给日期，不写 Invalid。 */
    fun date(seconds: Long): String {
        if (seconds <= 0) return ""
        val calendar = java.util.Calendar.getInstance()
        calendar.timeInMillis = seconds * 1000
        return "${calendar.get(java.util.Calendar.MONTH) + 1} 月 ${calendar.get(java.util.Calendar.DAY_OF_MONTH)} 日"
    }
}


/** 一次语音识别的结果：认出来了给文字，认不出来给一句人话原因。 */
data class VoiceResult(val available: Boolean, val text: String, val reason: String = "")

object VoiceWire {
    /**
     * 读 `/api/mobile/voice` 的回答。
     *
     * 空正文、坏 JSON、认出来但是空串，都算「没认出来」并给一句原因：
     * 把空串当成功塞进输入框，用户会以为自己的话被吞了。
     */
    fun parse(body: String): VoiceResult {
        val root = try {
            JSONObject(body)
        } catch (_: Exception) {
            return VoiceResult(false, "", "后端回的不是 JSON")
        }
        val available = root.optBoolean("available", false)
        val text = root.optString("text").trim()
        if (!available) return VoiceResult(false, "", root.optString("reason").ifBlank { "没认出来" })
        if (text.isEmpty()) return VoiceResult(false, "", "没听出字来")
        return VoiceResult(true, text)
    }
}
