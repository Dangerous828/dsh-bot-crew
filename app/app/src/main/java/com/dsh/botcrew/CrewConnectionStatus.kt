package com.dsh.botcrew

import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * 连接状态：**一行 48dp 的紧凑可点摘要 + 点开 Dialog 看详情**。
 *
 * 为什么不做成大卡片：手机首屏顶部已经太高（设计成员正在压缩，目标 <=20–24%）。
 * 连接说明是常驻内容，若再加一块会直接挤出消息区。所以这里只占一行：
 * 一个状态点 + 一句话说清「现在走的是哪条路」，点一下才在 Dialog 里展开
 * 「日常怎么用 / 服务停了怎么办 / 完整地址」。Dialog 不挤主内容。
 *
 * 不碰配对、不实际连服务、不自建连接初始化 —— 只画传入的状态，刷新回调交回上层。
 *
 * 状态判据（纯函数见下方 `summaryText` / `statusTone`，JVM 单测钉住）：
 * - [loading] 时一定不是绿色，也不写「已连接」：还没拉到任何东西。
 * - [problem] 非空时一定不是绿色：只报事实 + 可重试，不冒充连上。
 * - 只有拿到连接（拿到 client、但 timeline 尚未成功的窗口由上层用 [loading] 表达）
 *   且没有 problem 才显示绿色「已连接」。
 */
@Composable
fun CrewConnectionStatus(
    /** 现在走的是哪条路（隧道已连接 / 局域网 / 公网中转 …）；空串表示还算不出来。 */
    route: String,
    /** 正在建立/等待首份数据。true 时绝不显示绿色或「已连接」。 */
    loading: Boolean,
    /** 最近一次连接/拉取失败的人话原因；null 表示没有已知问题。 */
    problem: String?,
    palette: CrewPalette,
    /** 点「刷新」时回调上层重连/重拉。组件自身不自建连接。 */
    onRefresh: () -> Unit,
    /**
     * 可选：一进场就展开详情（供 WaitingLine 之类只借详情 Dialog 的调用方）。
     * 默认 false —— 正常顶栏摘要仍是折叠一行。
     */
    startExpanded: Boolean = false,
    /** 可选：详情被关掉时通知调用方（配合 [startExpanded] 复位自己的状态）。 */
    onExpandedConsumed: () -> Unit = {},
    /**
     * 嵌入顶栏 Row 时由调用方给宽度（例如 `Modifier.widthIn(max = 120.dp)`）——
     * 本组件**不再强制 fillMaxWidth**，否则塞进一行会把中/右两块挤掉。
     */
    modifier: Modifier = Modifier,
    /**
     * 紧凑模式：只显示「状态点 + 短 route（如『局域网』）」，隐藏右侧「详情/重试」文字，
     * 整行更窄，用来和「当前会话胶囊 + 更多」并进一行 52dp 顶栏。完整说明永远在 Dialog 里。
     */
    compact: Boolean = false,
) {
    var open by remember { mutableStateOf(startExpanded) }
    val tone = statusTone(loading = loading, problem = problem)
    val summary = summaryText(route = route, loading = loading, problem = problem)
    // 健康点的绿必须是「连接正常」的稳定语义绿，**不能复用传入 palette 的 accent**：
    // 分拣台（TriagePalette）的操作强调色是红棕，聊天页绿 → 任务页红会让用户误以为断连。
    // 这里按 surface 亮度判明暗主题，取固定语义绿（= LightPalette/DarkPalette.accent 的字面值），
    // 与之无关当前传入的是哪套 palette。WAIT 灰 / PROBLEM 红仍走传入 palette。
    val dot = when (tone) {
        Tone.OK -> connectionGreen(palette.surface)
        Tone.WAIT -> palette.faint
        Tone.PROBLEM -> palette.danger
    }

    Row(
        modifier = modifier
            .heightIn(min = 48.dp)
            .clip(RoundedCornerShape(8.dp))
            .clickable { open = true }
            .padding(horizontal = if (compact) 8.dp else 16.dp, vertical = 8.dp)
            .semantics { contentDescription = "连接状态：$summary，点按查看详情" },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // 状态点：绿=已连接，灰=正在连，红=有问题。颜色是唯一允许「发绿」的地方，
        // 且只在 tone==OK 时才绿。
        Spacer(
            Modifier
                .size(8.dp)
                .clip(CircleShape)
                .background(dot),
        )
        Spacer(Modifier.width(if (compact) 6.dp else 8.dp))
        Text(
            text = if (compact) shortSummary(route = route, loading = loading, problem = problem) else summary,
            fontSize = 12.sp,
            color = palette.muted,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            // 紧凑模式宽度由调用方 widthIn 约束，不用 weight 去抢满一行。
            modifier = if (compact) Modifier else Modifier.weight(1f),
        )
        if (!compact) {
            Spacer(Modifier.width(8.dp))
            Text(
                text = if (tone == Tone.PROBLEM) "重试" else "详情",
                fontSize = 12.sp,
                color = palette.accent,
                fontWeight = FontWeight.Medium,
            )
        }
    }

    if (open) {
        ConnectionDetailDialog(
            route = route,
            summary = summary,
            problem = problem,
            tone = tone,
            palette = palette,
            onRefresh = onRefresh,
            onDismiss = { open = false; onExpandedConsumed() },
        )
    }
}

/**
 * 详情 Dialog：不占主内容，展开才看。
 *
 * 内容三块：
 * 1. 现在的连接（完整 route / problem）。
 * 2. 日常怎么用：Mac 开机、联网、**不睡眠**即可；不用开本项目桌面 App，也不用留着这个聊天。
 * 3. 只有服务真的停了才需要跑一次启动命令（给可复制的正确命令）。
 *
 * 「已配对」是既有事实，这里**不建议重新配对** —— 重配会把现有连接和数据打乱。
 */
@Composable
private fun ConnectionDetailDialog(
    route: String,
    summary: String,
    problem: String?,
    tone: Tone,
    palette: CrewPalette,
    onRefresh: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = palette.card,
        titleContentColor = palette.ink,
        textContentColor = palette.muted,
        title = { Text("连接详情", fontSize = 16.sp, fontWeight = FontWeight.SemiBold) },
        text = {
            // 小屏 / 大字体下正文可能超出一屏：允许纵向滚动，命令块再长也能看到结尾按钮。
            Column(
                verticalArrangement = Arrangement.spacedBy(10.dp),
                // 显式限高再滚动：AlertDialog 的 text 槽对超高内容不自动滚，
                // 不限高时（竖屏 + fontScale 1.3–2.0）内容会把底部按钮挤出可视区。
                modifier = Modifier
                    .heightIn(max = 360.dp)
                    .verticalScroll(rememberScrollState()),
            ) {
                Text(summary, fontSize = 13.sp, color = palette.ink, fontWeight = FontWeight.Medium)
                // 完整 route 原样显示：出问题时这一行就是第一条线索，不截断。
                if (route.isNotBlank()) {
                    Text("当前路径：$route", fontSize = 12.sp, color = palette.muted)
                }
                if (!problem.isNullOrBlank()) {
                    Text("最近错误：$problem", fontSize = 12.sp, color = palette.danger)
                }

                SectionRule(palette)
                // 标题用 muted 而非 faint，保证在 card 底上够对比度。
                SectionTitle("日常使用", palette)
                GuidanceLine("Mac 保持开机、联网、不睡眠即可。")
                GuidanceLine("不用开本项目的桌面 App，也不用留着这个聊天窗口。")
                GuidanceLine("配对信息已保留；连接失败时先点刷新，并检查 Mac 上的服务是否在跑。")

                SectionRule(palette)
                SectionTitle("服务真的停了才需要", palette)
                GuidanceLine("仅在 Mac 服务停止时运行下面的命令：")
                // 命令默认折叠，避免一打开弹层就是一大块代码；点「显示命令」才展开。
                // 展开后提供整段可选中 + 一键复制按钮，命令块再长也不会撑爆弹层。
                CopyableCommand(command = ConnectionGuidance.START_COMMAND, palette = palette)
            }
        },
        confirmButton = {
            TextButton(onClick = { onRefresh(); onDismiss() }) {
                Text("刷新连接", color = palette.accent)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("关闭", color = palette.muted) }
        },
    )
}

@Composable
private fun SectionRule(palette: CrewPalette) {
    Spacer(Modifier.height(2.dp))
    Spacer(
        Modifier
            .fillMaxWidth()
            .height(1.dp)
            .background(palette.line),
    )
}

/** 分段小标题。用 muted 保证在 card 底上有足够对比度（faint 偏淡）。 */
@Composable
private fun SectionTitle(text: String, palette: CrewPalette) {
    Text(text, fontSize = 12.sp, color = palette.muted, fontWeight = FontWeight.SemiBold)
}

@Composable
private fun GuidanceLine(text: String) {
    Text("· $text", fontSize = 12.sp)
}

/**
 * 可折叠 + 可复制的命令块。
 *
 * 默认折叠成一行「显示命令」，弹层不会被一大段代码撑高；展开后整段放进
 * [SelectionContainer]（系统长按可选中复制），另配一个明确 48dp 高的「复制」按钮
 * 直接写平台剪贴板 —— 「可复制」名副其实，不靠猜长按。
 */
@Composable
private fun CopyableCommand(command: String, palette: CrewPalette) {
    var expanded by remember { mutableStateOf(false) }
    val context = LocalContext.current
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .clip(RoundedCornerShape(8.dp))
                .clickable { expanded = !expanded }
                .padding(horizontal = 8.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = if (expanded) "隐藏命令" else "显示命令",
                fontSize = 12.sp,
                color = palette.accent,
                fontWeight = FontWeight.Medium,
            )
        }
        if (expanded) {
            SelectionContainer {
                Text(
                    text = command,
                    fontSize = 11.sp,
                    color = palette.ink,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(6.dp))
                        .background(palette.field)
                        .padding(horizontal = 10.dp, vertical = 8.dp),
                )
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(palette.accentSoft)
                    .clickable {
                        val clip = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE)
                            as? android.content.ClipboardManager
                        clip?.setPrimaryClip(
                            android.content.ClipData.newPlainText("start command", command),
                        )
                    }
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center,
            ) {
                Text(
                    text = "复制命令",
                    fontSize = 12.sp,
                    color = palette.accent,
                    fontWeight = FontWeight.Medium,
                )
            }
        }
    }
}

/** 连接状态的三档语义。绿只在 [OK]。 */
enum class Tone { OK, WAIT, PROBLEM }

/**
 * 仅凭三个输入判档 —— 纯函数，JVM 单测直接钉住，不碰 Android。
 *
 * 优先级：problem > loading > 其余。
 * 关键约束：**未拿到成功结果前不许说「已连接」**，所以 loading 时是 [WAIT] 不是 [OK]；
 * problem 存在时是 [PROBLEM]，绝不因 route 看着正常就发绿。
 */
/**
 * 连接健康点的稳定语义绿。按 surface 明暗取固定值，不依赖传入 palette 的 accent ——
 * 因为分拣台的 accent 是红棕，复用会让「健康」在任务页显示成红色（误读断连）。
 *
 * 亮色 = `0xFF3E6B62`（= LightPalette.accent），暗色 = `0xFF5FBFA8`（= DarkPalette.accent）。
 * 纯函数：只读 surface 亮度，JVM 单测可直接钉住两档，不碰 Android。
 */
fun connectionGreen(surface: Color): Color = greenFor(surface.luminance() < 0.5f)

/**
 * 明暗 → 语义绿的纯判定（不碰 Compose 运行时，JVM 单测直接钉住）。
 * 暗底取亮绿 `0xFF5FBFA8`（= DarkPalette.accent），亮底取深绿 `0xFF3E6B62`（= LightPalette.accent）。
 */
fun greenFor(dark: Boolean): Color =
    if (dark) Color(0xFF5FBFA8) else Color(0xFF3E6B62)

/**
 * 仅凭三个输入判档 —— 纯函数，JVM 单测直接钉住，不碰 Android。
 *
 * 优先级：problem > loading > 其余。
 * 关键约束：**未拿到成功结果前不许说「已连接」**，所以 loading 时是 [WAIT] 不是 [OK]；
 * problem 存在时是 [PROBLEM]，绝不因 route 看着正常就发绿。
 */
fun statusTone(loading: Boolean, problem: String?): Tone = when {
    !problem.isNullOrBlank() -> Tone.PROBLEM
    loading -> Tone.WAIT
    else -> Tone.OK
}

/**
 * 摘要那一行的人话。紧凑、单行可截断。
 *
 * 规则：
 * - 有 problem：`连不上 · <problem>`（红），不冒充连上。
 * - loading：`正在连接…`（灰），哪怕 route 已经有值也不说「已连接」——首份时间线没拉回来前不算数。
 * - 其余：`已连接 · <route>`；route 为空时只说 `已连接`。
 */
fun summaryText(route: String, loading: Boolean, problem: String?): String = when {
    !problem.isNullOrBlank() -> if (problem.length > 40) "连不上 · ${problem.take(40)}…" else "连不上 · $problem"
    loading -> "正在连接…"
    route.isBlank() -> "已连接"
    else -> "已连接 · $route"
}

/**
 * 紧凑模式那一行（顶栏 Row 里塞得下）：只留**状态词**，route 取最短可辨识的一截。
 *
 * - 有 problem：`连不上`（红点），不展开原因（完整原因在 Dialog）。
 * - loading：`连接中`。
 * - OK：route 含「局域网」→ `局域网`；含「隧道」→ `隧道`；含「公网」→ `公网`；
 *   其余非空 route 原样（截到 6 字）；空 route → `已连接`。
 *
 * 关键约束仍是：**只有 tone==OK 才会走到「局域网/隧道/已连接」这些成功词**，
 * 未成功拉回 timeline 前由上层传 loading=true，这里只会给出「连接中」。
 */
fun shortSummary(route: String, loading: Boolean, problem: String?): String = when {
    !problem.isNullOrBlank() -> "连不上"
    loading -> "连接中"
    route.isBlank() -> "已连接"
    route.contains("局域网") -> "局域网"
    route.contains("隧道") -> "隧道"
    route.contains("公网") -> "公网"
    else -> route.take(6)
}

/**
 * 日常启动指引里唯一需要人手动复制的命令。
 *
 * 与交接文档一致：**仅服务停止时**在 Mac 上运行。组件只展示、不执行。
 * 单独抽成常量，测试可逐字钉住，避免将来文案漂移。
 */
object ConnectionGuidance {
    const val START_COMMAND =
        "cd /Users/cpuser/Code/dsh-bot-crew && python3 backend/scripts/dsh-superagent start --profile superagent"
}
