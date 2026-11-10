package com.dsh.botcrew

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
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
import kotlinx.coroutines.launch

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
)

val LightPalette = CrewPalette(
    surface = Color(0xFFFBF9F6), card = Color(0xFFFFFFFF),
    ink = Color(0xFF1F1D1A), muted = Color(0xFF57524A), faint = Color(0xFF8A8377),
    accent = Color(0xFF3E6B62), warn = Color(0xFF96603A), danger = Color(0xFFB45252),
    userBubble = Color(0xFF2C2A26), userInk = Color(0xFFFBF9F6),
    accentSoft = Color(0xFFEAF1EC), line = Color(0xFFEDE8E1), hint = Color(0xFFA9A294),
    emptyEdge = Color(0xFFD9D3C9), emptyGlyph = Color(0xFFB8B1A5), segment = Color(0xFFEFEBE5),
)

val DarkPalette = CrewPalette(
    surface = Color(0xFF17161A), card = Color(0xFF232228),
    ink = Color(0xFFF2EFEA), muted = Color(0xFFC4BFB6), faint = Color(0xFF928C82),
    accent = Color(0xFF5FBFA8), warn = Color(0xFFE0A574), danger = Color(0xFFE58A80),
    userBubble = Color(0xFF3B3942), userInk = Color(0xFFF2EFEA),
    accentSoft = Color(0xFF1E3A34), line = Color(0xFF33313A), hint = Color(0xFF6E6860),
    // 暗盘里没有对应的暖灰：虚线框落到分隔色，人形落到弱字色；分段底用抬起层。
    emptyEdge = Color(0xFF33313A), emptyGlyph = Color(0xFF928C82), segment = Color(0xFF1D1C21),
)

/**
 * 手机上三屏：队伍、后台，以及某个 Bot 的屏幕（工作区）。
 *
 * 从队伍进去时记下是谁的屏幕 —— 张冠李戴比进不去更糟，所以这个值一路带到工作区页。
 */
private enum class Screen { Crew, Backend, Workspace }

@Composable
fun CrewRoot(client: CrewClient, palette: CrewPalette, onForget: () -> Unit) {
    var conversation by remember { mutableStateOf<Conversation?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    var draft by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var screen by remember { mutableStateOf(Screen.Crew) }
    var profile by remember { mutableStateOf<BotCard?>(null) }
    // 工作区要看谁的屏幕。null 表示从后台进的，那时还没有具体的人。
    var onScreen by remember { mutableStateOf<BotCard?>(null) }
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()

    fun refresh() {
        scope.launch {
            try {
                conversation = client.timeline()
                problem = null
            } catch (error: Exception) {
                problem = error.message
            }
        }
    }

    LaunchedEffect(Unit) { refresh() }

    Surface(modifier = Modifier.fillMaxSize(), color = palette.surface) {
        // 让出状态栏与导航栏：断连横幅排在最前，不加的话会顶到系统时间上去。
        Column(modifier = Modifier.fillMaxSize().systemBarsPadding()) {
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
                Screen.Backend -> BackendScreen(client, conversation, palette, { screen = Screen.Crew }, { refresh() })
                Screen.Workspace -> WorkspaceScreen(
                    bot = onScreen ?: conversation?.bots?.firstOrNull { it.id == conversation?.defaultBotId },
                    palette = palette,
                    onBack = {
                        // 回到哪一屏由进来的人决定：名片进的就回队伍，后台进的就回后台。
                        screen = if (onScreen != null) Screen.Crew else Screen.Backend
                        onScreen = null
                    },
                )
                Screen.Crew -> CrewScreen(client, conversation, palette, problem, draft, sending,
                    { draft = it }, { sending = it }, { refresh() }, { problem = it },
                    onBackend = { screen = Screen.Backend },
                    onWorkspace = { bot ->
                        onScreen = bot
                        screen = Screen.Workspace
                    },
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
    palette: CrewPalette,
    onBackend: () -> Unit,
) {
    // 按过哪个按钮、它缺什么。null 表示还没按过；按过就一直写着，不闪一下就没。
    var touched by remember { mutableStateOf<String?>(null) }
    Column(
        modifier = Modifier.fillMaxSize().padding(horizontal = 32.dp, vertical = 24.dp),
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
                .clickable { touched = EmptyCopy.NO_CREATE_API }
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
    palette: CrewPalette,
    problem: String?,
    draft: String,
    sending: Boolean,
    onDraft: (String) -> Unit,
    onSending: (Boolean) -> Unit,
    onSent: () -> Unit,
    onFailed: (String) -> Unit,
    onBackend: () -> Unit,
    onWorkspace: (BotCard?) -> Unit,
) {
    // 名片与滚动位置归这一页；其余是发消息要用到的、由上层持有的状态。
    var profile by remember { mutableStateOf<BotCard?>(null) }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    Column(modifier = Modifier.fillMaxSize()) {
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
            TextButton(onClick = onBackend) { Text("后台", color = palette.accent) }
        }
        // 页头那 1 的下边线。画板把它画在页头这一块上，不画在内容上。
        Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(palette.line))
        val shown = conversation
        if (shown != null) {
            when {
                // 只按 bots 判：消息可能是「名字读不出来」的残留，那也还是没人的队伍。
                shown.bots.isEmpty() ->
                    EmptyState(palette, onBackend)
                else -> {
                    // 花名册横排：头像块 + 名字。设计稿里头像 32dp、圆角 10。
                    // 裸文字按钮看不出「这是一个人」，头像块才看得出来。
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 6.dp),
                        horizontalArrangement = Arrangement.spacedBy(16.dp),
                    ) {
                        for ((index, bot) in shown.bots.withIndex()) {
                            Column(
                                horizontalAlignment = Alignment.CenterHorizontally,
                                modifier = Modifier.clickable { profile = bot },
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
                        BotCardSheet(shownProfile, shown, palette, onTalk = { profile = null }, onClose = { profile = null }) {
                            // 进工作区前先把名片收起来：否则从屏幕页退回来时还压着一张卡。
                            profile = null
                            onWorkspace(it)
                        }
                    }
                    LazyColumn(
                        state = listState,
                        modifier = Modifier.weight(1f),
                        // 消息贴底：聊天的内容总是从下面往上长，空的地方应该在上面。
                        // 设计稿这里用的是 flex-end。
                        // 间距不设在这里：画板是组间 16、组内 9，得逐条算，见下面那一行。
                        verticalArrangement = Arrangement.Bottom,
                    ) {
                        itemsIndexed(shown.messages, key = { _, m -> m.id }) { index, message ->
                            // 与上一条是同一个人就连着排，不再重复标名字。
                            val previous = shown.messages.getOrNull(index - 1)
                            val sameSpeaker = previous != null &&
                                previous.fromBot == message.fromBot &&
                                previous.botId == message.botId
                            MessageRow(
                                message, shown.bots, palette,
                                showName = !sameSpeaker,
                                // 组内 9、换人 16。第一条上面不留白，否则贴底时首条离底边会多一截。
                                topGap = if (previous == null) 0.dp else if (sameSpeaker) 9.dp else 16.dp,
                            )
                        }
                        if (shown.tickets.isNotEmpty()) {
                            item { TicketStrip(shown, palette) }
                            // 第一张工单的子代理能在这里展开，就是「他派了谁」。
                            item { SubagentCard(client, shown.tickets.first().id, palette) }
                        }
                    }
                    LaunchedEffect(shown.messages.size) {
                        if (shown.messages.isNotEmpty()) listState.animateScrollToItem(shown.messages.size - 1)
                    }
                    // 连不上就别让人发：发出去也到不了，还让人以为发了。
                    Composer(draft, shown.queued.size, sending, palette, enabled = problem == null, onChange = onDraft) {
                        val text = draft
                        onSending(true)
                        scope.launch {
                            try {
                                client.send(
                                    text,
                                    CrewWire.mentionsIn(text, shown.bots),
                                    java.util.UUID.randomUUID().toString(),
                                )
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
                        .padding(vertical = 11.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("跟他说话", fontSize = 13.5.sp, fontWeight = FontWeight(550), color = palette.surface)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                    SmallCardButton("改人设", palette) { }
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
            .padding(vertical = 9.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, fontSize = 12.5.sp, color = palette.ink)
    }
}

/**
 * 工作区：某个 Bot 的屏幕，加上「接手操作」「让它停一下」。
 *
 * 画板 `Mobile-workspace.dc.html` 画的是屏幕已经接上那一刻。后端现在既没有读屏接口，
 * 也没有接管接口，所以这一页的原则是：只画真有的东西。
 * 屏幕那块给一个写了「画面还没接上」的空位，不拿黑白方块拼一个假浏览器窗口 ——
 * 假画面比空位更坏，它会让人以为自己看到的是真的。
 *
 * bot 为 null 表示从后台进来、还没指定是谁：那时抬头写「队伍」，也不编一个名字。
 */
@Composable
private fun WorkspaceScreen(bot: BotCard?, palette: CrewPalette, onBack: () -> Unit) {
    // 按过的那个动作。null 表示还没按过；按过一次就一直在下面写着，不闪一下就没。
    var touched by remember { mutableStateOf<WorkspaceAction?>(null) }

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
                    .size(30.dp)
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
                    .size(30.dp)
                    .border(1.dp, palette.line, RoundedCornerShape(9.dp))
                    .clickable { touched = WorkspaceAction.Takeover },
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
                Text(
                    "还没接上画面",
                    fontSize = 10.5.sp,
                    color = palette.faint,
                    fontFamily = FontFamily.Monospace,
                )
            }
            // 这里本该放它的画面。现在只能放一句话，而且要说清是「空」不是「在加载」。
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .background(palette.surface, RoundedCornerShape(10.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(WorkspaceCopy.PLACEHOLDER, fontSize = 13.sp, color = palette.muted)
                    Text(
                        "它现在看的那个页面，手机这头还没有通路",
                        fontSize = 11.sp,
                        color = palette.hint,
                        modifier = Modifier.padding(top = 6.dp),
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
                // 画板把「让它停一下」画成实心强调色。可这里还没有能停下来的接口：
                // 一个最显眼的按钮按下去什么也不发生，比一个低调的更有欺骗性。
                // 所以两个都先按次要样式排 —— 等接口接上，「让它停一下」再换成实心。
                WorkspaceButton(WorkspaceAction.Takeover, palette) { touched = it }
                WorkspaceButton(WorkspaceAction.Pause, palette) { touched = it }
            }
            Text(
                WorkspaceCopy.TAKEOVER_NOTE,
                fontSize = 10.5.sp,
                color = palette.hint,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )
            // 点过就把「没接上」写出来。空着的话，人会以为自己按对了。
            touched?.let {
                Text(
                    WorkspaceCopy.actionNote(it),
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
private fun RowScope.WorkspaceButton(action: WorkspaceAction, palette: CrewPalette, onPress: (WorkspaceAction) -> Unit) {
    Box(
        modifier = Modifier
            .weight(1f)
            .background(palette.card, RoundedCornerShape(10.dp))
            .border(1.dp, palette.line, RoundedCornerShape(10.dp))
            .clickable { onPress(action) }
            .padding(vertical = 11.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(action.label, fontSize = 13.sp, color = palette.ink)
    }
}

/** 队伍页顶栏上的小方块按钮。画板里是 32dp、圆角 9、细边、强调色字形。 */
@Composable
private fun GlassIconButton(glyph: String, tint: Color, palette: CrewPalette, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .size(32.dp)
            .background(palette.card, RoundedCornerShape(9.dp))
            .border(1.dp, palette.line, RoundedCornerShape(9.dp))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(glyph, fontSize = 13.sp, color = tint)
    }
}

@Composable
private fun BackendScreen(
    client: CrewClient,
    conversation: Conversation?,
    palette: CrewPalette,
    onCrew: () -> Unit,
    onRefresh: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    // 三档：进行中 / 待你 / 已完成。手机屏窄，标签放不下一排就换成可点的文字行。
    var tab by remember { mutableStateOf(0) }
    Column(modifier = Modifier.fillMaxSize().padding(horizontal = 14.dp, vertical = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("后台", fontSize = 15.sp, fontWeight = FontWeight(640), color = palette.ink)
            Box(modifier = Modifier.weight(1f))
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
                    modifier = Modifier.clickable { tab = index },
                )
            }
        }
        // needsPerson 是空串而不是 null（后端没给这个字段时 optString 返回 ""），
        // 所以判断「在等你」要看 isNotEmpty —— 写成 == null 会永远为 false，
        // 「进行中」那一栏因此全空。
        val tickets = allTickets.filter { ticket ->
            val waiting = ticket.needsPerson.isNotEmpty()
            when (tab) {
                1 -> waiting
                2 -> ticket.state == "done"
                else -> ticket.state != "done" && !waiting
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
            if (ticket.state == "failed") {
                // 失败的票得有一条出路。
                TextButton(onClick = {
                    scope.launch {
                        runCatching { client.retry(ticket.id) }
                        // 不管成没成都重读一次，状态由后端说了算。
                        onRefresh()
                    }
                }) { Text("重试", color = palette.accent, fontSize = 11.sp) }
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

@Composable
private fun TicketStrip(conversation: Conversation, palette: CrewPalette) {
    // 对话里只露一张「等你决定」，其余在后台里看。
    val waiting = conversation.tickets.firstOrNull { it.needsPerson.isNotEmpty() } ?: return
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(palette.card, RoundedCornerShape(10.dp))
            .padding(12.dp),
    ) {
        Text("等你决定", color = palette.warn, fontSize = 11.sp, fontWeight = FontWeight.Bold)
        Text(waiting.title, color = palette.ink, fontSize = 13.sp, modifier = Modifier.padding(top = 4.dp))
        Text(waiting.needsPerson, color = palette.warn, fontSize = 11.sp)
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
        Text("${stateWord(ticket.state)} · $owner", color = palette.muted, fontSize = 11.sp)
        if (ticket.needsPerson.isNotEmpty()) {
            Text(ticket.needsPerson, color = palette.warn, fontSize = 11.sp)
        }
    }
}

private fun stateWord(state: String): String = when (state) {
    "work" -> "在做"
    "person" -> "等你"
    "failed" -> "失败"
    "done" -> "已完成"
    else -> "在做"
}

/** 子代理卡：点开才去读树。子代理还能再分子代理，所以按层缩进展开。 */
@Composable
private fun SubagentCard(client: CrewClient, ticketId: String, palette: CrewPalette) {
    var open by remember { mutableStateOf(false) }
    var nodes by remember { mutableStateOf<List<AgentNode>?>(null) }
    var trouble by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    // 表头要显示「2 个子代理 · 1 在跑」，所以一出现就得去读，不用等点开。
    // 收起只是收起明细，摘要一直在。
    LaunchedEffect(ticketId) {
        if (nodes == null) {
            try {
                nodes = client.agents(ticketId)
            } catch (error: Exception) {
                trouble = error.message
            }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .background(palette.card, RoundedCornerShape(10.dp))
            .padding(13.dp),
    ) {
        // 表头：左「N 个子代理」，右「x 在跑 · y 已完成」。
        // 收起时也显示 —— 空的按钮块占着一大片白，比没有更难看。
        Row(
            modifier = Modifier.fillMaxWidth().clickable {
                open = !open
                if (open && nodes == null) {
                    scope.launch {
                        try {
                            nodes = client.agents(ticketId)
                        } catch (error: Exception) {
                            trouble = error.message
                        }
                    }
                }
            },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val total = nodes?.let { countAgents(it) }
            val running = nodes?.count { it.state != "done" } ?: 0
            Text(
                if (total == null) "子代理" else "%d 个子代理".format(total),
                fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = palette.muted,
            )
            Box(Modifier.weight(1f))
            Text(
                when {
                    total == null -> if (open) "读着…" else "点开看"
                    else -> "%d 在跑 · %d 已完成".format(running, total - running)
                },
                fontSize = 11.sp, color = palette.faint,
            )
        }
        trouble?.let {
            Spacer(Modifier.height(6.dp))
            Text(it, color = palette.danger, fontSize = 11.sp)
        }
        if (open) {
            Spacer(Modifier.height(6.dp))
            nodes?.forEach { AgentBranch(it, 0, palette) }
        }
    }
}

/** 数整棵树有多少个分身。 */
private fun countAgents(nodes: List<AgentNode>): Int =
    nodes.sumOf { 1 + countAgents(it.children) }

@Composable
private fun AgentBranch(node: AgentNode, depth: Int, palette: CrewPalette) {
    // 缩进就是层级：不压平，也不额外画线。
    Row(modifier = Modifier.padding(start = (depth * 12).dp, top = 2.dp)) {
        Text(
            // 有标签就显示标签：`a1-1` 这种内部编号对人没有意义。
            "${if (node.state == "done") "✓" else "·"} ${node.label.ifBlank { node.id }}",
            color = if (node.state == "done") palette.faint else palette.ink,
            fontSize = 11.sp,
        )
    }
    node.children.forEach { AgentBranch(it, depth + 1, palette) }
}

@Composable
private fun MessageRow(
    message: Message,
    bots: List<BotCard>,
    palette: CrewPalette,
    showName: Boolean = true,
    topGap: Dp = 0.dp,
) {
    val fromBot = message.fromBot
    val name = when {
        !fromBot -> "我"
        else -> bots.firstOrNull { it.id == message.botId }?.name ?: message.botId.orEmpty()
    }
    // 手机上一行就是一条消息：左对齐的是 Bot，右对齐的是自己。
    // 设计稿里自己发的那个气泡右下角收成 4dp，指向说话人那一侧。
    Column(
        modifier = Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, top = topGap),
        horizontalAlignment = if (fromBot) Alignment.Start else Alignment.End,
    ) {
        // 自己发的话不标名字：靠右对齐已经说明是谁了。
        // 别人（Bot）的才标 —— 多人对话里需要知道这句是谁说的。
        // 连着的同一个 Bot 只标一次，否则一排「写手」比不标还乱。
        if (showName && fromBot) {
            Text(
                name,
                fontSize = 10.5.sp,
                fontWeight = if (fromBot) FontWeight.SemiBold else FontWeight.Normal,
                color = if (fromBot) palette.accent else palette.faint,
            )
            Spacer(Modifier.height(3.dp))
        }
        Box(
            modifier = Modifier
                // 画板：气泡最宽 84%，不是写死的 300dp —— 390 宽上 300 太窄、更宽的屏又太短。
                .fillMaxWidth(0.84f)
                .clip(
                    if (fromBot) RoundedCornerShape(14.dp)
                    else RoundedCornerShape(14.dp, 14.dp, 4.dp, 14.dp)
                )
                .background(if (fromBot) palette.card else palette.userBubble)
                .padding(horizontal = 13.dp, vertical = 10.dp),
        ) {
            Text(
                message.text,
                fontSize = 14.sp,
                // 自己发的是 1.55，Bot 的话是 1.6：后者通常更长，行距松一点好读。
                lineHeight = if (fromBot) 22.5.sp else 21.75.sp,
                color = if (fromBot) palette.ink else palette.userInk,
            )
        }
    }
}

@Composable
private fun Composer(
    draft: String,
    queued: Int,
    sending: Boolean,
    palette: CrewPalette,
    enabled: Boolean,
    onChange: (String) -> Unit,
    onSend: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth()) {
        if (queued > 0) {
            // 排队的消息要看得见，否则发出去像石沉大海。
            Text(
                "$queued 条排队中，等队伍读完手上这一步",
                fontSize = 11.sp,
                color = palette.faint,
                modifier = Modifier.padding(start = 16.dp, top = 8.dp),
            )
        }
        ComposerRow(draft, sending, palette, enabled, onChange, onSend)
    }
}

@Composable
private fun ComposerRow(draft: String, sending: Boolean, palette: CrewPalette, enabled: Boolean, onChange: (String) -> Unit, onSend: () -> Unit) {
    // 输入区：画板里圆角 13、白底细边、上下留白。默认的 OutlinedTextField
    // 是直角加厚边框，和整页的圆润调子对不上，所以自己给形状和颜色。
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
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
            shape = RoundedCornerShape(13.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedContainerColor = palette.surface,
                unfocusedContainerColor = palette.surface,
                focusedBorderColor = palette.line,
                unfocusedBorderColor = palette.line,
                disabledBorderColor = palette.line,
                cursorColor = palette.accent,
            ),
            modifier = Modifier.weight(1f),
        )
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
