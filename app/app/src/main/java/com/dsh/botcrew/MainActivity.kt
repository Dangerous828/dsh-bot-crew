package com.dsh.botcrew

import android.os.Bundle
import android.util.Log
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    /**
     * 隧道代理是进程级的（一个客户端句柄服务所有连接），Activity 走了必须放掉 ——
     * 否则每次旋转屏幕都留一份 Go 运行时里的句柄。
     */
    override fun onDestroy() {
        TailcatP2p.stop()
        super.onDestroy()
    }

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
            // 隧道这条路上实测的一个来回。界面据此分「直连」和「中继」—— 两者都叫「隧道通」，
            // 但一个 1.4ms、一个 137ms，混成一句话说就是在骗人。
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

                // 隧道在后台接。手机经 DERP 引导首连要 5–15 秒（注册 + 打洞升级），
                // 挡在启动路径上就是让人对着空屏等；先让人看到内容，接上了再自己升级。
                val port = withContext(Dispatchers.IO) { TailcatP2p.start(current.p2pAddr) }
                if (port == null) {
                    // 地址空着是「这台电脑没公布 P2P」，不是故障，不必在界面上说。
                    if (current.p2pAddr.isNotBlank()) p2pNote = P2P_DOWN
                    return@LaunchedEffect
                }
                val probed = withContext(Dispatchers.IO) {
                    TailcatP2p.probe(port, current.token, current.deviceId)
                }
                if (probed.ok) {
                    // 记下端口再提队首：回调里的 kindOf 要认出这条是 P2P，界面才会改口。
                    proxyPort = port
                    opened.promote(CrewRoute.proxyBase(port))
                    way = CrewRoute.Way.P2P
                    tunnelMillis = probed.millis
                    p2pNote = ""
                    Log.i("CrewP2p", "隧道探通，一个来回 ${probed.millis}ms")
                } else {
                    // 代理留着不收：这次没探通不等于下一次请求用不上它，收摊交给 onDestroy。
                    // 具体原因（缺库、地址过期、电脑不在线）只有日志分得清，界面上就一句。
                    Log.i("CrewP2p", "隧道没接上：${TailcatP2p.state().detail}")
                    p2pNote = P2P_DOWN
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
                            // 隧道这条还要带上实测往返：打洞失败时 tailcat 会退回 DERP 中继，
                            // 那也是「通了」，但必须说成中继而不是直连。
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
    }
}

/** 建连接那一瞬间看到的一句话。它不是错误提示，所以不用告警色。 */
@Composable
private fun WaitingLine(palette: CrewPalette) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text("正在连上队伍…", fontSize = 13.sp, color = palette.muted)
    }
}
