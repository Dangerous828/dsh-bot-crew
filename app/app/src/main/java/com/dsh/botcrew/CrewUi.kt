package com.dsh.botcrew

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.interaction.collectIsDraggedAsState
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
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.rememberDrawerState
import androidx.activity.compose.BackHandler
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
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
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onLongClick
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
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
internal enum class Screen { Crew, Backend, Workspace, Models, Routine, Memory }

/**
 * 这一屏的对外名字。调试口的 `tab.set` 认它，与桌面端 nav.* 那套面板名对齐 ——
 * 同一个脚本能驱动两端，名字就不能各起一套。
 */
internal fun screenName(screen: Screen): String = when (screen) {
    Screen.Crew -> "crew"
    Screen.Backend -> "backend"
    Screen.Workspace -> "workspace"
    Screen.Models -> "models"
    Screen.Routine -> "routine"
    Screen.Memory -> "memory"
}

/** [screenName] 的反向：认不出来的名字返回 null，由调用方明确报错，不静默回落。 */
internal fun screenFromName(name: String): Screen? = when (name) {
    "crew" -> Screen.Crew
    "backend" -> Screen.Backend
    "workspace" -> Screen.Workspace
    "models" -> Screen.Models
    "routine" -> Screen.Routine
    "memory" -> Screen.Memory
    else -> null
}

/** 镜头名字。调试口的 `mode.set` 与桌面端 mode.set 同一套词。 */
internal fun modeName(mode: Mode): String = when (mode) {
    Mode.Chat -> "chat"
    Mode.Triage -> "triage"
}

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

/** 一条已发文本的短指认（与 [UncertainSend.excerpt] 同一口径，供没有落盘记录时兜底）。 */
private fun excerptOf(text: String): String {
    val head = text.lineSequence().firstOrNull()?.trim().orEmpty()
    if (head.isEmpty()) return "（空白内容）"
    return if (head.length <= 24) head else head.take(23) + "…"
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
    /**
     * 调试口的挂载点。null 表示开关没开 —— 那时一个调试对象都不建，
     * 界面这一层与没有这套东西时逐字相同。
     */
    debug: DebugBridge? = null,
    /**
     * 已配对的 crew。只用来算本地存储的命名空间（草稿 / 未确认发送按 crew + 会话隔离），
     * 不参与任何请求：凭据与入口仍由 [client] 持有。
     */
    paired: PairedCrew? = null,
) {
    // 设备接收链（#23）：推送落本地、按 id 去重、持久化后 ACK。用应用私有存储（SharedPreferences），
    // 不是 rememberSaveable —— force-stop / 冷启动之后仍要在，那是「不丢件」的底线。
    val appContext = androidx.compose.ui.platform.LocalContext.current.applicationContext
    val noticeStore = remember { NoticeStore(appContext) }
    // 屏幕上显示的推送：本进程内从本地持久化那份读出来（新的在前），新增时整体换掉触发重组。
    var notices by remember { mutableStateOf(noticeStore.all()) }
    // 推送轮询的健康度：失败多少次、最后什么错。不静默 —— 拉不到时界面上如实显示「重连中」，
    // 而不是一直挂着「隧道已连接」的假绿（task-10 第三根因）。
    var noticesHealth by remember { mutableStateOf(NoticesHealth()) }
    // 每会话一份 Conversation：切回 A 只显示 A 的缓存，绝不借 B 的消息来顶。
    // 老后端锁 main 时这张表只有一项，与从前单份 Conversation 的结构完全一致。
    var sessionState by remember {
        mutableStateOf(SessionState(current = initialSession.takeIf(SessionRoute::validId) ?: SessionRoute.MAIN))
    }
    val conversation: Conversation? = sessionState.shown
    // 诊断事件要带 session 短词：会话变了就同步给 DiagRuntime（只读，不写盘、不弹键盘）。
    androidx.compose.runtime.LaunchedEffect(sessionState.current) {
        DiagRuntime.get(appContext).currentSession = sessionState.current
    }
    // problem 只由「时间线读取失败」写入 → 喂顶部连接状态、也是「连不上就别发」的唯一依据。
    var problem by remember { mutableStateOf<String?>(null) }
    // 草稿与未确认发送都落盘（按 crew + 会话隔离）：切会话、进程被系统回收都不丢。
    val draftStore = remember(paired) { DraftStore(appContext, paired) }
    val sendStore = remember(paired) { SendRecoveryStore(appContext, paired) }
    // 每会话一份草稿正文。启动时从盘上读回来 —— 这就是「重建后草稿还在」。
    var draftBySession by remember { mutableStateOf(draftStore.all().associate { it.sessionKey to it.text }) }
    // 在途请求按会话隔离，旧会话的回调只更新自己的条目。
    var sendingBySession by remember { mutableStateOf<Map<String, Set<String>>>(emptyMap()) }
    // 未确认发送：盘上那份是唯一真源，内存这份只是它的投影（重启后从盘上重建）。
    var uncertain by remember { mutableStateOf(sendStore.all()) }
    // 失败/待确认提示按 requestId 记账，同会话可以有多条（A 的失败不能被 B 的成功抹掉）。
    var sendNotes by remember { mutableStateOf<Map<String, List<SendNote>>>(emptyMap()) }
    // 盘上记录读坏时的提示：一条可见的话，不静默当空、不覆盖、并且拦住发送。
    var storeTrouble by remember { mutableStateOf<String?>(null) }
    val activeSessionKey = sessionState.requestSession ?: SessionRoute.MAIN
    val draft = draftBySession[activeSessionKey].orEmpty()
    val sessionNotes = SendNoteBook.of(sendNotes, activeSessionKey)
    val sending = sendingBySession[activeSessionKey].orEmpty().isNotEmpty()
    // 轻量活动：只挂到消息上，不当成工单状态机。
    var activityCapability by remember { mutableStateOf(ActivityCapability.UNKNOWN) }
    var activityItems by remember { mutableStateOf<Map<String, RequestActivity>>(emptyMap()) }
    var activityStale by remember { mutableStateOf(false) }
    var activityGeneration by remember { mutableStateOf(0L) }
    var foreground by remember { mutableStateOf(true) }
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
    // 展开态只保存界面选择，按会话与工单归属，不保存任务状态。
    var expandedSubagent by remember { mutableStateOf<Pair<String, String>?>(null) }
    val scope = rememberCoroutineScope()
    // 时间线刷新的单飞记号（见下面 refresh）。
    val refreshGuard = remember { RefreshGuard() }
    var executorPaused by remember { mutableStateOf(false) }
    // 上一次停/继续的回执原话。调试口靠它断言「按下去之后到底成没成」——
    // 与工作区页上那行 `touched` 是同一个来源，只是那边是页面内状态，脚本读不到。
    var pauseResult by remember { mutableStateOf<String?>(null) }
    // 动作回执回来之后，已在途的时间线不再覆盖它；下一趟拉取仍以后端为准。
    var pauseRevision by remember { mutableStateOf(0) }
    // 名单先验失败后，人点「重试」就再问一次；不改变锁 main 的结论。
    var sessionRetry by remember { mutableStateOf(0) }

    fun navigateScreenBack() {
        when (screen) {
            Screen.Workspace -> {
                screen = Screen.Crew
                onScreen = null
                previewTicket = null
                previewView = null
            }
            Screen.Models, Screen.Backend -> screen = Screen.Crew
            Screen.Routine, Screen.Memory -> screen = Screen.Backend
            Screen.Crew -> Unit
        }
    }

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

    /**
     * 一条发送「已经确认到达」之后，输入框该不该收起。
     *
     * **对账成功与直接 200 成功共用这一句**：两条路都只是「这条意图已经送出」，
     * 没有理由一边收一边不收 —— 实机上就漏在旁边这半边：ledger 对上了、提示也清了，
     * 输入框还留着原文，用户看见就再点一次，于是同一句话发了第二遍（新的 UUID）。
     *
     * 只清「当前草稿仍等于当时发出去那一版」的那一格：用户后来改的字、别的会话，一律不动。
     */
    fun settleDraft(sessionKey: String, requestId: String, text: String) {
        val owner = SendOwner(sessionKey, requestId, text)
        val current = draftBySession[owner.sessionKey].orEmpty()
        if (!SendOwnership.shouldClearDraft(owner.sessionKey, current, owner)) return
        draftBySession = draftBySession - owner.sessionKey
        if (!draftStore.clearIfText(owner.sessionKey, owner.text)) storeTrouble = SendCopy.corruptRecord()
    }

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
                    // 对账：盘上未确认的发送若已出现在时间线里，说明服务端收到了 ——
                    // 清掉本机记录、不再提示也不再重发。没有证据的一律保留（不确定 ≠ 失败）。
                    val knownRequests = next.messages.mapNotNullTo(HashSet()) {
                        it.requestId.takeIf(String::isNotEmpty)
                    }
                    val settled = uncertain.filter { it.requestId in knownRequests }
                    if (settled.isNotEmpty()) {
                        for (send in settled) {
                            sendStore.done(send.requestId)
                            sendNotes = SendNoteBook.clear(sendNotes, send.sessionKey, send.requestId)
                            // 与直接成功同一条收尾：原文对得上才清，改过字就留着。
                            settleDraft(send.sessionKey, send.requestId, send.text)
                        }
                        uncertain = sendStore.all()
                    }
                    problem = null
                } while (refreshGuard.again)
            } catch (error: Exception) {
                problem = error.message
            } finally {
                refreshGuard.running = false
            }
        }
    }

    fun setSendInFlight(owner: SendOwner, inFlight: Boolean) {
        val current = sendingBySession[owner.sessionKey].orEmpty()
        val next = if (inFlight) current + owner.requestId else current - owner.requestId
        sendingBySession = if (next.isEmpty()) sendingBySession - owner.sessionKey
            else sendingBySession + (owner.sessionKey to next)
    }

    /**
     * 改一格草稿：内存与盘同时更新。空正文 = 用户自己清空（不算丢内容）。
     *
     * [recipientId] 是「这句话现在会发给谁」的快照。收件人真源仍是正文里的 @（见 [Recipient]）；
     * 存一份是为了冷启动时花名册还没拉回来，输入区仍说得清发给谁。
     */
    fun setDraft(sessionKey: String, text: String, recipientId: String = "") {
        draftBySession = draftBySession + (sessionKey to text)
        if (!draftStore.save(Draft(sessionKey, text, recipientId, System.currentTimeMillis()))) {
            storeTrouble = SendCopy.corruptRecord()
        }
    }

    /** 明确发送成功：只清「发出去的那一版」正文；用户之后又打的新字不动。 */
    /** 旧的入口名保留给既有调用点；做的事与对账那一侧完全同一份。 */
    fun clearSentDraft(owner: SendOwner) = settleDraft(owner.sessionKey, owner.requestId, owner.text)

    fun completeSend(owner: SendOwner) {
        setSendInFlight(owner, false)
        // 明确成功：盘上那一条未确认记录清掉，只清 requestId 相等的这一条。
        sendStore.done(owner.requestId)
        uncertain = sendStore.all()
        sendNotes = SendNoteBook.clear(sendNotes, owner.sessionKey, owner.requestId)
        settleDraft(owner.sessionKey, owner.requestId, owner.text)
        if ((sessionState.requestSession ?: SessionRoute.MAIN) == owner.sessionKey) refresh()
    }

    /**
     * 一次没成功。**必须说清请求有没有真的发出去**：
     * [posted] 为真 = 已经发出、结果未知（超时、断连、读到半个响应都算）→「结果待确认」；
     * 为假 = 请求根本没离开这台手机（落盘失败、本地校验没过）→ 确定性失败。
     */
    fun failSend(owner: SendOwner, message: String?, posted: Boolean) {
        setSendInFlight(owner, false)
        val excerpt = uncertain.firstOrNull { it.requestId == owner.requestId }?.excerpt() ?: excerptOf(owner.text)
        sendNotes = SendNoteBook.put(
            sendNotes, owner.sessionKey,
            SendNote(owner.requestId, SendCopy.noteFor(excerpt, message, posted)),
        )
    }

    /** 这条草稿这次的幂等键：同一段文字沿用同一个 id，改字则换一个（旧的不确定记录不删）。 */
    fun claimSend(
        sessionKey: String,
        text: String,
        mentions: List<String> = emptyList(),
        recipientId: String = "",
    ): UncertainSend {
        // 复用只认**完整意图**：同字换了收件人/`@` 名单是另一件事，必须拿新 id。
        // 只比正文会让旧 id 被拿来落盘，put 判冲突 → 一条正常的新发送被旧记录挡住。
        val replay = SendRecoveryRecord.reuse(uncertain, sessionKey, text, mentions, recipientId)
        if (replay != null) return replay
        return UncertainSend(
            requestId = java.util.UUID.randomUUID().toString(),
            sessionKey = sessionKey,
            text = text,
            mentions = mentions,
            recipientId = recipientId,
            at = System.currentTimeMillis(),
        )
    }

    /**
     * 发一次 `/send`。**先落盘再发**：记不住就不发（否则重启后再也无法对账）；
     * 落盘成功之后 POST 已经离开手机，任何异常都只说明「结果未知」，不是「没发出去」。
     */
    suspend fun sendWithRecovery(send: UncertainSend): Boolean {
        // 原样用调用方给的 envelope：mentions/recipient 是意图的一部分，这里再覆盖一次
        // 就等于允许「同一个 id 换 payload」，而盘上那条会被判冲突。
        val envelope = send
        if (!sendStore.record(envelope)) {
            storeTrouble = SendCopy.corruptRecord()
            failSend(SendOwner(envelope.sessionKey, envelope.requestId, envelope.text), null, posted = false)
            return false
        }
        uncertain = sendStore.all()
        val owner = SendOwner(envelope.sessionKey, envelope.requestId, envelope.text)
        setSendInFlight(owner, true)
        return try {
            client.send(
                envelope.text, envelope.mentions, envelope.requestId,
                envelope.sessionKey.takeIf { it != SessionRoute.MAIN },
            )
            completeSend(owner)
            true
        } catch (error: CancellationException) {
            // 协程被取消：POST 可能已经在路上，记录留着，下次对账/重试用同一个 id。
            setSendInFlight(owner, false)
            throw error
        } catch (error: Exception) {
            failSend(owner, error.message, posted = true)
            false
        } finally {
            setSendInFlight(owner, false)
        }
    }

    /**
     * 恢复：用盘上那份原样重发（同一个 request_id），成功后清掉这一条。
     * 换 crew 之后**不自动重发**：那只在同一个会话会被误当成新交代，见 [uncertainOfActive]。
     */
    fun retryRecovered(send: UncertainSend) {
        scope.launch { sendWithRecovery(send) }
    }

    /** 行内「不再重试，移除本机记录」：只删这一条，同会话别的未确认发送不动。 */
    fun forgetRecovered(requestId: String) {
        val send = uncertain.firstOrNull { it.requestId == requestId }
        sendStore.forget(requestId)
        uncertain = sendStore.all()
        // 提示按这条自己的会话清（它可能不属于当前正在看的那一格）。
        sendNotes = SendNoteBook.clear(sendNotes, send?.sessionKey ?: activeSessionKey, requestId)
    }

    /**
     * 停一下 / 继续执行。**界面按钮与调试口共用这一条**，不各写一份。
     *
     * 为什么要一个函数而不是两处各写一遍：暂停的状态位（[executorPaused] + [pauseRevision]）
     * 与回执话术绑在一起 —— 复制一份出来，就一定会有一份忘记把 revision 加一，
     * 那时时间线的下一趟刷新会把刚按下的状态覆盖掉，界面闪回「正在干活」。
     *
     * 成功才改状态：`client.pause/resume` 抛错时这里什么都不动，调用方照实说失败。
     * 返回那句给人看的话（与后端回的 scope 对得上）。
     */
    suspend fun setPaused(paused: Boolean, ticketId: String?): String {
        val said = if (paused) {
            // scope 用后端回执里的那个，不在这里写死 —— 将来多一种作用域时这句话才对得上。
            WorkspaceCopy.pauseDone(client.pause(ticketId))
        } else {
            client.resume()
            WorkspaceCopy.RESUMED
        }
        executorPaused = paused
        // 回执已到：在途的时间线不再拿它手里那份旧 status 覆盖刚按下的结果。
        pauseRevision += 1
        pauseResult = said
        return said
    }

    /**
     * 进入另一格会话：切过去与新建成功后走同一段，草稿/幂等键/结果条轮次一律不复用。
     * 请求路径不靠任何全局状态 —— 各处显式读 [SessionState.requestSession]，
     * 在途的旧请求仍带着它发起那一刻的会话 id。
     */
    fun enterSession(next: SessionState) {
        sessionState = next
        expandedSubagent = null
        onSessionChange(next.current)
        // 草稿不是「切会话就清」的东西：每个会话各有一格，切回去原样还在（见 DraftStore）。
        timelineEpoch += 1
        refresh()
    }

    /**
     * 调试口这一半：把界面状态摊平给 `state.dump`，把动作落到界面本来就有的那几个入口上。
     *
     * 只在开关开启时挂上去（[debug] 为 null 时一个对象都不建）；退出这一屏时摘掉，
     * 免得调试口还拿着已经离开组合的状态去改。写法用 remember + DisposableEffect：
     * 闭包里读的都是 `by remember { mutableStateOf(...) }` 的委托，每次调用拿到的是这一刻的值，
     * 所以这个对象不必随每帧重建。
     */
    if (debug != null) {
        val target = remember(debug) {
            CrewDebugScreen(
                state = { sessionState },
                tab = { screenName(screen) },
                mode = { modeName(mode) },
                timelineEpoch = { timelineEpoch },
                paused = { executorPaused },
                problem = { problem },
                draft = { draft },
                sending = { sending },
                entries = { client.routeOrder() },
                currentEntry = { client.currentEntry() },
                onRefresh = { refresh() },
                // 重拉名单与「重试」按钮同一条路（sessionRetry 变化会让上面那个 LaunchedEffect 重跑）。
                onReloadSessions = { sessionRetry += 1 },
                // 切会话走 enterSession：落盘、清草稿、重拉时间线一次做完，与点切换条同一条路。
                onEnterSession = { next -> enterSession(next) },
                onSend = { text, requestId ->
                    // 调试口也走同一条「先落盘再发」的路：请求 id 由调用方给定，便于脚本重放同一意图。
                    val key = sessionState.requestSession ?: SessionRoute.MAIN
                    val mentions = CrewWire.mentionsIn(text, conversation?.bots.orEmpty())
                    val envelope = claimSend(key, text, mentions).copy(requestId = requestId)
                    scope.launch { sendWithRecovery(envelope) }
                },
                onTab = { name -> screenFromName(name)?.let { screen = it } },
                onMode = { name -> mode = if (name == "triage") Mode.Triage else Mode.Chat },
                // 调试口按的停/继续与工作区那个按钮落到同一个 setPaused 上。
                // 失败也写进 pauseResult：脚本要能看见「没做成」，不能只看得见成功。
                onSetPaused = { next, ticketId ->
                    scope.launch {
                        try {
                            setPaused(next, ticketId)
                        } catch (error: CancellationException) {
                            throw error
                        } catch (error: Exception) {
                            pauseResult = WorkspaceCopy.failed(error.message)
                        }
                    }
                },
                pauseResult = { pauseResult },
            )
        }
        DisposableEffect(debug) {
            debug.screen = target
            onDispose { if (debug.screen === target) debug.screen = null }
        }
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

    // 前台/后台：活动轮询只在人真看着屏幕时才跑（后台由系统冻结，不该继续打请求）。
    val lifecycleOwner = androidx.lifecycle.compose.LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
            if (event == androidx.lifecycle.Lifecycle.Event.ON_RESUME) foreground = true
            if (event == androidx.lifecycle.Lifecycle.Event.ON_PAUSE) foreground = false
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        foreground = lifecycleOwner.lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    /**
     * 轻量活动轮询：有活跃活动 / 有未确认发送时约 1 秒一次，否则 4 秒；后台或后端没这项能力时不发。
     *
     * 与 6 秒的完整时间线是两条独立的节奏 —— 轻量这条只回答「现在还在干什么」，
     * 不重拉消息、不重拉产出，所以可以快。
     *
     * 迟到响应靠代际 guard 丢弃：每次真正发出前取一次 `activityGeneration`，
     * 回来时对不上（切了会话/又发了一轮）就整份丢掉，不写进当前会话。
     */
    LaunchedEffect(sessionState.requestSession, foreground, activityCapability, uncertain.size, activityItems) {
        val session = sessionState.requestSession
        val active = ActivityPoll.anyActive(activityItems.values) || uncertain.isNotEmpty()
        val wait = ActivityPoll.intervalMs(activityCapability, foreground, active) ?: return@LaunchedEffect
        while (true) {
            kotlinx.coroutines.delay(wait)
            if (!foreground) break
            val generation = activityGeneration
            val key = sessionState.requestSession
            if (key != session) break
            try {
                when (val result = client.activity(key)) {
                    is ActivityResult.Unsupported -> {
                        // 后端没这项能力：停掉这条轮询，退回旧时间线节奏，不刷错误、不伪造活动。
                        activityCapability = ActivityCapability.UNSUPPORTED
                        return@LaunchedEffect
                    }
                    is ActivityResult.Unavailable -> {
                        // 读不到 ≠ 没有活动：保留上一次事实，只标陈旧，不当成「已结束」。
                        activityStale = true
                    }
                    is ActivityResult.Live -> {
                        activityCapability = ActivityCapability.SUPPORTED
                        if (generation == activityGeneration && sessionState.requestSession == session) {
                            // 成功 200：以本次 items 为全活跃集合，不在其中的 overlay 清掉。
                            // 收据（request_state）仍以 timeline 为准，不在这里改。
                            activityItems = result.snapshot.items.associateBy { it.requestId }
                            activityStale = false
                            activityGeneration += 1
                        }
                    }
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                activityStale = true
            }
        }
    }

    // 队伍回话可能要几分钟。只读一次的话，屏幕会永远停在「已发出去」那一格；
    // 前台时每几秒重读一次，离开页面由 Compose 取消这个协程。
    LaunchedEffect(Unit) {
        while (true) {
            refresh()
            // 设备推送：先 peek（后端不删），把新条目**先落本地**（merge 用 commit 确认写盘），
            // 只有本次真正新增、且已确认落盘的 id 才 ACK 回后端（只删这些）。这样 GET 之后崩溃也不丢件，
            // 落盘之后 ACK 失败重试也不会重复显示（本地按稳定 id 去重）。断链时这一整段跳过，下次轮询再取。
            try {
                val view = client.notices()
                if (view.available && view.items.isNotEmpty()) {
                    val added = noticeStore.merge(view.items)
                    if (added.isNotEmpty()) {
                        notices = noticeStore.all()
                        client.reportSeen(added)   // 落盘成功之后才 ACK
                    }
                }
                // 这一轮拉到了（哪怕没有新条目）：健康度清零，界面退回正常文案。
                if (noticesHealth.consecutiveFailures != 0) noticesHealth = noticesHealth.onSuccess()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                // 拉推送失败不打断对话刷新，但**绝不静默**：记下失败，界面如实显示「重连中」。
                // 连续失败逐次累加，成功一次才清零 —— 让人看得出「一直没拉到」而不是看一眼就以为没事。
                noticesHealth = noticesHealth.onFailure(error.message ?: "推送拉取失败")
                android.util.Log.w("CrewNotices", "拉取推送失败（第 ${noticesHealth.consecutiveFailures} 次）", error)
            }
            delay(6_000)
        }
    }

    Surface(modifier = Modifier.fillMaxSize(), color = palette.surface) {
        // edge-to-edge 下由根容器统一消费系统栏与 IME Insets，避免页面各自重复扣边距。
        Column(modifier = Modifier.fillMaxSize().systemBarsPadding().imePadding()) {
          // 队伍这一屏的顶部信息（连接/会话/模式/成员/更多）由 CrewScreen 内的紧凑顶栏统一承载，
          // 不再在这里叠加 route 小字 + 常驻 SessionBar（那正是顶部占 40% 的根因：两层各画一段）。
          // 其余各屏（后台/工作区/模型…）仍沿用原有的常驻 route + 会话切换条。
          if (screen != Screen.Crew) {
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
            // 推送拉不到时如实说一句，不让「隧道已连接」的假绿盖住「一条推送都没拿到」。
            // 只在失败态出现，成功即消失，不占常驻位置。
            val noticesLine = noticesHealth.line()
            if (noticesLine.isNotEmpty()) {
                Text(
                    text = noticesLine,
                    style = MaterialTheme.typography.labelSmall,
                    color = palette.accent,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 2.dp),
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

            val renderedSessionKey = sessionState.requestSession ?: SessionRoute.MAIN
            // 此处理器先于下面的页面组合；页面内的 drawer/modal BackHandler 后注册，可优先消费返回键。
            BackHandler(enabled = screen != Screen.Crew) { navigateScreenBack() }
            when (screen) {
                Screen.Backend -> BackendScreen(client, conversation, palette, { navigateScreenBack() },
                    { refresh() }, onRoutines = { screen = Screen.Routine }, onMemory = { screen = Screen.Memory })
                Screen.Routine -> RoutineScreen(client, conversation, palette, onBack = { navigateScreenBack() })
                Screen.Memory -> MemoryScreen(client, palette, onBack = { navigateScreenBack() })
                Screen.Workspace -> WorkspaceScreen(
                    client = client,
                    bot = onScreen ?: conversation?.bots?.firstOrNull { it.id == conversation?.defaultBotId },
                    ticket = ticketOf(conversation, onScreen ?: conversation?.bots?.firstOrNull { it.id == conversation?.defaultBotId }),
                    // 执行器被全局暂停这件事压过单个 Bot 的 activity 词，所以从队伍状态里取。
                    paused = executorPaused,
                    onSetPaused = { next, ticketId -> setPaused(next, ticketId) },
                    palette = palette,
                    preview = previewTicket,
                    previewView = previewView,
                    onBack = { navigateScreenBack() },
                )
                Screen.Models -> ModelScreen(client, conversation, palette, onBack = { navigateScreenBack() })
                Screen.Crew -> CrewScreen(client, conversation, outputs, agents, palette, problem, draft, sending,
                    // 结果条按票的缓存每读回一次时间线就清空重读一次（见 CrewScreen）。
                    timelineEpoch = timelineEpoch,
                    expandedSubagentTicketId = expandedSubagent?.takeIf { it.first == sessionState.current }?.second,
                    onExpandedSubagentChange = { ticketId ->
                        expandedSubagent = ticketId?.let { sessionState.current to it }
                    },
                    noticesWarning = noticesHealth.line().ifEmpty { null },
                    requestIdFor = { text ->
                        val key = sessionState.requestSession ?: SessionRoute.MAIN
                        val mentions = CrewWire.mentionsIn(text, conversation?.bots.orEmpty())
                        claimSend(key, text, mentions, currentRecipientId(text, conversation?.bots.orEmpty()).orEmpty()).requestId
                    },
                    // 每个请求回执按 session + request id 更新自己的发送状态。
                    onDraft = { text ->
                        if ((sessionState.requestSession ?: SessionRoute.MAIN) == renderedSessionKey) {
                            setDraft(
                                renderedSessionKey, text,
                                currentRecipientId(text, conversation?.bots.orEmpty()).orEmpty(),
                            )
                        }
                    },
                    onSending = { owner, inFlight -> setSendInFlight(owner, inFlight) },
                    onSendSucceeded = { completeSend(it) },
                    onSendFailed = { owner, message, posted -> failSend(owner, message, posted) },
                    // 普通发消息的唯一入口：先落盘（commit）再 POST，异常一律「结果待确认」。
                    onSendNow = { text, mentions ->
                        val key = sessionState.requestSession ?: SessionRoute.MAIN
                        // 意图在 claim 时一次定全：正文 + @ 名单 + 收件人，一起参与「是不是同一条」。
                        val envelope = claimSend(
                            key, text, mentions,
                            currentRecipientId(text, conversation?.bots.orEmpty()).orEmpty(),
                        )
                        scope.launch { sendWithRecovery(envelope) }
                    },
                    sendRecoveries = uncertain.filter { it.sessionKey == activeSessionKey },
                    onRetryRecovered = { retryRecovered(it) },
                    onForgetRecovered = { forgetRecovered(it) },
                    sendNotes = sessionNotes,
                    storeTrouble = storeTrouble,
                    activityByRequest = activityItems,
                    activityStale = activityStale,
                    onSent = { if ((sessionState.requestSession ?: SessionRoute.MAIN) == renderedSessionKey) refresh() },
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
                    // 设备推送落本地那份：顶部一条紧凑提示，复用列表区，不新开屏。
                    notices = notices,
                    // 紧凑顶栏要用的连接/会话真源（都来自 CrewRoot，唯一一份；CrewScreen 只读不建）。
                    route = route,
                    connLoading = conversation == null && problem == null,
                    onRefresh = { refresh() },
                    sessionCurrent = sessionState.current,
                    sessionLabel = sessionState.sessions.firstOrNull { it.id == sessionState.current }?.let { if (it.name.isBlank()) it.id else it.name } ?: sessionState.current,
                    sessionSwitchable = sessionState.switchable,
                    sessionState = sessionState,
                    onSwitchSession = { id ->
                        val next = SessionFlow.switch(sessionState, id)
                        if (next.current != sessionState.current) enterSession(next)
                    },
                    onCreateSession = { id ->
                        val check = SessionFlow.create(sessionState, id)
                        sessionState = check.state
                        if (check.accepted) {
                            scope.launch {
                                try {
                                    val view = client.createSession(id)
                                    val next = SessionFlow.applyCreated(sessionState, view, id)
                                    if (next.current != sessionState.current) enterSession(next) else sessionState = next
                                } catch (error: CancellationException) {
                                    throw error
                                } catch (error: Exception) {
                                    android.util.Log.w("CrewSessions", "新建会话失败", error)
                                    sessionState = SessionFlow.createFailed(
                                        sessionState, error.message?.takeIf(String::isNotBlank) ?: error.toString(),
                                    )
                                }
                            }
                        }
                    },
                    // 未 @ 时的默认收件人真源：后端该会话的 default_bot_id（全表唯一 role=default）。
                    // 读不到就是空串，输入区如实报「未指定」，不硬编码第一位。
                    defaultBotId = conversation?.defaultBotId.orEmpty(),
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
    /** 推送拉取失败的健康信息：非空才显示一行，不常驻成功态、不吞错误。 */
    noticesWarning: String? = null,
    /** 第几次把时间线读回来。变了就按这一轮重读结果条。 */
    timelineEpoch: Int,
    /** 当前会话里用户展开的工单；跨刷新与列表回收保留，切会话后清空。 */
    expandedSubagentTicketId: String? = null,
    onExpandedSubagentChange: (String?) -> Unit = {},
    /** 同一段草稿重发要沿用同一个幂等键；新草稿换一个。 */
    requestIdFor: (String) -> String,
    onDraft: (String) -> Unit,
    onSending: (SendOwner, Boolean) -> Unit,
    onSendSucceeded: (SendOwner) -> Unit = {},
    /** [posted] = 请求是否已经离开手机；失败文案据此分「结果待确认 / 没有发出」。 */
    onSendFailed: (SendOwner, String?, Boolean) -> Unit = { _, _, _ -> },
    /**
     * 普通发消息：把「发什么」交给上层 —— 落盘与 POST 的先后由 CrewRoot 的 `sendWithRecovery` 保证。
     * 这一层不自己调 `client.send`，否则「先落盘再发」会被绕过。
     */
    onSendNow: (String, List<String>) -> Unit = { _, _ -> },
    /** 盘上还没确认的发送（当前会话）。有就画一条可恢复的记录，不静默留在盘上不可见。 */
    sendRecoveries: List<UncertainSend> = emptyList(),
    onRetryRecovered: (UncertainSend) -> Unit = {},
    onForgetRecovered: (String) -> Unit = {},
    /** 失败/待确认提示，按请求归属，可多条。 */
    sendNotes: List<SendNote> = emptyList(),
    /** 本机记录读坏了的一条可见提示；非空即拦住发送。 */
    storeTrouble: String? = null,
    /** 轻量活动快照：按 request_id 挂到消息上。空 = 后端没给这项能力。 */
    activityByRequest: Map<String, RequestActivity> = emptyMap(),
    /** 上一次活动读取失败：保留上次事实，只标陈旧。 */
    activityStale: Boolean = false,
    onSent: () -> Unit,
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
    /** 设备接收链（#23）落本地、已持久化的推送，最新在前。空表示没有。复用在列表区顶部，不新开一屏。 */
    notices: List<CrewNotice> = emptyList(),
    // 紧凑顶栏：连接/会话真源都来自 CrewRoot，这一层只读不改。
    route: String = "",
    connLoading: Boolean = false,
    onRefresh: () -> Unit = {},
    sessionCurrent: String = SessionRoute.MAIN,
    sessionLabel: String = SessionRoute.MAIN,
    sessionSwitchable: Boolean = false,
    sessionState: SessionState? = null,
    onSwitchSession: (String) -> Unit = {},
    onCreateSession: (String) -> Unit = {},
    /** 当前会话后端的 `default_bot_id`（全表唯一 role=default）。空串=后端没给，输入区据此如实报「未指定」。 */
    defaultBotId: String = "",
) {
    // 名片与滚动位置归这一页；其余是发消息要用到的、由上层持有的状态。
    var profile by remember { mutableStateOf<BotCard?>(null) }
    // 正在改人设的那一位。null 表示编辑层没开。
    var editing by remember { mutableStateOf<BotCard?>(null) }
    var steerTextNote by remember(sessionId) { mutableStateOf<String?>(null) }
    val listState = rememberLazyListState()
    var timelineTailRevision by remember(sessionId) { mutableStateOf(0) }
    val scope = rememberCoroutineScope()
    // 「跟他说话」把输入框聚焦到草稿（只在 App 内请求焦点，不碰系统输入）。
    val composerFocus = remember { FocusRequester() }
    // 事务板抽屉与模式切换都归这一页：切镜头时群聊的滚动位置还在（listState 留在组合里）。
    var boardOpen by remember { mutableStateOf(false) }
    var pendingJump by remember { mutableStateOf<String?>(null) }
    // 会话弹层（SessionBar）开合：CrewScreen 单一真源。顶栏点会话与 drawer「会话管理」共用它，
    // 两页（聊天/任务）都走同一份；不再由 CrewTopBar 各持一份内部 state。
    var showSessions by remember { mutableStateOf(false) }
    // 通知跳转（一次性）：drawer「通知」点下后置要跳的目标 index，等聊天列表挂载后滚过去再清标记。
    var pendingNoticeJump by remember { mutableStateOf(false) }
    // 侧边栏开合状态。点遮罩由 ModalNavigationDrawer 自身处理；系统 Back 在抽屉打开/开启动画期间显式拦截。
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    BackHandler(
        enabled = CrewNavigation.shouldConsumeDrawerBack(
            currentOpen = drawerState.currentValue == DrawerValue.Open,
            targetOpen = drawerState.targetValue == DrawerValue.Open,
        ),
    ) { scope.launch { drawerState.close() } }
    // 「资料」打开名片后，onTalk 要聚焦输入框 —— 但只在名片浮层撤掉、输入框重新挂上组合之后才请求，
    // 否则 FocusRequester 尚未附着会抛 "not initialized"。用一次性标记，在 LaunchedEffect 里消费。
    var focusComposerAfterTalk by remember { mutableStateOf(false) }
    // 诊断页开合：侧栏「工具 · 诊断」的唯一开关。诊断页是覆盖层，不常驻、不入顶部。
    var diagOpen by remember { mutableStateOf(false) }
    // 检查更新页开合：同样只从侧栏「工具」进来，覆盖层，不常驻。
    var otaOpen by remember { mutableStateOf(false) }

    // 分拣台的「丢」走和群聊同一条 POST /send，不另造一套发送。
    // 落盘与 POST 的顺序在上层（onSendNow → sendWithRecovery），这里只表达意图。
    fun sendBoardText(text: String, done: (Boolean) -> Unit) {
        onSendNow(text, CrewWire.mentionsIn(text, conversation?.bots.orEmpty()))
        done(true)
    }
    /**
     * 答复一张待决问题卡：**明确 ticket + attention_id 的票**走审批通道 POST /api/mobile/answer，
     * 不拼 `@某人 label` 再发 /send（那会让引擎起一段新活，而不是回这张卡的审批）。
     *
     * - 老后端没下发 attention_id 的票 / 普通聊天：attention_id 为空 → 退回既有 /send 路径，逐字不变。
     * - 选明确选项：text 传选项 label（后端 label/id 都认）。
     * - 自写 revise：走 [sendRevise]，text 是用户原文，同样带上这张卡的 attentionId。
     * - 409：**不冒充成功，也不替服务端说「卡已更新」** —— 409 有四种来源，只有一种是真换了卡。
     *   这里照实转述服务端原话（[AnswerStale.reason]），并刷新时间线。
     * - 请求中禁重入由 [BoardAnswerState] / 桌面 answers[slot] 保证；这里只做一次发射。
     */
    fun answerByTicket(ticket: WorkTicket, text: String, done: (ApprovalGate.Outcome) -> Unit) {
        val owner = SendOwner(
            sessionId ?: SessionRoute.MAIN,
            "answer:${ticket.attentionId.ifBlank { ticket.id }}",
            text,
        )
        onSending(owner, true)
        scope.launch {
            val outcome = try {
                client.answer(ticket.id, text, ticket.attentionId, sessionId)
                onSent()
                ApprovalGate.Outcome.Accepted
            } catch (error: AnswerStale) {
                // 服务端拒了这一次：刷新时间线，把它的原话照实说出去（不粉饰成「已更新」）。
                onSent()
                onSendFailed(owner, AnswerCopy.answerFailed(error.reason), true)
                ApprovalGate.Outcome.Rejected(error.reason)
            } catch (error: Exception) {
                onSendFailed(owner, error.message ?: "答复没发出去", true)
                ApprovalGate.Outcome.Failed(error.message)
            } finally {
                onSending(owner, false)
            }
            done(outcome)
        }
    }
    /**
     * 答复一张待决问题卡：**明确 ticket + attention_id 的票**走审批通道 POST /api/mobile/answer，
     * 不拼 `@某人 label` 再发 /send（那会让引擎起一段新活，而不是回这张卡的审批）。
     *
     * - 老后端没下发 attention_id 的票 / 普通聊天：attention_id 为空 → 退回既有 /send 路径，逐字不变。
     * - 选明确选项：text 传选项 label（后端 label/id 都认）。
     * - 自写 revise：由队伍消息区的待决卡（TicketStrip）内联输入框直接发 /answer，text 是用户原文。
     * - 409：不当成功；刷新时间线，服务端原话照实说（「卡已更新」只在真的换了卡时才提示，
     *   判定见 [AttentionSupersede]）。
     * - 请求中禁重入由 [ApprovalGate] / 桌面 answers[slot] 保证；这里只做一次发射。
     */
    fun answerTicket(ticket: WorkTicket, option: AttentionOption, done: (ApprovalGate.Outcome) -> Unit) {
        // 没有 attention_id 的票不是审批卡：保持既有 /send 行为，不引入审批语义。
        if (ticket.attentionId.isEmpty()) {
            val name = conversation?.bots?.firstOrNull { it.id == ticket.botId }?.name?.trim().orEmpty()
            val address = name.ifEmpty { ticket.botId.trim() }
            val text = if (address.isEmpty()) option.label else "@$address ${option.label}"
            sendBoardText(text) { ok ->
                done(if (ok) ApprovalGate.Outcome.Accepted else ApprovalGate.Outcome.Failed(null))
            }
            return
        }
        answerByTicket(ticket, option.label, done)
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

    // 顶栏会话弹层与 drawer「会话管理」共用同一份真源：由 CrewScreen 的 showSessions 统一控制，
    // 两页（聊天 / 任务）都走这同一个 state 和同一个弹层，不各写一份、不出现「启用了却点了没反应」。
    val openSessions = { showSessions = true }
    // 打开名片：两页共用。任务页（Triage）没有自己的名片渲染层，这里统一切到聊天页再开名片，
    // 保证「资料」在两页都真实可达；切页不动 draft（草稿归 CrewRoot，mode 只切渲染）。
    val openProfile: (BotCard) -> Unit = { bot ->
        profile = bot
        if (mode != Mode.Chat) switchMode(Mode.Chat)
        scope.launch { drawerState.close() }
        Unit
    }
    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            CrewDrawerSheet(
                palette = if (mode == Mode.Triage) TriagePalette else palette,
                mode = mode, bots = conversation?.bots.orEmpty(),
                recipientId = currentRecipientId(draft, conversation?.bots.orEmpty()),
                defaultBotId = defaultBotId,
                noticeCount = notices.size,
                // 通知行：关 drawer + 切聊天 + 置跳转标记（实际滚动在聊天分支列表挂载后执行）。
                onOpenNotices = {
                    switchMode(Mode.Chat)
                    pendingNoticeJump = true
                    scope.launch { drawerState.close() }
                },
                onPickRecipient = { bot ->
                    onDraft(Recipient.select(draft, bot, conversation?.bots.orEmpty()))
                    scope.launch { drawerState.close() }
                },
                onOpenProfile = openProfile,
                onNavChat = { switchMode(Mode.Chat); scope.launch { drawerState.close() } },
                onNavTasks = { switchMode(Mode.Triage); scope.launch { drawerState.close() } },
                // 「会话管理」打开真实 SessionBar 弹层（与顶栏点会话同一真源），不再只是关 drawer。
                onSessions = { openSessions(); scope.launch { drawerState.close() } },
                canSessions = sessionSwitchable && sessionState != null,
                onModels = { onModels(); scope.launch { drawerState.close() } },
                onBackend = { onBackend(); scope.launch { drawerState.close() } },
                onWorkspace = { onWorkspace(null); scope.launch { drawerState.close() } },
                hasWorkspace = conversation != null,
                // 诊断：关 drawer + 开诊断页（覆盖层）。放侧栏工具，不加常驻排。
                onDiag = { diagOpen = true; scope.launch { drawerState.close() } },
                onUpdate = { otaOpen = true; scope.launch { drawerState.close() } },
            )
        },
    ) {
    if (mode == Mode.Triage) {
        Column(modifier = Modifier.fillMaxSize()) {
            CrewTopBar(
                route = route, connLoading = connLoading, problem = problem, palette = TriagePalette,
                onRefresh = onRefresh,
                title = CrewNavigation.topBarTitle(mode, sessionLabel), sessionSwitchable = sessionSwitchable,
                sessionState = sessionState, onSwitchSession = onSwitchSession, onCreateSession = onCreateSession,
                onOpenDrawer = { scope.launch { drawerState.open() } },
                sessionsOpen = showSessions, onOpenSessions = { openSessions() }, onCloseSessions = { showSessions = false },
            )
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
            // 名片 overlay 在两页共用：任务页点「资料」切到聊天页后，这里同一层渲染名片（见下）。
            ProfileOverlay(profile, conversation, palette, draft,
                onDismiss = { profile = null },
                onTalk = { shownProfile, bots ->
                    profile = null
                    onDraft(Recipient.select(draft, shownProfile, bots))
                    focusComposerAfterTalk = true
                },
                onEdit = { shownProfile -> profile = null; editing = shownProfile },
                onWorkspace = { profile = null; onWorkspace(it) })
        }
    } else {
    Column(modifier = Modifier.fillMaxSize()) {
        var followIntent by remember(sessionId) { mutableStateOf(TimelineFollowIntent()) }
        var userDragPending by remember(sessionId) { mutableStateOf(false) }
        val timelineDragState = listState.interactionSource.collectIsDraggedAsState()
        val timelineDragged by timelineDragState
        fun isTimelineAtBottom(): Boolean {
            val info = listState.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull() ?: return true
            return timelineIsAtBottom(
                lastItemIndex = last.index,
                totalItemsCount = info.totalItemsCount,
                viewportEndOffset = info.viewportEndOffset,
                lastItemEndOffset = last.offset + last.size,
            )
        }

        LaunchedEffect(sessionId, timelineDragged) {
            if (timelineDragged) {
                userDragPending = true
            } else if (userDragPending) {
                snapshotFlow { listState.isScrollInProgress }.first { !it }
                followIntent = followIntent.onUserScrollSettled(isTimelineAtBottom())
                userDragPending = false
            }
        }

        // 单行顶栏 56：menu · 当前会话 · 连接状态。无模式行 / 成员横条 / 更多⋯。
        CrewTopBar(
            route = route, connLoading = connLoading, problem = problem, palette = palette,
            onRefresh = onRefresh,
            title = CrewNavigation.topBarTitle(mode, sessionLabel), sessionSwitchable = sessionSwitchable,
            sessionState = sessionState, onSwitchSession = onSwitchSession, onCreateSession = onCreateSession,
            onOpenDrawer = { scope.launch { drawerState.open() } },
            sessionsOpen = showSessions, onOpenSessions = { openSessions() }, onCloseSessions = { showSessions = false },
        )
        // 事务板/分拣台点一条：切回群聊并滚到那句话（ticket_ref 对不上的行不会走到这里）。
        // 通知现在作为 LazyColumn 首项插入：消息的列表索引 = 消息在 messages 里的索引 + 偏移。
        LaunchedEffect(pendingJump) {
            val messageId = pendingJump ?: return@LaunchedEffect
            val index = conversation?.messages?.indexOfFirst { it.id == messageId } ?: -1
            val offset = if (notices.isNotEmpty()) messagesListOffsetIfNotice else 0
            if (index >= 0) {
                followIntent = followIntent.stopFollowing()
                listState.animateScrollToItem(index + offset)
            }
            pendingJump = null
        }
        // 通知行点了：等列表挂载后滚到首项通知摘要（index 来自纯函数，不伪造 message id、不发请求）。
        // 等一帧确保列表已量出高度；滚完清标记，不重复触发。
        LaunchedEffect(pendingNoticeJump) {
            if (!pendingNoticeJump) return@LaunchedEffect
            val target = CrewNavigation.noticeItemIndex(notices.isNotEmpty())
            if (target >= 0) {
                followIntent = followIntent.stopFollowing()
                withFrameNanos { }
                listState.scrollToItem(target)
            }
            pendingNoticeJump = false
        }
        // 名片「跟他说话」后的聚焦：**不在固定帧数后盲 requestFocus**（那时 TextField 可能还没挂上，
        // requestFocus 会抛「not initialized」）。改为把 armed 标记传给 ComposerRow，由 TextField 自身
        // 的 onGloballyPositioned 在真正挂上后一次性 requestFocus + keyboard.show，成功后回调清标记。
        // 只由显式 onTalk 置位，不在导航/进页时自动弹键盘、不抢系统焦点。
        val shown = conversation
        if (shown != null) {
            when {
                // 只按 bots 判：消息可能是「名字读不出来」的残留，那也还是没人的队伍。
                // 建完人就刷新整段对话：花名册从后端重读，读到的才是真的。
                shown.bots.isEmpty() ->
                    EmptyState(client, palette, onBackend, onCreated = onSent)
                else -> {
                    // 名片 overlay：两页共用同一渲染（聊天/任务都在这层之上，切到聊天再开也不丢 draft）。
                    ProfileOverlay(profile, shown, palette, draft,
                        onDismiss = { profile = null },
                        onTalk = { shownProfile, bots ->
                            profile = null
                            onDraft(Recipient.select(draft, shownProfile, bots))
                            focusComposerAfterTalk = true
                        },
                        onEdit = { shownProfile -> profile = null; editing = shownProfile },
                        onWorkspace = { profile = null; onWorkspace(it) })
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
                    val queuedRequestIds = remember(sessionId, shown.queued) { shown.queued.toSet() }
                    val steerTicketId = shown.tickets.firstOrNull { it.open }?.id
                    val subagentTicket = SubagentCardSelection.ticket(shown.tickets, expandedSubagentTicketId)
                    // 业务动作失败/待确认：**按请求归属**，各自带原文片段与自己的操作。
                    // 从前这里只有一格、只读 message，于是「A 失败、改字发 B 成功」之后
                    // A 的失败还挂在那儿冒充刚才那条的结果。
                    storeTrouble?.let {
                        Text(
                            it, color = palette.danger, fontSize = 12.sp,
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 4.dp),
                        )
                    }
                    sendNotes.forEach { note ->
                        Text(
                            note.message, color = palette.danger, fontSize = 12.sp,
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 2.dp),
                        )
                    }
                    // 盘上还没确认的发送：给总数与逐条入口，不只留一行看不清归属的提示。
                    if (sendRecoveries.isNotEmpty()) {
                        Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 4.dp)) {
                            Text(
                                "另有 ${sendRecoveries.size} 条发送结果待确认",
                                color = palette.warn, fontSize = 12.sp,
                            )
                            sendRecoveries.forEach { send ->
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(
                                        "· ${send.excerpt()}",
                                        color = palette.muted, fontSize = 11.5.sp,
                                        maxLines = 1,
                                        modifier = Modifier.weight(1f),
                                    )
                                    TextButton(onClick = { onRetryRecovered(send) }) {
                                        Text(SendCopy.RETRY, color = palette.accent, fontSize = 11.sp)
                                    }
                                    TextButton(onClick = { onForgetRecovered(send.requestId) }) {
                                        Text(SendCopy.FORGET, color = palette.faint, fontSize = 11.sp)
                                    }
                                }
                            }
                        }
                    }
                    // 活动这一层读不到时如实标一句，但不覆盖上一次事实（不清空已有活动行）。
                    if (activityStale) {
                        Text(
                            ActivityCopy.STALE, color = palette.faint, fontSize = 11.sp,
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 2.dp),
                        )
                    }
                    // notices 拉取失败的健康信息也单独一行（不吞错误、不常驻成功态）。
                    noticesWarning?.let {
                        Text(
                            "推送拉取：$it", color = palette.accent, fontSize = 11.sp,
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 2.dp),
                        )
                    }
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
                        // 通知：列表内首项，随消息一起滚；默认一行摘要可展开，不常驻、不固定挤高度。
                        if (notices.isNotEmpty()) {
                            item(key = "notice") { NoticeSummary(notices, palette) }
                        }
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
                                showResult = resultEnds.getOrElse(index) { false },
                                sessionId = sessionId,
                                queuedRequestIds = queuedRequestIds,
                                steerTicketId = steerTicketId,
                                onActionCompleted = onSent,
                                onContentChanged = { timelineTailRevision += 1 },
                                // 活动按 request_id 挂到那条用户消息上；回话条目不挂。
                                activity = if (message.fromBot) null else activityByRequest[message.requestId]?.activity,
                                // 只有这条请求自己的票在等问题卡时，收据才说「等你答复」。
                                awaitingAnswer = shown.tickets.any { ticket ->
                                    ticket.open && ticket.needsPerson.isNotEmpty() && ticket.question.isNotBlank() &&
                                        (message.ticketRef.isEmpty() || message.ticketRef == ticket.id)
                                },
                            )
                        }
                        if (shown.tickets.any { it.open && it.needsPerson.isNotEmpty() }) {
                            // 「等你决定」只显示当前仍在等人的工单。
                            item(key = "tickets") {
                                TicketStrip(
                                    shown, palette, client,
                                    sessionId = sessionId,
                                    onPrefill = { name ->
                                        if (draft.isEmpty()) onDraft(if (name.isEmpty()) "" else "@$name ")
                                    },
                                    onSent = onSent,
                                    onOpenAllPending = { boardOpen = true },
                                )
                            }
                        }
                        if (subagentTicket != null) {
                            item(key = "subagents-${subagentTicket.id}") {
                                SubagentCard(
                                    client = client,
                                    ticket = subagentTicket,
                                    cache = agents,
                                    generation = timelineEpoch,
                                    palette = palette,
                                    open = expandedSubagentTicketId == subagentTicket.id,
                                    onExpandedChange = { open ->
                                        onExpandedSubagentChange(if (open) subagentTicket.id else null)
                                    },
                                    onContentChanged = { timelineTailRevision += 1 },
                                )
                            }
                        }
                    }
                    // 消息变更只用稳定 id 触发；是否继续跟随由用户滚动结束时保存的意图决定。
                    val lastMessageId = shown.messages.lastOrNull()?.id ?: ""
                    // 进对话屏 / 有新回话时，把主人读到的最后一条回话 id 报上去（契约 §5.6）。
                    // 只报队伍回的最后一条；还没收到任何回话就不报 —— 报了等于替主人说「都看过了」。
                    val lastAgentId = shown.messages.lastOrNull { it.fromBot }?.id ?: ""
                    LaunchedEffect(lastAgentId) {
                        if (lastAgentId.isNotEmpty()) client.reportRead(lastAgentId, sessionId)
                    }
                    // IME 改变视口时沿用阅读意图；消息 id 没变也要把正在跟随的尾部留在屏内。
                    LaunchedEffect(sessionId) {
                        snapshotFlow { listState.layoutInfo.viewportSize }.collect {
                            if (!timelineDragState.value && !userDragPending &&
                                !listState.isScrollInProgress &&
                                followIntent.shouldAutoScroll(isScrollInProgress = false)) {
                                val lastIdx = listState.layoutInfo.totalItemsCount - 1
                                if (lastIdx >= 0) listState.scrollToItem(lastIdx, Int.MAX_VALUE)
                            }
                        }
                    }
                    LaunchedEffect(
                        sessionId, lastMessageId, shown.tickets, notices.size,
                        subagentTicket?.id, expandedSubagentTicketId, timelineTailRevision,
                        timelineDragged, userDragPending,
                    ) {
                        if (timelineDragged || userDragPending || listState.isScrollInProgress) {
                            return@LaunchedEffect
                        }
                        if (!followIntent.shouldAutoScroll(isScrollInProgress = false)) return@LaunchedEffect
                        withFrameNanos { }
                        if (!timelineDragState.value && !userDragPending && !listState.isScrollInProgress &&
                            followIntent.shouldAutoScroll(isScrollInProgress = listState.isScrollInProgress)) {
                            val lastIdx = listState.layoutInfo.totalItemsCount - 1
                            if (lastIdx >= 0) listState.scrollToItem(lastIdx, Int.MAX_VALUE)
                        }
                    }
                    // 连不上就别让人发：发出去也到不了，还让人以为发了。
                    Composer(
                        draft = draft,
                        declinedReason = shown.declined.lastOrNull()?.reason,
                        steerTextNote = steerTextNote,
                        sending = sending,
                        palette = palette,
                        enabled = problem == null,
                        onChange = onDraft,
                        focusRequester = composerFocus,
                        focusWhenPlaced = focusComposerAfterTalk,
                        onFocusHandled = { focusComposerAfterTalk = false },
                        recipientLabel = CrewNavigation.recipientLabel(draft, shown.bots, defaultBotId),
                        onOpenRecipient = { scope.launch { drawerState.open() } },
                        steerTicketId = steerTicketId,
                        onSteerText = { ticketId ->
                            val text = draft
                            val requestId = requestIdFor(text)
                            val owner = SendOwner(sessionId ?: SessionRoute.MAIN, requestId, text)
                            steerTextNote = null
                            onSending(owner, true)
                            scope.launch {
                                try {
                                    client.steerText(ticketId, requestId, text, sessionId)
                                    onSendSucceeded(owner)
                                    steerTextNote = "已插话，队伍做完当前这一步会先处理这句"
                                } catch (error: CancellationException) {
                                    throw error
                                } catch (error: Exception) {
                                    // 插话也走 POST：异常时同样只是「结果待确认」。
                                    onSendFailed(owner, error.message ?: "插队没成功", true)
                                } finally {
                                    onSending(owner, false)
                                }
                            }
                        },
                    ) {
                        // 发送的唯一入口：落盘 → POST → 按结局收口，都在 CrewRoot 里。
                        onSendNow(draft, CrewWire.mentionsIn(draft, shown.bots))
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
    // 诊断页：覆盖层，从侧栏工具进来，不常驻。压在内容之上，关掉即回。
    if (diagOpen) {
        DiagPage(
            palette = palette,
            diag = DiagRuntime.get(androidx.compose.ui.platform.LocalContext.current.applicationContext),
            onClose = { diagOpen = false },
        )
    }
    // 检查更新页：覆盖层，与诊断同一层做法；关掉即回原页，不留常驻状态。
    if (otaOpen) {
        OtaPage(palette = palette, onClose = { otaOpen = false })
    }
    }
    }
}

/**
 * 当前收件人的显式 id：正文里 @ 了已知成员就是第一位；没点名返回 null（由调用方再落到后端默认）。
 * 与 [CrewNavigation.recipientLabel] 同口径，只把「名字」换回「id」给成员行高亮用。
 */
private fun currentRecipientId(draft: String, bots: List<BotCard>): String? {
    val name = Recipient.primaryRecipient(draft, bots) ?: return null
    return bots.firstOrNull { Recipient.label(it) == name }?.id
}

/**
 * 单行顶栏（56dp）：汉堡 menu(48) · 当前会话名(可点切换会话，占可用宽) · 连接状态(短词≤76dp，48命中，点开详情)。
 *
 * 不再常驻模式行 / 成员横条 / 「更多⋯」/ 独立通知块 —— 它们的入口全部下沉到 [CrewDrawerSheet]。
 * 会话胶囊是**唯一**会话入口的外层触发：点它弹出现有 [SessionBar] 管理面板（切/建/错误），
 * 真源仍是 CrewRoot 的 sessionState —— 这里不建第二份会话状态。
 * 连接状态复用 task-2 的 [CrewConnectionStatus]（compact），只画传入的 route/loading/problem。
 */
@Composable
private fun CrewTopBar(
    route: String,
    connLoading: Boolean,
    problem: String?,
    palette: CrewPalette,
    onRefresh: () -> Unit,
    title: String,
    sessionSwitchable: Boolean,
    sessionState: SessionState?,
    onSwitchSession: (String) -> Unit,
    onCreateSession: (String) -> Unit,
    onOpenDrawer: () -> Unit,
    /** 会话弹层是否展开（由 CrewScreen 单一真源控制，drawer「会话管理」也开同一个）。 */
    sessionsOpen: Boolean,
    onOpenSessions: () -> Unit,
    onCloseSessions: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(56.dp)
            .background(palette.card)
            .padding(horizontal = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        // 汉堡：48×48 命中，打开原生侧边栏。
        Box(
            modifier = Modifier
                .size(48.dp)
                .clip(RoundedCornerShape(10.dp))
                .clickable(onClick = onOpenDrawer)
                .semantics { contentDescription = "打开侧边栏" },
            contentAlignment = Alignment.Center,
        ) {
            Text("☰", fontSize = 18.sp, color = palette.ink)
        }
        // 当前会话名：占可用宽、单行 ellipsis；可切换时才可点（老后端锁 main 就只读显示）。
        Box(
            modifier = Modifier
                .weight(1f)
                .height(48.dp)
                .clip(RoundedCornerShape(9.dp))
                .clickable(enabled = sessionSwitchable && sessionState != null) { onOpenSessions() }
                .padding(horizontal = 8.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            Text(
                text = if (sessionSwitchable) "$title ▾" else title,
                fontSize = 15.sp, fontWeight = FontWeight.SemiBold, color = palette.ink,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        // 右：连接状态，单短词限宽 76dp、48 命中，点开连接详情。
        CrewConnectionStatus(
            route = route, loading = connLoading, problem = problem, palette = palette,
            onRefresh = onRefresh, compact = true,
            modifier = Modifier.widthIn(max = 76.dp).heightIn(min = 48.dp),
        )
    }
    // 会话管理弹层：复用现有 SessionBar（切/建/错误），真源不变；由 CrewScreen 单一真源 sessionsOpen 控制。
    if (sessionsOpen && sessionState != null) {
        AlertDialog(
            onDismissRequest = onCloseSessions,
            confirmButton = { TextButton(onClick = onCloseSessions) { Text("关闭", color = palette.accent) } },
            title = { Text("会话", color = palette.ink, fontSize = 15.sp) },
            text = {
                SessionBar(
                    state = sessionState,
                    palette = palette,
                    onSwitch = { id -> onSwitchSession(id); onCloseSessions() },
                    onCreate = { id -> onCreateSession(id) },
                    onDismissError = onCloseSessions,
                )
            },
        )
    }
}

/**
 * 侧边栏（原生 [ModalNavigationDrawer] 的 sheet，约 300dp、可滚、系统 back / 点遮罩关、右圆角 16）。
 *
 * 三段，按冻结设计自上而下：
 *  1. 导航：聊天 / 任务。选中态 = 当前页（[CrewNavigation.selectedNav]）。
 *  2. 成员·选收件人：花名册，行主体点=把该成员设为收件人（[Recipient.select] 落 @名字）；
 *     行尾独立「资料」48 按钮 = 名片/人设/屏幕的显式入口（不再只靠长按藏起来）。
 *     成员选中态 = 实际主收件人，与导航选中态各自独立。
 *  3. 工具：事务板 / 会话管理 / 模型 / 后台 / 屏幕（全部落到既有入口，不新造）。
 *
 * 所有交互 ≥48dp 命中。成员是「收件人」选择，不是在线状态；没有在线语义、不编造数据。
 */
/**
 * LazyColumn 里消息项相对列表顶部的偏移：通知存在时它占首项（key="notice"），消息从第 1 项开始；
 * 没通知时为 0。pendingJump / 滚到底等「按消息索引定位」的地方统一加这个偏移，
 * 避免「跳一条」落到通知项、或滚到底落错一格。
 */
private const val messagesListOffsetIfNotice = 1

/**
 * 通知摘要：列表内首项（可随消息滚走）。默认一行摘要，点整行（≥48 命中）展开看全部，
 * 不删除任何一条历史、不常驻挤高度。
 */
@Composable
private fun NoticeSummary(notices: List<CrewNotice>, palette: CrewPalette) {
    var open by remember { mutableStateOf(false) }
    val first = notices.first()
    Column(
        modifier = Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(palette.accentSoft),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp)
                .clickable { open = !open }
                .padding(horizontal = 12.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                "有事记得看一下 · ${notices.size}",
                fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = palette.accent,
            )
            Text(
                if (first.title.isNotBlank()) "${first.title}：${first.body}" else first.body,
                fontSize = 12.sp, color = palette.ink,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Text(if (open) "收起" else "展开", fontSize = 11.sp, color = palette.accent)
        }
        if (open) {
            for (notice in notices) {
                Text(
                    text = if (notice.title.isNotBlank()) "${notice.title}：${notice.body}" else notice.body,
                    fontSize = 12.sp, color = palette.ink, maxLines = 4,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 2.dp),
                )
            }
        }
    }
}

/**
 * 名片 overlay：聊天页与任务页共用同一份渲染与回调。
 *
 * profile 为 null 时什么都不画（其余时刻整屏铺开 [BotCardSheet]）。四个回调都落到 CrewScreen 的
 * 同一套状态上：onTalk=关名片+@这位落草稿+延迟聚焦（不丢 draft）；onEdit=让位给编辑层；
 * onWorkspace=关名片进工作区；onDismiss=关名片。两页因此不各写一份、也不出现「点了没反应」。
 */
@Composable
private fun ProfileOverlay(
    profile: BotCard?,
    conversation: Conversation?,
    palette: CrewPalette,
    draft: String,
    onDismiss: () -> Unit,
    onTalk: (BotCard, List<BotCard>) -> Unit,
    onEdit: (BotCard) -> Unit,
    onWorkspace: (BotCard) -> Unit,
) {
    if (profile == null || conversation == null) return
    BotCardSheet(profile, conversation, palette,
        onTalk = { onTalk(profile, conversation.bots) },
        onClose = onDismiss,
        onEdit = { onEdit(profile) },
    ) { onWorkspace(it) }
}

@Composable
private fun CrewDrawerSheet(    palette: CrewPalette,
    mode: Mode,
    bots: List<BotCard>,
    recipientId: String?,
    defaultBotId: String,
    noticeCount: Int,
    onOpenNotices: () -> Unit,
    onPickRecipient: (BotCard) -> Unit,
    onOpenProfile: (BotCard) -> Unit,
    onNavChat: () -> Unit,
    onNavTasks: () -> Unit,
    onSessions: () -> Unit,
    canSessions: Boolean,
    onModels: () -> Unit,
    onBackend: () -> Unit,
    onWorkspace: () -> Unit,
    hasWorkspace: Boolean,
    onDiag: () -> Unit,
    onUpdate: () -> Unit,
) {
    ModalDrawerSheet(
        modifier = Modifier.widthIn(max = 300.dp),
        drawerShape = RoundedCornerShape(topEnd = 16.dp, bottomEnd = 16.dp),
        drawerContainerColor = palette.surface,
    ) {
        // 头：品牌 + 当前会话（示例态，不编造）。可滚内容从导航开始。
        Column(modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 20.dp, bottom = 12.dp)) {
            Text("Bot Crew", fontSize = 16.sp, fontWeight = FontWeight.Bold, color = palette.ink)
        }
        Column(
            modifier = Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(bottom = 16.dp),
        ) {
            DrawerSectionLabel("导航", palette, first = true)
            val nav = CrewNavigation.selectedNav(mode)
            DrawerNavItem(NavEntry.Chat.label, selected = nav == NavEntry.Chat, palette) { onNavChat() }
            DrawerNavItem(NavEntry.Tasks.label, selected = nav == NavEntry.Tasks, palette) { onNavTasks() }
            // 通知：仅有通知时才画，计数真实 noticeCount。点它回聊天并把列表滚到首项摘要（不伪造消息、不发请求）。
            val noticeLabel = CrewNavigation.noticeRowLabel(noticeCount)
            if (noticeLabel.isNotEmpty()) {
                DrawerNavItem(noticeLabel, selected = false, palette) { onOpenNotices() }
            }

            DrawerSectionLabel("成员 · 选收件人", palette)
            for (bot in bots) {
                DrawerMemberRow(
                    bot = bot,
                    selected = bot.id == effectiveRecipientId(recipientId, bots, defaultBotId),
                    palette = palette,
                    onSelect = { onPickRecipient(bot) },
                    onProfile = { onOpenProfile(bot) },
                )
            }

            DrawerSectionLabel("工具", palette)
            if (canSessions) DrawerToolItem("会话管理", palette) { onSessions() }
            DrawerToolItem("模型", palette) { onModels() }
            DrawerToolItem("后台", palette) { onBackend() }
            DrawerToolItem("屏幕", palette = palette, enabled = hasWorkspace) { onWorkspace() }
            // 诊断：App 自身诊断的查看/复制/导出/补传/开关。放侧栏工具，不加顶部常驻排。
            DrawerToolItem("诊断", palette) { onDiag() }
            // 更新：检查/下载/校验/交系统安装器。入口只在这里，不常驻、不弹窗、不自动装。
            DrawerToolItem("检查更新", palette) { onUpdate() }
        }
    }
}

/** 成员行该亮哪一格：显式收件人优先，没点名就用后端默认（与 [CrewNavigation.recipientLabel] 同口径）。 */
private fun effectiveRecipientId(recipientId: String?, bots: List<BotCard>, defaultBotId: String): String? {
    if (recipientId != null) return recipientId
    val id = defaultBotId.trim()
    return if (id.isNotEmpty() && bots.any { it.id == id }) id else null
}

/**
 * 分组标题（导航 / 成员 / 工具）。
 *
 * 实机上三组读不出来：组内一行的间距是 180px（文字顶到文字顶），组与组之间只有 188px ——
 * 差 8px 等于没差，一整条侧栏看着像一长串同级的行。
 *
 * 现在两条一起给层级：组与组之间拉开到组内的 1.5 倍以上（[DRAWER_GROUP_TOP]），
 * 并在非首组的上方压一条 1px 细分割线；字重从 Medium 提到 SemiBold、颜色从 faint 提到 muted。
 * 不用大色块 —— 侧栏里一坨底色比没有层级更吵。
 */
@Composable
private fun DrawerSectionLabel(text: String, palette: CrewPalette, first: Boolean = false) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(
                start = 20.dp,
                end = 20.dp,
                top = if (first) DRAWER_FIRST_TOP else DRAWER_GROUP_TOP,
                bottom = 6.dp,
            ),
    ) {
        if (!first) {
            HorizontalDivider(
                color = palette.line,
                thickness = 1.dp,
                modifier = Modifier.padding(bottom = DRAWER_DIVIDER_GAP),
            )
        }
        Text(text, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = palette.muted)
    }
}


/**
 * 组与组之间，组标题上方留出的间距。
 *
 * 实机账（ui-drawer.xml，px ÷ 2 是 dp；「边界」= 上一组末行文字顶 → 下一组标题文字顶）：
 * - 导航组内文字顶 574 → 754 → 934，组内 180px；末行（934）到「成员」标题（1122）只有 188px；
 * - 成员组内文字顶 1281 → 1477 → 1673，组内 196px；末行（1673）到「工具」标题（1868）只有 195px。
 * 两处都几乎是「没差」，一整条侧栏读着像一长串同级行。要求：组间 ≥ 组内 1.5 倍，
 * 即导航边界 ≥ 270px、成员边界 ≥ 294px。
 *
 * 原实现的标题块只有 14dp（28px）上距，所以「末行文字顶 → 标题块上沿」的固定部分
 * 导航是 160px、成员是 167px。要让成员边界到 294px，标题块（上距 + 分割线 1dp + 线下间距）
 * 至少要 (294-167)/2 ≈ 64dp。这里给 40 + 1 + 28 = 69dp：
 * 导航边界 298px（组内的 1.66 倍）、成员边界 305px（1.56 倍），两个读数都过线。
 * 分割线放在间距里偏下、贴近它引出的标题 —— 它是「下一组从这里开始」，不是上一组的尾巴。
 */
private val DRAWER_GROUP_TOP = 40.dp

/** 分割线与它引出的组标题之间的间距（账见 [DRAWER_GROUP_TOP]）。 */
private val DRAWER_DIVIDER_GAP = 28.dp

/** 首组上方不需要分割线，也不需要那么大的间隔。 */
private val DRAWER_FIRST_TOP = 8.dp

/** 导航项：48dp 命中，选中态用 accentSoft 底 + accent 字。 */
@Composable
private fun DrawerNavItem(label: String, selected: Boolean, palette: CrewPalette, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .padding(horizontal = 10.dp, vertical = 2.dp)
            .clip(RoundedCornerShape(9.dp))
            .background(if (selected) palette.accentSoft else Color.Transparent)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        Text(
            label, fontSize = 14.sp,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
            color = if (selected) palette.accent else palette.ink,
        )
    }
}

/** 成员行：行主体（点=选收件人）+ 行尾「资料」48 按钮（开名片）。两者命中各自 ≥48。 */
@Composable
private fun DrawerMemberRow(
    bot: BotCard,
    selected: Boolean,
    palette: CrewPalette,
    onSelect: () -> Unit,
    onProfile: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .padding(horizontal = 10.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // 行主体：点=选收件人。48 命中高度；选中态用语义色彩，不冒充在线。
        Row(
            modifier = Modifier
                .weight(1f)
                .heightIn(min = 48.dp)
                .clip(RoundedCornerShape(9.dp))
                .background(if (selected) palette.accentSoft else Color.Transparent)
                .clickable(onClick = onSelect)
                .padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Box(
                modifier = Modifier.size(28.dp).clip(RoundedCornerShape(8.dp)).background(palette.accent),
                contentAlignment = Alignment.Center,
            ) {
                Text(bot.name.take(1), fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = palette.surface)
            }
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    bot.name.ifBlank { bot.id }, fontSize = 14.sp,
                    fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                    color = if (selected) palette.accent else palette.ink,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                val roleText = CrewNavigation.roleLabel(bot.role)
                if (roleText.isNotEmpty()) {
                    Text(
                        roleText, fontSize = 11.sp, color = palette.faint,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        // 行尾「资料」：独立的 48 命中按钮（名片/人设/屏幕显式入口，不藏在长按里）。
        Box(
            modifier = Modifier
                .size(48.dp)
                .clip(RoundedCornerShape(9.dp))
                .clickable(onClick = onProfile)
                .semantics { contentDescription = "查看${bot.name.ifBlank { bot.id }}的资料" },
            contentAlignment = Alignment.Center,
        ) {
            Text("资料", fontSize = 12.sp, color = palette.accent)
        }
    }
}

/** 工具项：48dp 命中；不可用时灰显（如没有对话就没有「屏幕」）。 */
@Composable
private fun DrawerToolItem(label: String, palette: CrewPalette, enabled: Boolean = true, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .padding(horizontal = 10.dp, vertical = 2.dp)
            .clip(RoundedCornerShape(9.dp))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 12.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        Text(label, fontSize = 14.sp, color = if (enabled) palette.ink else palette.hint)
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
 * 工作区暂停按钮按一下要做的那件事。
 *
 * [target] 是**目标**状态，不是当前状态：`setPaused(target)` 里 `target == true` 走 pause、
 * `false` 走 resume。传当前状态进去等于「按了让它停，它反而继续」—— 这个方向错在 Compose
 * 的点击闭包里看不出来（字是对的、状态位也真的翻了），只有把「算出目标」这一步抽成函数、
 * 和 [WorkspaceCopy.pauseLabel] 摆在一起断言才钉得住。
 *
 * [ticketId] 是作用对象：屏幕上显示的是哪张票就作用在哪张（[preview] 优先），都没有就是全局。
 */
data class PausePress(val target: Boolean, val ticketId: String?)

fun pausePress(paused: Boolean, preview: String?, ticket: String?): PausePress =
    PausePress(target = !paused, ticketId = preview ?: ticket)

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
    /**
     * 停一下 / 继续执行。挂到 CrewRoot.setPaused 上 —— 按钮与调试口共用同一条实现，
     * 这里只负责把结果写进页面（成功的话术，或失败原话）。
     */
    onSetPaused: suspend (Boolean, String?) -> String,
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
                    label = WorkspaceCopy.pauseLabel(paused)) {
                    if (busy) return@WorkspaceButton
                    // 传出去的是**目标**（取反），不是当前状态 —— 方向算在 pausePress 一处，
                    // 那里有断言钉着「目标必须与按钮这句话一致」。
                    val press = pausePress(paused, preview, ticket?.id)
                    busy = true
                    scope.launch {
                        try {
                            // 有票就带上票；没有票就全局停 —— 后端会如实回 scope。
                            // 状态位与回执话术都在 onSetPaused 里（CrewRoot.setPaused），
                            // 调试口按同一条路走，这里不另写一份。
                            touched = onSetPaused(press.target, press.ticketId)
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

/** 角标文字：超过 99 说「99+」，不让徽标跟着条数一起变宽（15dp 胶囊放不下三位数）。 */
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
 *
 * 实机量出来的四件事也落在这里（都是「这一块长得不像它该长的样子」）：
 * - 409 不再等于「这张卡已更新」：判不出更新的 attention 就一个字都不提示（[AttentionSupersede]）；
 * - 卡内输入行默认收起，只有选了「修改内容」才展开，并且和底部聊天输入长得不一样；
 * - 元信息与正文之间留出更大间隔、小一号、次要色；
 * - 详情区等宽小字 + 浅底 + 分节 + 限高滚动，原文一个字不改。
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
    /** 还有别的待决定时，去那边逐项看（事务板的「待你」那一栏）。 */
    onOpenAllPending: () -> Unit = {},
) {
    // 聊天里只**详细**展开一张，但要把「还有几项」说清并给出逐项入口 ——
    // 从前只画 firstOrNull，第一张没处理时其余几项在聊天里一点影子都没有。
    val pending = conversation.tickets.filter { it.open && it.needsPerson.isNotEmpty() }
    val waiting = pending.firstOrNull() ?: return
    // 这一组问题就是这张卡的身份：换了问题或换了选项，下面两行状态一起作废
    // （契约 §5：后台重新下发整组 options，旧的一组随即作废，前端不缓存旧选项）。
    val signature = CrewWire.answerSignature(waiting)
    // 同题互斥闸门：任一时刻这张卡只允许一个答复在途；HTTP 成功=已受理继续锁，等时间线收敛才解锁。
    // ticketKey 含 attention_id：换票/换卡即换 holder，旧请求回来只更新旧 holder，不污染新卡。
    val gate = rememberApprovalGate("${waiting.id}|${waiting.attentionId}", signature)
    val scope = rememberCoroutineScope()
    val botName = conversation.bots.firstOrNull { it.id == waiting.botId }?.name?.trim().orEmpty()
    // 点名用名字：手机上人认的是名片上那两个字。这一位不在花名册上（或名字空着）时退回 id ——
    // 与桌面端 nameOf 同一条规矩：宁可 @ 一个 id，也不能把回答滑给默认那位。
    val address = botName.ifEmpty { waiting.botId.trim() }
    fun addressed(text: String) = if (address.isEmpty()) text else "@$address $text"
    // 这张卡是不是审批卡：后端下发了 attention_id 的才是。是就**必须**走审批通道 /answer，
    // 拼 @label 发 /send 会让引擎起一段新活而不是回这张卡。老后端没这字段 → 退回 /send，逐字不变。
    val isApproval = waiting.attentionId.isNotEmpty()

    // 409 之后要判「这张卡到底有没有被换成更新的一张」：记下这次答的是哪一张卡，
    // 等刷新回来的时间线再判（[AttentionSupersede]）。判不出来就一个字都不提示 ——
    // 一条指向不存在的卡的指引比没有提示更糟。
    var rejected by remember(waiting.id) { mutableStateOf<AnsweredCard?>(null) }
    val newer = rejected?.let { AttentionSupersede.judge(it, conversation.tickets) } as? Supersede.Newer

    // 卡内输入行：默认收起，只有点了「修改内容」才展开（规则见 [CardReviseInput]）。
    // choice 只按票 id 记：选了「修改内容」之后后端会换一张新卡（问「请写下新的做法」），
    // 换卡不该把刚打开的那一行又收回去。
    var choice by remember(waiting.id) { mutableStateOf<AttentionOption?>(null) }
    var revise by remember(waiting.id, signature) { mutableStateOf("") }
    val reviseOpen = CardReviseInput.expanded(choice, waiting.options)

    /** 一次答复的发射，返回结局（Accepted / Rejected / Failed）。审批卡走 /answer，否则走既有 /send。 */
    suspend fun fire(label: String): ApprovalGate.Outcome {
        return try {
            if (isApproval) {
                client.answer(waiting.id, label, waiting.attentionId, sessionId)
            } else {
                val text = addressed(label)
                client.send(text, CrewWire.mentionsIn(text, conversation.bots),
                    java.util.UUID.randomUUID().toString(), sessionId)
            }
            // 答上了：上一条「换了新卡」的提示也就没有意义了。
            rejected = null
            gate.accepted()
            onSent()
            ApprovalGate.Outcome.Accepted
        } catch (error: AnswerStale) {
            // 409 不是「已更新」的同义词：认不出这句话、票已结束都会回 409。
            // 这里只做两件事：解锁并把服务端原话照实说出来；记下答的是哪一张，等时间线判。
            rejected = AnsweredCard(waiting.id, waiting.attentionId)
            gate.rejected(error.reason)
            onSent()
            ApprovalGate.Outcome.Rejected(error.reason)
        } catch (error: Exception) {
            gate.failed(error.message)
            ApprovalGate.Outcome.Failed(error.message)
        }
    }

    /** 点某一格：准入 → 置提交中 → 发 → 按结局落状态（同题互斥靠 gate.begin）。 */
    fun answerOption(option: AttentionOption) {
        // 选「修改内容」就是这次审批的入口：点它就展开本卡输入行（不发空答复）。
        choice = option
        if (!gate.begin()) return
        scope.launch { fire(option.label) }
    }

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
        // ① 提示条在**卡片最上面**：独立浅底 + 小字 + 图标，一眼看出不是正文。
        //    只在真的拿到更新的 attention 时出现，并且一定给出一条走得通的出路。
        if (newer != null) {
            SupersedeBanner(
                onThisCard = newer.ticketId == waiting.id,
                palette = palette,
                onJump = onOpenAllPending,
                onDismiss = { rejected = null },
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("◷", color = palette.warn, fontSize = 11.sp)
            Text("等你决定", color = palette.warn, fontSize = 11.sp, fontWeight = FontWeight(620))
        }
        // 有 approval 用它的预览（真实换行）；没有就读 question；都没有才退回 needs_person 的人话。
        // 段落、加粗/行内代码、超长折叠都在纯函数里定，这里只画（见 AnswerBody）。
        AnswerBody(waiting, palette)
        // ② 这张卡要做什么、对谁做：元信息行。和正文之间留出明显更大的间隔（6+8=14dp），
        //    小一号、次要色 —— 实机上它和正文段落同距（23px）同色，读起来像正文的下一句。
        AnswerCopy.actionLine(waiting)?.let {
            Column(modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) {
                Text(it, color = palette.faint, fontSize = 10.5.sp, lineHeight = 15.sp)
            }
        }
        // ③ 细节默认折叠：工具名、参数、路径这些不该占正文，但真的要看时必须在。
        val folded = AnswerCopy.details(waiting)
        if (folded != null) {
            var openDetails by remember(waiting.id, signature) { mutableStateOf(false) }
            DetailsToggle(open = openDetails, palette = palette) { openDetails = !openDetails }
            // 原文照录：字面 \n、JSON、路径都在这里，一个字符不改；只换排版（等宽小字 + 浅底 + 分节 + 限高）。
            if (openDetails) DetailsBlock(folded, palette)
        }
        // ④ A/B：每个选项一行，左边一个序号，点一下直接答。没有选项时这一整段不画。
        val g = gate.state
        waiting.options.forEachIndexed { index, option ->
            // 同题互斥：任一答复在途/已受理，所有选项一起禁用。
            val busy = g.busy
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(palette.card, RoundedCornerShape(8.dp))
                    .border(1.dp, palette.warnEdge, RoundedCornerShape(8.dp))
                    // 发着的那一格不再接第二下：提交中说「提交中…」，不画 ✓（还没答成）。
                    .clickable(enabled = !busy) { answerOption(option) }
                    .defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
                    .padding(horizontal = 11.dp, vertical = 9.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                // 字母徽标与右边那句话**同一个行高、固定宽度、居中**：
                // 实机上字母框 90px、文字框 72px，两个顶端差 9px，看着像没对齐。
                Text(
                    if (busy && g.submitting) "…" else AnswerCopy.optionMark(index),
                    color = if (busy) palette.faint else palette.accent,
                    fontSize = 13.sp,
                    lineHeight = 19.sp,
                    fontWeight = FontWeight(620),
                    textAlign = TextAlign.Center,
                    modifier = Modifier.width(16.dp),
                )
                Text(
                    if (busy && g.submitting) "提交中…" else option.label,
                    color = if (busy) palette.faint else palette.ink,
                    fontSize = 13.sp,
                    lineHeight = 19.sp,
                )
            }
        }
        // ⑤ 这张卡自己的结果：提交中/已受理/409/失败。做成独立提示条，不再混在正文里。
        g.note?.let {
            NoteBar(it, palette, alert = g.phase == ApprovalGate.Phase.Idle)
        }
        // ⑥ 卡内输入行。审批卡才有（typed 原文带 attention_id 走 /answer，不猜票号、
        //    不把回答滑进群聊 /send）。默认收起，只有选了「修改内容」才展开。
        if (isApproval) {
            if (reviseOpen) {
                val trimmed = revise.trim()
                val busy = g.busy
                // 缩进 + 白底 + 一道 accent 描边 + 独立标签：和底部聊天输入（顶到屏幕边、
                // 浅灰底、无边框）明确不是同一个东西，截图一眼就能分开。
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(start = 12.dp)
                        .background(palette.card, RoundedCornerShape(8.dp))
                        .border(1.dp, palette.accent, RoundedCornerShape(8.dp))
                        .padding(start = 10.dp, end = 6.dp, top = 7.dp, bottom = 7.dp),
                    verticalArrangement = Arrangement.spacedBy(5.dp),
                ) {
                    Text(
                        CardReviseInput.LABEL,
                        color = palette.accent, fontSize = 10.5.sp, fontWeight = FontWeight(620),
                    )
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                        // 高度交给 OutlinedTextField 自己算：Material3 的输入域自然高度约 56dp，
                        // 硬压成 48dp 会把单行文字垂直裁掉，占位提示看起来像被切了一半。
                        // 48dp 只作为命中下限。
                        Box(
                            modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                            contentAlignment = Alignment.CenterStart,
                        ) {
                            OutlinedTextField(
                                value = revise,
                                onValueChange = { revise = it },
                                enabled = !busy,
                                singleLine = true,
                                // 占位文案不带省略号：结尾的「…」会被读成「这里被裁掉了」。
                                placeholder = { Text("写下新的做法", color = palette.muted, fontSize = 12.sp, maxLines = 1) },
                                colors = OutlinedTextFieldDefaults.colors(
                                    focusedBorderColor = Color.Transparent,
                                    unfocusedBorderColor = Color.Transparent,
                                    disabledBorderColor = Color.Transparent,
                                    focusedContainerColor = Color.Transparent,
                                    unfocusedContainerColor = Color.Transparent,
                                    disabledContainerColor = Color.Transparent,
                                ),
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                        // 48dp 命中（实机 180×180 已经合格，别改坏）；图标是画出来的箭头，不再只靠一个字。
                        Box(
                            modifier = Modifier
                                .size(48.dp)
                                .clip(RoundedCornerShape(8.dp))
                                .background(if (busy || trimmed.isEmpty()) palette.track else palette.accent)
                                .clickable(enabled = !busy && trimmed.isNotEmpty()) {
                                    if (!gate.begin()) return@clickable
                                    scope.launch {
                                        val outcome = fire(trimmed)
                                        if (outcome is ApprovalGate.Outcome.Accepted) revise = ""
                                    }
                                }
                                .semantics { contentDescription = "回这一句，只影响这一次审批" },
                            contentAlignment = Alignment.Center,
                        ) {
                            ReplyGlyph(if (busy || trimmed.isEmpty()) palette.faint else palette.surface)
                        }
                    }
                    // 说明小字从 hint 提到 faint：hint 是「比 faint 更淡」的那一档，
                    // 白底上读不清（真机截图里几乎看不见）。
                    Text(CardReviseInput.HINT, color = palette.faint, fontSize = 10.5.sp, lineHeight = 15.sp)
                }
            }
        } else {
            // 老后端没 attention_id 的卡保持原样：点一下把在等的人带进输入框，仍走普通 /send。
            // 但它不再冒充聊天输入框（浅灰底 + 无边框 + 顶边对齐），而是一个「带进下面输入框」的动作块。
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 12.dp)
                    .heightIn(min = 48.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .border(1.dp, palette.line, RoundedCornerShape(8.dp))
                    .clickable { onPrefill(address) }
                    .padding(start = 10.dp, end = 6.dp)
                    .semantics { contentDescription = "把这句话带进下面的输入框" },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    "要回这一句？带进下面的输入框",
                    color = palette.muted, fontSize = 11.sp, modifier = Modifier.weight(1f),
                )
                ReplyGlyph(palette.accent)
            }
        }
        // ⑦ 另有几项在等：给总数与逐项入口，不把每一张的长正文都铺进聊天。
        if (pending.size > 1) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "另有 ${pending.size - 1} 项待决定",
                    color = palette.warn, fontSize = 11.sp, modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onOpenAllPending) {
                    Text(AttentionSupersede.JUMP, color = palette.accent, fontSize = 11.sp)
                }
            }
            pending.drop(1).forEach { ticket ->
                Text(
                    "· ${ticket.approval?.action?.takeIf { it.isNotEmpty() } ?: ticket.title}",
                    color = palette.muted, fontSize = 11.sp, maxLines = 1,
                )
            }
        }
    }
}

/**
 * 「这张卡的问题已经换了」提示条。
 *
 * 只在 [AttentionSupersede] 判出**确实拿到了更新的 attention** 时出现；判不出来一个字都不说。
 * 独立于正文：浅底、圆角、小字号、左侧图标，放在卡片最上面。
 * 动作一定给得出去路：最新那张就是这张卡 → 「知道了」收掉；在别处 → 「逐项看」跳过去。
 */
@Composable
private fun SupersedeBanner(
    onThisCard: Boolean,
    palette: CrewPalette,
    onJump: () -> Unit,
    onDismiss: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(palette.accentSoft)
            .padding(start = 10.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("↻", color = palette.accent, fontSize = 12.sp)
        Column(modifier = Modifier.weight(1f)) {
            Text(
                AttentionSupersede.BANNER,
                color = palette.accent, fontSize = 11.sp, fontWeight = FontWeight(620),
            )
            Text(
                AttentionSupersede.bannerDetail(onThisCard),
                color = palette.muted, fontSize = 10.5.sp, lineHeight = 15.sp,
            )
        }
        Box(
            modifier = Modifier
                .defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
                .clip(RoundedCornerShape(8.dp))
                .clickable { if (onThisCard) onDismiss() else onJump() }
                .semantics {
                    contentDescription = if (onThisCard) "收掉这条提示" else "去看最新的那张卡"
                },
            contentAlignment = Alignment.Center,
        ) {
            Text(
                AttentionSupersede.bannerAction(onThisCard),
                color = palette.accent, fontSize = 11.sp, fontWeight = FontWeight.Medium,
                textAlign = TextAlign.Center,
            )
        }
    }
}

/**
 * 卡片自己的回执：提交中 / 已受理 / 409 / 失败。
 *
 * 从前它是和正文同字号（10.5sp）同色（faint）的一行裸字，夹在 C 选项和输入框之间，
 * 读起来就是正文的下一句。现在是一条独立提示条：浅底 + 图标 + 小字。
 *
 * @param alert true = 这张卡此刻没锁、上一条答复没落地（失败/409）→ 用警示底色；
 *   false = 只是过程状态（已受理、等状态更新）→ 用中性底色。
 */
@Composable
private fun NoteBar(note: String, palette: CrewPalette, alert: Boolean) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(if (alert) palette.warnSoft else palette.field)
            .padding(horizontal = 10.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Text(
            if (alert) "!" else "·",
            color = if (alert) palette.warn else palette.faint,
            fontSize = 11.sp, fontWeight = FontWeight(700),
        )
        Text(
            note,
            color = if (alert) palette.ink else palette.muted,
            fontSize = 10.5.sp, lineHeight = 15.sp,
            modifier = Modifier.weight(1f),
        )
    }
}

/** 「看详情」/「收起详情」：48dp 命中、文字与命中区居中的小按钮。 */
@Composable
private fun DetailsToggle(open: Boolean, palette: CrewPalette, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 6.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            if (open) AnswerCopy.DETAILS_HIDE else AnswerCopy.DETAILS_SHOW,
            color = palette.accent, fontSize = 11.sp, textAlign = TextAlign.Center,
        )
    }
}

/**
 * 「看详情」展开后的原文块。
 *
 * 实机上它是一堵墙：一整块 2000 字的原文（含 `mcp__messages__send_message({"channel":…` 这种
 * 原始协议）与正文同字号同色，从 y=1903 一路压到卡片底部。这里只改**排版**，不改内容：
 * 等宽小字 + 浅底 + 按空行分节（[DetailsCopy]）+ 最多 [DetailsCopy.MAX_HEIGHT_DP] 高，超出就滚动。
 */
@Composable
private fun DetailsBlock(text: String, palette: CrewPalette) {
    val sections = remember(text) { DetailsCopy.sections(text) }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(palette.field, RoundedCornerShape(8.dp))
            .padding(horizontal = 9.dp, vertical = 8.dp)
            // 限高必须排在 verticalScroll 之前：滚动容器自己得有界，否则它按内容量出来的高度
            // 还是整块原文，卡片照旧被撑爆。
            .heightIn(max = DetailsCopy.MAX_HEIGHT_DP.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        for (section in sections) {
            Text(
                section,
                color = palette.muted,
                fontSize = DetailsCopy.FONT_SP.sp,
                lineHeight = (DetailsCopy.FONT_SP + 5).sp,
                fontFamily = FontFamily.Monospace,
                softWrap = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/**
 * 「回」的图标：一个画出来的箭头，不再只靠一个字。
 *
 * 实机上那一格是个 11.5sp 的「回」字，和正文没区别 —— 而它是**发送**，不是正文。
 * 用形状而不是字来说这件事，也免得换个字体就变成豆腐块。
 */
@Composable
private fun ReplyGlyph(color: Color) {
    Canvas(modifier = Modifier.size(20.dp)) {
        val mid = size.height / 2f
        val stroke = size.height * 0.14f
        val head = size.width * 0.28f
        drawLine(color, Offset(size.width * 0.1f, mid), Offset(size.width * 0.88f, mid),
            strokeWidth = stroke, cap = StrokeCap.Round)
        drawLine(color, Offset(size.width * 0.88f - head, mid - head), Offset(size.width * 0.88f, mid),
            strokeWidth = stroke, cap = StrokeCap.Round)
        drawLine(color, Offset(size.width * 0.88f - head, mid + head), Offset(size.width * 0.88f, mid),
            strokeWidth = stroke, cap = StrokeCap.Round)
    }
}
/**
 * 「等你决定」卡的正文：按段落画，段间留行距；`**加粗**` 与 `` `行内代码` `` 轻量渲染；
 * 超过 [QuestionBodyCopy.BRIEF_LINES] 行先折叠，点「展开全文」再看完整正文。
 *
 * 排版与解析全在 AnswerCopy / QuestionBodyCopy 里（纯函数、有单测），
 * 这里只把 [InlineKind] 翻成字体与底色 —— 不在 Composable 里解释文本。
 */
@Composable
private fun AnswerBody(ticket: WorkTicket, palette: CrewPalette) {
    val body = remember(ticket.id, CrewWire.answerSignature(ticket)) { AnswerCopy.bodyView(ticket) }
    // 展开状态跟着这张卡的一组问题走：换了问题/选项，回到折叠（与「详情」同一个键）。
    var expanded by remember(ticket.id, CrewWire.answerSignature(ticket)) { mutableStateOf(false) }
    val shown = if (expanded) body.full else body.brief
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        for (paragraph in shown) {
            Text(
                text = bodySpans(paragraph, palette),
                color = palette.ink,
                fontSize = 13.sp,
                lineHeight = 20.sp,
                softWrap = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        // 只剩一句固定标题时正文没有可展开的东西（原文在「看详情」里），不画这个按钮。
        if (body.expandable) {
            TextButton(
                onClick = { expanded = !expanded },
                contentPadding = PaddingValues(0.dp),
            ) {
                Text(
                    if (expanded) AnswerCopy.BODY_HIDE else AnswerCopy.BODY_SHOW,
                    color = palette.accent, fontSize = 11.sp,
                )
            }
        }
    }
}

/** 一个段落 → AnnotatedString。只有三种样式，别的字符原样画。 */
private fun bodySpans(paragraph: BodyParagraph, palette: CrewPalette) = buildAnnotatedString {
    for (span in paragraph.spans) {
        when (span.kind) {
            InlineKind.Plain -> append(span.text)
            InlineKind.Bold -> withStyle(SpanStyle(fontWeight = FontWeight(650))) { append(span.text) }
            InlineKind.Code -> withStyle(
                SpanStyle(fontFamily = FontFamily.Monospace, background = palette.field, color = palette.ink),
            ) { append(span.text) }
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
            // 列表里只有一行高：压平成一句摘要（工具参数不铺开），放不下就省略。
            Text(
                AnswerCopy.compact(ticket),
                color = palette.warn,
                fontSize = 11.sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
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

/** 子代理树在组件出现时读取；只有真实后代到达后才画摘要卡。点开只展开明细。 */
@Composable
private fun SubagentCard(
    client: CrewClient,
    ticket: WorkTicket,
    /** 按票的树缓存（见 AgentsCache）。由上层持有，切屏回来时那一份还在。 */
    cache: AgentsCache,
    /** 这一轮时间线的代号：变了就重读一次，队伍派了新的人也看得见。 */
    generation: Int,
    palette: CrewPalette,
    open: Boolean,
    onExpandedChange: (Boolean) -> Unit,
    onContentChanged: () -> Unit,
) {
    val ticketId = ticket.id
    var trouble by rememberSaveable(ticketId) { mutableStateOf<String?>(null) }
    // 重试：读不到的那一轮记在缓存里、不会自己再发请求，得有人把这一轮的记号清掉。
    var retry by remember(ticketId) { mutableStateOf(0) }
    // 树从缓存读取；tick 在请求结束时只重画当前这张卡。
    var tick by remember(ticketId) { mutableStateOf(0) }
    // 展开着的时候再慢一档刷新：只在人真的展开这一张时才重读，不做全树/全列无差别重拉。
    var idleTick by remember(ticketId) { mutableStateOf(0) }
    val nodes = remember(ticketId, generation, tick, retry, idleTick) { cache.get(ticketId, generation) }
    val descendants = AgentCopy.visibleSubagents(nodes)

    // 组件出现时启动读取；只有非空后代到达后才生成摘要卡。
    //
    // 这里只留这一处读取：从前点开时还抄了一份一模一样的请求，两边各发一遍
    // —— 表头那趟还没回来就点开，会同时飞出去两个 /agents。
    // 点开只切换展开状态，不会重复发起读取。
    // 展开时低频重读：票还在跑，人正看着这一块 —— 每 12 秒补一次，别等下一次时间线换代。
    // 收起时这个循环根本不启动，所以不会因为它在屏上就一直在打请求。
    LaunchedEffect(ticketId, open, generation) {
        if (!open) return@LaunchedEffect
        while (true) {
            kotlinx.coroutines.delay(12_000)
            idleTick += 1
        }
    }

    LaunchedEffect(ticketId, generation, retry, idleTick) {
        // start 同时挡住并发：同一张票在这一轮里已经有人发了请求，就不再发第二个。
        // 按过「重试」时先放掉上一轮「读不到」的记号，再照常走一遍。
        if (retry > 0) cache.forget(ticketId)
        if (!cache.start(ticketId, generation)) return@LaunchedEffect
        trouble = null
        try {
            cache.finish(ticketId, client.agents(ticketId), generation)
            tick += 1
            onContentChanged()
        } catch (error: CancellationException) {
            // 这一格被组合带走了：不是「读不到」，别把取消写成一句错误。
            // 交还给缓存，切回来时还会再读一次。
            cache.abandon(ticketId, generation)
            throw error
        } catch (error: Exception) {
            // 读不到也记一笔：同一轮里不再重发。trouble 只写在这一张卡上。
            cache.finish(ticketId, null, generation)
            tick += 1
            onContentChanged()
            trouble = AgentCopy.failureNote(error.message)
        }
    }

    // 只有真实非空后代才创建可展开卡；读取效果已在上方启动。
    if (descendants == null && trouble == null) return

    // 与消息同一列：消息行左边距 14 + 头像 25 + 间距 8 = 47，右边 14。
    // 卡自己不再加内边距式的 Padding(13)，那会让表头比正文还缩进 —— 画板里
    // 表头与正文同一条左基线。
    Column(
        modifier = Modifier.fillMaxWidth().padding(start = 47.dp, end = 14.dp),
    ) {
        if (descendants != null) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(palette.card, RoundedCornerShape(10.dp))
                    .border(1.dp, palette.line, RoundedCornerShape(10.dp)),
            ) {
                // 表头：左「N 个子代理」，右「x 在跑 · y 已完成」。
                // 真实后代到达后才显示摘要入口；刷新期间继续显示缓存中的上次成功树。
                // 点开只改这一枚 open：读取是上面那趟 LaunchedEffect 的事，这里不再发第二个请求。
                Row(
                    modifier = Modifier.fillMaxWidth().clickable {
                        onExpandedChange(!open)
                    }.defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    val total = AgentCopy.count(descendants)
                    val summary = AgentCopy.summary(descendants)
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
                            "%d 个子代理".format(total),
                            fontSize = 12.5.sp, fontWeight = FontWeight(550), color = palette.ink,
                        )
                        Text(
                            summary,
                            fontSize = 11.sp, color = palette.faint,
                        )
                    }
                    Text(
                        stateWord(ticket.state),
                        fontSize = 10.5.sp,
                        color = if (ticket.open) palette.faint else palette.accent,
                    )
                    Spacer(Modifier.width(7.dp))
                    Text(if (open) "‹" else "›", fontSize = 13.sp, color = palette.faint)
                }
                if (open) {
                    // 展开后只呈现已读取的真实树；未知与空树不创建卡片。
                    nodes.orEmpty().forEach { AgentBranch(it, 0, palette) }
                }
            }
        }
        trouble?.let { note ->
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = if (descendants == null) 0.dp else 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(note, color = palette.danger, fontSize = 11.sp, modifier = Modifier.weight(1f))
                TextButton(onClick = { retry += 1 }) {
                    Text("重试", color = palette.accent, fontSize = 11.sp)
                }
            }
        }
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

@Composable
private fun AgentBranch(node: AgentNode, depth: Int, palette: CrewPalette) {
    val running = AgentCopy.isRunning(node.state)
    val done = AgentCopy.isTerminal(node.state)
    val waiting = node.state.trim() in setOf("waiting", "waiting_for_person", "processing")
    val mark = when {
        done -> "✓"
        running -> "·"
        AgentCopy.isIdle(node.state) -> "○"
        else -> "?"
    }
    val stateColor = when {
        running -> palette.accent
        waiting -> palette.warn
        else -> palette.faint
    }
    // 缩进就是层级：不压平，也不额外画线。
    Row(
        modifier = Modifier.padding(start = (depth * 12).dp, top = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            // 后端 label 是呈现名；worker root 仍显示为「工单」，便于看懂子代理归属。
            "$mark ${node.label.ifBlank { node.id }}",
            color = if (running) palette.ink else palette.faint,
            fontSize = 11.sp,
        )
        // 右侧那截话：状态词 +（真有耗时时的）耗时。与桌面端 agentStatus 同一句，
        // 用词是子代理的「在跑 / 已完成」，不是工单卡的「在做」。
        // 后端今天还不发 elapsed_seconds，所以这里实际画出来的只有状态词 ——
        // 没数据就不画那一截，绝不补一个假数。
        Box(Modifier.weight(1f))
        Text(
            AgentCopy.status(node, working = running),
            // 仅明确的 working 用强调绿；等待、空闲、未知都不会被画成在跑。
            color = stateColor,
            fontSize = 10.5.sp,
        )
    }
    node.children.forEach { AgentBranch(it, depth + 1, palette) }
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
    queuedRequestIds: Set<String> = emptySet(),
    steerTicketId: String? = null,
    onActionCompleted: () -> Unit = {},
    onContentChanged: () -> Unit = {},
    /**
     * 这条请求此刻的执行活动（来自轻量快照，按 request_id 关联）。
     * null = 后端没给 / 这一条没有活动 —— 那时不画活动行，不编一句「正在思考」。
     */
    activity: ExecutionActivity? = null,
    /** 这条的收据是否带问题卡（决定 waiting_for_person 说「等你答复」还是「需要你处理」）。 */
    awaitingAnswer: Boolean = false,
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
    val requestActionScope = rememberCoroutineScope()
    var requestActionBusy by remember(sessionId, message.id, message.requestId) { mutableStateOf(false) }
    var requestActionDone by remember(sessionId, message.id, message.requestId) { mutableStateOf(false) }
    var requestActionNote by remember(sessionId, message.id, message.requestId) { mutableStateOf<String?>(null) }
    var requestActionsExpanded by remember(sessionId, message.id, message.requestId) { mutableStateOf(false) }
    val canWithdraw = RequestStateCopy.canWithdraw(message, queuedRequestIds)
    val canShowRequestActions = canWithdraw && !requestActionDone
    val requestStateLabel = RequestStateCopy.label(message.requestState, awaitingAnswer)
    LaunchedEffect(canShowRequestActions) {
        if (!canShowRequestActions) requestActionsExpanded = false
    }
    fun runRequestAction(action: suspend () -> Unit) {
        if (requestActionBusy) return
        requestActionBusy = true
        requestActionNote = null
        requestActionScope.launch {
            try {
                action()
                requestActionDone = true
                onActionCompleted()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                requestActionNote = error.message ?: "操作没成功"
            } finally {
                requestActionBusy = false
            }
        }
    }
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
                // 没有真实可见结果时不占位置；异步读回非空产出后再自然插入一行。
                // 已知非空的上次成功结果由 OutputsCache.line 在刷新期间继续提供。
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
                        val previousLine = outputs.line(ticket, generation)
                        var view: OutputsView? = null
                        try {
                            view = client.outputs(ticket)
                        } catch (error: CancellationException) {
                            // 这一条被组合带走了：不是「读不到」，别把它记成读不到。
                            // 放掉记号，滚回来时还会再读一次。
                            outputs.abandon(ticket, generation)
                            throw error
                        } catch (_: Exception) {
                            // 失败单独记本轮尝试，已有成功结果仍由缓存提供，不把失败当成空产出。
                            view = null
                        }
                        outputs.finish(ticket, view, generation)
                        if (outputs.line(ticket, generation) != previousLine) onContentChanged()
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
                .then(
                    if (canShowRequestActions) {
                        Modifier
                            .pointerInput(message.requestId) {
                                detectTapGestures(onLongPress = { requestActionsExpanded = true })
                            }
                            .semantics {
                                onLongClick(label = "显示消息操作") {
                                    requestActionsExpanded = true
                                    true
                                }
                            }
                    } else Modifier
                )
                .padding(horizontal = 13.dp, vertical = 10.dp),
        ) {
            Text(
                message.text,
                fontSize = 14.sp,
                lineHeight = 21.75.sp,
                color = palette.userInk,
            )
            DropdownMenu(
                expanded = requestActionsExpanded && canShowRequestActions,
                onDismissRequest = { requestActionsExpanded = false },
            ) {
                if (steerTicketId != null) {
                    DropdownMenuItem(
                        text = { Text(if (requestActionBusy) "处理中" else "插话") },
                        enabled = !requestActionBusy,
                        onClick = {
                            requestActionsExpanded = false
                            runRequestAction {
                                client.steer(steerTicketId, message.requestId, sessionId)
                            }
                        },
                    )
                }
                DropdownMenuItem(
                    text = { Text(if (requestActionBusy) "处理中" else "撤回") },
                    enabled = !requestActionBusy,
                    onClick = {
                        requestActionsExpanded = false
                        runRequestAction {
                            client.withdraw(message.requestId, sessionId)
                        }
                    },
                )
            }
        }
        Row(
            modifier = Modifier.fillMaxWidth(0.84f).padding(top = 2.dp),
            horizontalArrangement = Arrangement.End,
        ) {
            Text(
                requestStateLabel,
                fontSize = 10.5.sp,
                lineHeight = 13.sp,
                color = palette.faint,
                maxLines = 1,
                softWrap = false,
            )
        }
        requestActionNote?.let {
            Text(
                it,
                fontSize = 10.5.sp,
                color = palette.danger,
                modifier = Modifier.fillMaxWidth(0.84f).padding(top = 1.dp),
                textAlign = TextAlign.End,
            )
        }
        // 执行活动：与收据分开一行。收据说「到没到」，这条说「此刻在干什么」。
        ActivityCopy.line(activity)?.let { line ->
            Text(
                line,
                fontSize = 10.5.sp,
                lineHeight = 13.sp,
                color = palette.muted,
                maxLines = 1,
                softWrap = false,
                modifier = Modifier.fillMaxWidth(0.84f).padding(top = 1.dp),
                textAlign = TextAlign.End,
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
 * 只展示真实可见的产出。
 */
@Composable
private fun ResultBar(line: String, palette: CrewPalette) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(palette.card, RoundedCornerShape(8.dp))
            .border(1.dp, palette.line, RoundedCornerShape(8.dp))
            .padding(horizontal = 12.dp, vertical = 9.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("✓", fontSize = 13.sp, color = palette.accent)
        Text(line, fontSize = 11.5.sp, color = palette.muted)
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
    draft: String,
    declinedReason: String?,
    steerTextNote: String?,
    sending: Boolean,
    palette: CrewPalette,
    enabled: Boolean,
    onChange: (String) -> Unit,
    focusRequester: FocusRequester? = null,
    /** true = 显式 onTalk 请求聚焦，等输入框挂上后一次性聚焦+弹键盘；成功后经 onFocusHandled 清标记。 */
    focusWhenPlaced: Boolean = false,
    onFocusHandled: () -> Unit = {},
    /** 输入区左侧收件人按钮的文案（如「发给 大哥（按队伍默认）」）。点它开 drawer 选成员。 */
    recipientLabel: String,
    onOpenRecipient: () -> Unit,
    steerTicketId: String?,
    onSteerText: (String) -> Unit,
    onSend: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth()) {
        steerTextNote?.let {
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
        ComposerRow(draft, sending, palette, enabled, onChange, onSend,
            focusRequester = focusRequester, steerTicketId = steerTicketId, onSteerText = onSteerText,
            recipientLabel = recipientLabel, onOpenRecipient = onOpenRecipient,
            focusWhenPlaced = focusWhenPlaced, onFocusHandled = onFocusHandled)
    }
}

/**
 * 输入那一行：收件人按钮 · 输入框 · 可选的「插队」· 发送。
 *
 * 收件人在左侧一颗 48×48 按钮里（视觉像「大哥 ⌄」，最大 64dp 宽、名字单行 ellipsis），
 * 正文 TextField 吃剩余宽（按剩余宽自适应，360dp 下窄屏也保留完整可编辑宽度，不会缩成几字）。点击按钮开 drawer 选成员；
 * 「发给X」放 contentDescription，不占视觉宽度，也不替代正文里用户自己打的 @。
 *
 */
@Composable
private fun ComposerRow(
    draft: String,
    sending: Boolean,
    palette: CrewPalette,
    enabled: Boolean,
    onChange: (String) -> Unit,
    onSend: () -> Unit,
    focusRequester: FocusRequester? = null,
    steerTicketId: String?,
    onSteerText: (String) -> Unit,
    recipientLabel: String,
    onOpenRecipient: () -> Unit,
    focusWhenPlaced: Boolean = false,
    onFocusHandled: () -> Unit = {},
) {
    // 一次性聚焦守卫：本次 armed 只处理一次，避免 onGloballyPositioned 每帧重复 requestFocus。
    var focusFired by remember { mutableStateOf(false) }
    if (!focusWhenPlaced) focusFired = false
    val keyboard = LocalSoftwareKeyboardController.current
    // 收件人短名：从「发给 X（按队伍默认）」里剥出 X，只显示 1–3 字 + ⌄，不占满一行。
    val shortName = recipientLabel.removePrefix("发给 ")
        .substringBefore("（").substringBefore("·").trim().ifEmpty { "未指定" }
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // 收件人按钮：48×48 命中，最大 64dp 宽，视觉是短名 + ⌄。点开侧边栏选成员。
        Box(
            modifier = Modifier
                .height(48.dp)
                .widthIn(min = 48.dp, max = 64.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(palette.accentSoft)
                .clickable(onClick = onOpenRecipient)
                .semantics { contentDescription = "$recipientLabel，点按换成员" }
                .padding(horizontal = 8.dp),
            contentAlignment = Alignment.Center,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    shortName, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = palette.accent,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
                )
                Text("⌄", fontSize = 11.sp, color = palette.accent)
            }
        }
        Spacer(Modifier.width(6.dp))
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
            modifier = Modifier.weight(1f)
                .then(if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier)
                // 显式 onTalk 请求聚焦：**输入框真正挂上后**（onGloballyPositioned 回调、isAttached）才一次性
                // requestFocus + 弹键盘；不盲睡、不无界重试。失败写日志（不静默吞），成功后清 armed 标记。
                .onGloballyPositioned { coords ->
                    if (focusWhenPlaced && !focusFired && coords.isAttached && focusRequester != null) {
                        focusFired = true
                        try {
                            focusRequester.requestFocus()
                            keyboard?.show()
                            onFocusHandled()
                        } catch (error: Exception) {
                            android.util.Log.w("CrewComposer", "onTalk 聚焦失败（输入框未就绪）", error)
                        }
                    }
                },
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
