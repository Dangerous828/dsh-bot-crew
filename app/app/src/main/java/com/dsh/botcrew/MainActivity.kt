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
import androidx.compose.runtime.SideEffect
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
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    /**
     * 调试口的挂载点。开关没开时它一直是 null —— 那时不建 socket、不建总线、不建桥，
     * 界面这一层与没有这套东西时逐字相同。
     */
    private var debugBridge: DebugBridge? = null
    private var debugServer: CrewDebugServer? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 配好的电脑存在本机，重启后不用再念一次码。
        val pairing = PairingStore(this)
        val thisDevice = deviceId(this)

        // 调试口：debug 构建默认开，release 永远不开（见 CrewDebug 的注释）。
        // 起不来只记一行日志，界面照常 —— 调试口是外挂，不是界面的一部分。
        val debugOn = CrewDebug.enabled(BuildConfig.DEBUG, CrewDebug.systemProperty(CrewDebug.PROP))
        val bridge = if (debugOn) DebugBridge() else null
        debugBridge = bridge
        if (bridge != null) {
            val server = CrewDebugServer(CrewDebug(bridge))
            if (server.start()) debugServer = server
        }

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
            // 配对记录里那条局域网地址还活着吗。走公网时它是「为什么没走直连」的唯一答案：
            // 只写「公网中转」会让人以为本来就该这样，而死地址每次都在先白等一次连接超时。
            var lanReport by remember { mutableStateOf(CrewLanHealth.Report()) }

            LaunchedEffect(paired) {
                val current = paired
                if (current == null) {
                    TailcatP2p.stop()
                    client = null
                    way = null
                    p2pNote = ""
                    tunnelMillis = null
                    lanReport = CrewLanHealth.Report()
                    return@LaunchedEffect
                }
                client = null
                p2pNote = ""
                tunnelMillis = null
                lanReport = CrewLanHealth.Report()

                // 先把不含 P2P 的连接交出去：建客户端不碰网络，启动不等隧道。
                // proxyPort 在后台接上 P2P 之后才填，换路回调靠它认出「这一条是 P2P」。
                var proxyPort: Int? = null
                val entries = CrewRoute.entries(current, proxyPort = null)
                // 这一轮配对里「局域网那条」到底是哪个地址。重新发现换了地址时它会跟着变，
                // 所以不能一直拿最初的 current.base —— 那会拿一条已经不存在的地址判失效。
                var lanBase: String = current.base
                // 判一次局域网那条的状态。做成闭包是因为它要在三处被调：换路成功时、
                // 隧道探测每一轮、以及重新发现换了地址之后 —— 三处都可能有新证据。
                fun judgeLan(opened: CrewClient): CrewLanHealth.Report {
                    if (lanBase.isBlank()) return CrewLanHealth.Report()
                    return CrewLanHealth.judge(
                        lanBase = lanBase,
                        failures = opened.failureCount(lanBase),
                        localAddresses = LanAddresses.current(),
                        inUse = CrewPairing.normalize(opened.currentEntry()) == CrewPairing.normalize(lanBase),
                    )
                }
                // 回调里要读「刚建好的那个 client」，而它还在初始化中：先留一个口子，
                // 构造完立刻填上。回调只会在请求发生时被调，那时它一定已经填好了。
                var opened: CrewClient? = null
                val fresh = CrewClient(entries, current.token, current.deviceId) { entry ->
                    way = CrewRoute.kindOf(entry, current, proxyPort)
                    // 换路成功是一次新的证据：局域网那条刚被跳过，状态要跟着更新。
                    opened?.let { lanReport = judgeLan(it) }
                }
                opened = fresh
                client = fresh
                way = CrewRoute.kindOf(entries.firstOrNull().orEmpty(), current, null)
                // 建好就判一次：刚启动时局域网那条的失败计数是 0，这时结论必然是 OK，
                // 但它让「有没有可判的地址」这件事在快照里一开始就有个明确的答案。
                lanReport = judgeLan(fresh)

                // 句柄只建一次：start 内部先 stop 再新建隧道客户端，反复 start 等于每次探测都重建句柄。
                // 换网络后隧道在库内部自己重连，重试只复用这个端口去探，不再碰句柄。
                var ownedPort: Int? = null
                try {
                    val port = withContext(Dispatchers.IO) {
                        TailcatP2p.start(current.p2pAddr).also { ownedPort = it }
                    }
                    if (port == null) {
                        if (current.p2pAddr.isNotBlank()) p2pNote = P2P_DOWN
                        // 隧道根本没起来：局域网那条是唯一能省下公网往返的路，
                        // 而这一轮之后不会再有探测循环 —— 主动敲一次再退出，
                        // 否则这条地址的状态永远是「不知道」。
                        withContext(Dispatchers.IO) { fresh.probeEntry(lanBase) }
                        lanReport = judgeLan(fresh)
                        return@LaunchedEffect
                    }
                    // 只在前台探测；退到后台取消等待，再回前台重置退避。句柄始终复用。
                    lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                        // 配好之后也继续听附近的广播，但只作**兜底**：P2P 是网域无关的主路，
                        // 换 Wi-Fi / 出门根本不需要重新发现。这里只在 P2P 没起来时，让 LAN
                        // 那条重试能命中电脑当次的地址（同网段内 IP 变了）。
                        // 判据只认 crew 指纹，认不出就不动；没授权附近设备或网络无组播时
                        // 这条流安静结束，配对保持原样，不假装刷新过。
                        launch {
                            // 「当前已应用的配对」独立记录：它是 refresh 的比较基准，但**不能**
                            // 用 Compose 的 paired 状态存 —— 改那个会重启本 effect、重建 tailcat
                            // 句柄，把正在跑的 P2P 隧道打断。也不能一直拿最初的 current 比：
                            // A→B→A 时第三条与旧 A 相等会被判「无变化」，磁盘和入口表永久停在 B。
                            var applied: PairedCrew = checkNotNull(current)
                            CrewDiscovery.find(this@MainActivity).collect { sighting ->
                                val found = sighting as? CrewSighting.Found ?: return@collect
                                val refreshed = CrewNearby.refresh(applied, found.beacon) ?: return@collect
                                // PairingStore.save() 自己保留盘上的当前会话（唯一写入口是
                                // saveSession），这里只管更新网段相关的入口表，不补任何字段。
                                pairing.save(refreshed)
                                applied = refreshed
                                // 地址换了就是换了另一条路：判失效的基准跟着走，
                                // 旧地址的失败计数对新地址没有意义。
                                lanBase = refreshed.base
                                fresh.replaceEntries(CrewRoute.entries(refreshed, proxyPort))
                                lanReport = judgeLan(fresh)
                            }
                        }
                        var failures = 0
                        while (isActive) {
                            val probed = withContext(Dispatchers.IO) {
                                TailcatP2p.probe(port, current.token, current.deviceId)
                            }
                            if (probed.ok) {
                                proxyPort = port
                                fresh.promote(CrewRoute.proxyBase(port))
                                way = CrewRoute.Way.P2P
                                tunnelMillis = probed.millis
                                p2pNote = ""
                                failures = 0
                                // 隧道通了，局域网那条失效在界面上不再是问题 —— 但仍要重判一次：
                                // 快照里留着的是事实，界面上要不要说由 routeLine 决定。
                                lanReport = judgeLan(fresh)
                                delay(P2P_CHECK_INTERVAL_MS)
                            } else {
                                p2pNote = P2P_DOWN
                                tunnelMillis = null
                                // 隧道没通，局域网那条就是唯一能省下公网往返的路。
                                // 主动敲一次：`read()` 一旦落到公网就不会再试这条死地址，
                                // 光靠它数不出失败，也就永远说不出「地址已失效」。
                                withContext(Dispatchers.IO) { fresh.probeEntry(lanBase) }
                                lanReport = judgeLan(fresh)
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

            // 调试口的外壳那一半：配对、走哪条路、隧道往返。
            // 用 SideEffect 而不是在组合体里直接写：组合可能被丢弃重来，
            // 副作用只在这一次组合真的生效之后才落地。
            if (bridge != null) {
                SideEffect {
                    bridge.shell = DebugShell(
                        paired = paired != null,
                        crew = paired?.crew.orEmpty(),
                        device = paired?.deviceId.orEmpty(),
                        way = way?.name?.lowercase().orEmpty(),
                        tunnelMillis = tunnelMillis,
                        p2pNote = p2pNote,
                        route = CrewRoute.label(way, tunnelMillis, p2pNote),
                        // 局域网那条的状态也摊在这里：判据是「连续连不上 + 跨网段」，
                        // 只读它的结论与那两个地址，脚本能直接断言，不必反推。
                        lanVerdict = lanReport.verdict.name.lowercase(),
                        lanHost = lanReport.host,
                        lanSubnet = lanReport.subnet,
                        lanFailures = lanReport.failures,
                        session = pairing.session(),
                    )
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
                            // 走公网且局域网那条已判定失效时，这一行改成整句说明「为什么没走直连」——
                            // 只写「公网中转」会让人以为本来就该这样。
                            route = CrewLanHealth.routeLine(
                                CrewRoute.label(way, tunnelMillis, p2pNote),
                                lanReport,
                                way,
                            ),
                            onForget = {
                                pairing.clear()
                                paired = null
                            },
                            // 上次停在哪个会话从配对记录恢复；切会话只写这一格，不动 paired，
                            // 免得重启 LaunchedEffect 把正在跑的 P2P 隧道打断。
                            initialSession = pairing.session(),
                            onSessionChange = { session -> pairing.saveSession(session) },
                            // 调试口：只在开关开启时挂上去（null 时 CrewRoot 连一个对象都不建）。
                            debug = bridge,
                        )
                    }
                }
            }
        }
    }

    /**
     * 关掉调试口。与桌面端 ctx.Done() 那一路对应：listener 一关，accept 就退出，
     * abstract socket 随进程一起消失，不留死文件。
     */
    override fun onDestroy() {
        debugServer?.stop()
        debugServer = null
        debugBridge?.screen = null
        debugBridge = null
        super.onDestroy()
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
