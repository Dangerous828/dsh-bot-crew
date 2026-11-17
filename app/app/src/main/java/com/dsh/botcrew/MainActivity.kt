package com.dsh.botcrew

import android.os.Bundle
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.core.view.WindowCompat
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.unit.dp
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

    /** 这一届 Activity 在调试口上的令牌。退场时只摘自己这一份，见 CrewDebugPorts。 */
    private val debugToken = Any()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        // 配好的电脑存在本机，重启后不用再念一次码。
        val pairing = PairingStore(this)
        val thisDevice = deviceId(this)

        // 诊断子系统：先拿实例、装崩溃处理器、开上报循环。release 也开（这是给用户看的 App 自身诊断），
        // 但只记白名单字段、可关可清。版本信息从 BuildConfig 灌进去（纯逻辑层不依赖 BuildConfig）。
        BuildInfo.VERSION_NAME = BuildConfig.VERSION_NAME
        BuildInfo.VERSION_CODE = BuildConfig.VERSION_CODE
        BuildInfo.BUILD_ID = BuildConfig.CREW_BUILD_ID
        val diag = DiagRuntime.get(this)
        diag.installCrashHandler()
        diag.startUploadLoop()
        // 启动先记一条配置快照（不 dump 凭据）：prefs 是否读到配对、host/routeKind、pairing 解析是否异常。
        recordStartupSnapshot(pairing, diag)
        // 网络回调：更新连接种类、断网/恢复、网络切换时清路由冷却。
        val cm = getSystemService(ConnectivityManager::class.java)
        cm?.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: android.net.Network) { diag.updateNetwork(network) }
            override fun onLost(network: android.net.Network) { diag.updateNetwork(null) }
            override fun onCapabilitiesChanged(network: android.net.Network, caps: NetworkCapabilities) { diag.updateNetwork(network) }
        })
        // 前后台事件。
        diag.recordLifecycle(true)

        // 调试口：debug 构建默认开，release 永远不开（见 CrewDebug 的注释）。
        // 起不来只记一行日志，界面照常 —— 调试口是外挂，不是界面的一部分。
        //
        // 归属按进程算，不按 Activity 算：转屏会重建 Activity，而新的 onCreate 早于旧的 onDestroy，
        // 「每届各 bind 一次」必然 Address already in use（真机复现三次）。这里只在进程第一次
        // 进场时开 socket，之后每届只换挂载点。
        val debugOn = CrewDebug.enabled(BuildConfig.DEBUG, CrewDebug.systemProperty(CrewDebug.PROP))
        val bridge = if (debugOn) DebugBridge() else null
        debugBridge = bridge
        if (bridge != null) CrewDebugPorts.process.attach(debugToken, bridge)

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

                // 诊断：给 client 挂配对快照（选路种类要用）、请求埋点、绑定上报器。
                fresh.attachPairing(current, proxyPort)
                fresh.networkKindProvider = diag.networkKind
                // 上传入口只从可信来源取（serverPublicBase / HTTPS fallback / 注入且 crew 精确匹配的 DIAG_BASE）；
                // 无有效凭据或无可信 HTTPS 入口 → 不 bind、不上报、不发 token。绝不硬编码 crew 域名。
                fun rebindUploader(p: PairedCrew) {
                    val savedCrew = p.serverCrew.ifBlank { p.crew }
                    val chosen = UploadEndpoint.decide(
                        serverPublicBase = p.serverPublicBase,
                        fallbackBase = p.fallbackBase,
                        savedCrew = savedCrew,
                        diagBase = BuildConfig.CREW_DIAG_BASE,
                        expectedCrew = BuildConfig.CREW_EXPECTED_CREW,
                    )
                    if (chosen.url.isNotBlank()) {
                        diag.bindUploader(p.deviceId, p.token, chosen.url)
                    } else {
                        diag.unbindUploader()
                    }
                }
                rebindUploader(current)
                fresh.diagSink = { path, method, status, ms, err, routeKind ->
                    diag.noteRouteKind(routeKind)
                    diag.record(
                        type = when {
                            routeKind.isNotEmpty() && err == null && (status ?: 0) in 200..299 -> ClientDiag.EventType.OTHER
                            err != null -> ClientDiag.EventType.NET_FAIL
                            else -> ClientDiag.EventType.HTTP_ERROR
                        },
                        route = path, method = method, status = status, ms = ms, err = err,
                        extra = mapOf("phase" to "receive", "routeKind" to routeKind),
                    )
                }
                // 网络变化：清路由冷却、按新网络重判、更新连接的 networkKind（蜂窝优先公网）。
                diag.onNetworkChanged = {
                    fresh.onNetworkChanged()
                    fresh.networkKindProvider = diag.networkKind
                }

                // 可信公网入口自愈（不动 token/deviceId/crew 身份，不重配对）：
                // ① 非空旧域名也由同 crew 可信元数据更新；② 空 fallback 才 bootstrap，
                //    且准入由纯函数 BootstrapGate 判定（空 savedCrew / 预期不符 / 配置空 → 0 请求），
                //    bootstrap 内部再对 server.crew 做精确比对。绝不用 build 预期值伪装成已登记身份。
                val savedCrew = current.serverCrew.ifBlank { current.crew }
                kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.IO).launch {
                    try {
                        // ① 从已知可信当前入口读 server 元数据，crew 相同时更新（含非空旧 fallback）。
                        if (current.fallbackBase.isNotBlank() || current.base.isNotBlank()) {
                            val trusted = fresh.trustedPublicBase(
                                current.fallbackBase.ifBlank { current.base },
                                savedCrew,
                            )
                            if (!trusted.isNullOrBlank() && trusted != current.fallbackBase) {
                                val updated = current.copy(fallbackBase = trusted)
                                pairing.save(updated)
                                fresh.replaceEntries(CrewRoute.entries(updated, proxyPort))
                                rebindUploader(updated)
                            }
                        }
                        // ② 空 fallback 的 bootstrap：准入纯函数判定，全绿才请求。
                        val decision = BootstrapGate.decide(
                            savedCrew = savedCrew,
                            injectedBase = BuildConfig.CREW_PUBLIC_BASE,
                            expectedCrew = BuildConfig.CREW_EXPECTED_CREW,
                            savedFallback = current.fallbackBase,
                        )
                        if (decision.allowed) {
                            val got = fresh.bootstrapPublic(decision.base, decision.expectCrew)
                            if (!got.isNullOrBlank()) {
                                val updated = current.copy(fallbackBase = got)
                                pairing.save(updated)
                                fresh.replaceEntries(CrewRoute.entries(updated, proxyPort))
                                rebindUploader(updated)
                            }
                        }
                    } catch (t: Throwable) {
                        android.util.Log.w("CrewDiag", "公网入口自愈失败（忽略，不影响连接）", t)
                    }
                }

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
                                // 局域网那条若已经恢复，就把当前入口切回去（#12 第 2 项）。
                                // 光靠请求本身回不去：公网一直通，请求从它开始、成功即返回，
                                // 永远轮不到试局域网。这里主动探一次更优的那条。
                                val better = withContext(Dispatchers.IO) { fresh.preferBetterEntry() }
                                if (better != null) {
                                    way = CrewRoute.kindOf(better, current, proxyPort)
                                    failures = 0
                                    lanReport = judgeLan(fresh)
                                }
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
            //
            // **必须在组合阶段把这些状态读出来**，不能直接在 SideEffect 的 lambda 里读：
            // 快照读取只在组合期间才登记成依赖，SideEffect 是组合之后才跑的副作用 ——
            // 在它里面读 `way` 不会让这个组件在 `way` 变化时重组，于是 shell 会永远停在
            // 首帧的值（实测：日志里 promoted way=P2P，而 state.dump 里 way 一直是空串）。
            // 在这里读进局部变量，变化才会触发重组，SideEffect 才会带着新值重跑。
            if (bridge != null) {
                val shellWay = way
                val shellTunnel = tunnelMillis
                val shellNote = p2pNote
                val shellReport = lanReport
                val shellPaired = paired
                SideEffect {
                    bridge.shell = DebugShell(
                        paired = shellPaired != null,
                        crew = shellPaired?.crew.orEmpty(),
                        device = shellPaired?.deviceId.orEmpty(),
                        way = shellWay?.name?.lowercase().orEmpty(),
                        tunnelMillis = shellTunnel,
                        p2pNote = shellNote,
                        route = CrewRoute.label(shellWay, shellTunnel, shellNote),
                        // 局域网那条的状态也摊在这里：判据是「连续连不上 + 跨网段」，
                        // 只读它的结论与那两个地址，脚本能直接断言，不必反推。
                        lanVerdict = shellReport.verdict.name.lowercase(),
                        lanHost = shellReport.host,
                        lanSubnet = shellReport.subnet,
                        lanFailures = shellReport.failures,
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
                            // 本地存储的命名空间（草稿 / 未确认发送）按这台已配对的 crew 分隔。
                            // 只用于算 namespace，不参与请求。
                            paired = current,
                        )
                    }
                }
            }
        }
    }

    /**
     * 退场：只摘自己这一届的挂载点，**不关 socket**。
     *
     * 转屏时新的 onCreate 已经先跑完了，这里关掉就等于把新实例刚接上的口摘掉 ——
     * 那正是真机上「转屏后空响应到杀进程」的成因。socket 随进程一起消失，不需要谁去 close。
     */
    override fun onDestroy() {
        DiagRuntime.get(this).recordLifecycle(false)
        if (debugBridge != null) CrewDebugPorts.process.detach(debugToken)
        debugBridge?.screen = null
        debugBridge = null
        super.onDestroy()
    }

    /**
     * 启动配置快照：让验证员能**真实看到**旧 prefs 的状态，而不是被「读到 null 就当没配对」掩盖。
     *
     * 只把服务端白名单字段写进事件（phase/routeKind/version/networkKind）；**不**把 host 或 paired 布尔
     * 塞进 extra（服务端会丢未知键，塞了反而给人「已上报」的假象）。prefs 三态用 phase 表示：
     * `prefs_missing` / `prefs_loaded` / `prefs_parse_error`；parse_error 的 detail（键名层面）与提取出的
     * hostname（不含 userinfo/query）只写本地 logcat + 诊断页，不进上报。
     *
     * parse_error 时**保留**原始损坏 prefs、不自动配对覆盖，留待人工修。
     */
    private fun recordStartupSnapshot(pairing: PairingStore, diag: DiagRuntime) {
        val readState = try {
            pairing.probeReadState()
        } catch (t: Throwable) {
            // 读 prefs 本身抛（极端）：如实记一条 parse_error，别伪装成 missing。
            PairingRecord.ReadState(PairingRecord.ReadState.PARSE_ERROR, ClientDiag.errOf(t))
        }
        val phase = when (readState.state) {
            PairingRecord.ReadState.MISSING -> "prefs_missing"
            PairingRecord.ReadState.LOADED -> "prefs_loaded"
            else -> "prefs_parse_error"
        }
        // 提取 hostname 仅用于本地可观测（不含 userinfo/query），绝不进上报 extra。
        val storedHost = try {
            pairing.stored()?.base?.let { hostnameOf(it) }.orEmpty()
        } catch (_: Throwable) {
            ""
        }
        android.util.Log.i("CrewDiag", "startup prefs=${readState.state} detail=${readState.detail} host=$storedHost")
        // 上报：只用白名单字段。version/networkKind 由 diag 自动带；这里补 phase。
        diag.record(
            type = ClientDiag.EventType.OTHER,
            route = "/app/startup",
            extra = mapOf("phase" to phase, "version" to BuildConfig.VERSION_NAME),
        )
        if (readState.state == PairingRecord.ReadState.PARSE_ERROR) {
            // 再补一条独立的 parse_error 事件（err 只放短词 errorClass 语义，不塞 message）。
            diag.record(
                type = ClientDiag.EventType.OTHER,
                route = "/app/startup",
                err = "PrefsParseError",
                extra = mapOf("phase" to "prefs_parse_error"),
            )
        }
    }

    /** 从地址里提取纯 hostname（不含 scheme/userinfo/query/port）。取不到返回空串。 */
    private fun hostnameOf(url: String): String = try {
        val u = java.net.URI(url.trim())
        u.host?.substringBefore(':').orEmpty()
    } catch (_: Throwable) {
        ""
    }

    private companion object {
        /** 界面上那句话。它是说明，不是错误码：真正的原因看 logcat 的 CrewP2p/CrewTailcat。 */
        const val P2P_DOWN = "P2P 没通"

        const val P2P_CHECK_INTERVAL_MS = 30_000L
    }
}

/**
 * 建连接那一瞬间看到的一句话。它不是错误提示，所以不用告警色。
 *
 * 只在这一句下面挂一个可点的「连接/使用说明」小字：点开的是同一个
 * [CrewConnectionStatus] 详情 Dialog（日常开机联网不睡眠、无需桌面 App、
 * 仅服务停止时才跑 start 命令）。**不动这里的连接初始化**：仍然是在连上队伍的过程中，
 * 所以 loading=true —— 详情里不会说「已连接」。
 */
@Composable
private fun WaitingLine(palette: CrewPalette) {
    var helpOpen by remember { mutableStateOf(false) }
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text("正在连上队伍…", fontSize = 13.sp, color = palette.muted)
            Spacer(Modifier.height(6.dp))
            Text(
                "使用说明",
                fontSize = 12.sp,
                color = palette.accent,
                // 可点区 >=48dp：虽是「小字」，触控命中高度仍按统一规格来，不留例外。
                modifier = Modifier
                    .heightIn(min = 48.dp)
                    .clickable { helpOpen = true }
                    .padding(horizontal = 12.dp, vertical = 12.dp),
            )
        }
        if (helpOpen) {
            // 复用连接组件的详情 Dialog（折叠成 0 高度、只借它的详情内容）：
            // 不重做一套说明，文案/命令只有一处真理源。
            CrewConnectionStatus(
                route = "",
                loading = true,
                problem = null,
                palette = palette,
                onRefresh = {},
                startExpanded = true,
                onExpandedConsumed = { helpOpen = false },
            )
        }
    }
}
