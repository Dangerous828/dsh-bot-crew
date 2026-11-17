package com.dsh.botcrew

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * 诊断页：App **自身**诊断的查看 / 复制 / 导出 / 清理 / 开关。
 *
 * ## 入口与位置
 *
 * 只从侧栏「工具」里的「诊断」进来（[CrewUi] 的 [CrewDrawerSheet]），**不**新增顶部常驻排、
 * 不退回旧的多排结构。进来是一整页覆盖层（与名片 overlay 同一做法），不是常驻块。
 *
 * ## 只读安全
 *
 * 列表里的每条都是环形里已白名单序列化过的字段（route 已去 query、err 只类名）。
 * 复制/导出前再过一次脱敏断言（[DiagRuntime.exportText]），命中敏感形态直接拒绝——
 * 生产日志绝不出现明文凭据。
 *
 * ## 不做的事
 *
 * 不弹键盘（本页只有按钮和开关，无输入框，不 requestFocus）；不改其它 App、不动网络设置。
 */
@Composable
fun DiagPage(palette: CrewPalette, diag: DiagRuntime, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    // 刷新触发：清空/补传后整体重读一份。
    var rows by remember { mutableStateOf(diag.recent(200)) }
    var enabled by remember { mutableStateOf(diag.enabled) }
    var note by remember { mutableStateOf<String?>(null) }
    val stats = remember(rows) { diag.stats() }

    Box(modifier = Modifier.fillMaxSize().background(palette.surface)) {
        Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
            // 顶：标题 + 关闭。
            Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("诊断 · 本机", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = palette.ink)
                Spacer(Modifier.weight(1f))
                Box(
                    modifier = Modifier.heightIn(min = 48.dp).width(64.dp).clickable(onClick = onClose),
                    contentAlignment = Alignment.Center,
                ) { Text("关闭", fontSize = 14.sp, color = palette.accent) }
            }
            Text(
                "只记录本 App 自身：请求方法/去 query 路径/耗时/状态/换路/前后台/网络异常/崩溃。" +
                    "不采聊天正文、审批内容、凭据、cookie、配对码。本地有界（${stats.rows} 条 / ${stats.bytes / 1024}KB；隔离 ${diag.quarantinedCount()} 条）。",
                fontSize = 12.sp, color = palette.muted, modifier = Modifier.padding(vertical = 8.dp),
            )
            // 构建标记：便于服务端/验证对照「哪个真实 APK」。
            Text(
                "构建 ${BuildInfo.buildIdLabel()} · ${BuildInfo.buildLabel()}",
                fontSize = 11.sp, color = palette.faint, modifier = Modifier.padding(bottom = 6.dp),
            )

            // 开关：记录诊断信息。
            Row(modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("记录诊断信息", fontSize = 14.sp, color = palette.ink)
                    Text(
                        if (enabled) "开：持续记录本机基础诊断（有上限），联网时自动批量补传到域名"
                        else "关：不再收集、不自动上传；已有记录保留，可手动清理",
                        fontSize = 11.sp, color = palette.faint,
                    )
                }
                Switch(
                    checked = enabled,
                    onCheckedChange = { on ->
                        enabled = on
                        diag.enabled = on
                        note = if (on) "已开启记录" else "已关闭记录"
                    },
                )
            }

            // 按钮行：复制 / 导出 / 手动补传 / 清理。
            Row(modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                DiagAction("复制", palette) {
                    val text = diag.exportText()
                    if (text.startsWith("检测到")) { note = text } else {
                        clipboard.setText(AnnotatedString(text))
                        note = "已复制 ${rows.size} 条"
                    }
                }
                DiagAction("导出", palette) {
                    val text = diag.exportText()
                    if (text.startsWith("检测到")) { note = text } else {
                        // 导出为可分享文本：写进剪贴板之外，界面给出全文选择区（见下）。
                        clipboard.setText(AnnotatedString(text))
                        note = "已导出到剪贴板（命中脱敏断言会拒绝）"
                    }
                }
                DiagAction("手动补传", palette) {
                    scope.launch {
                        note = diag.uploadNow()
                        rows = diag.recent(200)
                    }
                }
                DiagAction("清理", palette) {
                    diag.clear()
                    rows = diag.recent(200)
                    note = "已清理本地诊断"
                }
            }
            note?.let { Text(it, fontSize = 12.sp, color = palette.accent, modifier = Modifier.padding(bottom = 6.dp)) }

            // 列表：可选中复制的文本区。
            Column(modifier = Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                if (rows.isEmpty()) {
                    Text("暂时没有记录。", fontSize = 13.sp, color = palette.faint, modifier = Modifier.padding(8.dp))
                } else {
                    SelectionContainer {
                        Column {
                            for (row in rows.asReversed()) {
                                DiagRow(row, palette)
                            }
                        }
                    }
                }
            }
        }
    }
}

/** 一行事件：时间 · 事件 · 方法+路径 · 状态 · 耗时 · err/routeKind。 */
@Composable
private fun DiagRow(row: JSONObject, palette: CrewPalette) {
    val at = row.optString("at")
    val event = row.optString("event")
    val method = row.optString("method")
    val route = row.optString("route")
    val status = row.optInt("status", -1)
    val ms = row.optLong("ms", -1)
    val err = row.optString("err")
    val extra = row.optJSONObject("extra")
    val routeKind = extra?.optString("routeKind").orEmpty()
    val phase = extra?.optString("phase").orEmpty()
    val line = buildString {
        append(at.substringAfter('T', at))
        append(" · ").append(event)
        if (method.isNotEmpty()) append(" ").append(method)
        if (route.isNotEmpty()) append(" ").append(route)
        if (status >= 0) append(" →").append(status)
        if (ms >= 0) append(" ").append(ms).append("ms")
        if (err.isNotEmpty()) append(" · ").append(err)
        if (phase.isNotEmpty()) append(" · ").append(phase)
        if (routeKind.isNotEmpty()) append(" · ").append(routeKind)
    }
    Text(
        line, fontSize = 11.sp, color = palette.ink,
        maxLines = 2, overflow = TextOverflow.Ellipsis,
        modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp),
    )
}

/** 诊断页一个动作按钮：48dp 命中高度。 */
@Composable
private fun DiagAction(label: String, palette: CrewPalette, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .heightIn(min = 48.dp)
            .background(palette.accentSoft, RoundedCornerShape(9.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp),
        contentAlignment = Alignment.Center,
    ) { Text(label, fontSize = 13.sp, color = palette.accent) }
}
