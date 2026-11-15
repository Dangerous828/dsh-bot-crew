package com.dsh.botcrew

import android.net.LocalServerSocket
import android.net.LocalSocket
import android.os.Handler
import android.os.Looper
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject

/**
 * CrewDebug.kt —— 手机端与 `desktop/debug.go` 等价的那条调试口。
 *
 * 为什么要有它：真机自动化里「点一下队伍页右上角的后台」在 adb 眼里是黑盒 ——
 * 没有可寻址的控件 id，坐标点击又跟着屏幕尺寸漂。所以换一条路：**按名字调界面本来就有的方法**，
 * 再读回一份结构化快照（state.dump）断言「这一下到底改了什么」。
 *
 * 协议与桌面端**逐字兼容**，同一个客户端脚本能驱动两端：
 *   请求：一行 JSON `{"action":"...","args":{...}}`
 *   响应：一行 JSON `{"ok":true,"result":...}` 或 `{"ok":false,"error":"..."}`
 * 每个连接单独处理，动作报错只回这一条、不退出服务；未知动作明确报错，不静默。
 *
 * ## 开关（与桌面端的 CREW_DEBUG 对应）
 *
 * Android 没有进程环境变量，所以改成「构建期 + 一条系统属性」两级：
 *   - **release 构建永远不开**（`BuildConfig.DEBUG == false` 直接 false）—— 调试口能驱动整屏，
 *     生产面零暴露；
 *   - **debug 构建默认开**，`adb shell setprop debug.crew.debug 0` 后重启 App 可关掉
 *     （用来做反向验证：确认关掉时连不上）；
 *   - `setprop debug.crew.debug 1` 在 debug 构建上等同默认，写出来只为把意图说清。
 *
 * 读系统属性要反射 `android.os.SystemProperties`（@hide），读不到就当没写 —— 回落构建期默认，
 * 绝不让「读不到」变成「打开」。
 *
 * ## 落点：abstract namespace unix socket
 *
 * 桌面端是 `$TMPDIR/crew-debug.sock` + `chmod 0600`。Android 上文件 socket 要处理 app 私有目录、
 * SELinux 上下文与 adb 的访问权限，还得先 root 才能 `nc` 到那条路径。abstract namespace
 * （内核里记作 `@crew-debug`）不吃文件系统：不需要建文件、不需要改权限、不需要 root，
 * `adb forward tcp:9099 localabstract:crew-debug` 就能转发到它，转发端口只绑在 adb 所在的宿主机上。
 */
class CrewDebug(private val target: CrewDebugTarget) {

    /** 全部可调用动作。建一次，不随界面刷新变。 */
    private val actions: Map<String, (JSONObject) -> DebugReply> = linkedMapOf(
        "actions.list" to { _ ->
            DebugReply.ok(JSONObject().put("actions", JSONArray(actionNames())))
        },
        "state.dump" to { _ -> DebugReply.ok(target.snapshot()) },
        "refresh" to { _ -> target.refresh() },
        "session.reload" to { _ -> target.reloadSessions() },
        "session.list" to { _ -> target.sessions() },
        "session.set" to { args ->
            val session = argString(args, "session")
            if (session == null) {
                DebugReply.fail("session is required")
            } else {
                // 走 S2 已有的切换路径（SessionFlow.switch）：能力位没到 LIVE 时它原地不动，
                // 调试口**不许**绕过那道先验 —— 否则「调试一下」就能造出界面做不到的状态。
                target.switchSession(session)
            }
        },
        "send" to { args ->
            val text = argString(args, "text")
            if (text == null) {
                DebugReply.fail("text is required")
            } else {
                // request_id 可选：不给就现生成一个（与界面上「新草稿换一个幂等键」同一规矩）。
                target.send(text, argString(args, "request_id").orEmpty())
            }
        },
        "pause" to { args -> target.pause(argString(args, "ticket")) },
        "resume" to { _ -> target.resume() },
        "tab.set" to { args ->
            val tab = argString(args, "tab")
            when {
                tab == null -> DebugReply.fail("tab is required")
                tab !in TABS -> DebugReply.fail("unknown tab: $tab (one of ${TABS.joinToString(", ")})")
                else -> target.setTab(tab)
            }
        },
        "mode.set" to { args ->
            val mode = argString(args, "mode")
            when {
                mode == null -> DebugReply.fail("mode is required")
                mode !in MODES -> DebugReply.fail("unknown mode: $mode (one of ${MODES.joinToString(", ")})")
                else -> target.setMode(mode)
            }
        },
    )

    /** 排好序的动作名。与桌面端 actions.list 一样按字母序，方便脚本 diff 两端。 */
    fun actionNames(): List<String> = actions.keys.sorted()

    /**
     * 按名字调一条动作。未知动作明确报错，不静默。
     *
     * 这一层是纯逻辑：不碰 socket、不碰 Compose、不碰 Android —— JVM 单测直接调它。
     */
    fun invoke(action: String, args: JSONObject): DebugReply {
        val fn = actions[action] ?: return DebugReply.fail("unknown action: $action")
        return try {
            fn(args)
        } catch (t: Throwable) {
            // 动作里崩了也只回这一条：调试口本身不该把宿主 App 拖下水。
            DebugReply.fail(t.message ?: t.toString())
        }
    }

    companion object {
        /** abstract namespace 里的名字。adb 侧写作 `localabstract:crew-debug`（不含 `\0`）。 */
        const val SOCKET_NAME = "crew-debug"

        /** 开关那条系统属性。只有 debug 构建认它，且只用来「关」。 */
        const val PROP = "debug.crew.debug"

        /** 界面上能切到的几屏。名字与桌面端 nav.* 的那几个面板对齐。 */
        val TABS = listOf("crew", "backend", "workspace", "models", "routine", "memory")

        /** 两个镜头。与桌面端 mode.set 的取值同一套词。 */
        val MODES = listOf("chat", "triage")

        /**
         * 调试口开不开。
         *
         * release 一律 false —— 不因为任何属性、任何运行时条件打开。
         * debug 构建默认 true，`debug.crew.debug=0` 可关（反向验证用）。
         * 属性读不到（null）时按构建期默认，绝不当成「用户要开」。
         */
        fun enabled(debugBuild: Boolean, prop: String?): Boolean {
            if (!debugBuild) return false
            return prop?.trim() != "0"
        }

        /**
         * 读一条系统属性。`android.os.SystemProperties` 是 @hide，只能反射；
         * 读不到（类不在、方法被隐藏 API 拦住、JVM 单测里根本没有这个类）一律返回 null。
         */
        fun systemProperty(key: String): String? = try {
            val cls = Class.forName("android.os.SystemProperties")
            (cls.getMethod("get", String::class.java).invoke(null, key) as? String)?.trim()
        } catch (t: Throwable) {
            null
        }
    }
}

/**
 * 一条动作的回应。字段名与桌面端逐字一致：成功给 `result`，失败给 `error`，两者互斥。
 */
data class DebugReply(val ok: Boolean, val result: JSONObject?, val error: String) {

    /** 一行的 JSON，不带换行 —— 由调用方补 `\n`，保证「一行一个响应」。 */
    fun toLine(): String = if (ok) {
        JSONObject().put("ok", true).put("result", result ?: JSONObject()).toString()
    } else {
        JSONObject().put("ok", false).put("error", error).toString()
    }

    companion object {
        fun ok(result: JSONObject = JSONObject()): DebugReply = DebugReply(true, result, "")
        fun fail(error: String): DebugReply = DebugReply(false, null, error)
    }
}

/**
 * 调试口能碰到的应用状态。全部读/写都经由界面本来那条路：
 * 快照只摊平已有的状态，动作调的就是界面按一下会调的同一个方法。
 *
 * 拆成接口是为了让 `CrewDebug` 在 JVM 单测里能配一个假目标跑，
 * 而真目标（[DebugBridge]）只是把 MainActivity 与 CrewRoot 两处接起来。
 */
interface CrewDebugTarget {
    /** 这一屏为什么长这样。字段全部来自现有状态，不另算一份。 */
    fun snapshot(): JSONObject

    /** 会话名单与能力位状态。 */
    fun sessions(): DebugReply

    /**
     * 重拉会话名单（等价于点界面那个「重试」，或等价于进队伍时那次先验）。
     *
     * 为什么要这个动作：`refresh` 只刷时间线，不重读名单。真机验收里在别的门新建了会话，
     * 手机这边不重拉名单就永远只看到旧的 —— 那不是产品 bug（界面上有「重试」按钮），
     * 而是调试口缺一个等价入口，验收会卡在这儿。
     */
    fun reloadSessions(): DebugReply

    /** 触发一次时间线刷新（界面每 6 秒自己也在做同一件事）。 */
    fun refresh(): DebugReply

    /** 切到指定会话。能力位没到 LIVE 时必须拒绝，不绕过先验。 */
    fun switchSession(id: String): DebugReply

    /** 发一条消息。走 CrewClient.send，与输入框那条路一致。 */
    fun send(text: String, requestId: String): DebugReply

    /** 切屏。 */
    fun setTab(tab: String): DebugReply

    /** 切镜头（聊天 / 分拣台）。 */
    fun setMode(mode: String): DebugReply

    /**
     * 停一下 / 继续执行。
     *
     * 存在的理由：工作区那个按钮在 adb 眼里是坐标，按不中也不可断言。这条动作必须落到
     * **界面按一下会调的同一个函数**（CrewRoot.setPaused）—— 状态位、pauseRevision、
     * 回执话术都在那一份里，这里不许另写一套替身，否则「调试口验过」不代表按钮验过。
     */
    fun pause(ticketId: String?): DebugReply

    /** 继续执行。与 [pause] 同一条路，只是方向相反。 */
    fun resume(): DebugReply
}

/**
 * CrewRoot 写的那一半：把界面状态摊平成快照，动作落到界面本来那几个入口上。
 *
 * 全部状态都通过函数读：CrewRoot 里的 `by remember { mutableStateOf(...) }` 是稳定的委托对象，
 * 闭包每次调用读到的都是**这一刻**的值，不需要每帧重建这个对象。
 * 动作也只调界面按一下会调的那几个函数（refresh / enterSession / client.send / setScreen），
 * 调试口不另造第二套行为。
 */
class CrewDebugScreen(
    private val state: () -> SessionState,
    private val tab: () -> String,
    private val mode: () -> String,
    private val timelineEpoch: () -> Int,
    private val paused: () -> Boolean,
    private val problem: () -> String?,
    private val draft: () -> String,
    private val sending: () -> Boolean,
    /** 入口表与在用的那条：给「现在到底走哪条路」一个可断言的答案。 */
    private val entries: () -> List<String>,
    private val currentEntry: () -> String,
    private val onRefresh: () -> Unit,
    /** 重拉会话名单：CrewRoot 传 `sessionRetry += 1`（与「重试」按钮同一条路）。 */
    private val onReloadSessions: () -> Unit,
    /** 切会话：CrewRoot 传进来的是 enterSession 那一整段（落盘 + 清草稿 + 重拉时间线）。 */
    private val onEnterSession: (SessionState) -> Unit,
    /** 发消息：CrewRoot 用 client.send 那条路；失败由 CrewRoot 写进 problem，下次 dump 读得到。 */
    private val onSend: (String, String) -> Unit,
    private val onTab: (String) -> Unit,
    private val onMode: (String) -> Unit,
    /**
     * 停一下 / 继续执行：CrewRoot 传 `scope.launch { setPaused(...) }`，与工作区那个按钮
     * 落到同一个函数上。这里只发起，**不在这里断言成功** —— 结果由 [snapshot] 的
     * `paused` 与 `pauseResult` 读回，脚本按那两处断言，不认这一条回执。
     */
    private val onSetPaused: (Boolean, String?) -> Unit,
    /** 上一次停/继续的回执原话（成功话术或失败原话）；还没按过是 null。 */
    private val pauseResult: () -> String?,
) : CrewDebugTarget {

    override fun snapshot(): JSONObject {
        val cur = state()
        val shown: Conversation? = cur.shown
        val snap = JSONObject()
            .put("session", cur.current)
            .put("capability", cur.capability.name.lowercase())
            .put("switchable", cur.switchable)
            .put("defaultSession", cur.defaultSessionId)
            .put("note", cur.note)
            .put("error", cur.error)
            .put("sessions", JSONArray(cur.sessions.map { it.id }))
            // 已缓存的会话：切回某一格时能不能一帧就画出内容，看这个。
            .put("cached", JSONArray(cur.conversations.keys.sorted()))
            .put("tab", tab())
            .put("mode", mode())
            .put("paused", paused())
            // 停/继续的回执原话。null 表示还没按过 —— 与 problem 同一规矩，不拿空串冒充。
            .put("pauseResult", pauseResult() ?: JSONObject.NULL)
            .put("problem", problem() ?: JSONObject.NULL)
            .put("draft", draft())
            .put("sending", sending())
            .put("entries", JSONArray(entries()))
            .put("entry", currentEntry())
            // P2P 通没通，判据就是「在用的是不是那个本地回环代理」——与 CrewClient 换表同一个信号。
            .put("p2p", currentEntry().startsWith(CrewRoute.LOCAL_PROXY_PREFIX))
        val timeline = JSONObject().put("epoch", timelineEpoch())
        if (shown == null) {
            // 还没读到这一格的时间线。用 null 明说「不知道」，不用 0 冒充「确实是空」。
            timeline.put("loaded", false).put("messages", JSONObject.NULL)
        } else {
            timeline.put("loaded", true)
                .put("messages", shown.messages.size)
                .put("bots", shown.bots.size)
                .put("tickets", shown.tickets.size)
                .put("queued", shown.queued.size)
                .put("declined", shown.declined.size)
                .put("unread", shown.unread ?: JSONObject.NULL)
                .put("unreadReplies", shown.unreadReplies ?: JSONObject.NULL)
                .put("lastMessage", shown.messages.lastOrNull()?.id ?: "")
        }
        return snap.put("timeline", timeline)
    }

    override fun sessions(): DebugReply {
        val cur = state()
        val rows = JSONArray()
        for (info in cur.sessions) {
            rows.put(
                JSONObject()
                    .put("id", info.id)
                    .put("name", info.name)
                    .put("current", info.id == cur.current),
            )
        }
        return DebugReply.ok(
            JSONObject()
                .put("capability", cur.capability.name.lowercase())
                .put("switchable", cur.switchable)
                .put("current", cur.current)
                .put("default", cur.defaultSessionId)
                .put("note", cur.note)
                .put("sessions", rows),
        )
    }

    override fun refresh(): DebugReply {
        onRefresh()
        return DebugReply.ok(JSONObject().put("refreshing", true))
    }

    override fun reloadSessions(): DebugReply {
        onReloadSessions()
        return DebugReply.ok(JSONObject().put("reloading", true))
    }

    override fun switchSession(id: String): DebugReply {
        val cur = state()
        // 能力位先验没过就锁着：调试口不绕过它，否则能造出界面做不到的状态。
        if (!cur.switchable) {
            return DebugReply.fail(
                "session switching is locked: capability=${cur.capability.name.lowercase()}" +
                    (if (cur.note.isEmpty()) "" else " (${cur.note})"),
            )
        }
        if (cur.sessions.none { it.id == id }) {
            return DebugReply.fail("unknown session: $id")
        }
        val next = SessionFlow.switch(cur, id)
        if (next.current != cur.current) onEnterSession(next)
        return DebugReply.ok(JSONObject().put("session", next.current))
    }

    override fun send(text: String, requestId: String): DebugReply {
        // 幂等键不给就现生成一个：与界面「新草稿换一个键」同一规矩，
        // 给的话沿用 —— 超时重发要落在同一个键上，不然会重复入队。
        val id = requestId.ifEmpty { java.util.UUID.randomUUID().toString() }
        onSend(text, id)
        return DebugReply.ok(JSONObject().put("sent", text).put("requestId", id))
    }

    override fun setTab(name: String): DebugReply {
        onTab(name)
        return DebugReply.ok(JSONObject().put("tab", tab()))
    }

    override fun setMode(name: String): DebugReply {
        onMode(name)
        return DebugReply.ok(JSONObject().put("mode", mode()))
    }

    /**
     * 停一下。ticket 给了就带上（与按钮上「屏幕上显示的是哪张票」同一口径），没给就是全局。
     *
     * 回执只说「已发出」，不在这里报成功：真正成没成看 `paused` 有没有翻过来 ——
     * 那一位由 setPaused 在 HTTP 成功后写。所以脚本要断言 `paused`，不是断言这里的 ok。
     */
    override fun pause(ticketId: String?): DebugReply {
        onSetPaused(true, ticketId)
        return DebugReply.ok(JSONObject().put("requested", "pause"))
    }

    override fun resume(): DebugReply {
        onSetPaused(false, null)
        return DebugReply.ok(JSONObject().put("requested", "resume"))
    }
}

/** MainActivity 写的那一半：配对、走哪条路、隧道往返、局域网那条地址的状态。 */
data class DebugShell(
    val paired: Boolean = false,
    val crew: String = "",
    val device: String = "",
    val way: String = "",
    val tunnelMillis: Long? = null,
    val p2pNote: String = "",
    val route: String = "",
    /**
     * 配对记录里那条局域网地址的判定（`ok` / `unreachable` / `stale`）。
     *
     * 单独摊出来是因为它解释「为什么绕公网」：只看 `way=public` 分不清「家里本来就该走
     * 公网」和「局域网地址废了只能绕」。`host` / `subnet` 是判据里的两个地址，
     * 脚本拿它们和自己读到的网段一对，就能验证判定不是编的。
     */
    val lanVerdict: String = "ok",
    val lanHost: String = "",
    val lanSubnet: String = "",
    val lanFailures: Int = 0,
    val session: String = SessionRoute.MAIN,
)

/**
 * 调试口的挂载点：外壳层（MainActivity）与界面层（CrewRoot）各写一半，调试口只读这两份。
 *
 * 为什么不让 MainActivity 直接实现 [CrewDebugTarget]：界面状态全在 CrewRoot 的 Compose 里，
 * 外壳只有配对与路由。两份分开写，谁也不知道对方的字段，拼快照这一件事只在这里做一次。
 */
class DebugBridge : CrewDebugTarget {

    /** 外壳层，每次重组后由 MainActivity 刷新。 */
    @Volatile
    var shell: DebugShell = DebugShell()

    /** 界面层。还没进队伍（没配对 / 客户端没建起来）时为 null。 */
    @Volatile
    var screen: CrewDebugTarget? = null

    override fun snapshot(): JSONObject {
        val snap = JSONObject()
            .put("paired", shell.paired)
            .put("crew", shell.crew)
            .put("device", shell.device)
            .put("way", shell.way)
            .put("tunnelMillis", shell.tunnelMillis ?: JSONObject.NULL)
            .put("p2pNote", shell.p2pNote)
            .put("route", shell.route)
            // 局域网那条地址的状态：走公网时它解释「为什么没走直连」。
            .put("lanVerdict", shell.lanVerdict)
            .put("lanHost", shell.lanHost)
            .put("lanSubnet", shell.lanSubnet)
            .put("lanFailures", shell.lanFailures)
            .put("session", shell.session)
            .put("screenReady", screen != null)
            .put("screen", screen?.snapshot() ?: JSONObject())
        return snap
    }

    override fun sessions(): DebugReply = screen?.sessions() ?: notInCrew()
    override fun refresh(): DebugReply = screen?.refresh() ?: notInCrew()
    override fun reloadSessions(): DebugReply = screen?.reloadSessions() ?: notInCrew()
    override fun switchSession(id: String): DebugReply = screen?.switchSession(id) ?: notInCrew()
    override fun send(text: String, requestId: String): DebugReply =
        screen?.send(text, requestId) ?: notInCrew()

    override fun setTab(tab: String): DebugReply = screen?.setTab(tab) ?: notInCrew()
    override fun setMode(mode: String): DebugReply = screen?.setMode(mode) ?: notInCrew()
    override fun pause(ticketId: String?): DebugReply = screen?.pause(ticketId) ?: notInCrew()
    override fun resume(): DebugReply = screen?.resume() ?: notInCrew()

    /** 还没进队伍：如实说，不假装动作成功。 */
    private fun notInCrew(): DebugReply = DebugReply.fail("界面还没进队伍：先配对")
}

/**
 * 调试口的 socket 层。薄到不需要单测：收一行 → [CrewDebug.invoke] → 回一行。
 *
 * 所有动作都**在主线程上执行**（Handler.post + 等回执）。界面状态是 Compose 的
 * snapshot state，从 socket 线程直接改它会绕过组合器的时序；桌面端那边是「界面线程也在碰同一份状态」，
 * 手机端更严格 —— 干脆让调试口的调用与真人点一下走同一条线程。
 *
 * ## 归属：socket 属于进程，不属于某一届 Activity
 *
 * 这条口子的名字在内核里是全局的（abstract namespace），而 Activity 会重建 —— 转屏、
 * 锁竖屏、换字号都会重建，重建顺序是**新的 onCreate 先于旧的 onDestroy**。所以「每届 Activity
 * 各建一个 server、各 bind 一次」必然撞车：新实例 bind 时旧 listener 还活着，报
 * `Address already in use`；随后旧实例的 onDestroy 把旧 listener 关了，进程里就再没有 listener ——
 * `adb forward` 仍能建，连上去读到空响应，直到杀进程。
 *
 * 真机三次复现（17:27 / 17:35 / 17:49）都是这个形状：失败瞬间 `/proc/net/unix` 里
 * `crew-debug` 计数为 0，而 bind 仍报占用。所以修法不是「关得更快」或「重试到成功」，
 * 而是**让 bind 只发生一次**：见 [CrewDebugPorts]。
 */
class CrewDebugServer(
    private val name: String = CrewDebug.SOCKET_NAME,
) : CrewDebugPort {
    private var listener: LocalServerSocket? = null
    private var acceptThread: Thread? = null

    /** 现在台前挂着谁。换人只换这一份，socket 不动。 */
    @Volatile
    private var debug: CrewDebug? = null

    private val main: Handler by lazy { Handler(Looper.getMainLooper()) }

    /** 挂上这一届的挂载点。socket 已经开着时它只换人。 */
    override fun bind(target: CrewDebugTarget) {
        debug = CrewDebug(target)
    }

    /** 摘掉挂载点，socket 照旧开着：下一届 Activity 进场立刻能用。 */
    override fun unbind() {
        debug = null
    }

    /**
     * 开一条调试口。返回 false 表示没起来 —— 调用方只记一行日志，界面照常。
     *
     * 走 abstract namespace，所以这里既没有文件要清（不存在上次崩溃留下的死 socket），
     * 也没有权限要设（内核里的名字不与文件系统上的任何路径对应）。
     *
     * 只由 [CrewDebugPorts] 调，且一个进程只成功一次。
     */
    override fun open(): Boolean {
        if (listener != null) return true
        val server = try {
            // 只传裸名字：LocalServerSocket 内部用 `LocalSocketAddress(name)`，而那个构造函数
            // 默认就是 ABSTRACT namespace（内核里记作 `@crew-debug`）。
            // **不要**自己往名字前面补 `\0` —— 那个 NUL 会变成名字的第一个字节（`@\0crew-debug`），
            // 而 adb 的 `localabstract:crew-debug` 找的是名字正好为 "crew-debug" 的那一个，两边对不上。
            LocalServerSocket(name)
        } catch (t: Throwable) {
            android.util.Log.w("CrewDebug", "调试口没起来：localabstract:$name", t)
            return false
        }
        listener = server
        acceptThread = Thread({ acceptLoop(server) }, "crew-debug").apply {
            isDaemon = true
            start()
        }
        android.util.Log.i("CrewDebug", "调试口已开：localabstract:$name")
        return true
    }

    /**
     * 关掉监听。**进程退出时才走这条路** —— Activity 重建期间这条口必须一直开着。
     *
     * close 一落，阻塞在 accept 里的线程就会抛错退出（acceptLoop 里那一条）。
     */
    override fun close() {
        val server = listener ?: return
        listener = null
        debug = null
        try {
            server.close()
        } catch (t: Throwable) {
            android.util.Log.w("CrewDebug", "调试口关不掉", t)
        }
        acceptThread = null
    }

    private fun acceptLoop(server: LocalServerSocket) {
        while (true) {
            val conn = try {
                server.accept()
            } catch (t: Throwable) {
                return // listener 被关时 accept 报错，正常退出
            }
            Thread({ serve(conn) }, "crew-debug-conn").apply {
                isDaemon = true
                start()
            }
        }
    }

    /** 一个连接一行一个请求，直到对端断开。 */
    private fun serve(conn: LocalSocket) {
        try {
            conn.use { socket ->
                val reader = BufferedReader(InputStreamReader(socket.inputStream, Charsets.UTF_8))
                val writer = OutputStreamWriter(socket.outputStream, Charsets.UTF_8)
                while (true) {
                    val line = reader.readLine() ?: return
                    if (line.isBlank()) continue
                    writer.write(dispatch(line).toLine())
                    writer.write("\n")
                    writer.flush()
                }
            }
        } catch (t: Throwable) {
            // 对端提前断开是常态（脚本发一条就走），留一行就够。
            android.util.Log.d("CrewDebug", "调试连接收尾：${t.message}")
        }
    }

    /** 把一行请求变成一条回应。坏帧也只回一条错误，不把服务带走。 */
    private fun dispatch(line: String): DebugReply {
        val request = try {
            JSONObject(line)
        } catch (t: Throwable) {
            return DebugReply.fail("bad request: ${t.message ?: "not json"}")
        }
        val action = request.optString("action")
        if (action.isEmpty()) return DebugReply.fail("action is required")
        val args = request.optJSONObject("args") ?: JSONObject()

        // 界面状态归主线程。这里等回执，超时就如实说「界面没空」，不无限挂住这个连接。
        val active = debug ?: return DebugReply.fail("界面还没挂上：这一届 Activity 已退场")
        val latch = CountDownLatch(1)
        var reply: DebugReply = DebugReply.fail("ui thread busy")
        main.post {
            reply = active.invoke(action, args)
            latch.countDown()
        }
        if (!latch.await(UI_WAIT_MS, TimeUnit.MILLISECONDS)) {
            return DebugReply.fail("ui thread busy: $action")
        }
        return reply
    }

    private companion object {
        /** 主线程多久没回就算这一条失败。界面在长列表滚动时也远不到这个数。 */
        const val UI_WAIT_MS = 10_000L
    }
}

/**
 * 一条调试口能被怎么对待：开 / 挂载点换人 / 关。
 *
 * 拆成接口只为一件事：让 [CrewDebugPorts] 的归属规则能在 JVM 单测里跑（真 socket 在 JVM 上没有）。
 */
interface CrewDebugPort {
    /** 起监听。返回 false 表示没起来，调用方只记日志。 */
    fun open(): Boolean

    /** 把台前的挂载点换成 [target]。socket 不动。 */
    fun bind(target: CrewDebugTarget)

    /** 摘掉挂载点。socket 照旧开着。 */
    fun unbind()

    /** 真正关掉监听。只由进程收尾调。 */
    fun close()
}

/**
 * 调试口的归属：**一个进程一条 socket，谁在台前谁挂上去**。
 *
 * 为什么要有这一层（而不是让每届 Activity 各建一个 [CrewDebugServer]）：
 *
 * 1. abstract namespace 里的名字是**进程级**的，Activity 重建时名字不跟着变；
 * 2. Activity 重建的顺序是**新的 onCreate 先于旧的 onDestroy**，所以「新实例 bind」一定早于
 *    「旧实例 close」。真机上看到的就是新实例 `Address already in use`，随后旧实例把口关掉，
 *    进程内从此没有 listener —— 空响应到杀进程。
 * 3. 即使把顺序倒过来也不行：真机判据是失败瞬间 `/proc/net/unix` 里 `crew-debug` 计数为 0，
 *    说明 `close()` 对 abstract namespace 的释放不是同步可见的。所以「关得更快」和
 *    「重试到成功」都不是根因修法 —— **唯一可靠的修法是让 bind 只发生一次**。
 *
 * 于是：[attach] 第一次进来开 socket，之后每届 Activity 只换挂载点；[detach] 只摘挂载点，
 * 且**只认自己那一届**（老实例晚到的收尾不会摘掉新实例的口）。
 *
 * 线程：Activity 生命周期回调都在主线程，但锁照旧加 —— 调试口的连接线程会读挂载点，
 * 而 attach/detach 与它不在同一条线程上。
 */
class CrewDebugPorts(private val port: CrewDebugPort) {

    /** 现在台前那一届 Activity 的令牌。null 表示 socket 开着但没人挂。 */
    private var owner: Any? = null

    /** socket 起没起来。起不来时每一届 Activity 各试一次（一次，不是循环重试）。 */
    var isOpen: Boolean = false
        private set

    val currentOwner: Any?
        get() = synchronized(this) { owner }

    /**
     * 这一届 Activity 上台。返回 false 表示调试口没起来 —— 调用方只记一行日志，界面照常。
     *
     * 已经开着时**不重开**：只换挂载点。这正是转屏不再失效的那一下。
     */
    fun attach(who: Any, target: CrewDebugTarget): Boolean = synchronized(this) {
        if (!isOpen) isOpen = port.open()
        if (!isOpen) return false
        owner = who
        port.bind(target)
        true
    }

    /**
     * 这一届 Activity 退场。只摘挂载点，**不关 socket**。
     *
     * 令牌对不上就什么都不做：转屏时旧的 onDestroy 晚于新的 onCreate，它不许把新的口摘掉。
     */
    fun detach(who: Any) {
        synchronized(this) {
            if (owner !== who) return
            owner = null
            port.unbind()
        }
    }

    companion object {
        /**
         * 进程里唯一的那一份。Activity 换了几届都指向它 —— 与桌面端「一个进程一个调试口」同一口径。
         *
         * 懒初始化：release 构建永远不读它，也就永远不建 socket。
         */
        val process: CrewDebugPorts by lazy { CrewDebugPorts(CrewDebugServer()) }
    }
}

/** 取一个必填字符串参数。缺键、类型不对、空串都算没给 —— 与桌面端 argString 同一口径。 */
private fun argString(args: JSONObject, key: String): String? {
    val value = args.optString(key).trim()
    return value.ifEmpty { null }
}
