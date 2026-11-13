package com.dsh.botcrew

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.shadow
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** 设计稿里的两套命名颜色。界面只按名字取色，不写字面色值。 */
data class CrewPalette(
    val surface: Color, val card: Color,
    val ink: Color, val muted: Color, val faint: Color,
    val accent: Color, val warn: Color, val danger: Color,
    val userBubble: Color, val userInk: Color,
    // 强调色的淡底：头像块、徽标用它。设计稿里这一层和 accent 是成对的。
    val accentSoft: Color,
    // 卡片边框。设计稿的卡不是靠阴影分层，是靠一条极细的边。
    val line: Color,
    // 比 faint 更淡的一档：占位、极弱说明。
    val hint: Color,
    // 空态那一块虚线框与里面的人形。画板里是两种暖灰，和 hint 不是同一个值。
    val emptyEdge: Color, val emptyGlyph: Color,
    // 分段切换的底（画板的 #EFEBE5：比 surface 深、比 line 浅）。
    val segment: Color,
    // 「等你决定」卡的底与边。画板亮色 #FDF9F4 / #E9D9C9，暗色 #241F1A / #4A3A28。
    // 单列出来是因为它既不是 card（太白）也不是 warnSoft（太黄）。
    val warmBase: Color, val warnEdge: Color,
    // 输入框的底（画板亮色 #F3F0EA / 暗色 #2A2830）。浅灰无边框，
    // 靠底色而不是描边和页面分开。
    val field: Color,
    // 删除行的浅橙底（画板亮色 #F6EEE6）。和 warmBase 不同：那个是「等你决定」的卡底。
    val warnSoft: Color,
    // 工单卡进度条的轨道底（画板亮色 #EFEBE5 / 暗色 #2A2830，与桌面端 theme.go 的 Track 同值）。
    // 填充直接复用 accent。没有计划时整条都不画，这块底色也就用不上。
    val track: Color,
    /**
     * 压在 `warn` 实底上的字。画板亮色是白（#96603A 底 + #FFFFFF 字），暗色是深字
     * （#E0A574 底 + #232228 字）—— 两套的赭不在一个明度档上，所以字色也必须分开。
     *
     * 未读角标（契约 §5.6）与「等你决定」的「回」按钮都压在这层赭色上：
     * 亮色下用白读得清，暗色下白压在 #E0A574 上只有 1.9:1，得换成深色。
     */
    val onWarn: Color,
)

val LightPalette = CrewPalette(
    surface = Color(0xFFFBF9F6), card = Color(0xFFFFFFFF),
    ink = Color(0xFF1F1D1A), muted = Color(0xFF57524A), faint = Color(0xFF8A8377),
    accent = Color(0xFF3E6B62), warn = Color(0xFF96603A), danger = Color(0xFFB45252),
    userBubble = Color(0xFF2C2A26), userInk = Color(0xFFFBF9F6),
    accentSoft = Color(0xFFEAF1EC), line = Color(0xFFEDE8E1), hint = Color(0xFFA9A294),
    emptyEdge = Color(0xFFD9D3C9), emptyGlyph = Color(0xFFB8B1A5), segment = Color(0xFFEFEBE5),
    warmBase = Color(0xFFFDF9F4), warnEdge = Color(0xFFE9D9C9), warnSoft = Color(0xFFF6EEE6), field = Color(0xFFF3F0EA),
    track = Color(0xFFEFEBE5),
    // 画板 Mobile.dc.html:41 的角标：赭底 + 白字。
    onWarn = Color(0xFFFFFFFF),
)

val DarkPalette = CrewPalette(
    surface = Color(0xFF17161A), card = Color(0xFF232228),
    ink = Color(0xFFF2EFEA), muted = Color(0xFFC4BFB6), faint = Color(0xFF928C82),
    accent = Color(0xFF5FBFA8), warn = Color(0xFFE0A574), danger = Color(0xFFE58A80),
    userBubble = Color(0xFF3B3942), userInk = Color(0xFFF2EFEA),
    accentSoft = Color(0xFF1E3A34), line = Color(0xFF33313A), hint = Color(0xFF6E6860),
    // 暗盘里没有对应的暖灰：虚线框落到分隔色，人形落到弱字色；分段底用抬起层。
    emptyEdge = Color(0xFF33313A), emptyGlyph = Color(0xFF928C82), segment = Color(0xFF1D1C21),
    warmBase = Color(0xFF241F1A), warnEdge = Color(0xFF4A3A28), warnSoft = Color(0xFF3A2A1C),
    field = Color(0xFF2A2830),
    track = Color(0xFF2A2830),
    // 画板 Mobile-dark.dc.html:41 的角标：亮赭底 + 深字（#232228）。
    onWarn = Color(0xFF232228),
)

/**
 * 手机上这几屏：队伍、后台、某个 Bot 的屏幕（工作区）、模型，以及常规任务。
 *
 * 从队伍进去时记下是谁的屏幕 —— 张冠李戴比进不去更糟，所以这个值一路带到工作区页。
 *
 * 常规任务（契约 §5.5）从后台那一屏进：桌面端它也是后台左栏里的一项，
 * 手机这一屏就是从「后台」页头点进去的同一个位置。
 */
private enum class Screen { Crew, Backend, Workspace, Models, Routine, Memory }

/**
 * 该 Bot 手上最近那张还没结束的票：接手与暂停都只对这张有意义。
 *
 * 票只在结束时才写结局（completed / merged / closed / dropped / stopped），
 * 没结束时 state 是阶段名（work / person / unknown）。所以按「结局集合」判，不是只认 work。
 */
private fun ticketOf(conversation: Conversation?, bot: BotCard?): WorkTicket? {
    if (conversation == null || bot == null) return null
    return conversation.tickets.lastOrNull { it.botId == bot.id && it.open }
}

/**
 * 时间线刷新的单飞记号：一个普通对象，不进 Compose 状态。
 *
 * 它只管「这一趟还在跑吗、跑完要不要再跑一趟」，变了也不需要重画界面 ——
 * 所以用 remember { } 存着、不当状态读，避免每 6 秒的轮询把 CrewRoot 整屏重组一遍。
 */
private class RefreshGuard {
    var running = false
    var again = false
}

@Composable
fun CrewRoot(
    client: CrewClient,
    palette: CrewPalette,
    /** 现在走的是哪条路（隧道已连接 / 局域网 / 公网中转）。空串表示还算不出来。 */
    route: String = "",
    onForget: () -> Unit,
    /** 上次停在哪个会话（从配对记录恢复）；名单本身每次启动都从后端拉。 */
    initialSession: String = SessionRoute.MAIN,
    /** 当前会话变了就落盘。只写这一格，不改 paired，免得重建 P2P 隧道。 */
    onSessionChange: (String) -> Unit = {},
) {
    // 每会话一份 Conversation：切回 A 只显示 A 的缓存，绝不借 B 的消息来顶。
    // 老后端锁 main 时这张表只有一项，与从前单份 Conversation 的结构完全一致。
    var sessionState by remember {
        mutableStateOf(SessionState(current = initialSession.takeIf(SessionRoute::validId) ?: SessionRoute.MAIN))
    }
    val conversation: Conversation? = sessionState.shown
    var problem by remember { mutableStateOf<String?>(null) }
    var draft by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    // 同一条草稿重发要沿用同一个 request_id：超时后其实已经进了队，换一个键会重复入队。
    var pendingSend by remember { mutableStateOf<Pair<String, String>?>(null) }
    var screen by remember { mutableStateOf(Screen.Crew) }
    // 两个模式共一本时间线：这里只存镜头，不另拉一次账（契约 §1）。默认日常群聊。
    var mode by remember { mutableStateOf(Mode.Chat) }
    var profile by remember { mutableStateOf<BotCard?>(null) }
    // 工作区要看谁的屏幕。null 表示从后台进的，那时还没有具体的人。
    var onScreen by remember { mutableStateOf<BotCard?>(null) }
    // 代码卡「看看改完的样子」带过来的票号与画面。手机上没有桌面端那块常驻画面区，
    // 所以那一次读取的结果直接整屏显示；返回时一起清掉，回到队伍不该还挂着旧快照。
    var previewTicket by remember { mutableStateOf<String?>(null) }
    var previewView by remember { mutableStateOf<ScreenView?>(null) }
    // 第几次把时间线读回来。结果条按票的缓存跟着它清：桌面端也是每读回一次对话就把
    // perTicket 清空重读 —— worker 可能只写了个文件，一句话也没多说。
    var timelineEpoch by remember { mutableStateOf(0) }
    val scope = rememberCoroutineScope()
    // 时间线刷新的单飞记号（见下面 refresh）。
    val refreshGuard = remember { RefreshGuard() }
    var executorPaused by remember { mutableStateOf(false) }
    // 动作回执回来之后，已在途的时间线不再覆盖它；下一趟拉取仍以后端为准。
    var pauseRevision by remember { mutableStateOf(0) }
    // 名单先验失败后，人点「重试」就再问一次；不改变锁 main 的结论。
    var sessionRetry by remember { mutableStateOf(0) }

    // 消息结果条按票读产出（契约 §5.4）。挂在 CrewRoot 上、不挂在队伍页里：
    // 去后台/工作区/模型页再回来时，队伍页会整段重新组合，缓存要是跟着它一起没了，
    // 每张票都会在切屏后的第一帧重新发一遍请求 —— 那正是「切屏掉帧」的一半来源。
    // 放在这一层，切回来时结果条是现成的，一帧都不用等。
    // 轮次还是按时间线走：每读回一份新内容就重读一轮，见 OutputsCache 的说明。
    // 按会话重建：结果条与代理树都按票号缓存，票号是会话内的数据，切会话不能复用。
    val outputs = remember(sessionState.current) { OutputsCache() }
    // 子代理树（第一张工单派了谁）。同样挂在这一层：它画在消息列表末尾，
    // 从后台/工作区回来时人第一眼就看那一块，缓存跟着页面走的话每次都要等一趟网络。
    val agents = remember(sessionState.current) { AgentsCache() }

    fun refresh() {
        // 同一时刻只跑一趟。两趟叠在一起时，先发出去的那趟可能带着更旧的时间线后回来，
        // 把较新的那份盖掉；轮次「变了才加一」也跟着算错，结果条按错轮的账本重读一遍。
        // 途中又被要求刷新（发完消息马上想看排队的回执，或刚切了会话）就记一笔，
        // 跑完补一趟 —— 不吞掉，吞掉就得等下一个 6 秒才看得见自己刚发的话。
        if (refreshGuard.running) {
            refreshGuard.again = true
            return
        }
        refreshGuard.running = true
        scope.launch {
            try {
                do {
                    refreshGuard.again = false
                    val requestedPauseRevision = pauseRevision
                    // 每一轮重新读「这一刻该请求哪个会话」：先验未回来 / 锁 main 时是 null，
                    // 老路径逐字不变；切会话时只置了 again，这一轮便会用新的 id 去拉。
                    // key 与请求是同一个值 —— 旧会话的在途刷新写回旧会话那一格，绝不串线。
                    val requestedSession = sessionState.requestSession
                    val key = requestedSession ?: SessionRoute.MAIN
                    val next = client.timeline(requestedSession)
                    // 轮次只在「真的换了一份内容」时才加一。时间线每 6 秒读一次，如果每次都加，
                    // 所有消息的结果条就跟着每 6 秒重读一遍，整列消息行也跟着重组 ——
                    // 列表在这个环里反复重新布局，人什么都不做也看着它在动。
                    //
                    // 这一步比较（Conversation 的逐字段 equals，含每条消息的文本与代码行）
                    // 放在后台：时间线里有几百条消息时，它是实打实的 CPU 活，正卡在人滑动的那一帧上。
                    // 比的是这个会话自己的那份缓存，不拿别的会话来当基准。
                    val current = sessionState.conversations[key]
                    val changed = withContext(Dispatchers.Default) { current != next }
                    // 只有真变了才写回去。写这一下本身也会做一次 equals（状态按结构比）——
                    // 每 6 秒在主线程上把几百条消息比一遍，正是我们要省掉的那笔。
                    // 等值的时候不写：界面不会重组，比较也一次不发生在主线程上。
                    if (changed) {
                        sessionState = SessionFlow.withConversation(sessionState, key, next)
                        timelineEpoch += 1
                        // 只有内容真的变了才记一行。每 6 秒都记的话，日志会被噪声淹掉，
                        // 也就看不出「哪一次是真的变了」。看：adb logcat -s CrewTimeline
                        android.util.Log.i("CrewTimeline",
                            "session=$key changed msgs=${next.messages.size} tickets=${next.tickets.size} " +
                            "queued=${next.queued.size} last=${next.messages.lastOrNull()?.id}")
                    }
                    if (requestedPauseRevision == pauseRevision) executorPaused = next.status.paused
                    problem = null
                } while (refreshGuard.again)
            } catch (error: Exception) {
                problem = error.message
            } finally {
                refreshGuard.running = false
            }
        }
    }

    /**
     * 进入另一格会话：切过去与新建成功后走同一段，草稿/幂等键/结果条轮次一律不复用。
     * 请求路径不靠任何全局状态 —— 各处显式读 [SessionState.requestSession]，
     * 在途的旧请求仍带着它发起那一刻的会话 id。
     */
    fun enterSession(next: SessionState) {
        sessionState = next
        onSessionChange(next.current)
        draft = ""
        pendingSend = null
        timelineEpoch += 1
        refresh()
    }

    // 能力位先验（契约 §2 / §9.5 C4）：启动 / 首次进入时先问一次名单，失败后可由「重试」再问。
    // 200 且 session_api: 1 → 正常启用切换；404 或缺能力位 → 锁 main 并如实说老后端；
    // 网络错 → 锁 main 并如实说读不到。三态都不假装成功、不静默降级。
    // 名单是后端的唯一真源：恢复的会话不在名单里时由 SessionFlow 回落到 default。
    LaunchedEffect(sessionRetry) {
        val next = try {
            SessionFlow.accept(sessionState, client.sessions())
        } catch (error: CancellationException) {
            throw error
        } catch (error: SessionsUnavailable) {
            if (error.status == 404) SessionFlow.unsupported(sessionState) else SessionFlow.unreadable(sessionState)
        } catch (error: Exception) {
            // 不静默吞错：解析崩了、或者别的意外都留一条 logcat，界面仍如实说「读不到」。
            android.util.Log.w("CrewSessions", "读不到会话列表", error)
            SessionFlow.unreadable(sessionState)
        }
        sessionState = next
        onSessionChange(next.current)
        refresh()
    }

    // 队伍回话可能要几分钟。只读一次的话，屏幕会永远停在「已发出去」那一格；
    // 前台时每几秒重读一次，离开页面由 Compose 取消这个协程。
    LaunchedEffect(Unit) {
        while (true) {
            refresh()
            delay(6_000)
        }
    }

    Surface(modifier = Modifier.fillMaxSize(), color = palette.surface) {
        // 让出状态栏与导航栏：断连横幅排在最前，不加的话会顶到系统时间上去。
        Column(modifier = Modifier.fillMaxSize().systemBarsPadding()) {
            // 走的是哪条路：一行小字常驻。它不是装饰 —— 连不上时人最先要问的就是
            // 「现在是不是在绕公网」，这一行直接回答，不必让人去猜。
            if (route.isNotEmpty()) {
                Text(
                    text = "现在走：$route",
                    style = MaterialTheme.typography.labelSmall,
                    color = palette.muted,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                )
            }
            // 会话切换条只在能力位先验通过时画；老后端 / 读不到名单时如实提示并锁 main，
            // 一条切换条都不出现，也一个非 main 请求都不发（禁止静默降级）。
            if (sessionState.switchable) {
                SessionBar(
                    state = sessionState,
                    palette = palette,
                    onSwitch = { id ->
                        val next = SessionFlow.switch(sessionState, id)
                        if (next.current != sessionState.current) enterSession(next)
                    },
                    onCreate = { id ->
                        val check = SessionFlow.create(sessionState, id)
                        sessionState = check.state
                        if (check.accepted) {
                            scope.launch {
                                try {
                                    // 名单只认后端返回的 sessions[]：本地不新增条目。
                                    val view = client.createSession(id)
                                    val next = SessionFlow.applyCreated(sessionState, view, id)
                                    // 名单里没有新 id 时 applyCreated 只给错误，不切、不刷。
                                    if (next.current != sessionState.current) enterSession(next) else sessionState = next
                                } catch (error: CancellationException) {
                                    throw error
                                } catch (error: Exception) {
                                    // 400 invalid_session / 409 unsupported_session / 503 原文直译。
                                    // 异常本身留 logcat：不静默吞掉根因。
                                    android.util.Log.w("CrewSessions", "新建会话失败", error)
                                    sessionState = SessionFlow.createFailed(
                                        sessionState, error.message?.takeIf(String::isNotBlank) ?: error.toString(),
                                    )
                                }
                            }
                        }
                    },
                    onDismissError = { sessionState = SessionFlow.clearError(sessionState) },
                )
            } else if (sessionState.note.isNotEmpty()) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = sessionState.note,
                        style = MaterialTheme.typography.bodySmall,
                        color = palette.muted,
                        modifier = Modifier.weight(1f),
                    )
                    // 后端升级 / 网络恢复后重问一次名单；结果回来之前仍锁 main，不先放行。
                    TextButton(onClick = { sessionRetry += 1 }) { Text("重试", color = palette.accent) }
                }
            }
            // 断连要说在前面：内容区是撑满高度的，摆在它后面的东西会被挤出屏幕。
            problem?.let {
                Text(
                    text = "连不上队伍：$it",
                    style = MaterialTheme.typography.bodySmall,
                    color = palette.danger,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                )
                Row {
                    TextButton(onClick = { refresh() }) { Text("重试", color = palette.accent) }
                    // 连不上又撤不回来时，得有一条换电脑的退路。
                    TextButton(onClick = onForget) { Text("重新配对", color = palette.faint) }
                }
            }

            when (screen) {
                Screen.Backend -> BackendScreen(client, conversation, palette, { screen = Screen.Crew },
                    { refresh() }, onRoutines = { screen = Screen.Routine }, onMemory = { screen = Screen.Memory })
                Screen.Routine -> RoutineScreen(client, conversation, palette, onBack = { screen = Screen.Backend })
                Screen.Memory -> MemoryScreen(client, palette, onBack = { screen = Screen.Backend })
                Screen.Workspace -> WorkspaceScreen(
                    client = client,
                    bot = onScreen ?: conversation?.bots?.firstOrNull { it.id == conversation?.defaultBotId },
                    ticket = ticketOf(conversation, onScreen ?: conversation?.bots?.firstOrNull { it.id == conversation?.defaultBotId }),
                    // 执行器被全局暂停这件事压过单个 Bot 的 activity 词，所以从队伍状态里取。
                    paused = executorPaused,
                    onPausedChanged = { executorPaused = it; pauseRevision += 1 },
                    palette = palette,
                    preview = previewTicket,
                    previewView = previewView,
                    onBack = {
                        // 回到哪一屏由进来的人决定：名片进的就回队伍，后台进的就回后台。
                        // 代码卡进的是从队伍点出来的，所以也回队伍。
                        screen = if (onScreen != null || previewTicket != null) Screen.Crew else Screen.Backend
                        onScreen = null
                        previewTicket = null
                        previewView = null
                    },
                )
                Screen.Models -> ModelScreen(client, conversation, palette, onBack = { screen = Screen.Crew })
                Screen.Crew -> CrewScreen(client, conversation, outputs, agents, palette, problem, draft, sending,
                    // 结果条按票的缓存每读回一次时间线就清空重读一次（见 CrewScreen）。
                    timelineEpoch = timelineEpoch,
                    requestIdFor = { text ->
                        if (pendingSend?.first == text) {
                            pendingSend!!.second
                        } else {
                            java.util.UUID.randomUUID().toString().also { pendingSend = text to it }
                        }
                    },
                    // 发出去了才丢掉幂等键：失败重发必须还在。
                    { draft = it }, { sending = it }, { pendingSend = null; refresh() }, { problem = it },
                    // 代码卡上「看看改完的样子」真读到了画面：整屏去看它的屏幕，看的是
                    // 这段改动所属的那张票 —— 票号由代码卡带过来，这里不再猜。
                    onPreview = { ticketId, botId, view ->
                        previewTicket = ticketId
                        previewView = view
                        // 头像尽量给对人：这一段是谁写的就显示谁；不在这份花名册上时留空，
                        // 抬头只写「工作区」，不编一个名字。
                        onScreen = conversation?.bots?.firstOrNull { it.id == botId }
                        screen = Screen.Workspace
                    },
                    onBackend = { screen = Screen.Backend },
                    onModels = { screen = Screen.Models },
                    onWorkspace = { bot ->
                        onScreen = bot
                        screen = Screen.Workspace
                    },
                    // 队伍这一屏内部再分聊天 / 分拣台：切镜头不换 Screen、不重建时间线。
                    mode = mode,
                    onModeChange = { mode = it },
                    // 先验未完成 / 锁 main 时是 null，深层所有会话请求一律走老路径。
                    sessionId = sessionState.requestSession,
                )
            }

        }
    }
}

/**
 * 全空的队伍：虚线框里一个人形，一句标题，一句正文，一个主按钮。
 *
 * 画板（Mobile-roster 第 6 张）底下还有一枚「队伍 / 后台」的分段切换，
 * 它和主按钮一样没有对应的创建接口 —— 按下去只把缺什么说出来，不摆一块按了没反应的形状。
 * 空态判定只看 bots：消息留着而 Bot 没了的情况（名字读不出来）也归这里。
 */
@Composable
private fun EmptyState(
    client: CrewClient,
    palette: CrewPalette,
    onBackend: () -> Unit,
    onCreated: () -> Unit,
) {
    // 按过哪个按钮、它缺什么。null 表示还没按过；按过就一直写着，不闪一下就没。
    var touched by remember { mutableStateOf<String?>(null) }
    // 内联表单：有真接口了，按「加第一位」就地填，不把人赶去电脑上改配置。
    var formOpen by remember { mutableStateOf(false) }
    var botId by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    var persona by remember { mutableStateOf("") }
    var problem by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    // 表单展开后比一屏高：小屏上不加滚动，底部的「加上」会被屏幕边缘和键盘一起吃掉。
    // 只在展开时可滚，空态本身仍然居中。
    val scroll = rememberScrollState()
    Column(
        modifier = Modifier.fillMaxSize()
            .then(if (formOpen) Modifier.verticalScroll(scroll) else Modifier)
            .padding(horizontal = 32.dp, vertical = 24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // 虚线方框 64、圆角 20，里面一个人形。用 Canvas 画：画板是 stroke 不是填充。
        Canvas(modifier = Modifier.size(64.dp)) {
            val corner = CornerRadius(20.dp.toPx())
            val inset = 0.5.dp.toPx()
            drawRoundRect(
                color = palette.emptyEdge,
                topLeft = Offset(inset, inset),
                size = Size(size.width - inset * 2, size.height - inset * 2),
                cornerRadius = corner,
                style = Stroke(
                    width = 1.dp.toPx(),
                    pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx())),
                ),
            )
            // 26 的人形按 24 的画布缩放：圆头 r3.4 在 (12,8)，肩线从 y=20 起。
            val scale = (26.dp.toPx() / 24f)
            val origin = Offset((size.width - 24f * scale) / 2f, (size.height - 24f * scale) / 2f)
            fun at(x: Float, y: Float) = Offset(origin.x + x * scale, origin.y + y * scale)
            val pen = Stroke(width = 1.6.dp.toPx() * scale, cap = StrokeCap.Round)
            drawCircle(palette.emptyGlyph, radius = 3.4f * scale, center = at(12f, 8f), style = pen)
            val shoulders = Path().apply {
                moveTo(at(5f, 20f).x, at(5f, 20f).y)
                cubicTo(
                    at(5f, 16.1f).x, at(5f, 16.1f).y,
                    at(8.1f, 13f).x, at(8.1f, 13f).y,
                    at(12f, 13f).x, at(12f, 13f).y,
                )
                cubicTo(
                    at(15.9f, 13f).x, at(15.9f, 13f).y,
                    at(19f, 16.1f).x, at(19f, 16.1f).y,
                    at(19f, 20f).x, at(19f, 20f).y,
                )
            }
            drawPath(shoulders, palette.emptyGlyph, style = pen)
        }
        // gap 13：方框到标题、标题到正文都是这一段。
        Text(
            "队伍还是空的",
            fontSize = 15.sp,
            fontWeight = FontWeight(600),
            color = palette.muted,
            modifier = Modifier.padding(top = 13.dp),
        )
        // 画板里这一句是写死两行的（中间一个 br）。行高 1.65。
        Text(
            "加一位 Bot，他从今天起会记住\n你们的每一次对话。",
            fontSize = 13.sp,
            lineHeight = 21.sp,
            color = palette.hint,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 13.dp),
        )
        Box(
            modifier = Modifier
                // 画板：margin-top 4，加上 gap 13 就是 17。
                .padding(top = 17.dp)
                .background(palette.accent, RoundedCornerShape(11.dp))
                .clickable { formOpen = true; touched = null }
                .defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
                .padding(horizontal = 26.dp, vertical = 11.dp),
        ) {
            Text("加第一位", fontSize = 14.sp, fontWeight = FontWeight(550), color = palette.surface)
        }
        // 按过之后把「差什么」写在原地说一遍：闪一下就消失的提示等于没写。
        touched?.let {
            Text(
                it,
                fontSize = 11.sp,
                color = palette.warn,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 9.dp),
            )
        }
        if (formOpen) {
            // 内联表单：id、显示名、人设。id 的形状与后端一致，先本地拦一道，
            // 让「不合规」在按键之前就说清楚；重名之类只有后端知道，错误原样带回来。
            Column(
                modifier = Modifier.padding(top = 14.dp).widthIn(max = 300.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                val field = OutlinedTextFieldDefaults.colors(
                    focusedContainerColor = palette.surface,
                    unfocusedContainerColor = palette.surface,
                    focusedBorderColor = palette.accent,
                    unfocusedBorderColor = palette.line,
                    focusedTextColor = palette.ink,
                    unfocusedTextColor = palette.ink,
                    cursorColor = palette.accent,
                )
                val fieldStyle = androidx.compose.ui.text.TextStyle(fontSize = 13.sp, color = palette.ink)
                OutlinedTextField(
                    value = botId,
                    onValueChange = { botId = it; problem = null },
                    label = { Text(EmptyCopy.ID_HINT, fontSize = 11.sp) },
                    singleLine = true,
                    textStyle = fieldStyle,
                    shape = RoundedCornerShape(11.dp),
                    colors = field,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it; problem = null },
                    label = { Text(EmptyCopy.NAME_HINT, fontSize = 11.sp) },
                    singleLine = true,
                    textStyle = fieldStyle,
                    shape = RoundedCornerShape(11.dp),
                    colors = field,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = persona,
                    onValueChange = { persona = it; problem = null },
                    label = { Text(EmptyCopy.PERSONA_HINT, fontSize = 11.sp) },
                    textStyle = fieldStyle,
                    shape = RoundedCornerShape(11.dp),
                    colors = field,
                    maxLines = 3,
                    modifier = Modifier.fillMaxWidth(),
                )
                Button(
                    onClick = {
                        val id = botId.trim()
                        if (!BotsWire.ID.matches(id)) {
                            problem = EmptyCopy.ID_INVALID
                            return@Button
                        }
                        if (name.isBlank()) {
                            problem = "给他起个名字"
                            return@Button
                        }
                        busy = true
                        scope.launch {
                            try {
                                client.createBot(id, name.trim(), persona.trim())
                                formOpen = false
                                onCreated()
                            } catch (error: Exception) {
                                problem = error.message
                            } finally {
                                busy = false
                            }
                        }
                    },
                    enabled = !busy,
                    colors = ButtonDefaults.buttonColors(containerColor = palette.accent, contentColor = palette.surface),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(if (busy) "正在加…" else "加上", fontSize = 13.sp)
                }
                problem?.let {
                    Text(it, fontSize = 11.sp, color = palette.warn, textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth())
                }
            }
        }
        // 分段切换：200 宽、3 的内边距、圆角 10。它在这里是个摆件 ——
        // 「后台」按下去只是换个标签，因为队列页在没 Bot 时没有可看的东西，也没接口读。
        Row(
            modifier = Modifier
                .padding(top = 18.dp)
                .width(200.dp)
                .background(palette.segment, RoundedCornerShape(10.dp))
                .padding(3.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            SegmentChip("队伍", selected = true, palette, onClick = {})
            // 后台页要的是队列；没 Bot 就没有队列，所以按下去只说这句话，不跳一个空页。
            SegmentChip("后台", selected = false, palette, onClick = { touched = EmptyCopy.NO_BACKEND_YET })
        }
    }
}

// SegmentChip 是空态底部那枚两格切换里的一格。
@Composable
private fun RowScope.SegmentChip(label: String, selected: Boolean, palette: CrewPalette, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .weight(1f)
            .clip(RoundedCornerShape(7.dp))
            .background(if (selected) palette.card else Color.Transparent)
            .clickable(onClick = onClick)
            .defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
            .padding(vertical = 6.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            fontSize = 12.sp,
            fontWeight = if (selected) FontWeight(600) else FontWeight.Normal,
            color = if (selected) palette.ink else palette.faint,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun CrewScreen(
    client: CrewClient,
    conversation: Conversation?,
    /** 结果条按票的缓存。由上层持有：切到别的屏再回来时还留着，不必整屏重读。 */
    outputs: OutputsCache,
    /** 子代理树按票的缓存。同样由上层持有：它在列表末尾，切回来时最容易被看见。 */
    agents: AgentsCache,
    palette: CrewPalette,
    problem: String?,
    draft: String,
    sending: Boolean,
    /** 第几次把时间线读回来。变了就按这一轮重读结果条（上一轮的结果不再算数）。 */
    timelineEpoch: Int,
    /** 同一段草稿重发要沿用同一个幂等键；新草稿换一个。 */
    requestIdFor: (String) -> String,
    onDraft: (String) -> Unit,
    onSending: (Boolean) -> Unit,
    onSent: () -> Unit,
    onFailed: (String) -> Unit,
    /** 代码卡上的「看看改完的样子」读到了画面：由上层决定怎么显示（手机上是整屏去看它的屏幕）。 */
    onPreview: (String, String?, ScreenView) -> Unit,
    onBackend: () -> Unit,
    onModels: () -> Unit,
    onWorkspace: (BotCard?) -> Unit,
    /** 聊天 / 分拣台：只切渲染，群聊的滚动位置与草稿都留在这一页里。 */
    mode: Mode = Mode.Chat,
    onModeChange: (Mode) -> Unit = {},
    /**
     * 这一刻该把会话请求发到哪一格。每次重组拿到的都是当前值，但协程在发起时
     * 捕获的是它启动那一刻的参数 —— 切会话时在途的旧请求仍发往旧会话。
     * null = 老路径（先验未完成 / 锁 main），一个 `?session_id=` 都不带。
     */
    sessionId: String? = null,
) {
    // 名片与滚动位置归这一页；其余是发消息要用到的、由上层持有的状态。
    var profile by remember { mutableStateOf<BotCard?>(null) }
    // 正在改人设的那一位。null 表示编辑层没开。
    var editing by remember { mutableStateOf<BotCard?>(null) }
    // 撤回失败要在这条消息旁边说，不冒充发送失败。
    var withdrawNote by remember { mutableStateOf<String?>(null) }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    // 事务板抽屉与模式切换都归这一页：切镜头时群聊的滚动位置还在（listState 留在组合里）。
    var boardOpen by remember { mutableStateOf(false) }
    var pendingJump by remember { mutableStateOf<String?>(null) }

    // 分拣台的「丢」与事务板上的回答都走和群聊同一条 POST /send，不另造一套发送。
    fun sendBoardText(text: String, done: (Boolean) -> Unit) {
        onSending(true)
        scope.launch {
            val ok = try {
                client.send(text, CrewWire.mentionsIn(text, conversation?.bots.orEmpty()), requestIdFor(text), sessionId)
                onDraft("")
                onSent()
                true
            } catch (error: Exception) {
                onFailed(error.message ?: "发送失败")
                false
            } finally {
                onSending(false)
            }
            done(ok)
        }
    }
    fun answerTicket(ticket: WorkTicket, option: AttentionOption, done: (Boolean) -> Unit) {
        val name = conversation?.bots?.firstOrNull { it.id == ticket.botId }?.name?.trim().orEmpty()
        val address = name.ifEmpty { ticket.botId.trim() }
        val text = if (address.isEmpty()) option.label else "@$address ${option.label}"
        sendBoardText(text, done)
    }
    fun jump(messageId: String) {
        boardOpen = false
        onModeChange(Mode.Chat)
        pendingJump = messageId
    }
    fun switchMode(next: Mode) {
        boardOpen = false
        onModeChange(next)
    }

    if (mode == Mode.Triage) {
        Column(modifier = Modifier.fillMaxSize()) {
            // 分拣台整屏用纸感（含顶栏），聊天模式仍是暗色：两个镜头各自的视觉语言不混着用。
            ModeHeader(mode, TriagePalette, { next -> switchMode(next) }, boardUnread(conversation), onOpenBoard = {})
            TriageScreen(
                conversation = conversation,
                palette = TriagePalette,
                draft = draft,
                onDraft = onDraft,
                sending = sending,
                enabled = problem == null,
                problem = problem,
                onDrop = { text -> sendBoardText(text) {} },
                onAnswer = { ticket, option, done -> answerTicket(ticket, option, done) },
                onJumpToMessage = { messageId -> jump(messageId) },
                modifier = Modifier.weight(1f),
            )
        }
        return
    }
    Column(modifier = Modifier.fillMaxSize()) {
        ModeHeader(mode, palette, { next -> switchMode(next) }, boardUnread(conversation), onOpenBoard = { boardOpen = true })
        // 事务板/分拣台点一条：切回群聊并滚到那句话（ticket_ref 对不上的行不会走到这里）。
        LaunchedEffect(pendingJump) {
            val messageId = pendingJump ?: return@LaunchedEffect
            val index = conversation?.messages?.indexOfFirst { it.id == messageId } ?: -1
            if (index >= 0) listState.animateScrollToItem(index)
            pendingJump = null
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(palette.card)
                // 画板页头：padding 10 18 14，白底 + 下边线 1。边线就是这一层底的最下面一条。
                .padding(start = 18.dp, end = 18.dp, top = 10.dp, bottom = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // 画板第 6 张（手机花名册）的页头标题是 20sp / 660 / 字距 -0.02em。
            Text(
                "我的队伍",
                fontSize = 20.sp,
                fontWeight = FontWeight(660),
                letterSpacing = (-0.02f).em,
                color = palette.ink,
            )
            Spacer(Modifier.weight(1f))
            // 画板 Mobile 的顶栏在这里放的是「看它的屏幕」那个小方块。后端还没这条接口，
            // 所以按下去说一句实话，不跳到一个空页面 —— 空页面比没反应更像出了故障。
            GlassIconButton(
                glyph = "屏幕",
                tint = if (conversation != null) palette.accent else palette.hint,
                palette = palette,
                onClick = { onWorkspace(null) },
            )
            TextButton(onClick = onModels) { Text("模型", color = palette.accent) }
            // 「后台」入口本来就该在最常去的地方；画板还给它挂了一枚未读角标（契约 §5.6）。
            // 算不出来时角标不出现（见 BackendIconButton），入口本身照常在。
            BackendIconButton(
                tint = palette.accent,
                count = conversation?.unread,
                palette = palette,
                onClick = onBackend,
            )
        }
        // 页头那 1 的下边线。画板把它画在页头这一块上，不画在内容上。
        Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(palette.line))
        val shown = conversation
        if (shown != null) {
            when {
                // 只按 bots 判：消息可能是「名字读不出来」的残留，那也还是没人的队伍。
                // 建完人就刷新整段对话：花名册从后端重读，读到的才是真的。
                shown.bots.isEmpty() ->
                    EmptyState(client, palette, onBackend, onCreated = onSent)
                else -> {
                    // 花名册横排：头像块 + 名字。设计稿里头像 32dp、圆角 10。
                    // 裸文字按钮看不出「这是一个人」，头像块才看得出来。
                    Row(
                        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())
                            .padding(horizontal = 14.dp, vertical = 6.dp),
                        horizontalArrangement = Arrangement.spacedBy(16.dp),
                    ) {
                        for ((index, bot) in shown.bots.withIndex()) {
                            Column(
                                horizontalAlignment = Alignment.CenterHorizontally,
                                modifier = Modifier.clickable { profile = bot }
                                    .defaultMinSize(minWidth = 48.dp, minHeight = 48.dp),
                            ) {
                                Box(
                                    modifier = Modifier
                                        .size(32.dp)
                                        .clip(RoundedCornerShape(10.dp))
                                        .background(if (index == 0) palette.accentSoft else palette.card),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text(
                                        bot.name.take(1),
                                        fontSize = 13.sp,
                                        fontWeight = FontWeight.SemiBold,
                                        color = palette.accent,
                                    )
                                }
                                Spacer(Modifier.height(3.dp))
                                Text(bot.name, fontSize = 11.sp, color = palette.muted)
                            }
                        }
                    }
                    val shownProfile = profile
                    if (shownProfile != null) {
                        BotCardSheet(shownProfile, shown, palette, onTalk = { profile = null },
                            onClose = { profile = null }, onEdit = {
                                // 名片让位给编辑层：两个都是铺满整屏的浮层，同时画会互相压住。
                                profile = null
                                editing = shownProfile
                            }) {
                            // 进工作区前先把名片收起来：否则从屏幕页退回来时还压着一张卡。
                            profile = null
                            onWorkspace(it)
                        }
                    }
                    val shownEditor = editing
                    if (shownEditor != null) {
                        BotEditorSheet(client, shownEditor, palette,
                            onClose = { editing = null },
                            onSaved = { editing = null; profile = null; onSent() })
                    }
                    // 「同一张票只挂在最后一条回复上」：按这一版时间线算一次，一屏十几条
                    // 消息共用这一份结果。从前是每条消息各自调用一次 lastOfTicket
                    // （每趟都往后扫一遍尾巴），一屏就是十几趟 O(n)。key 用消息列表本身：
                    // 时间线没变（每 6 秒读回来的那份 equals 相同）时它原样留着，连这一趟都不做。
                    // 键是 messages 的内容，不是列表实例：时间线每 6 秒读一份回来，
                    // 内容没变时这份结果原样留着。它是 O(n) 的，放在滚动帧里算就是每帧 O(n) ——
                    // 120Hz 上帧预算 8ms，这一趟能占掉一大截，于是滑动就不跟手了。
                    val resultEnds = remember(shown.messages) {
                        OutputsCopy.takeLastOfTicket(shown.messages)
                    }
                    // 滚动中先不挂结果条：它每条都要查一次缓存、必要时发一次读请求，
                    // 挂在滚动帧里就是每帧多一份活。120Hz 上一帧只有 8ms，这点活足够掉帧。
                    // 手一停，它立刻回来 —— 停手的那一帧重算一次，人看不到「刚才没有」。
                    val scrolling = listState.isScrollInProgress
                    LazyColumn(
                        state = listState,
                        modifier = Modifier.weight(1f),
                        // 消息贴底：聊天的内容总是从下面往上长，空的地方应该在上面。
                        // 设计稿这里用的是 flex-end。
                        // 间距不设在这里：画板是组间 16、组内 9，得逐条算，见下面那一行。
                        verticalArrangement = Arrangement.Bottom,
                        // 首尾各留一口气。不留的话，滚到中途时最上面那条会被页头的下边线
                        // 硬生生切掉半行，最下面那条又贴着输入框消失。
                        contentPadding = PaddingValues(top = 10.dp, bottom = 10.dp),
                    ) {
                        // 网关的 item 不保证带 id：缺 id 时 optString 给空串，几条缺 id 的消息
                        // 就会共用同一个 key，Compose 直接抛 "Key was already used"。
                        itemsIndexed(shown.messages, key = { index, m -> m.id.ifEmpty { "missing-$index" } }) { index, message ->
                            // 与上一条是同一个人就连着排，不再重复标名字。
                            val previous = shown.messages.getOrNull(index - 1)
                            val sameSpeaker = previous != null &&
                                previous.fromBot == message.fromBot &&
                                previous.botId == message.botId
                            MessageRow(
                                message, shown.bots, palette, client,
                                // 代码卡上「看看改完的样子」读到了画面：整屏去看它的屏幕。
                                // 从队伍进来的，退回队伍 —— 和名片进工作区同一条返回规矩。
                                onScreen = { ticketId, view -> onPreview(ticketId, message.botId, view) },
                                showName = !sameSpeaker,
                                // 组内 9、换人 16。第一条上面不留白，否则贴底时首条离底边会多一截。
                                topGap = if (previous == null) 0.dp else if (sameSpeaker) 9.dp else 16.dp,
                                // 结果条：这条话带票号才去读那张票的产出；没有票号就什么都不读。
                                outputs = outputs,
                                generation = timelineEpoch,
                                // 同一张票的票号会挂在「收到」和「报结果」两条回复上：只让这张票
                                // 在时间线上的最后一条回复挂结果条，见 OutputsCopy.lastOfTicket。
                                // 这份判断整列只算一次，见上面的 resultEnds。
                                showResult = !scrolling && resultEnds.getOrElse(index) { false },
                                sessionId = sessionId,
                            )
                        }
                        if (shown.tickets.isNotEmpty()) {
                            // 「等你决定」：后端随问题下发了 options 就画成能点的 A/B，
                            // 点一下直接把那句话发回去（走同一条 POST /send）。
                            // 显式给 key：消息用的是消息 id，这两块若用默认自增 key，
                            // 一旦消息 id 是数字串就会撞上，Compose 会复用错误的 item，
                            // 那一格的高度按上一条算 —— 表现为最后那张卡被裁掉半截、列表也滚不到位。
                            item(key = "tickets") {
                                TicketStrip(
                                    shown, palette, client,
                                    sessionId = sessionId,
                                    // 草稿空着才补一句 `@名字 `；已经写了一半的不动它 ——
                                    // 点一下就把人写了一半的话冲掉，比什么都不做更糟。
                                    onPrefill = { name ->
                                        if (draft.isEmpty()) onDraft(if (name.isEmpty()) "" else "@$name ")
                                    },
                                    onSent = onSent,
                                )
                            }
                            // 第一张工单的子代理能在这里展开，就是「他派了谁」。
                            // 树按票号缓存（agents），切屏回来时不用再等一次网络。
                            item(key = "subagents") {
                                SubagentCard(client, shown.tickets.first().id, agents, timelineEpoch, palette)
                            }
                        }
                    }
                    // 列表要不要自己滚，只由两件事决定：是不是真的多了一句，以及人是不是本来就贴着底。
                    //
                    // 从前这里用「消息条数」当 key，而时间线每 6 秒读一次、把整份换成新对象，
                    // 条数在排队、回复、撤回之间来回变，每变一次就滚一次 —— 没人碰它，屏幕自己在跳。
                    val lastMessageId = shown.messages.lastOrNull()?.id ?: ""
                    // 进对话屏 / 有新回话时，把主人读到的最后一条回话 id 报上去（契约 §5.6）。
                    // 只报队伍回的最后一条；还没收到任何回话就不报 —— 报了等于替主人说「都看过了」。
                    val lastAgentId = shown.messages.lastOrNull { it.fromBot }?.id ?: ""
                    LaunchedEffect(lastAgentId) {
                        if (lastAgentId.isNotEmpty()) client.reportRead(lastAgentId, sessionId)
                    }
                    // 第一次拿到消息时要落到底（打开就该看到最新一句）；之后只跟着新消息走。
                    var settled by remember { mutableStateOf(false) }
                    LaunchedEffect(lastMessageId) {
                        if (lastMessageId.isEmpty()) return@LaunchedEffect
                        // 手指正按在列表上（甩动或拖动中）：这一下不去动它。
                        //
                        // 从前这里不看这个：新消息一到就 scrollToItem，手指还压着也照滚，
                        // 列表和手指抢同一个位置 —— 手感上就是"滑到一半被拽回去、顿一下"。
                        // 内容、顺序、什么时候该落底都没改，只是把"人正滑着"这一种情况让给人。
                        // 让开之后不补滚：人松手时停在哪儿就是哪儿（这本来就是他自己选的），
                        // 下一次新消息来它照旧跟着走。
                        if (listState.isScrollInProgress) return@LaunchedEffect
                        val info = listState.layoutInfo
                        val last = info.visibleItemsInfo.lastOrNull()
                        // 离底不足 48px 才算贴着底。用像素而不是索引：一条撑满整屏的长消息也算在底部；
                        // 停在离底十来个像素时不算 —— 那种位置通常是人正看着最后一句话，不该被拽走。
                        val gap = if (last == null) 0 else (info.viewportEndOffset - (last.offset + last.size))
                        val atBottom = last == null || (last.index >= info.totalItemsCount - 1 && gap <= 48)
                        // scrollToItem(末项) 只能把它顶到视口顶部；末项比视口矮时列表会停在半途。
                        // 给一个很大的 offset，才是滚到真正的尽头。
                        suspend fun bottom() { listState.scrollToItem(shown.messages.lastIndex, Int.MAX_VALUE) }
                        // 真正动手之前再看一眼：上面这几行读布局、再等一帧，中间隔着十几毫秒，
                        // 人完全可能在这期间把手指按下来。按下去之后再滚，等于把上面那条让开的规矩
                        // 白写了 —— 而且这一下会打断他自己刚甩起来的惯性。
                        if (!settled) {
                            settled = true
                            // 这一帧排完再滚：消息还没量出高度时滚，落点按估算算，会差一截。
                            withFrameNanos { }
                            if (!listState.isScrollInProgress) bottom()
                        } else if (atBottom) {
                            // 结果条、子代理卡是异步读回来的，滚完这句它们才把高度撑开。补一帧再落一次。
                            withFrameNanos { }
                            if (!listState.isScrollInProgress) bottom()
                        }
                    }
                    // 排队中的消息要能撤回：按 request_id 把正文找回来，读不到就显示占位，不编内容。
                    val queued = shown.queued.map { requestId ->
                        requestId to (shown.messages.firstOrNull { it.requestId == requestId }?.text ?: "这条消息")
                    }
                    // 连不上就别让人发：发出去也到不了，还让人以为发了。
                    Composer(client, draft, queued, shown.declined.lastOrNull()?.reason, withdrawNote, sending, palette,
                        enabled = problem == null, onChange = onDraft,
                        steerTicketId = shown.tickets.firstOrNull { it.open }?.id,
                        onSteer = { requestId, ticketId ->
                            scope.launch {
                                withdrawNote = try {
                                    client.steer(ticketId, requestId, sessionId)
                                    "已插话，队伍做完当前这一步会先处理这句"
                                } catch (error: Exception) {
                                    error.message ?: "插队没成功"
                                }
                            }
                        },
                        onWithdraw = { requestId ->
                            scope.launch {
                                withdrawNote = try {
                                    client.withdraw(requestId, sessionId)
                                    onSent()
                                    null
                                } catch (error: Exception) {
                                    error.message ?: "撤回没成功"
                                }
                            }
                        },
                        onSteerText = { ticketId ->
                            val text = draft
                            val requestId = requestIdFor(text)
                            scope.launch {
                                withdrawNote = try {
                                    client.steerText(ticketId, requestId, text, sessionId)
                                    onDraft("")
                                    onSent()
                                    "已插话，队伍做完当前这一步会先处理这句"
                                } catch (error: Exception) {
                                    error.message ?: "插队没成功"
                                }
                            }
                        }) {
                        val text = draft
                        val requestId = requestIdFor(text)
                        onSending(true)
                        scope.launch {
                            try {
                                client.send(text, CrewWire.mentionsIn(text, shown.bots), requestId, sessionId)
                                onDraft("")
                                onSent()
                            } catch (error: Exception) {
                                // 失败也要让上层知道：它负责显示那句话。
                                onFailed(error.message ?: "发送失败")
                            } finally {
                                onSending(false)
                            }
                        }
                    }
                }
            }
        } else if (problem == null) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.Center,
            ) { CircularProgressIndicator() }
        }
    }
    // 事务板是聊天模式旁边的抽屉，压在群聊上；分拣台模式本身就是那块板，不再叠一层。
    if (boardOpen) {
        BoardDrawer(
            conversation = conversation,
            palette = palette,
            onDismiss = { boardOpen = false },
            onJumpToMessage = { messageId -> jump(messageId) },
            problem = problem,
            onAnswer = { ticket, option, done -> answerTicket(ticket, option, done) },
        )
    }
}

/* 名片：照着画板「Personal Agent · 名片」做的一张卡。
 *
 * 画板里它不是底部抽屉，是一整页 —— 上面一行小字写这是谁的名片，
 * 中间一张 330 宽的白卡，背后那层队伍内容压到 55% 透明度。
 * 所以这里做成全屏覆盖层，不是 ModalBottomSheet。 */
@Composable
private fun BotCardSheet(
    bot: BotCard,
    conversation: Conversation,
    palette: CrewPalette,
    onTalk: () -> Unit,
    onClose: () -> Unit,
    onEdit: () -> Unit,
    onWorkspace: (BotCard) -> Unit,
) {
    // 画板实测：卡片最大 330、圆角 18、白底、边框 #EDE8E1、阴影往下 18。
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(palette.surface.copy(alpha = 0.55f))
            .clickable(onClick = onClose),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier
                // 画板里卡片铺到 330 满宽；屏幕比 330 窄时才留 20 的边。
                // padding 必须写在 shadow 之前 —— 反过来会把阴影和白底一起压窄。
                .padding(horizontal = 20.dp)
                .widthIn(max = 330.dp)
                .fillMaxWidth()
                .shadow(18.dp, RoundedCornerShape(18.dp))
                .background(palette.card, RoundedCornerShape(18.dp))
                .border(1.dp, palette.line, RoundedCornerShape(18.dp))
                // 卡内不能再让点击穿透出去关掉自己。
                .clickable(enabled = false) {},
        ) {
            // 头：56 的方形头像 + 名字 + 一行职能。
            Row(
                modifier = Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 22.dp, bottom = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(13.dp),
            ) {
                Box(
                    modifier = Modifier
                        .size(56.dp)
                        .background(palette.accent, RoundedCornerShape(17.dp)),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        bot.name.take(1),
                        fontSize = 22.sp,
                        fontWeight = FontWeight(620),
                        color = palette.surface,
                    )
                }
                Column(modifier = Modifier.padding(top = 4.dp)) {
                    Text(bot.name, fontSize = 18.sp, fontWeight = FontWeight(660), color = palette.ink)
                    Text(
                        bot.role.ifBlank { "队伍成员" },
                        fontSize = 12.5.sp,
                        color = palette.faint,
                    )
                }
            }

            // 人设：11 的小标题 + 13.5 正文，行高 1.65。
            if (bot.persona.isNotBlank()) {
                Column(modifier = Modifier.padding(start = 20.dp, end = 20.dp, bottom = 16.dp)) {
                    Text(
                        "人设",
                        fontSize = 11.sp,
                        fontWeight = FontWeight(600),
                        color = palette.faint,
                        modifier = Modifier.padding(bottom = 7.dp),
                    )
                    Text(
                        bot.persona,
                        fontSize = 13.5.sp,
                        lineHeight = 22.sp,
                        color = palette.ink,
                    )
                }
            }

            // 三行事实：记忆名 / 最近的活 / 认识多久。左灰右深，基线对齐。
            val own = conversation.tickets.count { it.botId == bot.id }
            val running = conversation.tickets.count { it.botId == bot.id && it.state == "running" }
            Column(
                modifier = Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 16.dp),
                verticalArrangement = Arrangement.spacedBy(9.dp),
            ) {
                FactRow("他的记忆", "bot/${bot.id}", palette, mono = true)
                FactRow("最近的活", "$own 张 · $running 在跑", palette)
                // 认识多久：取不到时间就整行不画。写上「未知」等于把缺数据画成了一条事实。
                BotSince.label(bot.since)?.let { FactRow("认识多久", it, palette) }
            }

            // 三个按钮：主按钮铺满，下面两个并排。圆角 10。
            Column(
                modifier = Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 20.dp),
                verticalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(palette.accent, RoundedCornerShape(10.dp))
                        .clickable(onClick = onTalk)
                        .defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
                        .padding(vertical = 11.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("跟他说话", fontSize = 13.5.sp, fontWeight = FontWeight(550), color = palette.surface)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                    SmallCardButton("改人设", palette, onEdit)
                    // 原先这里是「看他的记忆」：点了没有任何反应，和「改人设」一样是一块
                    // 做了样子的空地。换成工作区入口 —— 它点下去至少有一句实话，
                    // 而且是「跟他说话」旁边最自然的一件事：看着它干活。
                    SmallCardButton("看他的屏幕", palette) { onWorkspace(bot) }
                }
            }
        }
    }
}

// FactRow 是名片里的一行：左边灰标签，右边值。
@Composable
private fun FactRow(label: String, value: String, palette: CrewPalette, mono: Boolean = false) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, fontSize = 11.5.sp, color = palette.faint)
        Text(
            value,
            fontSize = 11.5.sp,
            color = palette.muted,
            fontFamily = if (mono) FontFamily.Monospace else FontFamily.Default,
        )
    }
}

// SmallCardButton 是名片下方并排的两个次要按钮。
@Composable
private fun RowScope.SmallCardButton(label: String, palette: CrewPalette, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .weight(1f)
            .border(1.dp, palette.line, RoundedCornerShape(10.dp))
            .clickable(onClick = onClick)
            .defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
            .padding(vertical = 9.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, fontSize = 12.5.sp, color = palette.ink)
    }
}

/**
 * 工作区：某个 Bot 的屏幕，加上「接手操作」「让它停一下」。
 *
 * 画面不是像素截帧，是**实景**：它此刻在干什么（后端推出的 activity）、这段从几点开始、
 * 它刚跑了什么命令、输出了什么、说了什么（契约 §5.1）。画的是真事，不是黑白方块拼出来的假浏览器 ——
 * 假画面比空位更坏。
 *
 * 没有实景时如实报 unavailable：后端给 reason 就写 reason，链路断了就写读不到，
 * 两种都不是「在加载」。进页面后每几秒重读一次，让它真的在动 —— 一张停住的「实景」等于假画面。
 *
 * bot 为 null 表示从后台进来、还没指定是谁：那时抬头写「工作区」，也不编一个名字。
 * ticket 是这个 Bot 手上最近一张还没结束的票；没有票时接手只能说「它手上没有活儿」。
 *
 * preview 是代码卡上「看看改完的样子」刚读回来的那份快照（票号 + 画面）：
 * 手机上没有桌面端那块常驻画面区，所以那一次读取的结果直接在这儿整屏显示。
 * null 表示不是从代码卡进来的，照常按 ticket 读一次。
 */
@Composable
private fun WorkspaceScreen(
    client: CrewClient,
    bot: BotCard?,
    ticket: WorkTicket?,
    paused: Boolean,
    onPausedChanged: (Boolean) -> Unit,
    palette: CrewPalette,
    /** 代码卡带过来的票号；有值时这一页读的是它，而不是 bot 手上那张。 */
    preview: String? = null,
    previewView: ScreenView? = null,
    onBack: () -> Unit,
) {
    // 按过之后显示的那一行。null 表示还没按过；按过一次就一直写着，不闪一下就没。
    var touched by remember { mutableStateOf<String?>(null) }
    // 读屏的结果。view 是后端的话，screenProblem 是链路的话，两者不同时用。
    // 从代码卡进来的那一次已经在上一屏读过，直接用带回来的画面，不再打一遍。
    var view by remember(bot?.id, ticket?.id, preview) { mutableStateOf(previewView) }
    var screenProblem by remember(bot?.id, ticket?.id, preview) { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    // 进页面读一次，之后每 5 秒重读一次：worker 在跑，屏幕就该跟着动。
    // 重读失败不把已有的实景擦掉（那会让画面闪成空白）；只有第一次就读不到时才写「读不到」。
    // 代码卡已经带着画面进来了就不重读 —— 那一份就是它刚查到的结果。
    //
    // 读到的东西与手上的一模一样就不写回去：view 是状态，写一次就整页重组一次，
    // 下面那几十行快照文本也跟着全部重排。屏幕上没有变化的那一次，不该付这笔钱。
    suspend fun read() {
        val next = client.screen(preview ?: ticket?.id)
        if (next != view) view = next
        screenProblem = null
    }
    LaunchedEffect(bot?.id, ticket?.id, preview) {
        if (previewView != null) return@LaunchedEffect
        while (true) {
            try {
                read()
            } catch (error: Exception) {
                if (view == null) screenProblem = error.message
            }
            delay(5_000)
        }
    }

    // 按下按钮之后要把屏幕重读一次：停了之后画面不该还写着「正在干活」。
    fun reread() {
        scope.launch {
            try {
                read()
            } catch (error: Exception) {
                if (view == null) screenProblem = error.message
            }
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        // 头：退回 / 头像 / 名字与那一行小字 / 全屏。
        // 画板是 30dp 方形按钮、圆角 9、头像 26dp。全屏在这儿先摆着，尺寸和画板一致。
        Row(
            modifier = Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, top = 6.dp, bottom = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(48.dp)
                    .background(palette.card, RoundedCornerShape(9.dp))
                    .clickable(onClick = onBack),
                contentAlignment = Alignment.Center,
            ) {
                // 画板用的是箭头；这里用半个宽度的字形，不引图标库。
                Text("‹", fontSize = 17.sp, color = palette.ink)
            }
            val who = bot
            if (who != null) {
                Box(
                    modifier = Modifier
                        .size(26.dp)
                        .background(palette.accent, RoundedCornerShape(8.dp)),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        WorkspaceCopy.initial(who),
                        fontSize = 11.sp,
                        fontWeight = FontWeight(620),
                        // surface 是 accent 的反面色：浅色盘 accent 深、surface 接近白；
                        // 暗盘反过来。和队伍页、名片上的头像块同一条规矩。
                        color = palette.surface,
                    )
                }
            }
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    if (who != null) WorkspaceCopy.title(who) else "工作区",
                    fontSize = 13.sp,
                    fontWeight = FontWeight(620),
                    color = palette.ink,
                )
                Text(WorkspaceCopy.SUBTITLE, fontSize = 11.sp, color = palette.faint)
            }
            Box(
                modifier = Modifier
                    .size(48.dp)
                    .border(1.dp, palette.line, RoundedCornerShape(9.dp))
                    // 全屏还没有对应的接口：点一下如实说出来，不做别的动作。
                    .clickable { touched = WorkspaceCopy.FULLSCREEN_NOTE },
                contentAlignment = Alignment.Center,
            ) {
                Text("⤢", fontSize = 12.sp, color = palette.muted)
            }
        }

        // 屏幕块：细边、圆角 12，占满中间 —— 上下两块让出来之后剩下的高度全给它。
        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .padding(horizontal = 14.dp)
                // 先描边再裁：反过来的话裁剪会把圆角处的边也切直。
                .border(1.dp, palette.line, RoundedCornerShape(12.dp))
                .clip(RoundedCornerShape(12.dp))
                .background(palette.card),
        ) {
            // 地址条：画板里是三个灰点加一行粗等宽小字。没有画面时地址是空的，
            // 那就不写地址 —— 写一个 `localhost:3000/login` 等于告诉人「这就是它现在看的页」。
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 9.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                repeat(3) {
                    Box(
                        modifier = Modifier
                            .size(7.dp)
                            .clip(CircleShape)
                            .background(palette.muted),
                    )
                }
                Spacer(Modifier.width(5.dp))
                val cwd = view?.takeIf { it.live }?.cwd.orEmpty()
                Text(
                    // 有快照时才写工作目录；没有就只说这是它的屏幕，不编一个路径。
                    cwd.ifBlank { "它的屏幕" },
                    fontSize = 10.5.sp,
                    color = palette.faint,
                    fontFamily = FontFamily.Monospace,
                )
            }
            // 实景那一行：它此刻在干什么 + 这段从几点开始。只照后端给的 activity 写（契约 §5.1），
            // 推不出来就整行不写 —— 不写「未知」，也不从下面的行自己算一遍。
            val live = view?.takeIf { it.live }
            val word = live?.let { screenActivityWord(it.activity, paused) }
            val since = live?.since.orEmpty()
            if (live != null && (word != null || since.isNotBlank())) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp).padding(bottom = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(7.dp),
                ) {
                    // 在跑才亮那颗点：灰点表示它现在没在动，「不动」不该画成「在动」。
                    val working = !paused && (live.activity == "running" || live.activity == "thinking")
                    Box(
                        modifier = Modifier
                            .size(6.dp)
                            .clip(CircleShape)
                            .background(if (working) palette.accent else palette.faint),
                    )
                    if (word != null) {
                        Text(word, fontSize = 11.5.sp, fontWeight = FontWeight(560), color = palette.ink)
                    }
                    if (since.isNotBlank()) {
                        Text("· 从 ${screenClock(since)} 起", fontSize = 11.sp, color = palette.faint)
                    }
                }
            }
            val lines = live?.lines.orEmpty()
            if (lines.isNotEmpty()) {
                // 活动快照：它刚跑了什么、输出了什么、说了什么。不是截帧，是那件事本身。
                //
                // 时分秒在这里按整列算一次，而不是每行在正文里现算：screenClock 里是
                // Instant.parse + 每次新建一个 DateTimeFormatter，一屏一百多行就是一百多次。
                // 颜色同理，按行的种类在查表里取，不在正文里写 when。
                val stamps = remember(lines) { lines.map { screenClock(it.at) } }
                Column(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth()
                        .background(palette.surface, RoundedCornerShape(10.dp))
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    lines.forEachIndexed { index, line ->
                        Text(
                            "${stamps[index]}  ${line.text}",
                            fontSize = 11.sp,
                            lineHeight = 16.sp,
                            fontFamily = FontFamily.Monospace,
                            color = when (line.kind) {
                                "command" -> palette.accent
                                "said" -> palette.muted
                                "status" -> palette.faint
                                else -> palette.ink
                            },
                        )
                    }
                    // 后端说还有多少条没变成行（认不出的类型、超出上限的旧记录）。有就写一句，
                    // 不把「没展开」悄悄吞掉，也不假装屏幕就这么点内容。
                    screenHiddenNote(live?.hidden ?: 0)?.let {
                        Text(it, fontSize = 10.5.sp, color = palette.hint)
                    }
                }
            } else {
                // 没有可显示的活动。后端说没有就写没有，读不到就写读不到 —— 两种都不是「在加载」。
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth()
                        .background(palette.surface, RoundedCornerShape(10.dp)),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        screenProblem ?: WorkspaceCopy.screenText(view?.reason),
                        fontSize = 13.sp,
                        color = palette.muted,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(horizontal = 18.dp),
                    )
                }
            }
        }

        // 底部：两个动作 + 一句约定 + 按下去之后的那行提示。
        Column(
            modifier = Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, top = 16.dp, bottom = 22.dp),
            verticalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                // 两个按钮现在都动真格。画板把「让它停一下」画成实心强调色；
                // 接口接上了，但一次请求没回来之前不让连点，所以忙碌时一并变淡。
                WorkspaceButton(WorkspaceAction.Takeover, palette, enabled = !busy) {
                    if (busy) return@WorkspaceButton
                    // 屏幕上显示的是哪张票，接手与暂停就作用在哪张票上：
                    // 从代码卡进来看的是这段改动所属的那张，不是这位 Bot 手上另一张。
                    val id = preview ?: ticket?.id
                    if (id == null) {
                        // 它手上没有在跑的票：没有可接的活，别假装接成功了。
                        touched = WorkspaceCopy.TAKEOVER_IDLE
                        return@WorkspaceButton
                    }
                    busy = true
                    scope.launch {
                        try {
                            client.takeover(id)
                            touched = WorkspaceCopy.TAKEOVER_DONE
                            // 停了之后重读：画面不该还写着「正在干活」。
                            reread()
                        } catch (error: Exception) {
                            touched = WorkspaceCopy.failed(error.message)
                        } finally {
                            busy = false
                        }
                    }
                }
                WorkspaceButton(WorkspaceAction.Pause, palette, enabled = !busy,
                    label = if (paused) "继续执行" else WorkspaceAction.Pause.label) {
                    if (busy) return@WorkspaceButton
                    val resuming = paused
                    busy = true
                    scope.launch {
                        try {
                            // 有票就带上票；没有票就全局停 —— 后端会如实回 scope。
                            if (resuming) {
                                client.resume()
                                onPausedChanged(false)
                                touched = "已继续执行（全局执行器）"
                            } else {
                                client.pause(preview ?: ticket?.id)
                                onPausedChanged(true)
                                touched = "已让它停一下（全局执行器）"
                            }
                            // 停完重读：画面顶上那一行要说「停住了」，不能还写着「正在干活」。
                            reread()
                        } catch (error: Exception) {
                            touched = WorkspaceCopy.failed(error.message)
                        } finally {
                            busy = false
                        }
                    }
                }
            }
            Text(
                WorkspaceCopy.TAKEOVER_NOTE,
                fontSize = 10.5.sp,
                color = palette.hint,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )
            // 结果如实写在原地：成功、没活儿、失败都要有下文，不闪一下就没。
            touched?.let {
                Text(
                    it,
                    fontSize = 11.sp,
                    color = palette.warn,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

/** 工作区底下的两个并排按钮。圆角 10、上下 11、字号 13，和画板一致。 */
@Composable
private fun RowScope.WorkspaceButton(
    action: WorkspaceAction,
    palette: CrewPalette,
    enabled: Boolean = true,
    label: String = action.label,
    onPress: (WorkspaceAction) -> Unit,
) {
    Box(
        modifier = Modifier
            .weight(1f)
            .background(palette.card, RoundedCornerShape(10.dp))
            .border(1.dp, palette.line, RoundedCornerShape(10.dp))
            .clickable(enabled = enabled) { onPress(action) }
            .defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
            .padding(vertical = 11.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, fontSize = 13.sp, color = if (enabled) palette.ink else palette.faint)
    }
}

/** 队伍页顶栏上的小方块按钮。画板里是 32dp、圆角 9、细边、强调色字形。 */
@Composable
private fun GlassIconButton(glyph: String, tint: Color, palette: CrewPalette, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .size(48.dp)
            .background(palette.card, RoundedCornerShape(9.dp))
            .border(1.dp, palette.line, RoundedCornerShape(9.dp))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(glyph, fontSize = 13.sp, color = tint)
    }
}

/**
 * 「后台」入口，右上角带未读角标（契约 §5.6）。
 *
 * 画板 Mobile.dc.html 第 39-41 行的原样：32dp、圆角 9、细边；角标是绝对定位在 `top:-4 right:-4`、
 * 最小 15 高、圆角 8、字号 9.5、赭色底（暗色下是更亮的赭 `#E0A574` 配深字）、左右 3 的内衬。
 * 这里按同一套数值换算成 dp/sp：15→15.dp、9.5sp、1dp 内衬，8.dp 圆角 —— 手机屏窄，
 * 角标挂在外面也不会把页头挤开，因为它画在按钮之上而不是排进 Row。
 *
 * `count` 为 null 表示算不出来，这时**不画角标**。画一个 0 就是在说「都读过了」，
 * 那是替网关说话；这一格只画有证据的数。
 */
@Composable
private fun BackendIconButton(tint: Color, count: Int?, palette: CrewPalette, onClick: () -> Unit) {
    Box(modifier = Modifier.size(48.dp)) {
        GlassIconButton(glyph = "后台", tint = tint, palette = palette, onClick = onClick)
        if (count != null && count > 0) {
            Box(
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .offset(x = 4.dp, y = (-4).dp)
                    // 两颗角的胶囊：画板是 min-width 15 / height 15 / radius 8。
                    .defaultMinSize(minWidth = 15.dp, minHeight = 15.dp)
                    .background(palette.warn, RoundedCornerShape(8.dp))
                    .padding(horizontal = 3.dp, vertical = 1.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    unreadBadge(count),
                    fontSize = 9.5.sp,
                    fontWeight = FontWeight(600),
                    // 赭色底上的字。画板亮色给的是白（#96603A 底 + #FFFFFF），暗色给的是深字
                    // （#E0A574 底 + #232228）：亮暗两套的赭不是一个明度档，字也不能共用一个值。
                    // onWarn 就是这个「压在赭色上当字」的颜色，见 CrewPalette。
                    color = palette.onWarn,
                )
            }
        }
    }
}

/**
 * 角标上的那点字：超过 99 说「99+」，不让徽标跟着条数一起变宽。
 *
 * 用 ASCII 的加号而不是中文「以上」：15dp 的胶囊里放不下三个字，
 * 而把胶囊撑开又会顶到旁边的按钮上。
 */
internal fun unreadBadge(count: Int): String = if (count > 99) "99+" else count.toString()

@Composable
private fun BackendScreen(
    client: CrewClient,
    conversation: Conversation?,
    palette: CrewPalette,
    onCrew: () -> Unit,
    onRefresh: () -> Unit,
    /** 「常规任务」：后台这一屏的常驻入口，与桌面端左栏那一项同一个位置。 */
    onRoutines: () -> Unit,
    /** 「记忆」：队伍的长期账本，与「常规任务」并排。 */
    onMemory: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    // 三档：进行中 / 待你 / 已完成。手机屏窄，标签放不下一排就换成可点的文字行。
    var tab by remember { mutableStateOf(0) }
    Column(modifier = Modifier.fillMaxSize().padding(horizontal = 14.dp, vertical = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("后台", fontSize = 15.sp, fontWeight = FontWeight(640), color = palette.ink)
            Box(modifier = Modifier.weight(1f))
            // 常规任务放在「队伍」旁边：这一屏本来就窄，多一个图标反而看不出是什么。
            // 它是一个独立的一屏，不是页签 —— 进去读一次，退回来还是后台这一档。
            // 桌面端它也是后台栏里的一项（nav.go 的 navRoutine），两边进的是同一件事。
            TextButton(onClick = onRoutines) { Text("常规任务", color = palette.accent) }
            TextButton(onClick = onMemory) { Text("记忆", color = palette.accent) }
            TextButton(onClick = onCrew) { Text("队伍", color = palette.accent) }
        }
        val allTickets = conversation?.tickets.orEmpty()
        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            for ((index, label) in listOf("进行中", "待你", "已完成").withIndex()) {
                Text(
                    label,
                    fontSize = 12.sp,
                    fontWeight = if (tab == index) FontWeight(600) else FontWeight.Normal,
                    color = if (tab == index) palette.ink else palette.faint,
                    modifier = Modifier.clickable { tab = index }
                        .defaultMinSize(minWidth = 48.dp, minHeight = 48.dp),
                )
            }
        }
        // needsPerson 是空串而不是 null（后端没给这个字段时 optString 返回 ""），
        // 所以判断「在等你」要看 isNotEmpty —— 写成 == null 会永远为 false，
        // 「进行中」那一栏因此全空。
        val tickets = allTickets.filter { ticket ->
            val waiting = ticket.needsPerson.isNotEmpty()
            when (tab) {
                // 页签归属由后端给的 open 决定，不按 state 的词猜：终态词表有五种。
                1 -> waiting
                2 -> !ticket.open
                else -> ticket.open && !waiting
            }
        }
        if (tickets.isEmpty()) {
            Text(
                if (allTickets.isEmpty()) "还没有工单。" else "这一栏还是空的。",
                color = palette.faint,
                modifier = Modifier.padding(vertical = 12.dp),
            )
            return@Column
        }
        for (ticket in tickets) {
            TaskRow(ticket, conversation, palette)
            if (ticket.retryable) {
                // 失败的票得有一条出路。失败原因要显示出来，不能悄悄吞掉。
                var trouble by remember(ticket.id) { mutableStateOf<String?>(null) }
                TextButton(onClick = {
                    scope.launch {
                        trouble = try {
                            client.retry(ticket.id)
                            null
                        } catch (error: Exception) {
                            error.message ?: "重试没成功"
                        }
                        onRefresh()
                    }
                }) { Text("重试", color = palette.accent, fontSize = 11.sp) }
                trouble?.let { Text(it, color = palette.danger, fontSize = 11.sp) }
            }
            // 点开才读：一屏十张票不该发十个请求。
            var open by remember(ticket.id) { mutableStateOf(false) }
            var steps by remember(ticket.id) { mutableStateOf<List<WorkStep>?>(null) }
            TextButton(onClick = {
                open = !open
                if (open && steps == null) {
                    scope.launch {
                        steps = runCatching { client.work(ticket.id) }.getOrNull()
                    }
                }
            }) {
                Text(if (open) "收起" else "看他怎么做", color = palette.accent, fontSize = 11.sp)
            }
            if (open) {
                val loaded = steps
                if (loaded == null) {
                    Text("读不到过程", color = palette.faint, fontSize = 11.sp)
                } else {
                    for (step in loaded) {
                        Text(
                            "· ${step.text}",
                            color = palette.muted,
                            fontSize = 11.sp,
                            modifier = Modifier.padding(start = 8.dp, bottom = 2.dp),
                        )
                    }
                }
            }
        }
    }
}

/**
 * 「常规任务」：主人写下的定时账本（契约 §5.5）。
 *
 * 三态分开说，一句都不能互相顶替：
 * - 还没读回来：说「正在读」；
 * - `live`：逐条列标题、周期、负责的 Bot、开关、上次 / 下次跑，底部一行「到点不会自己跑」；
 * - `empty`：读得到、确实一条都没有 —— 说「还没有常规任务」，并且同样说明它不会自己跑；
 * - `unavailable` / 请求失败：只说「读不到」，绝不借用「还没有」。
 *
 * 开关这一版只是显示：后端没有写接口，按下去看起来生效了就是撒谎。所以每一条的开关
 * 只写一个词（开着 / 关着），顶上还先写一句「只看不能按」。
 *
 * 进来读一次，不轮询：这一屏是账本，不是正在发生的事；返回再进来会重新读一遍
 * （组合项整个重建），下次跑的时间因此不会停在上一次。
 */
@Composable
private fun RoutineScreen(
    client: CrewClient,
    conversation: Conversation?,
    palette: CrewPalette,
    onBack: () -> Unit,
) {
    // null 表示还没读回来。读失败时 view 也是 null，另有 problem 说明为什么。
    var view by remember { mutableStateOf<RoutinesView?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    // 正在编辑的那条（null = 不编辑）；新增用一个空模板。
    var editing by remember { mutableStateOf<RoutineItem?>(null) }
    var adding by remember { mutableStateOf(false) }
    var writeError by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableStateOf(0) }

    suspend fun reread() {
        try {
            view = client.routines()
            problem = null
        } catch (error: Exception) {
            problem = error.message
        }
    }
    LaunchedEffect(reload) { reread() }

    // 写一次（新增 / 修改 / 删除）；成功就关面板并重读，失败把后端那句原因留下。
    fun write(run: suspend () -> Unit) {
        scope.launch {
            try {
                run()
                editing = null
                adding = false
                writeError = null
                reload += 1
            } catch (error: Exception) {
                writeError = error.message
            }
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier.fillMaxWidth().background(palette.card)
                .padding(start = 6.dp, end = 18.dp, top = 10.dp, bottom = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // 退回后台：这一屏就是从那里进来的，回去还是那一档。
            TextButton(onClick = onBack) { Text("返回", color = palette.accent) }
            Text("常规任务", fontSize = 20.sp, fontWeight = FontWeight(660), color = palette.ink)
            Spacer(Modifier.weight(1f))
            TextButton(onClick = { adding = true; editing = null; writeError = null }) { Text(RoutinesCopy.ADD, color = palette.accent) }
        }
        Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(palette.line))

        val loaded = view
        if (loaded == null) {
            // 读失败先说读失败：那时说「正在读」是句假话，说「还没有」是编的。
            val unreadable = problem != null
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp)
                    .background(palette.card, RoundedCornerShape(10.dp))
                    .border(1.dp, palette.line, RoundedCornerShape(10.dp))
                    .padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(
                    if (unreadable) RoutinesCopy.UNREADABLE_TITLE else RoutinesCopy.READING,
                    fontSize = 14.sp,
                    fontWeight = FontWeight(600),
                    color = palette.muted,
                )
                // 请求失败时带上队伍那句话（可能是 401、503），原样写出来，不粉饰成「读不到」。
                if (unreadable) {
                    Text(
                        problem ?: RoutinesCopy.UNREADABLE_BODY,
                        fontSize = 12.sp,
                        lineHeight = 19.sp,
                        color = palette.danger,
                    )
                }
            }
            return@Column
        }

        if (!loaded.live || loaded.items.isEmpty()) {
            // empty 与 unavailable 都落在这里，但说的不是同一句话。
            val unreadable = !loaded.live
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp)
                    .background(palette.card, RoundedCornerShape(10.dp))
                    .border(1.dp, palette.line, RoundedCornerShape(10.dp))
                    .padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(
                    if (unreadable) RoutinesCopy.UNREADABLE_TITLE else RoutinesCopy.EMPTY_TITLE,
                    fontSize = 14.sp,
                    fontWeight = FontWeight(600),
                    color = palette.muted,
                )
                // 后端给了原因就写它那一句；没给才落到这两句各自的兜底，不自己编一个理由。
                Text(
                    when {
                        unreadable -> loaded.reason.ifBlank { RoutinesCopy.UNREADABLE_BODY }
                        else -> RoutinesCopy.EMPTY_BODY
                    },
                    fontSize = 12.sp,
                    lineHeight = 19.sp,
                    color = palette.faint,
                )
                if (!unreadable) {
                    // 空态更要说清它不会自己跑：让人以为写着就会跑，比空着更糟。
                    Text(RoutinesCopy.NO_SCHEDULER, fontSize = 11.sp, color = palette.faint)
                }
            }
            return@Column
        }

        // 栏头小结：用后端给的 counts，不自己再数一遍。
        val summary = RoutinesCopy.summary(loaded)
        if (summary.isNotEmpty()) {
            Text(
                summary,
                fontSize = 11.sp,
                color = palette.faint,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
        }
        // 先把「开关按不动」说在前面：等按了几下才发现它只是个显示，比一开始就说清楚更伤人。
        Text(
            RoutinesCopy.EDITABLE,
            fontSize = 11.sp,
            color = palette.hint,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 2.dp),
        )
        LazyColumn(
            modifier = Modifier.weight(1f),
            contentPadding = PaddingValues(horizontal = 14.dp, vertical = 4.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(loaded.items, key = { it.id }) { item ->
                RoutineRow(item, conversation, palette, onClick = { editing = item; adding = false; writeError = null })
            }
        }
        // 脚注钉在列表下面，不滚走：账本有一百条的时候，「到点不会自己跑」这句话
        // 也不该跟着滚出屏幕 —— 它说的不是某一条，是整本账的性质。
        // 与桌面端 routinesPane 末尾那行同一句、同一个位置（清单之后）。
        RoutinesCopy.footnote(loaded)?.let { line ->
            Text(
                line,
                fontSize = 11.sp,
                lineHeight = 17.sp,
                color = palette.faint,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
            )
        }
    }

    // 编辑浮层：新增或改一条。盖在整屏上，点「保存」才发请求，成功后关掉并重读。
    val target = editing
    if (adding || target != null) {
        RoutineEditor(
            existing = target,
            bots = conversation?.bots.orEmpty(),
            error = writeError,
            palette = palette,
            onCancel = { adding = false; editing = null; writeError = null },
            onSave = { title, cycle, botId, enabled ->
                if (target != null) write { client.editRoutine(target.id, title, cycle, botId, enabled) }
                else write { client.createRoutine(title, cycle, botId, enabled) }
            },
            onRemove = target?.let { { write { client.removeRoutine(it.id) } } },
        )
    }
}

/**
 * 增 / 改一条常规任务的浮层。与「改人设」同一套排版：标题、周期三选一、负责人可空、开关。
 *
 * 保存与删都走 POST（Connection 只认 GET/POST，PUT/DELETE 到不了插件，早先就是这么静默失败的）。
 * 后端校验不通过时把那一句原因原样显示在这里，不在客户端猜。
 */
@Composable
private fun RoutineEditor(
    existing: RoutineItem?,
    bots: List<BotCard>,
    error: String?,
    palette: CrewPalette,
    onCancel: () -> Unit,
    onSave: (title: String, cycle: String, botId: String, enabled: Boolean) -> Unit,
    onRemove: (() -> Unit)?,
) {
    var title by remember { mutableStateOf(existing?.title ?: "") }
    var cycle by remember { mutableStateOf(existing?.cycle ?: "daily") }
    var botId by remember { mutableStateOf(existing?.botId ?: "") }
    var enabled by remember { mutableStateOf(existing?.enabled ?: true) }
    Box(
        modifier = Modifier.fillMaxSize().background(palette.ink.copy(alpha = 0.4f)).clickable(onClick = onCancel),
        contentAlignment = Alignment.Center,
    ) {
        // 内层再吃掉点击，免得点面板本体也把浮层关掉。
        Column(
            modifier = Modifier
                .widthIn(max = 420.dp)
                .fillMaxWidth(0.9f)
                .background(palette.card, RoundedCornerShape(12.dp))
                .border(1.dp, palette.line, RoundedCornerShape(12.dp))
                .padding(18.dp)
                .clickable(enabled = false) {},
            verticalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            Text(if (existing == null) "新增常规任务" else "改这条常规任务", fontSize = 17.sp, fontWeight = FontWeight(660), color = palette.ink)

            Text("标题", fontSize = 11.sp, color = palette.faint)
            OutlinedTextField(
                value = title, onValueChange = { title = it }, singleLine = true,
                textStyle = androidx.compose.ui.text.TextStyle(fontSize = 15.sp, color = palette.ink),
                shape = RoundedCornerShape(9.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedContainerColor = palette.surface, unfocusedContainerColor = palette.surface,
                    focusedBorderColor = palette.accent, unfocusedBorderColor = palette.line,
                    focusedTextColor = palette.ink, unfocusedTextColor = palette.ink, cursorColor = palette.accent,
                ),
                modifier = Modifier.fillMaxWidth(),
            )

            Text("周期", fontSize = 11.sp, color = palette.faint)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                RoutinesWrite.CYCLES.forEach { value ->
                    val picked = cycle == value
                    TextButton(onClick = { cycle = value }) {
                        Text(
                            RoutinesCopy.cycleName(value),
                            color = if (picked) palette.surface else palette.muted,
                            fontSize = 13.sp,
                            modifier = Modifier.background(
                                if (picked) palette.accent else palette.surface,
                                RoundedCornerShape(8.dp),
                            ).padding(horizontal = 10.dp, vertical = 6.dp),
                        )
                    }
                }
            }

            Text("谁负责（可空 = 谁有空谁接）", fontSize = 11.sp, color = palette.faint)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = { botId = "" }) {
                    Text("谁有空", fontSize = 12.5.sp, color = if (botId.isBlank()) palette.accent else palette.muted)
                }
                bots.forEach { bot ->
                    TextButton(onClick = { botId = bot.id }) {
                        Text(bot.name.ifBlank { bot.id }, fontSize = 12.5.sp, color = if (botId == bot.id) palette.accent else palette.muted)
                    }
                }
            }

            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("状态", fontSize = 11.sp, color = palette.faint)
                TextButton(onClick = { enabled = !enabled }) {
                    Text(RoutinesCopy.switchName(enabled), color = if (enabled) palette.accent else palette.muted,
                        fontSize = 13.sp,
                        modifier = Modifier.background(
                            if (enabled) palette.accentSoft else palette.surface, RoundedCornerShape(8.dp),
                        ).padding(horizontal = 10.dp, vertical = 6.dp))
                }
            }

            if (error != null) {
                Text(error, fontSize = 12.sp, lineHeight = 18.sp, color = palette.danger)
            }

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                if (onRemove != null) {
                    TextButton(onClick = onRemove) { Text("删掉", color = palette.danger) }
                }
                Spacer(Modifier.weight(1f))
                TextButton(onClick = onCancel) { Text("取消", color = palette.muted) }
                Button(onClick = { onSave(title.trim(), cycle, botId, enabled) }, enabled = title.isNotBlank()) {
                    Text("保存")
                }
            }
        }
    }
}

/**
 * 账本里的一条：标题（带逾期标记）、周期 · 谁负责 · 开关、上次 / 下次。
 *
 * 「上次跑」没有就写「还没跑过」，不填日期；关着的那条不说「下一次」，逾期也只对开着的说。
 * 开关写成一个词（开着 / 关着），不是开关控件：这一版没有写接口，
 * 画一个能拨的形状就是在许一个空诺 —— 拨过去什么也不会发生。
 */
@Composable
private fun RoutineRow(item: RoutineItem, conversation: Conversation?, palette: CrewPalette, onClick: () -> Unit = {}) {
    // 负责人的名字优先用花名册上的；不在花名册（或没这个人）时把 id 原样写出来，不空着。
    val botName = conversation?.bots?.firstOrNull { it.id == item.botId }?.name.orEmpty()
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(palette.card, RoundedCornerShape(10.dp))
            .border(1.dp, palette.line, RoundedCornerShape(10.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 11.dp, vertical = 9.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                item.title,
                fontSize = 13.sp,
                fontWeight = FontWeight(600),
                color = palette.ink,
                maxLines = 1,
                modifier = Modifier.weight(1f),
            )
            // 逾期只说开着的那条：关掉的账不算「该跑了」，那是替它安排了一件不会发生的事。
            if (item.overdue && item.enabled) {
                Text("逾期", fontSize = 10.5.sp, color = palette.warn)
            }
            Text(
                RoutinesCopy.switchName(item.enabled),
                fontSize = 10.5.sp,
                color = if (item.enabled) palette.accent else palette.faint,
            )
        }
        Text(
            RoutinesCopy.detailLine(item, botName),
            fontSize = 11.sp,
            color = palette.muted,
            maxLines = 1,
        )
        val whens = RoutinesCopy.whenLine(
            RoutinesCopy.lastRunLine(item.lastRun),
            RoutinesCopy.nextRunLine(item),
        )
        if (whens.isNotEmpty()) {
            Text(whens, fontSize = 11.sp, color = palette.faint, maxLines = 1)
        }
    }
}

/**
 * 「记忆」：队伍长期记得什么 —— 主人能看、能改、能忘。
 *
 * 三态和「常规任务」同一套：读不到说读不到，读得到但没有说还没有，
 * 只有 `live` 才逐条画。忘掉不删行，所以忘过的条目仍留在账本里，
 * 只是不再进它下一次开口时的上下文。
 *
 * 与桌面端记忆栏同一份契约（`GET/POST /api/mobile/memory`），同一句小结。
 */
@Composable
private fun MemoryScreen(
    client: CrewClient,
    palette: CrewPalette,
    onBack: () -> Unit,
) {
    // null 表示还没读回来。读失败时 view 也是 null，另有 problem 说明为什么。
    var view by remember { mutableStateOf<MemoryView?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableStateOf(0) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(reload) {
        view = null
        problem = null
        try {
            view = client.memory()
        } catch (error: Exception) {
            if (error !is CancellationException) problem = error.message
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier.fillMaxWidth().background(palette.card)
                .padding(start = 6.dp, end = 18.dp, top = 10.dp, bottom = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextButton(onClick = onBack) { Text("返回", color = palette.accent) }
            Text("记忆", fontSize = 20.sp, fontWeight = FontWeight(660), color = palette.ink)
            Spacer(Modifier.weight(1f))
            TextButton(onClick = { reload += 1 }) { Text("重读", color = palette.accent) }
        }
        Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(palette.line))

        val loaded = view
        if (loaded == null) {
            // 读失败先说读失败：那时说「正在读」是句假话，说「还没有」是编的。
            val unreadable = problem != null
            Column(
                modifier = Modifier.fillMaxWidth().padding(16.dp)
                    .background(palette.card, RoundedCornerShape(10.dp))
                    .border(1.dp, palette.line, RoundedCornerShape(10.dp))
                    .padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(
                    if (unreadable) MemoryCopy.UNREADABLE_TITLE else MemoryCopy.READING,
                    fontSize = 14.sp,
                    fontWeight = FontWeight(600),
                    color = palette.muted,
                )
                if (unreadable) {
                    // 队伍那句话原样写出来：可能是 401、也可能是 503，不粉饰成「读不到」。
                    Text(problem ?: MemoryCopy.UNREADABLE_BODY, fontSize = 12.sp, lineHeight = 19.sp, color = palette.danger)
                }
            }
            return@Column
        }

        if (!loaded.live || loaded.items.isEmpty()) {
            val unreadable = !loaded.live
            Column(
                modifier = Modifier.fillMaxWidth().padding(16.dp)
                    .background(palette.card, RoundedCornerShape(10.dp))
                    .border(1.dp, palette.line, RoundedCornerShape(10.dp))
                    .padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(
                    if (unreadable) MemoryCopy.UNREADABLE_TITLE else MemoryCopy.EMPTY_TITLE,
                    fontSize = 14.sp,
                    fontWeight = FontWeight(600),
                    color = palette.muted,
                )
                Text(
                    when {
                        unreadable -> loaded.reason.ifBlank { MemoryCopy.UNREADABLE_BODY }
                        else -> MemoryCopy.EMPTY_BODY
                    },
                    fontSize = 12.sp, lineHeight = 19.sp, color = palette.faint,
                )
            }
            return@Column
        }

        Text(
            MemoryCopy.summary(loaded),
            fontSize = 11.sp,
            color = palette.faint,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
        )
        LazyColumn(
            modifier = Modifier.weight(1f),
            contentPadding = PaddingValues(horizontal = 14.dp, vertical = 4.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(loaded.items, key = { it.name }) { item ->
                MemoryRow(
                    item = item,
                    palette = palette,
                    onForget = {
                        scope.launch {
                            try {
                                client.forgetMemory(item.name)
                                reload += 1
                            } catch (error: CancellationException) {
                                throw error
                            } catch (error: Exception) {
                                problem = error.message
                            }
                        }
                    },
                )
            }
        }
        // 脚注钉在列表下面：它说的不是某一条，是整本账的性质。
        Text(
            MemoryCopy.LIVE_ONLY,
            fontSize = 11.sp,
            lineHeight = 17.sp,
            color = palette.faint,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
        )
    }
}

/**
 * 账本里的一条：标题、正文首段、谁记得 · 来源 · 何时，以及「忘掉」。
 *
 * 忘掉的条目整行压暗并标一个「已忘掉」：它们仍在账本里（不删行），
 * 但不再进它下次开口时的上下文 —— 这一点必须看得见，否则「忘了没忘」没人说得清。
 */
@Composable
private fun MemoryRow(item: MemoryItem, palette: CrewPalette, onForget: () -> Unit) {
    var confirm by remember(item.name) { mutableStateOf(false) }
    val faded = !item.active
    Column(
        modifier = Modifier.fillMaxWidth()
            .background(palette.card, RoundedCornerShape(10.dp))
            .border(1.dp, palette.line, RoundedCornerShape(10.dp))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                MemoryCopy.title(item),
                fontSize = 13.sp,
                fontWeight = FontWeight(620),
                color = if (faded) palette.faint else palette.ink,
                modifier = Modifier.weight(1f),
            )
            if (!item.active) {
                Text("已忘掉", fontSize = 10.sp, color = palette.faint)
            }
        }
        // 正文只取第一段：这一条是给主人确认用的，不是让人读文档。
        val body = item.body.split(Regex("\\n\\s*\\n")).firstOrNull()?.trim().orEmpty()
        if (body.isNotEmpty()) {
            Text(
                body,
                fontSize = 12.sp,
                lineHeight = 18.sp,
                color = if (faded) palette.faint else palette.muted,
                maxLines = 4,
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(MemoryCopy.detail(item), fontSize = 11.sp, color = palette.faint, maxLines = 1, modifier = Modifier.weight(1f))
            if (item.active) {
                // 两步：忘掉是不可撤销的（不删行、但不再用），点一下就该生效。
                TextButton(onClick = { if (confirm) onForget() else confirm = true }) {
                    Text(if (confirm) "确认忘掉？" else "忘掉", fontSize = 11.sp,
                        color = if (confirm) palette.danger else palette.accent)
                }
            }
        }
    }
}

/**
 * 「等你决定」：赭色细边 + 暖白底，问题下面是后端随问题一起下发的 A/B。
 *
 * 点一下就直接答，不经过输入框 —— 画板上那两个按钮是「直接答」，
 * 多一步「再按发送」就不像在回答了。选项只是呈现，不是审批：回答走的是
 * 已有的 POST /send，text 里带上选中的 label，并点名在等的那位 Bot（契约 §5）。
 *
 * 三条规矩都落在这一处：
 * - 后端没给 options 就一个选项都不画，也不把 question 拆成选项；
 * - 防连点：正在发的那一格换成 ✓ 且不再接第二下；
 * - 回执只写在这张卡自己的问题下：问题的文本或选项一变，旧的另存为作废。
 */
@Composable
private fun TicketStrip(
    conversation: Conversation,
    palette: CrewPalette,
    client: CrewClient,
    /**
     * 「自己写一句」：把这句在等的人带进输入框，省得人再想上下文。
     * 只补一个 `@名字 `，不替人写字，也不覆盖已经写了一半的草稿（与桌面端同一条规矩）。
     */
    onPrefill: (String) -> Unit,
    onSent: () -> Unit,
    /** 这张卡上的回答发到哪一格；发起时固定，不跟着切会话变。 */
    sessionId: String? = null,
) {
    // 对话里只露一张「等你决定」，其余在后台里看。
    val waiting = conversation.tickets.firstOrNull { it.needsPerson.isNotEmpty() } ?: return
    // 这一组问题就是这张卡的身份：换了问题或换了选项，下面两行状态一起作废
    // （契约 §5：后台重新下发整组 options，旧的一组随即作废，前端不缓存旧选项）。
    val signature = CrewWire.answerSignature(waiting)
    // 正在发的那几个选项，键是「票号|选项 id」：挡住连点，也让那一行在发着的时候换成 ✓。
    var answering by remember(waiting.id, signature) { mutableStateOf(emptySet<String>()) }
    // 这张卡自己的结果。答的是上一道题，就不写在新问题下面。
    var note by remember(waiting.id, signature) { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val botName = conversation.bots.firstOrNull { it.id == waiting.botId }?.name?.trim().orEmpty()
    // 点名用名字：手机上人认的是名片上那两个字。这一位不在花名册上（或名字空着）时退回 id ——
    // 与桌面端 nameOf 同一条规矩：宁可 @ 一个 id，也不能把回答滑给默认那位。
    val address = botName.ifEmpty { waiting.botId.trim() }
    fun addressed(text: String) = if (address.isEmpty()) text else "@$address $text"

    // 画板：赭色细边 + 暖白底 + 圆角 10。白底会让这张最该被看见的卡
    // 和普通工单卡长得一样，而它要的是「现在只有这一件事等你」。
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 47.dp, end = 14.dp)
            .background(palette.warmBase, RoundedCornerShape(10.dp))
            .border(1.dp, palette.warnEdge, RoundedCornerShape(10.dp))
            .padding(11.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("◷", color = palette.warn, fontSize = 11.sp)
            Text("等你决定", color = palette.warn, fontSize = 11.sp, fontWeight = FontWeight(620))
        }
        // 有 question 就读 question；没有（delivery / review / blocked / failed 这几种「等你」）
        // 才退回 needs_person 的人话 —— 绝不补一个空问题。
        Text(AnswerCopy.body(waiting), color = palette.ink, fontSize = 13.sp, lineHeight = 20.sp)
        // A/B：每个选项一行，左边一个序号，点一下直接答。没有选项时这一整段不画。
        waiting.options.forEachIndexed { index, option ->
            val slot = CrewWire.answerSlot(waiting.id, option.id)
            val sending = slot in answering
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(palette.card, RoundedCornerShape(8.dp))
                    .border(1.dp, palette.warnEdge, RoundedCornerShape(8.dp))
                    // 发着的那一格不再接第二下：按下去没反应比按了有效果更让人以为坏了，
                    // 所以它的样子会换成 ✓，而不是装作还能点。
                    .clickable(enabled = !sending) {
                        answering = answering + slot
                        note = null
                        val text = addressed(option.label)
                        scope.launch {
                            try {
                                client.send(
                                    text,
                                    CrewWire.mentionsIn(text, conversation.bots),
                                    java.util.UUID.randomUUID().toString(),
                                    sessionId,
                                )
                                note = AnswerCopy.ANSWER_DONE
                                // 重读时间线：答完之后这张卡要么消失，要么换成下一道题。
                                onSent()
                            } catch (error: Exception) {
                                // 失败写在这张卡自己的结果行里，不冒充断连横幅。
                                note = AnswerCopy.answerFailed(error.message)
                            } finally {
                                answering = answering - slot
                            }
                        }
                    }
                    .defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
                    .padding(horizontal = 11.dp, vertical = 9.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    if (sending) "✓" else AnswerCopy.optionMark(index),
                    color = palette.accent,
                    fontSize = 13.sp,
                    fontWeight = FontWeight(620),
                )
                Text(option.label, color = palette.ink, fontSize = 13.sp, lineHeight = 19.sp)
            }
        }
        // 只在这张卡自己答过之后说一句：两张待决的卡并排时，A 的结果不该写到 B 上。
        note?.let {
            Text(it, color = palette.faint, fontSize = 10.5.sp, lineHeight = 16.sp)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            Box(
                modifier = Modifier
                    .weight(1f)
                    .height(48.dp)
                    .background(palette.card, RoundedCornerShape(8.dp))
                    .border(1.dp, palette.warnEdge, RoundedCornerShape(8.dp))
                    // 点它 = 把这句在等的人带进输入框，省得人再想上下文。
                    .clickable { onPrefill(address) }
                    .padding(horizontal = 11.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                Text("自己写一句…", color = palette.hint, fontSize = 11.5.sp)
            }
            Box(
                modifier = Modifier
                    .size(48.dp)
                    .background(palette.warn, RoundedCornerShape(8.dp))
                    .clickable { onPrefill(address) },
                contentAlignment = Alignment.Center,
            ) {
                Text("回", color = palette.onWarn, fontSize = 11.5.sp)
            }
        }
    }
}

@Composable
private fun TaskRow(ticket: WorkTicket, conversation: Conversation?, palette: CrewPalette) {
    val tint = when {
        ticket.needsPerson.isNotEmpty() -> palette.warn
        ticket.state == "failed" -> palette.danger
        else -> palette.ink
    }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 5.dp)
            .background(palette.card, RoundedCornerShape(10.dp))
            .padding(11.dp),
    ) {
        Text(ticket.title, color = tint, fontSize = 13.sp)
        val owner = conversation?.bots?.firstOrNull { it.id == ticket.botId }?.name ?: ticket.botId
        // 第几步接在状态行的末尾；空段（没 plan / 没 bot_id）不拼，规则见 CrewWire.ticketDetail。
        val detail = ticketDetail(stateWord(ticket.state), owner, stepOf(ticket))
        Text(detail, color = palette.muted, fontSize = 11.sp)
        // 进度条：只在后端给了计划（total_steps > 0）时画，与桌面端 ui.go 的 progressOf 同一口径 ——
        // 分母来自计划，不拿读到的条数顶替。没有计划就空着，不画一根永远停在 100% 的假条。
        // 零步走完时只画轨道：宽度 0 的填充在某些引擎上仍会留下一个点。
        val (done, total) = progressOf(ticket)
        if (total > 0) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 6.dp)
                    .height(3.dp)
                    .background(palette.track, RoundedCornerShape(2.dp)),
            ) {
                if (done > 0) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth(done.toFloat() / total.toFloat())
                            .height(3.dp)
                            .background(palette.accent, RoundedCornerShape(2.dp)),
                    )
                }
            }
        }
        if (ticket.needsPerson.isNotEmpty()) {
            // needs_person 存的是类别（answer / review / …），直接画出来是个英文单词。
            Text(
                ticket.question.ifBlank { AnswerCopy.waitingWord(ticket.needsPerson) },
                color = palette.warn,
                fontSize = 11.sp,
            )
        }
    }
}

private fun stateWord(state: String): String = when (state) {
    // 进行中：后端给的是 stage（working / person / idle），不是 work/done。
    "work", "working" -> "在做"
    "person" -> "等你"
    "idle" -> "闲着"
    "failed" -> "失败"
    // 终态：ticket.ended.outcome 有五种。
    "completed" -> "已完成"
    "merged" -> "已合并"
    "closed" -> "已关闭"
    "dropped" -> "已放弃"
    "stopped" -> "已停止"
    "done" -> "已完成"
    else -> "在做"
}

/** 子代理卡：一出现就去读树（表头要报数），点开只是把明细放出来。子代理还能再分子代理，所以按层缩进展开。 */
@Composable
private fun SubagentCard(
    client: CrewClient,
    ticketId: String,
    /** 按票的树缓存（见 AgentsCache）。由上层持有，切屏回来时那一份还在。 */
    cache: AgentsCache,
    /** 这一轮时间线的代号：变了就重读一次，队伍派了新的人也看得见。 */
    generation: Int,
    palette: CrewPalette,
) {
    var open by remember(ticketId) { mutableStateOf(false) }
    var trouble by remember(ticketId) { mutableStateOf<String?>(null) }
    // 重试：读不到的那一轮记在缓存里、不会自己再发请求，得有人把这一轮的记号清掉。
    var retry by remember(ticketId) { mutableStateOf(0) }
    // 树本身从缓存来。它不是 Compose 的状态，读回来之后靠这枚记号重画这一格。
    // 表头那两行（「N 个子代理」/「x 在跑 · y 已完成」）从头到尾都是同一档字号的两行，
    // 有没有数据都不变高，所以读回来不会推动列表。
    var tick by remember(ticketId) { mutableStateOf(0) }
    val nodes = remember(ticketId, generation, tick, retry) { cache.get(ticketId, generation) }

    // 表头要显示「2 个子代理 · 1 在跑」，所以一出现就得去读，不用等点开。
    // 收起只是收起明细，摘要一直在。
    //
    // 这里只留这一处读取：从前点开时还抄了一份一模一样的请求，两边各发一遍
    // —— 表头那趟还没回来就点开，会同时飞出去两个 /agents。
    // 点开时要做的只是等这一趟：它回来时 tick 变了，卡自己会重画。
    LaunchedEffect(ticketId, generation, retry) {
        // start 同时挡住并发：同一张票在这一轮里已经有人发了请求，就不再发第二个。
        // 按过「重试」时先放掉上一轮「读不到」的记号，再照常走一遍。
        if (retry > 0) cache.forget(ticketId)
        if (!cache.start(ticketId, generation)) return@LaunchedEffect
        trouble = null
        try {
            cache.finish(ticketId, client.agents(ticketId), generation)
            tick += 1
        } catch (error: CancellationException) {
            // 这一格被组合带走了：不是「读不到」，别把取消写成一句错误。
            // 交还给缓存，切回来时还会再读一次。
            cache.abandon(ticketId, generation)
            throw error
        } catch (error: Exception) {
            // 读不到也记一笔：同一轮里不再重发。trouble 只写在这一张卡上。
            cache.finish(ticketId, null, generation)
            tick += 1
            trouble = error.message
        }
    }

    // 与消息同一列：消息行左边距 14 + 头像 25 + 间距 8 = 47，右边 14。
    // 卡自己不再加内边距式的 Padding(13)，那会让表头比正文还缩进 —— 画板里
    // 表头与正文同一条左基线。
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 47.dp, end = 14.dp)
            .background(palette.card, RoundedCornerShape(10.dp))
            .border(1.dp, palette.line, RoundedCornerShape(10.dp)),
    ) {
        // 表头：左「N 个子代理」，右「x 在跑 · y 已完成」。
        // 收起时也显示 —— 空的按钮块占着一大片白，比没有更难看。
        // 点开只改这一枚 open：读取是上面那趟 LaunchedEffect 的事，这里不再发第二个请求。
        Row(
            modifier = Modifier.fillMaxWidth().clickable {
                open = !open
            }.defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val total = nodes?.let { countAgents(it) }
            // 后端目前只发 working；终态集合留给以后。递归数，否则嵌套节点会被算成已完成。
            val running = nodes?.let { countRunning(it) } ?: 0
            // 画板：左边一个 22×22 的淡绿方块图标，再是「N 个子代理 / x 在跑 · y 已完成」两行。
            // 一行文字块看不出「这里能点开」，方块图标给了它一个可点的形状。
            Box(
                modifier = Modifier
                    .size(22.dp)
                    .background(palette.accentSoft, RoundedCornerShape(7.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Text("⑂", fontSize = 11.sp, color = palette.accent)
            }
            Spacer(Modifier.width(9.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    if (total == null) "子代理" else "%d 个子代理".format(total),
                    fontSize = 12.5.sp, fontWeight = FontWeight(550), color = palette.ink,
                )
                Text(
                    when {
                        total == null -> if (open) "读着…" else "点开看"
                        else -> "%d 在跑 · %d 已完成".format(running, total - running)
                    },
                    fontSize = 11.sp, color = palette.faint,
                )
            }
            Text(if (open) "‹" else "›", fontSize = 13.sp, color = palette.faint)
        }
        trouble?.let {
            Spacer(Modifier.height(6.dp))
            Text(it, color = palette.danger, fontSize = 11.sp)
            // 读不到得有一条出路：按一下，重读一次这一张票的树。
            // 缓存里「这一轮读不到」的记号先清掉，否则下面那趟 LaunchedEffect 会当它已经读过。
            TextButton(onClick = { retry += 1 }) {
                Text("重试", color = palette.accent, fontSize = 11.sp)
            }
        }
        if (open) {
            // 树还没回来：先按一行分支的高度占住（与 AgentBranch 同字号、同 2dp 上边距），
            // 回来时只是把这一处换成真名，卡的上沿不再爬 —— 它挂在消息列表末尾，
            // 一变高就把上面所有东西顶走一下，正滑着就是一次顿挫。
            // 真有几行是读回来才知道的，那一下的增高属于数据本身；靠「出现就去读」
            // 把它压在人还没滑到这里的时候（见上面那趟 LaunchedEffect）。
            if (nodes == null) {
                // 和 AgentBranch 同一档字号、同一处内衬：读回来只是把这一行换成真名。
                Text("· 读着…", fontSize = 11.sp, color = palette.faint,
                    modifier = Modifier.padding(start = 12.dp, top = 2.dp))
            }
            nodes?.forEach { AgentBranch(it, 0, palette) }
        }
        // 收起时不占位，也不做动画：表头那两行（「N 个子代理」/「点开看」或
        // 「x 在跑 · y 已完成」）无论读没读回来都是同一档字号的两行，读回来不会
        // 让这张卡变高或变矮，本来就不会推动列表。真有变动的是点开之后树长出来，
        // 那一下是人自己点的，跟着动是对的 —— 不拿动画把用户的点击拖慢。
    }
}

/**
 * 代码卡里一段文字该用什么颜色。与桌面端 `codeSegments` 三套配色的关系一一对应：
 *
 * - 上下文行：普通文字暖灰（faint），值是赭色（warn）—— 画板 `gap: <span>12px</span>;`
 *   那一段。数字与字符串都算「值」，所以都染赭色。
 * - 注释：跟普通文字同一个颜色。认注释不是为了把它染成另一种颜色，而是为了
 *   **别把注释里的数字当成值**：`// 等 2 秒` 里的 2 不是这段改动要改的东西。
 *   桌面端 `codeSegments` 就是这么做的（注释落在 base 上）—— 两端不这么做，
 *   同一行代码在两边看起来会不一样。
 * - 新增行 / 删除行：整行一个颜色（accent / warn）。这两种行的 kind 在
 *   [CodeSyntax.segments] 里已经合成一整段，所以这里只会被问到 Plain，
 *   落到行类别那一支上就是整行同色。
 */
private fun codeColor(kind: CodeSyntax.Kind, lineKind: String, palette: CrewPalette): Color = when (lineKind) {
    "added" -> palette.accent
    "removed" -> palette.warn
    else -> when (kind) {
        CodeSyntax.Kind.Number, CodeSyntax.Kind.Quoted -> palette.warn
        // 注释与普通文字同色：见上，认注释只是为了不让里面的数字冒充「值」。
        CodeSyntax.Kind.Comment, CodeSyntax.Kind.Plain -> palette.faint
    }
}

/**
 * 消息里带的代码片段：文件名 + 增删统计，逐行标出新增/删除，下面挂两个按钮。
 *
 * 画板里整行浅绿底表示新增、整行浅橙底表示删除，`+` / `-` 跟在行首。
 * 只给号着色是不够的 —— 一屏代码里看不出改了哪几行。
 *
 * 两个按钮都不新开后端接口（契约 §5）：
 * - **采用**：不是把这几行写回工作区（宿主机上没有这条通道，前台也不该绕过 worker
 *   去动它的工作目录），而是一次表态 —— 走已有的 POST /send 发一句普通消息，
 *   点名写这段的那位 Bot。因此幂等、排队、撤回、错误码都按那条消息算。
 * - **看看改完的样子**：走已有的 GET /api/mobile/screen?ticket=…，读这张工单的活动快照。
 *   没有票号时只如实说看不了，**绝不拿别的票顶替**。
 *
 * 两件事都得先说清「对谁做」：没有署名对象时按钮照样在，按下去得到的是一句实话，
 * 而不是静默不动。
 */
@Composable
private fun CodeCard(
    block: CodeBlock,
    botId: String?,
    botName: String?,
    /** 花名册：「采用」那句话要点名，mentions 得从这句里认出来，路由才确定落在那位身上。 */
    bots: List<BotCard>,
    palette: CrewPalette,
    client: CrewClient,
    /** 拿到快照之后交给上层：手机上没有桌面端那块常驻画面区，去看它的屏幕最顺。 */
    onScreen: (String, ScreenView) -> Unit,
    /** 「采用」那句话发到哪一格。 */
    sessionId: String? = null,
) {
    // 卡的身份。key 由解析层给（后端的 id，或缺省时拼的「票号|文件名」）——
    // 同一段对话里并排两张卡时，「采用中 / 已采用」与回执都按它各记各的，不串台。
    var adopting by remember(block.id) { mutableStateOf(false) }
    var adopted by remember(block.id) { mutableStateOf(false) }
    var checking by remember(block.id) { mutableStateOf(false) }
    // 只有这一张卡自己的结果，绝不冒充顶部的断连横幅。
    var note by remember(block.id) { mutableStateOf<String?>(null) }
    var noteIsFailure by remember(block.id) { mutableStateOf(false) }
    // 「看看改完的样子」拿到了但没有画面：这句写在这里，有画面就交给上层去画。
    val scope = rememberCoroutineScope()
    val buttons = CodeCardRules.showsButtons(block)

    // 整块代码只分词一次：键是这块的内容（逐行正文与类别）而不是「重组了几次」。
    // 时间线每几秒读一遍，CodeBlock 每次都是新对象但内容一样 —— data class 的 equals
    // 让 remember 认出「还是这块代码」，于是滑动、刷新都不会再切一遍。
    // palette 一起进键：亮暗两套的赭色不同，换主题要重算颜色。颜色只是个 when，不贵；
    // 贵的是分词，而它只跟代码内容有关。
    val painted = remember(block.lines, palette) {
        block.lines.map { line ->
            CodeSyntax.segments(line).map { token -> token.text to codeColor(token.kind, line.kind, palette) }
        }
    }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(palette.card, RoundedCornerShape(10.dp))
            .border(1.dp, palette.line, RoundedCornerShape(10.dp)),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 11.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(block.path, fontSize = 11.sp, color = palette.faint)
            Box(Modifier.weight(1f))
            if (block.added > 0) Text("+${block.added}", fontSize = 11.sp, color = palette.accent)
            if (block.removed > 0) {
                Text(" -${block.removed}", fontSize = 11.sp, color = palette.warn)
            }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(palette.line))
        Column(modifier = Modifier.padding(vertical = 4.dp)) {
            block.lines.forEachIndexed { index, line ->
                val added = line.kind == "added"
                val removed = line.kind == "removed"
                val soft = when {
                    added -> palette.accentSoft
                    removed -> palette.warnSoft
                    else -> Color.Transparent
                }
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(soft)
                        .padding(horizontal = 11.dp, vertical = 1.dp),
                ) {
                    // 这一段只取上面算好的结果，不在这里分词 —— 列表每几秒重组一遍，
                    // 每次都切一遍整块代码正是滑动卡顿的来源。拼回去与原文逐字相同，
                    // 这一点由 CodeSyntaxTest 钉住：高亮可以少，不能吃掉字符。
                    painted.getOrNull(index).orEmpty().forEach { (text, color) ->
                        if (text.isEmpty()) return@forEach
                        Text(
                            text,
                            fontFamily = FontFamily.Monospace,
                            fontSize = 11.sp,
                            lineHeight = 19.8.sp,
                            color = color,
                        )
                    }
                }
            }
        }
        // 按钮是这张卡的一部分：没有改动就没有「采用」，所以只在真有改动时才画。
        if (buttons) {
            Box(Modifier.fillMaxWidth().height(1.dp).background(palette.line))
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 9.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(7.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // 采用：主强调的实心按钮。已采用时换成淡底对勾，但按钮还在（布局不跳）。
                Box(
                    modifier = Modifier
                        .background(
                            if (adopted) palette.accentSoft else palette.accent,
                            RoundedCornerShape(8.dp),
                        )
                        // 正在发或已经采用过就不再接第二下：一个按下去没反应的手型指针，
                        // 比一个不能点的按钮更让人以为坏了。
                        .clickable(enabled = !adopting && !adopted) {
                            adopting = true
                            note = null
                            noteIsFailure = false
                            val text = CodeCopy.adoptText(block, botId, botName)
                            scope.launch {
                                try {
                                    // mentions 从这句话里认：点名用 id，花名册里有这一位就一定认出来，
                                    // 这条表态才落在写这段的 Bot 身上，不会滑给默认那位。
                                    client.send(
                                        text,
                                        CrewWire.mentionsIn(text, bots),
                                        java.util.UUID.randomUUID().toString(),
                                        sessionId,
                                    )
                                    adopted = true
                                    note = CodeCopy.ADOPT_DONE
                                } catch (error: Exception) {
                                    note = CodeCopy.adoptFailed(error.message)
                                    noteIsFailure = true
                                } finally {
                                    adopting = false
                                }
                            }
                        }
                        .defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
                        .padding(horizontal = 12.dp, vertical = 7.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        when {
                            adopted -> CodeCopy.ADOPTED
                            adopting -> CodeCopy.ADOPTING
                            else -> CodeCopy.ADOPT
                        },
                        fontSize = 11.5.sp,
                        color = if (adopted) palette.accent else palette.surface,
                    )
                }
                // 看看改完的样子：白底细边的次按钮 —— 画板里就是一主一次。
                Box(
                    modifier = Modifier
                        .background(palette.card, RoundedCornerShape(8.dp))
                        .border(1.dp, palette.line, RoundedCornerShape(8.dp))
                        .clickable(enabled = !checking) {
                            // 票号只认这一段改动自己带的那个。没有就如实说，
                            // 不拿「第一张在跑的票」顶 —— 那会把 A 的活显示成 B 的结果。
                            val ticket = block.ticketRef.trim()
                            if (ticket.isEmpty()) {
                                note = CodeCopy.NO_TICKET
                                noteIsFailure = true
                            } else {
                                note = null
                                noteIsFailure = false
                                checking = true
                                scope.launch {
                                    try {
                                        val view = client.screen(ticket)
                                        val line = CodeCopy.previewNote(view)
                                        if (line == null) {
                                            // 真读到了画面：交给上层换屏，这里不再写一行字。
                                            onScreen(ticket, view)
                                        } else {
                                            note = line
                                            noteIsFailure = true
                                        }
                                    } catch (error: Exception) {
                                        note = CodeCopy.previewFailed(error.message)
                                        noteIsFailure = true
                                    } finally {
                                        checking = false
                                    }
                                }
                            }
                        }
                        .defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
                        .padding(horizontal = 12.dp, vertical = 7.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(CodeCopy.PREVIEW, fontSize = 11.5.sp, color = palette.ink)
                }
            }
            // 回执只写在它自己这张卡下面：同一段对话里并排两张卡时，不串台。
            note?.let {
                Text(
                    it,
                    fontSize = 10.5.sp,
                    lineHeight = 16.sp,
                    color = if (noteIsFailure) palette.warn else palette.faint,
                    modifier = Modifier.padding(start = 9.dp, end = 9.dp, bottom = 9.dp),
                )
            }
        }
    }
}

/** 数整棵树有多少个分身。 */
private fun countAgents(nodes: List<AgentNode>): Int =
    nodes.sumOf { 1 + countAgents(it.children) }

/** 一个子代理是不是已经收工。后端目前只发 working，这个集合为将来的终态留位置。 */
private fun agentDone(state: String): Boolean =
    state in setOf("done", "ended", "completed", "failed", "stopped")

/** 还在跑的分身数，递归整棵树。 */
private fun countRunning(nodes: List<AgentNode>): Int =
    nodes.sumOf { if (agentDone(it.state)) 0 else 1 + countRunning(it.children) }

@Composable
private fun AgentBranch(node: AgentNode, depth: Int, palette: CrewPalette) {
    val done = agentDone(node.state)
    // 缩进就是层级：不压平，也不额外画线。
    Row(
        modifier = Modifier.padding(start = (depth * 12).dp, top = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            // 有标签就显示标签：`a1-1` 这种内部编号对人没有意义。记号与桌面端 subagentRow 同一套：
            // 在跑是 ○、收工是 ✓（这里沿用手机上原来那颗 ·，颜色跟着状态走）。
            "${if (done) "✓" else "·"} ${node.label.ifBlank { node.id }}",
            color = if (done) palette.faint else palette.ink,
            fontSize = 11.sp,
        )
        // 右侧那截话：状态词 +（真有耗时时的）耗时。与桌面端 agentStatus 同一句，
        // 用词是子代理的「在跑 / 已完成」，不是工单卡的「在做」。
        // 后端今天还不发 elapsed_seconds，所以这里实际画出来的只有状态词 ——
        // 没数据就不画那一截，绝不补一个假数。
        Box(Modifier.weight(1f))
        Text(
            AgentCopy.status(node, working = !done),
            // 在跑的那一行是强调绿，收工的退成弱灰 —— 与桌面端同一处配色，扫一眼就知道谁还在动。
            color = if (done) palette.faint else palette.accent,
            fontSize = 10.5.sp,
        )
    }
    node.children.forEach { AgentBranch(it, depth + 1, palette) }
}

/**
 * 「听」那一小行：按一下把这句话念出来。
 *
 * 念不出来时说的是为什么（这台机器没有那个声音 / 转换失败），
 * 不是一句通用的「播报不可用」—— 那三个原因的处置完全不同。
 */
@Composable
private fun SpeakButton(client: CrewClient, palette: CrewPalette, text: String) {
    val scope = rememberCoroutineScope()
    var playing by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf("") }
    val context = androidx.compose.ui.platform.LocalContext.current
    Row(
        modifier = Modifier.padding(top = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        TextButton(
            enabled = !playing,
            contentPadding = PaddingValues(horizontal = 0.dp, vertical = 0.dp),
            modifier = Modifier.defaultMinSize(minWidth = 48.dp, minHeight = 48.dp),
            onClick = {
                playing = true
                note = SpeechCopy.PLAYING
                scope.launch {
                    try {
                        val result = client.speak(text)
                        val wav = result.wav
                        if (!result.available || wav == null) {
                            note = result.reason
                            return@launch
                        }
                        // 交给系统播放器念：不在应用里自己解码 PCM。
                        val file = java.io.File(context.cacheDir, "speech-${System.currentTimeMillis()}.wav")
                        java.io.FileOutputStream(file).use { it.write(wav) }
                        note = SpeechCopy.done(result.seconds, result.truncated)
                        val intent = android.content.Intent(android.content.Intent.ACTION_VIEW).apply {
                            setDataAndType(
                                androidx.core.content.FileProvider.getUriForFile(context, context.packageName + ".files", file),
                                "audio/wav",
                            )
                            addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        }
                        context.startActivity(intent)
                    } catch (error: Exception) {
                        note = error.message ?: SpeechCopy.FAILED
                    } finally {
                        playing = false
                    }
                }
            },
        ) {
            Text(
                if (playing) SpeechCopy.PLAYING else SpeechCopy.LISTEN,
                fontSize = 10.5.sp,
                color = if (playing) palette.faint else palette.accent,
            )
        }
        if (note.isNotEmpty()) {
            Text(note, fontSize = 10.sp, color = palette.faint, maxLines = 1)
        }
    }
}

@Composable
private fun MessageRow(
    message: Message,
    bots: List<BotCard>,
    palette: CrewPalette,
    client: CrewClient,
    onScreen: (String, ScreenView) -> Unit,
    /** 结果条按票缓存：读哪张、读过没有、该画哪句话，都由它一处说了算。 */
    outputs: OutputsCache,
    /** 这一轮时间线的代号：变了就重读一次。 */
    generation: Int,
    /**
     * 这一条该不该挂结果条。由调用方用 OutputsCopy.takeLastOfTicket 按整条时间线算好 ——
     * 「同一张票只挂在最后一条回复上」，判断要看得见整列消息，所以不在这一格里算。
     */
    showResult: Boolean = false,
    showName: Boolean = true,
    topGap: Dp = 0.dp,
    /** 代码卡的「采用」发到哪一格；由队伍屏在发起那一刻传下来。 */
    sessionId: String? = null,
) {
    // 这一条自己的「结果读回来了」记号。它是每条消息各记各的：某张票的产出读回来时，
    // 只有挂着它的那一条重画（见下面 remember 的键）。
    //
    // 从前这一枚是整页共享的（CrewScreen 里的 outputsTick）：任意一张票读回来，
    // 整列消息行都跟着重组一遍，每行把结果条重查一次 —— 列表越长越明显。
    // 现在它退到这一行里面，谁读完谁自己动，别处的行不受牵动。
    var outputsTick by remember { mutableStateOf(0) }
    val fromBot = message.fromBot
    val name = when {
        !fromBot -> "我"
        else -> bots.firstOrNull { it.id == message.botId }?.name ?: message.botId.orEmpty()
    }
    // 分色按 Bot ID 判，不按显示名：名字是花名册里可改的呈现，ID 才是身份。
    val warn = isWarnBot(message.botId)
    // 手机上一行就是一条消息：左对齐的是 Bot（带 25×25 头像），右对齐的是自己。
    // 画板里 Bot 那条是「头像 + 正文」两列，不是一整块气泡 ——
    // 少了头像，一屏连排的 Bot 发言会糊成一大段没有主人的字。
    if (fromBot) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, top = topGap),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.Top,
        ) {
            // 头像只在「这个人这一轮的第一句」出现：连续发言时重复画头像是噪音。
            if (showName) {
                Box(
                    modifier = Modifier
                        .size(25.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(if (warn) palette.warn else palette.accent),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        name.take(1),
                        fontSize = 11.sp,
                        fontWeight = FontWeight(620),
                        color = if (warn) Color(0xFFFFFBF6) else Color(0xFFFFFFFF),
                    )
                }
            } else {
                // 不画头像的那几行也要占住这一列，否则正文会往左跳一格。
                Spacer(Modifier.size(25.dp))
            }
            // 名字与正文同一列：名字在正文上方一行，弱一档。
            Column(modifier = Modifier.weight(1f)) {
                if (showName) {
                    Text(
                        name,
                        fontSize = 10.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = palette.accent,
                        modifier = Modifier.padding(bottom = 1.dp),
                    )
                }
                Text(
                    message.text,
                    fontSize = 14.sp,
                    lineHeight = 22.4.sp,
                    color = palette.ink,
                )
                // 念出来：只有机器人说的话才值得听，自己打的不用念回来。
                if (fromBot && message.text.isNotBlank()) {
                    SpeakButton(client, palette, message.text)
                }
                message.code?.let { block ->
                    Spacer(Modifier.height(9.dp))
                    // 署名带下去：卡上的「采用」要点名写这段的那位，不能猜成默认 Bot。
                    // 名字取花名册里的显示名；这一位不在花名册上时不编一个，只点名 id。
                    CodeCard(
                        block = block,
                        botId = message.botId,
                        botName = bots.firstOrNull { it.id == message.botId }?.name,
                        bots = bots,
                        palette = palette,
                        client = client,
                        onScreen = onScreen,
                        sessionId = sessionId,
                    )
                }
                // 结果条：「✓ 两张图片已放进产出」。只在「这条话带票号、那张票确实有产出」时画，
                // 放在代码卡之后，与桌面端同序。line 是纯查表，不发请求。
                //
                // 同一张票会挂在好几条回复上（先一句「收到」，干完再一句「报结果」）。
                // 两条各画一遍，屏幕上就是连着两条同一句话 —— 所以只让这张票在时间线上的
                // 最后一条回复挂它，判断由调用方按整列消息一次算好，见 OutputsCopy.takeLastOfTicket。
                val ticket = OutputsCopy.barTicket(message)
                // 缓存是普通表，Compose 不会自己知道它变了：读完一次，这条自己的
                // outputsTick 就加一，这一格跟着重算，才读得到新结果。票号、轮次与
                // 这条该不该挂也进键 —— 换了消息或换了轮次要重查。
                //
                // 这枚 tick 是「这一条自己的」：从前它是整页共享的一个，任意一张票
                // 读回来就把整列消息行全部重组一遍（每行都重算一遍结果条）。
                // 收窄到这一行之后，一次读取只重画它自己那条结果条。
                val line = remember(generation, showResult, ticket, outputsTick) {
                    if (showResult) outputs.line(ticket, generation) else null
                }
                // 结果条是异步读回来的。读回来之前这块地方的高度必须和读到之后一样，
                // 否则读完那一刻这条消息长高、列表里下面的东西全被顶走一下 ——
                // 正滑着就是一次顿挫。
                //
                // 占位直接画同一行的空白（同样的上下间距、同样的边框底、同样的一句话），
                // 只是把字与对勾换成看不见的白：量出来的高度就是真那一行的高度，
                // 不靠「9 + 9 + 16 ≈ 34dp」这种手算去对（11.5sp 的行高不是字号的 1.4 倍，
                // 手算出来的数一差，占位就等于没占）。
                //
                // 只在「还没读到」的时候占：读过了、确实没有产出，就一点都不留 ——
                // 那种情况留一块空白是永久的，比读回来时动一下难看得多。
                if (showResult && line == null && outputs.pending(ticket, generation)) {
                    Spacer(Modifier.height(9.dp))
                    ResultBar(" ", palette, hidden = true)
                }
                line?.let {
                    Spacer(Modifier.height(9.dp))
                    ResultBar(it, palette)
                }
                // 没读过就先要一份；读完之前不画，免得先闪一条空的再变成有内容的。
                // 读不到的也记一笔（见 OutputsCache）：结果条不会每帧重发请求。
                // 每读回一次时间线 generation 就加一，这里会跟着重读一次。
                // 不挂结果条的那几条不去读：同一张票只读一次，读了也没地方画。
                if (showResult && ticket.isNotEmpty()) {
                    LaunchedEffect(ticket, generation) {
                        if (!outputs.start(ticket, generation)) return@LaunchedEffect
                        var view: OutputsView? = null
                        try {
                            view = client.outputs(ticket)
                        } catch (error: CancellationException) {
                            // 这一条被组合带走了：不是「读不到」，别把它记成读不到。
                            // 放掉记号，滚回来时还会再读一次。
                            outputs.abandon(ticket, generation)
                            throw error
                        } catch (_: Exception) {
                            // 读失败就是「这张没有可画的产出」：不画，也不冒充断连。
                            view = null
                        }
                        outputs.finish(ticket, view, generation)
                        // 读回来要重画：缓存是普通表，界面不会自己知道它变了。
                        // 只碰这一条自己的 tick —— 整页共享的那个已经从这一格里拿掉了，
                        // 否则一次读取会让每一行消息都重组一遍。
                        outputsTick += 1
                    }
                }
            }
        }
        return
    }
    Column(
        modifier = Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, top = topGap),
        horizontalAlignment = Alignment.End,
    ) {
        Box(
            modifier = Modifier
                // 画板：气泡最宽 84%，不是写死的 300dp —— 390 宽上 300 太窄、更宽的屏又太短。
                .fillMaxWidth(0.84f)
                .clip(RoundedCornerShape(14.dp, 14.dp, 4.dp, 14.dp))
                .background(palette.userBubble)
                .padding(horizontal = 13.dp, vertical = 10.dp),
        ) {
            Text(
                message.text,
                fontSize = 14.sp,
                lineHeight = 21.75.sp,
                color = palette.userInk,
            )
        }
    }
}

/**
 * 消息结果条：白底细边的一行「✓ 两张图片已放进产出」（契约 §5.4 末节）。
 *
 * 与桌面端 resultBar 同一套画法：一行、细边、卡片底，对勾用强调色。
 * 它只在有结果时被调用 —— 空态、读不到、请求失败都不画这条，见 OutputsCopy.barLine。
 *
 * `hidden = true` 是同一个框、同一句话、同一处间距，只是字与对勾透明：用来在读回来之前
 * 把这一行的高度占住。量出来的是真那一行的高度，不是猜的 —— 见 MessageRow 里那一处。
 * 对无障碍树也不留字：它是占位，不该被读屏念出来。
 */
@Composable
private fun ResultBar(line: String, palette: CrewPalette, hidden: Boolean = false) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(palette.card, RoundedCornerShape(8.dp))
            .border(1.dp, palette.line, RoundedCornerShape(8.dp))
            .padding(horizontal = 12.dp, vertical = 9.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("✓", fontSize = 13.sp, color = if (hidden) Color.Transparent else palette.accent)
        Text(line, fontSize = 11.5.sp, color = if (hidden) Color.Transparent else palette.muted)
    }
}

/**
 * 画板里「周」那类商务/市场角色用赭色头像，其余用主题绿。
 * 这是有意的语义分色，不是随机配色 —— 与桌面端 messageAvatar 保持一致。
 * 规则照抄桌面端 isWarnBot：按 bot_id 判，不按名字判 —— 显示名可以在花名册里改。
 */
private fun isWarnBot(botId: String?): Boolean = when (botId) {
    "zhou", "business", "market" -> true
    else -> false
}

@Composable
private fun Composer(
    client: CrewClient,
    draft: String,
    queued: List<Pair<String, String>>,
    declinedReason: String?,
    withdrawNote: String?,
    sending: Boolean,
    palette: CrewPalette,
    enabled: Boolean,
    onChange: (String) -> Unit,
    steerTicketId: String?,
    onSteer: (String, String) -> Unit,
    onWithdraw: (String) -> Unit,
    onSteerText: (String) -> Unit,
    onSend: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth()) {
        if (queued.isNotEmpty()) {
            // 排队的消息要看得见，否则发出去像石沉大海；还要能撤回。
            Text(
                "${queued.size} 条排队中，等队伍读完手上这一步",
                fontSize = 11.sp,
                color = palette.faint,
                modifier = Modifier.padding(start = 16.dp, top = 8.dp),
            )
            queued.take(3).forEach { (requestId, text) ->
                Row(
                    modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 12.dp, top = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text.lineSequence().first().take(24),
                        fontSize = 11.sp,
                        color = palette.muted,
                        maxLines = 1,
                        overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    // 有工单在跑时才能插队：它把话交给那张票的 worker 下一步。
                    if (steerTicketId != null) {
                        TextButton(onClick = { onSteer(requestId, steerTicketId) }) {
                            Text("插队", color = palette.accent, fontSize = 11.sp)
                        }
                    }
                    TextButton(onClick = { onWithdraw(requestId) }) {
                        Text("撤回", color = palette.accent, fontSize = 11.sp)
                    }
                }
            }
        }
        withdrawNote?.let {
            Text(it, fontSize = 11.sp, color = palette.danger, modifier = Modifier.padding(start = 16.dp, top = 2.dp))
        }
        if (!declinedReason.isNullOrBlank()) {
            // 读过但不动手的那条也要说一声：屏幕上只有自己说的话时，分不清「还在想」和「不会回」。
            Text(
                "有一条队伍看过了没动手：$declinedReason",
                fontSize = 11.sp,
                color = palette.faint,
                modifier = Modifier.padding(start = 16.dp, top = 8.dp),
            )
        }
        ComposerRow(client, draft, sending, palette, enabled, onChange, onSend,
            steerTicketId = steerTicketId, onSteerText = onSteerText)
    }
}

/**
 * 输入区最左边那枚麦克风：按一下开始录，再按一下结束并认字。
 *
 * 认出来的话**追加**到草稿，不直接发出去 —— 认错一个字是常事，
 * 直接发出去就是把错的当成你说的。
 *
 * 没有麦克风时这枚键不画：画一个按不动的按钮，比不画更像坏了。
 */
@Composable
private fun VoiceButton(
    client: CrewClient,
    palette: CrewPalette,
    enabled: Boolean,
    onText: (String) -> Unit,
    onBusy: (Boolean) -> Unit,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    val recorder = remember { VoiceRecorder() }
    var recording by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var startedAt by remember { mutableStateOf(0L) }
    var note by remember { mutableStateOf<String?>(null) }
    val canRecord = remember { recorder.available() }

    // Android 6+ 录音一律运行时授权；没有捷径。
    val permission = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.RequestPermission(),
    ) { granted -> note = if (granted) null else VoiceCopy.NEED_PERMISSION }

    if (!canRecord) {
        Text(VoiceCopy.NO_MIC, fontSize = 11.sp, color = palette.faint)
        return
    }

    TextButton(
        enabled = enabled && !busy,
        onClick = {
            if (recording) {
                // 停：把采到的字节包成 WAV 交给后端认字。
                recording = false
                busy = true
                onBusy(true)
                val elapsed = System.currentTimeMillis() - startedAt
                val wav = recorder.stop()
                note = VoiceCopy.TRANSCRIBING
                scope.launch {
                    try {
                        if (VoiceCopy.tooShort(elapsed)) {
                            note = VoiceCopy.TOO_SHORT
                        } else {
                            val result = client.voice(wav)
                            if (result.available) {
                                onText(result.text)
                                note = VoiceCopy.INSERTED
                            } else {
                                note = result.reason
                            }
                        }
                    } finally {
                        busy = false
                        onBusy(false)
                    }
                }
                return@TextButton
            }
            val granted = androidx.core.content.ContextCompat.checkSelfPermission(
                context, android.Manifest.permission.RECORD_AUDIO,
            ) == android.content.pm.PackageManager.PERMISSION_GRANTED
            if (!granted) {
                permission.launch(android.Manifest.permission.RECORD_AUDIO)
                return@TextButton
            }
            if (recorder.start()) {
                startedAt = System.currentTimeMillis()
                recording = true
                note = VoiceCopy.LISTENING
            } else {
                note = VoiceCopy.NO_MIC
            }
        },
    ) {
        Text(
            when {
                busy -> "…"
                recording -> "■"
                else -> "●"
            },
            fontSize = 13.sp,
            color = when {
                recording -> palette.danger
                busy -> palette.faint
                else -> palette.accent
            },
        )
    }
    note?.let {
        Text(it, fontSize = 11.sp, color = if (recording) palette.accent else palette.faint, maxLines = 1)
    }
}

/**
 * 输入那一行：麦克风 · 输入框 · 可选的「插队」· 发送。
 *
 * 语音与发送共用同一份草稿：认出来的字先落进草稿，让人看一眼再发。
 */
@Composable
private fun ComposerRow(
    client: CrewClient,
    draft: String,
    sending: Boolean,
    palette: CrewPalette,
    enabled: Boolean,
    onChange: (String) -> Unit,
    onSend: () -> Unit,
    steerTicketId: String?,
    onSteerText: (String) -> Unit,
) {
    var listening by remember { mutableStateOf(false) }
    // 输入区：画板里圆角 13、白底细边、上下留白。默认的 OutlinedTextField
    // 是直角加厚边框，和整页的圆润调子对不上，所以自己给形状和颜色。
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // 麦克风在最左边：输入框右边已经是发送键，语音再挤进去会让人按错。
        VoiceButton(client, palette, enabled = enabled && !sending && !listening,
            onText = { said ->
                // 追加而不是替换：人可能已经打了一半，语音只补后半句。
                val joined = if (draft.isBlank()) said else draft.trimEnd() + " " + said
                onChange(joined)
            },
            onBusy = { listening = it })
        // 画板：输入框是**浅灰底、无边框**（#F3F0EA / 暗色 #2A2830），圆角 12；
        // 发送键是框内右侧 30×30 的绿方块。之前做成了白底 + 细边，
        // 在这张暖白页面上等于没有分界，看不出哪里能打字。
        OutlinedTextField(
            value = draft,
            onValueChange = onChange,
            placeholder = {
                Text(
                    if (enabled) "跟队伍说点什么" else "连上之后才能发",
                    color = palette.hint,
                    fontSize = 13.sp,
                )
            },
            enabled = enabled,
            textStyle = androidx.compose.ui.text.TextStyle(fontSize = 13.sp, color = palette.ink),
            shape = RoundedCornerShape(12.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedContainerColor = palette.field,
                unfocusedContainerColor = palette.field,
                disabledContainerColor = palette.field,
                focusedBorderColor = Color.Transparent,
                unfocusedBorderColor = Color.Transparent,
                disabledBorderColor = Color.Transparent,
                cursorColor = palette.accent,
            ),
            modifier = Modifier.weight(1f),
        )
        if (steerTicketId != null && draft.isNotBlank() && enabled && !sending) {
            // 有工单在跑时，这句可以不经排队、直接交给它的下一步。
            TextButton(onClick = { onSteerText(steerTicketId) }) {
                Text("插队", color = palette.accent, fontSize = 11.sp)
            }
        }
        Box(modifier = Modifier.padding(start = 8.dp)) {
            Button(
                enabled = enabled && draft.isNotBlank() && !sending,
                onClick = onSend,
                shape = RoundedCornerShape(13.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = palette.accent,
                    contentColor = Color.White,
                    disabledContainerColor = palette.line,
                    disabledContentColor = palette.faint,
                ),
            ) { Text(if (sending) "发送中" else "发送", fontSize = 13.sp) }
        }
    }
}

/**
 * 模型：全员用哪家、每位成员单独用哪家，以及这家模型的推理档位。
 *
 * 手机上没有第四块页签 —— 它是从队伍页头进来的临时一屏，返回就回到对话。
 * 一切以后端为准：目录、成员路由、档位都是读回来的；点一下才提交，失败就照实写。
 */
@Composable
private fun ModelScreen(
    client: CrewClient,
    conversation: Conversation?,
    palette: CrewPalette,
    onBack: () -> Unit,
) {
    var catalog by remember { mutableStateOf<ModelCatalog?>(null) }
    var efforts by remember { mutableStateOf<Efforts?>(null) }
    // null 是全员；否则是这一位的 bot_id。
    var scope by remember { mutableStateOf<String?>(null) }
    var note by remember { mutableStateOf<String?>(null) }
    // 读失败与切失败是两件事：读不到目录时不能说成「没切成功」。
    var loadTrouble by remember { mutableStateOf<String?>(null) }
    var trouble by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val coroutine = rememberCoroutineScope()
    val scroll = rememberScrollState()
    val bots = conversation?.bots.orEmpty()

    suspend fun reload(scopeId: String?) {
        val loaded = client.models()
        catalog = loaded
        loadTrouble = null
        val choice = loaded.choiceFor(scopeId)
        efforts = if (choice == null) null else try {
            client.efforts(choice.provider, choice.model)
        } catch (_: Exception) { null }
    }

    LaunchedEffect(scope) {
        loadTrouble = null
        try { reload(scope) } catch (error: Exception) { loadTrouble = error.message }
    }

    fun scopeLabel(id: String?): String = if (id == null) "全员" else bots.firstOrNull { it.id == id }?.name ?: id

    fun switchTo(provider: String, model: String, effort: String? = null) {
        if (busy) return
        busy = true
        note = null
        trouble = null
        val forScope = scope
        coroutine.launch {
            try {
                client.switchModel(provider, model, forScope, effort)
                reload(forScope)
                note = if (forScope == null) "全员已切到 $model" else "${scopeLabel(forScope)} 已切到 $model（下个工单生效）"
            } catch (error: Exception) {
                trouble = error.message
            }
            busy = false
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier.fillMaxWidth().background(palette.card)
                .padding(start = 6.dp, end = 18.dp, top = 10.dp, bottom = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextButton(onClick = onBack) { Text("返回", color = palette.accent) }
            Text("模型", fontSize = 20.sp, fontWeight = FontWeight(660), color = palette.ink)
            Spacer(Modifier.weight(1f))
            if (busy) CircularProgressIndicator(modifier = Modifier.size(16.dp), color = palette.accent, strokeWidth = 2.dp)
        }
        Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(palette.line))

        Column(
            modifier = Modifier.weight(1f).verticalScroll(scroll).padding(horizontal = 16.dp, vertical = 14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            val current = catalog?.choiceFor(scope)
            Text("作用", fontSize = 11.sp, color = palette.faint)
            Row(
                modifier = Modifier.fillMaxWidth().background(palette.segment, RoundedCornerShape(9.dp)).padding(3.dp),
            ) {
                SegmentChip("全员", scope == null, palette) { scope = null }
                for (bot in bots) SegmentChip(bot.name, scope == bot.id, palette) { scope = bot.id }
            }
            Text(
                when {
                    current == null -> "还没有选模型"
                    scope == null -> "${current.provider} · ${current.model}"
                    catalog?.followsCrew(scope) == true -> "跟随全员：${current.provider} · ${current.model}"
                    else -> "单独使用：${current.provider} · ${current.model}"
                },
                fontSize = 12.sp,
                color = palette.muted,
            )
            if (scope != null && catalog?.followsCrew(scope) == false) {
                TextButton(onClick = {
                    if (busy) return@TextButton
                    busy = true
                    val forScope = scope
                    coroutine.launch {
                        try {
                            // 空 model 且带 bot_id：后端清掉这一位的单独路由。
                            client.switchModel("", "", forScope, null)
                            reload(forScope)
                            note = "${scopeLabel(forScope)} 改回跟随全员"
                        } catch (error: Exception) {
                            trouble = error.message
                        }
                        busy = false
                    }
                }) { Text("改回跟随全员", color = palette.accent, fontSize = 12.sp) }
            }

            val loaded = efforts
            if (loaded != null && loaded.efforts.isNotEmpty() && current != null) {
                Text("推理档位", fontSize = 11.sp, color = palette.faint)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (effort in loaded.efforts) {
                        val chosen = current.reasoningEffort == effort.id ||
                            (current.reasoningEffort == null && loaded.default == effort.id)
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(8.dp))
                                .background(if (chosen) palette.accentSoft else palette.card)
                                .border(1.dp, if (chosen) palette.accent else palette.line, RoundedCornerShape(8.dp))
                                .clickable(enabled = !busy) { switchTo(current.provider, current.model, effort.id) }
                                .defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
                                .padding(horizontal = 12.dp, vertical = 7.dp),
                        ) {
                            Text(effort.name, fontSize = 12.sp,
                                fontWeight = if (chosen) FontWeight(600) else FontWeight.Normal,
                                color = if (chosen) palette.accent else palette.muted)
                        }
                    }
                }
            }

            val loadedCatalog = catalog
            when {
                loadedCatalog == null && loadTrouble == null -> Text("正在读模型…", fontSize = 12.sp, color = palette.faint)
                loadedCatalog != null -> {
                    for (provider in loadedCatalog.providers) {
                        Text(provider.name, fontSize = 11.sp, color = palette.faint, modifier = Modifier.padding(top = 6.dp))
                        for (model in provider.models) {
                            ModelRow(
                                model = model,
                                selected = current?.provider == provider.id && current.model == model.id,
                                palette = palette,
                                enabled = !busy,
                                onClick = { switchTo(provider.id, model.id) },
                            )
                        }
                    }
                    for (failure in loadedCatalog.failures) {
                        Text("${failure.name} 暂时连不上", fontSize = 11.sp, color = palette.danger)
                    }
                }
            }
        }

        note?.let { Text(it, fontSize = 11.sp, color = palette.faint, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) }
        loadTrouble?.let { Text("读不到模型：$it", fontSize = 11.sp, color = palette.danger, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) }
        trouble?.let { Text("没切成功：$it", fontSize = 11.sp, color = palette.danger, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) }
    }
}

@Composable
private fun ModelRow(
    model: ModelOption,
    selected: Boolean,
    palette: CrewPalette,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(if (selected) palette.accentSoft else palette.card)
            .clickable(enabled = enabled, onClick = onClick)
            .defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(model.name, fontSize = 13.sp, color = if (selected) palette.accent else palette.ink)
            model.description?.let { Text(it, fontSize = 11.sp, color = palette.faint) }
        }
        if (selected) Text("✓", fontSize = 14.sp, color = palette.accent)
    }
}

/**
 * 改一位 Bot：名字与人设。bot_id 只读 —— 记忆挂在它上面，改了等于换人。
 *
 * 写的是真接口：PUT /api/mobile/bots。成功后才关，失败原样写出来，不假装保存过。
 */
@Composable
private fun BotEditorSheet(
    client: CrewClient,
    bot: BotCard,
    palette: CrewPalette,
    onClose: () -> Unit,
    onSaved: () -> Unit,
) {
    var name by remember(bot.id) { mutableStateOf(bot.name) }
    var persona by remember(bot.id) { mutableStateOf(bot.persona) }
    var trouble by remember(bot.id) { mutableStateOf<String?>(null) }
    var busy by remember(bot.id) { mutableStateOf(false) }
    // 撤人不可逆：第一次按只是把话问出来，第二次才真删。
    var confirmingRemove by remember(bot.id) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val scroll = rememberScrollState()

    fun save() {
        if (busy) return
        val trimmed = name.trim()
        if (trimmed.isEmpty()) {
            trouble = "名字不能为空"
            return
        }
        busy = true
        trouble = null
        scope.launch {
            try {
                client.editBot(bot.id, trimmed, persona.trim())
                onSaved()
            } catch (error: Exception) {
                trouble = error.message
            }
            busy = false
        }
    }

    Box(
        modifier = Modifier.fillMaxSize().background(palette.surface.copy(alpha = 0.55f)).clickable(onClick = onClose),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 20.dp).widthIn(max = 360.dp).fillMaxWidth()
                .shadow(18.dp, RoundedCornerShape(18.dp))
                .background(palette.card, RoundedCornerShape(18.dp))
                .border(1.dp, palette.line, RoundedCornerShape(18.dp))
                .clickable(enabled = false) {}
                .verticalScroll(scroll)
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("改这一位", fontSize = 18.sp, fontWeight = FontWeight(660), color = palette.ink)
            Text("bot/${bot.id}", fontSize = 11.sp, color = palette.faint, fontFamily = FontFamily.Monospace)

            Text("名字", fontSize = 11.sp, fontWeight = FontWeight(600), color = palette.faint)
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = palette.accent, unfocusedBorderColor = palette.line,
                    focusedContainerColor = palette.surface, unfocusedContainerColor = palette.surface,
                ),
            )

            Text("人设（他怎么说话、擅长什么）", fontSize = 11.sp, fontWeight = FontWeight(600), color = palette.faint)
            OutlinedTextField(
                value = persona,
                onValueChange = { persona = it },
                minLines = 4,
                modifier = Modifier.fillMaxWidth(),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = palette.accent, unfocusedBorderColor = palette.line,
                    focusedContainerColor = palette.surface, unfocusedContainerColor = palette.surface,
                ),
            )
            Text("留空就是没有特别的人设，他会照队伍默认的方式说话。", fontSize = 11.sp, color = palette.faint)

            trouble?.let { Text("没改成功：$it", fontSize = 11.sp, color = palette.danger) }

            Row(horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                SmallCardButton("取消", palette, onClose)
                Box(
                    modifier = Modifier.weight(1f).background(palette.accent, RoundedCornerShape(10.dp))
                        .clickable(enabled = !busy, onClick = { save() })
                        .defaultMinSize(minWidth = 48.dp, minHeight = 48.dp).padding(vertical = 11.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(if (busy) "保存中…" else "保存", fontSize = 13.5.sp, fontWeight = FontWeight(550),
                        color = palette.surface)
                }
            }

            // 撤掉这一位：不可逆，所以要两步 —— 第一次按只是把话问出来。
            if (confirmingRemove) {
                Text("撤掉「${bot.name}」？他的记忆留在本机，但队伍里不再有他。", fontSize = 12.sp,
                    color = palette.warn)
            }
            Box(
                modifier = Modifier.fillMaxWidth()
                    .background(if (confirmingRemove) palette.danger else palette.card, RoundedCornerShape(10.dp))
                    .border(1.dp, if (confirmingRemove) palette.danger else palette.line, RoundedCornerShape(10.dp))
                    .clickable(enabled = !busy) {
                        if (!confirmingRemove) { confirmingRemove = true; return@clickable }
                        busy = true
                        scope.launch {
                            try {
                                client.removeBot(bot.id)
                                onSaved()
                            } catch (error: Exception) {
                                trouble = error.message
                                busy = false
                                confirmingRemove = false
                            }
                        }
                    }
                    .defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
                    .padding(vertical = 11.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(if (confirmingRemove) "确认撤掉" else "撤掉这一位", fontSize = 13.sp,
                    color = if (confirmingRemove) palette.surface else palette.danger)
            }
        }
    }
}
