package com.dsh.botcrew

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 配好的电脑存在本机，重启后不用再念一次码。
        val pairing = PairingStore(this)
        val thisDevice = deviceId(this)

        setContent {
            val palette = if (isSystemInDarkTheme()) DarkPalette else LightPalette
            // 显式标类型：PairingStore.load 返回的是平台类型，推断不出来会让整段编译失败。
            var paired by remember { mutableStateOf(pairing.load()) }
            var client by remember { mutableStateOf<CrewClient?>(null) }
            // 现在走的是哪条路。换路时由 CrewClient 回调改它，界面那一行跟着变。
            var way by remember { mutableStateOf<CrewRoute.Way?>(null) }
            // 本该有 P2P 却没接上时挂在界面上的一句话；一切正常时是空串。
            var p2pNote by remember { mutableStateOf("") }
            // 隧道这条路上实测的一个来回。界面照实报出这个数，不拿它猜直连还是中继 ——
            // RTT 快慢证明不了请求有没有经 DERP，那是没有实际路径信号时的臆测。
            var tunnelMillis by remember { mutableStateOf<Long?>(null) }

            LaunchedEffect(paired) {
                val current = paired
                if (current == null) {
                    TailcatP2p.stop()
                    client = null
                    way = null
                    p2pNote = ""
                    tunnelMillis = null
                    return@LaunchedEffect
                }
                client = null
                p2pNote = ""
                tunnelMillis = null

                // 先把不含 P2P 的连接交出去：建客户端不碰网络，启动不等隧道。
                // proxyPort 在后台接上 P2P 之后才填，换路回调靠它认出「这一条是 P2P」。
                var proxyPort: Int? = null
                val entries = CrewRoute.entries(current, proxyPort = null)
                val opened = CrewClient(entries, current.token, current.deviceId) { entry ->
                    way = CrewRoute.kindOf(entry, current, proxyPort)
                }
                client = opened
                way = CrewRoute.kindOf(entries.firstOrNull().orEmpty(), current, null)

                // 句柄只建一次：start 内部先 stop 再新建隧道客户端，反复 start 等于每次探测都重建句柄。
                // 换网络后隧道在库内部自己重连，重试只复用这个端口去探，不再碰句柄。
                var ownedPort: Int? = null
                try {
                    val port = withContext(Dispatchers.IO) {
                        TailcatP2p.start(current.p2pAddr).also { ownedPort = it }
                    }
                    if (port == null) {
                        if (current.p2pAddr.isNotBlank()) p2pNote = P2P_DOWN
                        return@LaunchedEffect
                    }
                    // 只在前台探测；退到后台取消等待，再回前台重置退避。句柄始终复用。
                    lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                        var failures = 0
                        while (isActive) {
                            val probed = withContext(Dispatchers.IO) {
                                TailcatP2p.probe(port, current.token, current.deviceId)
                            }
                            if (probed.ok) {
                                proxyPort = port
                                opened.promote(CrewRoute.proxyBase(port))
                                way = CrewRoute.Way.P2P
                                tunnelMillis = probed.millis
                                p2pNote = ""
                                failures = 0
                                delay(P2P_CHECK_INTERVAL_MS)
                            } else {
                                p2pNote = P2P_DOWN
                                tunnelMillis = null
                                delay(CrewRoute.retryDelay(failures))
                                failures = (failures + 1).coerceAtMost(5)
                            }
                        }
                    }
                } finally {
                    // 旧配对的延迟收尾不能关掉后来新建的代理。
                    ownedPort?.let(TailcatP2p::stop)
                }
            }

            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    val current = paired
                    val ready = client
                    when {
                        current == null -> PairingScreen(palette, thisDevice, this) { credential ->
                            // 配好就落盘，下一帧直接进队伍。
                            pairing.save(credential)
                            paired = credential
                        }
                        ready == null -> WaitingLine(palette)
                        else -> CrewRoot(
                            client = ready,
                            palette = palette,
                            // 三条路哪条在用要说出来：出问题时「现在走的是公网中转」就是第一条线索。
                            // 隧道这条带上实测往返，只说连上了、多快，不凭快慢断言是直连还是中继。
                            route = CrewRoute.label(way, tunnelMillis, p2pNote),
                            onForget = {
                                pairing.clear()
                                paired = null
                            },
                        )
                    }
                }
            }
        }
    }

    private companion object {
        /** 界面上那句话。它是说明，不是错误码：真正的原因看 logcat 的 CrewP2p/CrewTailcat。 */
        const val P2P_DOWN = "P2P 没通"

        const val P2P_CHECK_INTERVAL_MS = 30_000L
    }
}

/** 建连接那一瞬间看到的一句话。它不是错误提示，所以不用告警色。 */
@Composable
private fun WaitingLine(palette: CrewPalette) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text("正在连上队伍…", fontSize = 13.sp, color = palette.muted)
    }
}
