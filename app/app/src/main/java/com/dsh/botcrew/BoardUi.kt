package com.dsh.botcrew

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

/**
 * 两个模式：日常群聊（[Chat]，默认）与看全局分派的分拣台（[Triage]）。
 *
 * 切换只换镜头，不换账：`GET /timeline` 一次就返回 items + tasks + queued + declined，
 * 这里没有第二份任务状态（契约 §1）。模式本身归 CrewRoot 持有，切换时不重建时间线。
 */
enum class Mode { Chat, Triage }

/**
 * 分拣台自己的纸感色：亚麻底 + 纸条 + 墨 + 朱红，与桌面 `desktop/triage.go` 同一套值。
 *
 * 聊天模式仍是暗色（[DarkPalette]），两个模式的视觉语言不同是场景差异，不是不一致。
 * 这里用 [LightPalette.copy] 只覆盖案头那几层，其余字段沿用亮色，不另造一套完整色板。
 * 每个前景色都按 WCAG 实算过：`ink/card` 13.31、`muted/surface` 6.40、
 * `faint/surface` 5.12、`accent/card` 5.48、`warn/surface` 5.13、`onWarn/warn` 6.14，全部 ≥ 4.5:1。
 */
val TriagePalette = LightPalette.copy(
    surface = Color(0xFFF1EADC), card = Color(0xFFFBF7F0),
    ink = Color(0xFF2F2A24), muted = Color(0xFF5B5247), faint = Color(0xFF6B6053),
    accent = Color(0xFFA6473B), warn = Color(0xFF8A552F), danger = Color(0xFFB23A2B),
    userBubble = Color(0xFF2F2A24), userInk = Color(0xFFFBF7F0),
    accentSoft = Color(0xFFE8DCC8), line = Color(0xFFD6CBB9), hint = Color(0xFF8A7E6E),
    emptyEdge = Color(0xFFC9BDA8), emptyGlyph = Color(0xFFB0A38E), segment = Color(0xFFE5DAC6),
    warmBase = Color(0xFFF2E4BE), warnEdge = Color(0xFFD9C79A), warnSoft = Color(0xFFF2E4BE),
    field = Color(0xFFF6F1E7), track = Color(0xFFE5DAC6),
    onWarn = Color(0xFFFFFFFF),
)

/**
 * 事务板上「还没回的话」。它不是 WorkTicket：来源是 queued 里的 request_id 反查 messages，
 * 反查不到就不画（与契约 §4「ticket_ref 只读展示」同一条规矩）。
 */
internal data class BoardWaiting(val requestId: String, val text: String, val messageId: String)

/**
 * 四组都从同一份 Conversation 投影出来：
 * - waiting：queued 里能按 requestId 反查到正文的话；
 * - running / deciding / done：只按 open 与 needsPerson 分，不自己解释 state 词表。
 */
internal data class BoardGroups(
    val waiting: List<BoardWaiting>,
    val running: List<WorkTicket>,
    val deciding: List<WorkTicket>,
    val done: List<WorkTicket>,
)

internal fun boardGroups(conversation: Conversation?): BoardGroups? {
    if (conversation == null) return null
    val waiting = conversation.queued.mapNotNull { requestId ->
        val message = conversation.messages.firstOrNull { it.requestId == requestId } ?: return@mapNotNull null
        val text = message.text.lineSequence().firstOrNull().orEmpty().trim()
        if (text.isEmpty()) return@mapNotNull null
        BoardWaiting(requestId, text, message.id)
    }
    val running = conversation.tickets.filter { it.open && it.needsPerson.isEmpty() }
    val deciding = conversation.tickets.filter { it.open && it.needsPerson.isNotEmpty() }
    val done = conversation.tickets.filter { !it.open }
    return BoardGroups(waiting, running, deciding, done)
}

/**
 * 「事务板」按钮的未读数：还没回的话 + 等你拍板的票。两项都有后端出处，
 * 读不到（conversation 为 null）时返回 0，角标不画 —— 不把「说不清」画成 0 件事务，
 * 也不拿 items 自己数第二份账。
 */
internal fun boardUnread(conversation: Conversation?): Int {
    if (conversation == null) return 0
    val waiting = conversation.queued.count { requestId ->
        conversation.messages.any { it.requestId == requestId && it.text.isNotBlank() }
    }
    return waiting + conversation.tickets.count { it.open && it.needsPerson.isNotEmpty() }
}

/** 顶栏那一行：普通 segmented「聊天 / 分拣台」，聊天模式下多一个带未读数的「事务板」。 */
@Composable
fun ModeHeader(
    mode: Mode,
    palette: CrewPalette,
    onModeChange: (Mode) -> Unit,
    unread: Int,
    onOpenBoard: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(palette.card)
            .padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            modifier = Modifier
                .clip(RoundedCornerShape(9.dp))
                .background(palette.segment)
                .border(1.dp, palette.line, RoundedCornerShape(9.dp)),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ModeChip("聊天", mode == Mode.Chat, palette) { onModeChange(Mode.Chat) }
            ModeChip("分拣台", mode == Mode.Triage, palette) { onModeChange(Mode.Triage) }
        }
        Spacer(Modifier.weight(1f))
        if (mode == Mode.Chat) {
            Box {
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .background(palette.card)
                        .border(1.dp, palette.line, RoundedCornerShape(8.dp))
                        .clickable(onClick = onOpenBoard)
                        .defaultMinSize(minWidth = 48.dp, minHeight = 40.dp)
                        .padding(horizontal = 11.dp, vertical = 8.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("事务板", color = palette.muted, fontSize = 11.sp)
                }
                if (unread > 0) {
                    Box(
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .offset(x = 6.dp, y = (-6).dp)
                            .defaultMinSize(minWidth = 16.dp, minHeight = 16.dp)
                            .clip(CircleShape)
                            .background(palette.warn)
                            .padding(horizontal = 3.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            if (unread > 99) "99+" else unread.toString(),
                            color = palette.onWarn,
                            fontSize = 9.sp,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ModeChip(label: String, selected: Boolean, palette: CrewPalette, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(if (selected) palette.accent else Color.Transparent)
            .clickable(onClick = onClick)
            .defaultMinSize(minWidth = 56.dp, minHeight = 44.dp)
            .padding(horizontal = 12.dp, vertical = 7.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            fontSize = 12.sp,
            fontWeight = if (selected) FontWeight(600) else FontWeight.Normal,
            color = if (selected) palette.surface else palette.faint,
        )
    }
}

/**
 * 聊天模式的事务板：从右侧滑入的抽屉，压在群聊上面。
 *
 * 四组紧凑列表都来自 [boardGroups]；分组为空就不画，读不到（conversation 为 null
 * 或 problem 非空）与确实没有事务是两句不同的话。点一条只在能按 ticket_ref
 * 反查到对应消息时才跳回群里 —— 对不上就宁可不跳。
 */
@Composable
fun BoardDrawer(
    conversation: Conversation?,
    palette: CrewPalette,
    onDismiss: () -> Unit,
    onJumpToMessage: (String) -> Unit,
    problem: String? = null,
    /** 点「等你拍板」的选项：把这句原样发回去，done(true/false) 用来解除这一格的发送态。 */
    onAnswer: (WorkTicket, AttentionOption, (Boolean) -> Unit) -> Unit = { _, _, _ -> },
) {
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        var shown by remember { mutableStateOf(false) }
        LaunchedEffect(Unit) { shown = true }
        val slide by animateDpAsState(targetValue = if (shown) 0.dp else 306.dp)
        val groups = boardGroups(conversation)
        val answerState = rememberBoardAnswerState(
            resetKey = groups?.deciding?.firstOrNull()?.let { CrewWire.answerSignature(it) },
            onAnswer = onAnswer,
        )
        Box(
            modifier = Modifier
                .fillMaxSize()
                .systemBarsPadding(),
        ) {
            // 遮罩用现有底色压暗，不另引一套颜色；点它收起抽屉。
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(palette.surface.copy(alpha = 0.72f))
                    .clickable(onClick = onDismiss),
            )
            Column(
                modifier = Modifier
                    .align(Alignment.CenterEnd)
                    .offset(x = slide)
                    .fillMaxHeight()
                    .width(306.dp)
                    .background(palette.card)
                    .border(width = 1.dp, color = palette.line),
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(52.dp)
                        .padding(horizontal = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("事务板", color = palette.ink, fontSize = 13.sp, fontWeight = FontWeight(600))
                    if (groups != null) {
                        val count = groups.waiting.size + groups.running.size + groups.deciding.size + groups.done.size
                        Text("  $count 件", color = palette.faint, fontSize = 10.sp)
                    }
                    Spacer(Modifier.weight(1f))
                    Box(
                        modifier = Modifier
                            .size(40.dp)
                            .clip(RoundedCornerShape(8.dp))
                            .clickable(onClick = onDismiss),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text("×", color = palette.faint, fontSize = 18.sp)
                    }
                }
                Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(palette.line))
                LazyColumn(
                    modifier = Modifier.weight(1f),
                    contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
                    verticalArrangement = Arrangement.spacedBy(5.dp),
                ) {
                    boardSections(
                        conversation = conversation,
                        groups = groups,
                        problem = problem,
                        palette = palette,
                        titles = BoardTitles("还没回的话", "在跑", "等你拍板", "办完"),
                        answering = answerState.answering,
                        note = answerState.note,
                        onAnswer = answerState.answer,
                        onJump = { messageId -> onDismiss(); onJumpToMessage(messageId) },
                    )
                }
                Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(palette.line))
                Text(
                    "点任一条，跳回群里那句话",
                    color = palette.faint,
                    fontSize = 10.sp,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
                )
            }
        }
    }
}

/**
 * 分拣台：顶部 58dp 大按钮是「丢」的第一动作，下面按状态分组的条目流，
 * 底部固定一条「丢 →」输入行。调用方传 [TriagePalette]（纸感案头），
 * 聊天模式与事务板抽屉仍用暗色 [DarkPalette] —— 同一个 [CrewPalette] 形状，两套值。
 */
@Composable
fun TriageScreen(
    conversation: Conversation?,
    palette: CrewPalette,
    draft: String,
    onDraft: (String) -> Unit,
    sending: Boolean,
    enabled: Boolean,
    problem: String?,
    onDrop: (String) -> Unit,
    onAnswer: (WorkTicket, AttentionOption, (Boolean) -> Unit) -> Unit = { _, _, _ -> },
    onJumpToMessage: (String) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val focus = remember { FocusRequester() }
    val groups = boardGroups(conversation)
    val answerState = rememberBoardAnswerState(
        resetKey = groups?.deciding?.firstOrNull()?.let { CrewWire.answerSignature(it) },
        onAnswer = onAnswer,
    )
    Column(modifier = modifier.fillMaxSize().background(palette.surface)) {
        // 大按钮不另做假的「图 / 语音」入口：输入框只发文本，点它就是把焦点交给输入行。
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 8.dp)
                .height(58.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(palette.card)
                .border(1.dp, palette.accent, RoundedCornerShape(10.dp))
                .clickable { focus.requestFocus() },
            contentAlignment = Alignment.Center,
        ) {
            Text("＋ 丢一件进来", color = palette.accent, fontSize = 16.sp, fontWeight = FontWeight(600))
        }
        LazyColumn(
            modifier = Modifier.weight(1f),
            contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            boardSections(
                conversation = conversation,
                groups = groups,
                problem = problem,
                palette = palette,
                titles = BoardTitles("刚丢进来的", "各人在跑", "等你拍板", "办完"),
                answering = answerState.answering,
                note = answerState.note,
                onAnswer = answerState.answer,
                onJump = onJumpToMessage,
            )
        }
        // 底部固定：什么都能丢的一行。草稿与聊天模式共用，切镜头不丢写了一半的话。
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(palette.card)
                .padding(horizontal = 14.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("丢 →", color = palette.faint, fontSize = 11.sp)
            OutlinedTextField(
                value = draft,
                onValueChange = onDraft,
                placeholder = { Text("一句话、一个链接…", color = palette.hint, fontSize = 12.sp) },
                enabled = enabled,
                singleLine = true,
                textStyle = TextStyle(fontSize = 13.sp, color = palette.ink),
                shape = RoundedCornerShape(10.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedContainerColor = palette.field,
                    unfocusedContainerColor = palette.field,
                    disabledContainerColor = palette.field,
                    focusedBorderColor = Color.Transparent,
                    unfocusedBorderColor = Color.Transparent,
                    disabledBorderColor = Color.Transparent,
                    cursorColor = palette.accent,
                ),
                modifier = Modifier
                    .weight(1f)
                    .padding(start = 8.dp)
                    .focusRequester(focus),
            )
            Button(
                enabled = enabled && !sending && draft.isNotBlank(),
                onClick = { onDrop(draft) },
                shape = RoundedCornerShape(10.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = palette.accent,
                    contentColor = palette.surface,
                    disabledContainerColor = palette.line,
                    disabledContentColor = palette.faint,
                ),
                modifier = Modifier.padding(start = 8.dp),
            ) { Text(if (sending) "…" else "↑", fontSize = 14.sp) }
        }
    }
}

/** 选项按钮的发送态与回执：一次只答一题，问题或选项换了旧的那一组随即作废。 */
private class BoardAnswerState(
    val answering: Set<String>,
    val note: Pair<String, String>?,
    val answer: (WorkTicket, AttentionOption) -> Unit,
)

@Composable
private fun rememberBoardAnswerState(
    resetKey: String?,
    onAnswer: (WorkTicket, AttentionOption, (Boolean) -> Unit) -> Unit,
): BoardAnswerState {
    var answering by remember { mutableStateOf(emptySet<String>()) }
    var note by remember { mutableStateOf<Pair<String, String>?>(null) }
    LaunchedEffect(resetKey) {
        answering = emptySet()
        note = null
    }
    val answer: (WorkTicket, AttentionOption) -> Unit = { ticket, option ->
        val slot = CrewWire.answerSlot(ticket.id, option.id)
        if (slot !in answering) {
            answering = answering + slot
            note = null
            onAnswer(ticket, option) { ok ->
                answering = answering - slot
                note = slot to if (ok) AnswerCopy.ANSWER_DONE else AnswerCopy.answerFailed(null)
            }
        }
    }
    return BoardAnswerState(answering, note, answer)
}

private data class BoardTitles(val waiting: String, val running: String, val deciding: String, val done: String)

/**
 * 两个模式共用的四组流。分组为空不画；只有 groups 为 null（还没读到时间线）才说「正在读」，
 * problem 非空说「读不到」，四组全空才说「还没有事务」—— 三种状态不混成一句话。
 */
private fun LazyListScope.boardSections(
    conversation: Conversation?,
    groups: BoardGroups?,
    problem: String?,
    palette: CrewPalette,
    titles: BoardTitles,
    answering: Set<String>,
    note: Pair<String, String>?,
    onAnswer: (WorkTicket, AttentionOption) -> Unit,
    onJump: (String) -> Unit,
) {
    if (problem != null) {
        item(key = "board-unavailable") {
            Text(
                "读不到队伍：$problem${if (groups == null) "" else "（下面只是上次读到的）"}",
                color = palette.danger,
                fontSize = 11.sp,
                modifier = Modifier.padding(vertical = 6.dp),
            )
        }
    }
    if (groups == null) {
        item(key = "board-loading") {
            Text(
                if (problem == null) "正在读时间线…" else "暂时读不到事务",
                color = palette.faint,
                fontSize = 11.sp,
                modifier = Modifier.padding(vertical = 8.dp),
            )
        }
        return
    }
    val empty = groups.waiting.isEmpty() && groups.running.isEmpty() &&
        groups.deciding.isEmpty() && groups.done.isEmpty()
    if (empty) {
        item(key = "board-empty") {
            Text(
                "还没有事务，丢一件进来",
                color = palette.faint,
                fontSize = 11.sp,
                modifier = Modifier.padding(vertical = 10.dp),
            )
        }
    }
    if (groups.waiting.isNotEmpty()) {
        item(key = "head-waiting") {
            BoardGroupTitle("${titles.waiting} · ${groups.waiting.size}", palette)
        }
        itemsIndexed(groups.waiting, key = { index, _ -> "waiting-$index" }) { _, waiting ->
            BoardWaitingRow(waiting, palette, onClick = jumpFor(waiting.messageId, onJump))
        }
    }
    if (groups.running.isNotEmpty()) {
        item(key = "head-running") {
            BoardGroupTitle("${titles.running} · ${groups.running.size}", palette)
        }
        itemsIndexed(groups.running, key = { index, ticket -> "running-$index-${ticket.id}" }) { _, ticket ->
            BoardTicketRow(
                ticket = ticket,
                conversation = conversation,
                palette = palette,
                showProgress = true,
                showOptions = false,
                answering = answering,
                note = note,
                onAnswer = onAnswer,
                onClick = jumpFor(messageIdOf(conversation, ticket), onJump),
            )
        }
    }
    if (groups.deciding.isNotEmpty()) {
        item(key = "head-deciding") {
            BoardGroupTitle("${titles.deciding} · ${groups.deciding.size}", palette, tint = palette.warn)
        }
        itemsIndexed(groups.deciding, key = { index, ticket -> "deciding-$index-${ticket.id}" }) { _, ticket ->
            BoardTicketRow(
                ticket = ticket,
                conversation = conversation,
                palette = palette,
                showProgress = false,
                showOptions = true,
                answering = answering,
                note = note,
                onAnswer = onAnswer,
                onClick = jumpFor(messageIdOf(conversation, ticket), onJump),
            )
        }
    }
    if (groups.done.isNotEmpty()) {
        item(key = "head-done") {
            BoardGroupTitle("${titles.done} · ${groups.done.size}", palette)
        }
        itemsIndexed(groups.done, key = { index, ticket -> "done-$index-${ticket.id}" }) { _, ticket ->
            BoardTicketRow(
                ticket = ticket,
                conversation = conversation,
                palette = palette,
                showProgress = false,
                showOptions = false,
                answering = answering,
                note = note,
                onAnswer = onAnswer,
                onClick = jumpFor(messageIdOf(conversation, ticket), onJump),
            )
        }
    }
}

/** 只认后端给的 ticket_ref；对不上就不画跳转（契约 §1 / §4）。 */
private fun messageIdOf(conversation: Conversation?, ticket: WorkTicket): String? {
    if (conversation == null || ticket.id.isEmpty()) return null
    return conversation.messages.lastOrNull { message ->
        message.ticketRef == ticket.id || message.code?.ticketRef == ticket.id
    }?.id?.takeIf { it.isNotEmpty() }
}

private fun jumpFor(messageId: String?, onJump: (String) -> Unit): (() -> Unit)? {
    if (messageId.isNullOrEmpty()) return null
    return { onJump(messageId) }
}

@Composable
private fun BoardGroupTitle(text: String, palette: CrewPalette, tint: Color = palette.faint) {
    Text(
        text,
        color = tint,
        fontSize = 10.sp,
        letterSpacing = 0.6.sp,
        modifier = Modifier.padding(top = 8.dp, bottom = 2.dp, start = 2.dp),
    )
}

/** 「待分」那条不是工单：只是 queued 的 request_id 反查回来的那句话。 */
@Composable
private fun BoardWaitingRow(waiting: BoardWaiting, palette: CrewPalette, onClick: (() -> Unit)?) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(palette.card)
            .border(1.dp, palette.accent, RoundedCornerShape(8.dp))
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 11.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(modifier = Modifier.size(6.dp).clip(CircleShape).background(palette.accent))
        Spacer(Modifier.width(8.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(waiting.text, color = palette.ink, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("刚丢进来的 · 还没回", color = palette.faint, fontSize = 10.sp)
        }
    }
}

@Composable
private fun BoardTicketRow(
    ticket: WorkTicket,
    conversation: Conversation?,
    palette: CrewPalette,
    showProgress: Boolean,
    showOptions: Boolean,
    answering: Set<String>,
    note: Pair<String, String>?,
    onAnswer: (WorkTicket, AttentionOption) -> Unit,
    onClick: (() -> Unit)?,
) {
    val tint = when {
        ticket.needsPerson.isNotEmpty() -> palette.warn
        ticket.state == "failed" -> palette.danger
        !ticket.open -> palette.faint
        else -> palette.accent
    }
    val base = if (ticket.needsPerson.isNotEmpty()) palette.warmBase else palette.card
    val edge = if (ticket.needsPerson.isNotEmpty()) palette.warnEdge else palette.line
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(base)
            .border(1.dp, edge, RoundedCornerShape(8.dp))
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 11.dp, vertical = 9.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(modifier = Modifier.size(6.dp).clip(CircleShape).background(tint))
            Spacer(Modifier.width(8.dp))
            Text(
                ticket.title,
                color = palette.ink,
                fontSize = 12.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            // owner 与步数都只在后端给了才拼；bot_id 空、没有计划时这一行整行不画。
            val owner = conversation?.bots?.firstOrNull { it.id == ticket.botId }?.name?.trim()
                ?: ticket.botId.trim()
            // state=unknown 时后端这份计划说不清走到哪，步数文字也跟着不画。
            val stepText = if (ticket.state == "unknown") "" else stepOf(ticket)
            val parts = listOfNotNull(
                owner.takeIf { it.isNotEmpty() },
                stepText.takeIf { it.isNotEmpty() },
            )
            if (parts.isNotEmpty()) {
                Text(
                    parts.joinToString(" · "),
                    color = palette.faint,
                    fontSize = 9.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.widthIn(max = 120.dp),
                )
            }
        }
        // 进度只认后端下发的计划（progressOf 已把 stepsDone 夹在 [0, totalSteps]）；
        // state=unknown 或没有分母时整条不画，绝不拿读到的条数当分母。
        val (done, total) = progressOf(ticket)
        if (showProgress && total > 0 && ticket.state != "unknown") {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 8.dp)
                    .height(4.dp)
                    .clip(CircleShape)
                    .background(palette.track),
            ) {
                if (done > 0) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth(done.toFloat() / total.toFloat())
                            .height(4.dp)
                            .clip(CircleShape)
                            .background(palette.accent),
                    )
                }
            }
            Text(stepOf(ticket), color = palette.faint, fontSize = 9.sp,
                modifier = Modifier.padding(top = 4.dp))
        }
        if (showOptions) {
            // 有 question 读 question，没有就只说清「为什么在等」；question 不拆成选项。
            Text(AnswerCopy.body(ticket), color = palette.warn, fontSize = 11.sp,
                modifier = Modifier.padding(top = 6.dp))
            // 后端没给 options 就一个按钮都不画（契约 §5 禁止前端编 A/B）。
            if (ticket.options.isNotEmpty()) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    for (option in ticket.options) {
                        val slot = CrewWire.answerSlot(ticket.id, option.id)
                        val busy = slot in answering
                        Box(
                            modifier = Modifier
                                .weight(1f)
                                .clip(RoundedCornerShape(6.dp))
                                .background(palette.card)
                                .border(1.dp, palette.warnEdge, RoundedCornerShape(6.dp))
                                .clickable(enabled = !busy) { onAnswer(ticket, option) }
                                .defaultMinSize(minHeight = 36.dp)
                                .padding(horizontal = 7.dp, vertical = 8.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                if (busy) "✓" else option.label,
                                color = palette.warn,
                                fontSize = 10.sp,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }
            if (note != null && note.first.startsWith(ticket.id + "|")) {
                Text(note.second, color = palette.faint, fontSize = 10.sp,
                    modifier = Modifier.padding(top = 6.dp))
            }
        }
    }
}
