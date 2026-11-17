package com.dsh.botcrew

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import java.util.Locale
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * 检查更新页：整页覆盖层，从侧栏「工具 · 检查更新」进来（与「诊断」同一做法，无顶部常驻入口）。
 *
 * 只画四件事：当前版本、可用版本、一个主动作（检查 / 下载 / 取消 / 重试 / 安装）、以及异常时的一句短话。
 * 状态全部来自 [OtaRuntime]（磁盘残量 + 进程内任务），所以进程重建、权限往返回来都是真实状态。
 */
@Composable
fun OtaPage(palette: CrewPalette, onClose: () -> Unit) {
    val context = LocalContext.current
    val runtime = remember { OtaRuntime.get(context.applicationContext) }
    var state by remember { mutableStateOf(runtime.current()) }
    var note by remember { mutableStateOf("") }
    // 回前台就自增：授权状态读的是运行期事实，但值相同不会触发重组，靠这个计数把「去允许」刷成「安装」。
    var resumeTick by remember { mutableStateOf(0) }
    // 页面订阅运行时的状态：下载进度、取消、校验结果都由它推送，不靠各按钮自己回写。
    DisposableEffect(runtime) {
        runtime.observe { state = it }
        onDispose { runtime.observe(null) }
    }
    // 进页面（含 Activity 重建）：先按磁盘对齐一次，再走冷却内的静默检查。
    LaunchedEffect(Unit) {
        runtime.restore()
        state = runtime.current()
        if (state.stage == Ota.Stage.Idle) runtime.check(force = false)
    }
    // 从「安装未知应用」设置页 / 系统安装器回来：重新对齐一次（授权可能已变，版本可能已升级）。
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner) {
        val lifecycleObserver = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                runtime.restore()
                state = runtime.current()
                resumeTick++
            }
        }
        owner.lifecycle.addObserver(lifecycleObserver)
        onDispose { owner.lifecycle.removeObserver(lifecycleObserver) }
    }

    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(modifier = Modifier.fillMaxSize().background(palette.surface)) {
            Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
                Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("检查更新", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = palette.ink)
                    Spacer(Modifier.weight(1f))
                    Box(
                        modifier = Modifier.heightIn(min = 48.dp).width(64.dp).clickable(onClick = onClose),
                        contentAlignment = Alignment.Center,
                    ) { Text("关闭", fontSize = 14.sp, color = palette.accent) }
                }

                Text(
                    "当前 ${runtime.installedVersionName()}(${runtime.installedVersionCode()})" +
                        " · 构建 ${BuildInfo.BUILD_ID}",
                    fontSize = 12.sp, color = palette.muted, modifier = Modifier.padding(top = 4.dp, bottom = 2.dp),
                )

                val m = state.manifest
                if (m != null) {
                    Text(
                        "可用 ${m.versionName}(${m.versionCode})" + if (m.buildId.isNotBlank()) " · ${m.buildId}" else "",
                        fontSize = 12.sp, color = palette.muted, modifier = Modifier.padding(bottom = 6.dp),
                    )
                }

                Text(
                    stageLabel(state),
                    fontSize = 13.sp, color = if (state.stage == Ota.Stage.Failed) palette.danger else palette.ink,
                    modifier = Modifier.padding(top = 8.dp),
                )
                state.percent?.let { pct ->
                    if (state.stage == Ota.Stage.Downloading || state.stage == Ota.Stage.Verifying ||
                        state.resumable
                    ) {
                        LinearProgressIndicator(
                            progress = { pct / 100f },
                            modifier = Modifier.fillMaxWidth().padding(top = 8.dp).height(4.dp),
                            color = palette.accent,
                            trackColor = palette.track,
                        )
                    }
                }
                if (m != null && m.notes.isNotBlank() && state.stage != Ota.Stage.Checking) {
                    Text(m.notes, fontSize = 12.sp, color = palette.faint, modifier = Modifier.padding(top = 8.dp))
                }

                // 必须用户操作的那一件事，单独一行说明；正常流程不写教学。
                val canInstall = remember(state.stage, resumeTick) { runtime.canInstall() }
                if (state.stage == Ota.Stage.Ready && !canInstall) {
                    Text(
                        "需要允许「安装未知应用」",
                        fontSize = 12.sp, color = palette.warn, modifier = Modifier.padding(top = 8.dp),
                    )
                }
                if (note.isNotEmpty()) {
                    Text(note, fontSize = 12.sp, color = palette.accent, modifier = Modifier.padding(top = 6.dp))
                }

                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    when (state.stage) {
                        Ota.Stage.Checking -> OtaAction("检查中", palette, enabled = false)
                        Ota.Stage.Downloading -> OtaAction("取消", palette) { runtime.cancel() }
                        Ota.Stage.Verifying -> OtaAction("校验中", palette, enabled = false)
                        Ota.Stage.Ready -> {
                            OtaAction(if (canInstall) "安装" else "去允许", palette) {
                                if (canInstall) {
                                    runtime.install { ok -> if (!ok) note = "系统没有打开安装页" }
                                } else if (!runtime.openInstallSettings()) {
                                    note = "打不开系统设置"
                                }
                            }
                        }
                        else -> {
                            if (state.manifest != null && state.stage != Ota.Stage.Idle) {
                                val resume = state.resumable || (state.stage == Ota.Stage.Failed && state.downloaded > 0L)
                                OtaAction(if (resume) "继续下载" else "下载", palette) {
                                    runtime.download()
                                }
                            }
                            OtaAction("检查", palette) {
                                note = ""
                                runtime.check(force = true)
                            }
                        }
                    }
                }
            }
        }
    }
}

/** 一句话说清当前阶段；不解释原理、不写标语。 */
private fun stageLabel(state: Ota.State): String = when (state.stage) {
    Ota.Stage.Idle -> state.note.ifBlank { "已是最新" }
    Ota.Stage.Checking -> "正在检查"
    Ota.Stage.Available -> when {
        state.resumable -> "已暂停 · ${state.downloaded / 1024}KB / ${state.size / 1024}KB"
        state.manifest != null -> "可更新 · ${String.format(Locale.ROOT, "%.1f", state.size / 1048576.0)} MB"
        else -> "已是最新"
    }
    Ota.Stage.Downloading -> {
        val pct = state.percent ?: 0
        "下载中 $pct% · ${state.downloaded / 1024}KB / ${state.size / 1024}KB"
    }
    Ota.Stage.Verifying -> "正在校验"
    Ota.Stage.Ready -> "已校验，可安装"
    Ota.Stage.Failed -> failureCopy(state.note)
}

@Composable
private fun OtaAction(label: String, palette: CrewPalette, enabled: Boolean = true, onClick: () -> Unit = {}) {
    Box(
        modifier = Modifier
            .heightIn(min = 48.dp)
            .background(if (enabled) palette.accentSoft else palette.field, RoundedCornerShape(9.dp))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 16.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label, fontSize = 13.sp,
            color = if (enabled) palette.accent else palette.hint,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * 校验/下载失败的短码 → 一句人话。只给「发生了什么」，不给教学；重试按钮就在旁边。
 * 未知短码原样露出，方便真机对照日志，也不必为每种情况编一句安慰话。
 */
private fun failureCopy(code: String): String = when (code) {
    "" -> "失败，可重试"
    "size_mismatch" -> "文件长度与发布信息不符，已丢弃"
    "sha_mismatch" -> "文件校验不通过，已丢弃"
    "archive_unreadable" -> "读不出安装包信息"
    "package_mismatch" -> "安装包包名不符"
    "version_mismatch" -> "安装包版本与发布信息不符"
    "target_package_mismatch" -> "安装包与本机应用不同"
    "not_newer" -> "该版本不比当前新"
    "signer_unknown" -> "读不出当前应用签名"
    "signer_mismatch" -> "安装包签名与本机应用不一致"
    "signer_manifest_mismatch" -> "发布信息里的签名与实际不符"
    else -> code
}
