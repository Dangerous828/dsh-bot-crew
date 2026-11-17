package com.dsh.botcrew

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * 诊断子系统的 Android 装配层：把纯逻辑（[ClientDiag]/[DiagAck]/[DiagRingStore]/[DiagUploader]）
 * 接到真实进程上——记录点、未捕获崩溃、前后台、网络变化、以及上报循环。
 *
 * ## 只有这一层碰 Android
 *
 * 纯逻辑层（ClientDiag/DiagAck/RoutePolicy/DiagUploader 编排）都能在 JVM 单测里跑。
 * 这里只做「把事件发生的那一刻变成一次 [record]」，不写判断逻辑。
 *
 * ## 记什么（白名单，严格）
 *
 * App 自身：请求方法/去 query 路径/耗时/响应状态/route 切换/前后台/DNS-TLS-网络异常/未捕获崩溃/
 * 版本型号/连接种类。**不记**：聊天正文、审批内容、Authorization/cookie/token 原值、配对码、
 * 其它 App、任意 exception.message（[ClientDiag.errOf] 只取类名）。
 *
 * ## 不上报自己
 *
 * 上传用[RéalTransport]直接发，**不**经过 [record] 的记录点，所以上传请求不会被环形再记一遍、
 * 也不会自我循环上报。
 *
 * ## 开关
 *
 * [enabled] 为 false 时 [record] 为空操作、不写盘、不上报。诊断页可切。
 */
class DiagRuntime private constructor(private val app: Context) {

    private val store = DiagRingStore(app)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** 记录诊断信息的总开关（默认开=基础诊断可持续）。关掉不写盘、不上报。 */
    @Volatile var enabled: Boolean = true

    /** 当前网络是否可用（链接有 TRANSPORT 且 validated/或至少 INTERNET）。 */
    @Volatile private var online: Boolean = true

    /** 当前连接种类：wifi/cellular/other/none。 */
    @Volatile var networkKind: String = "none"
        private set

    /** 当前会话 id（给事件带 session 短词）。由 CrewRoot 更新。 */
    @Volatile var currentSession: String = SessionRoute.MAIN

    /** 当前 route 种类（lan/p2p/tunnel/public），由 CrewClient 换路回调更新，喂 extra.routeKind。 */
    @Volatile var routeKind: String = ""

    private val uploaderLock = Any()
    @Volatile private var uploader: DiagUploader? = null
    private var prevHandler: Thread.UncaughtExceptionHandler? = null
    /** 单飞：所有触发 uploadOnce 的入口（周期/网络恢复/手动/配好补传）都经这把锁，避免并发重复发。 */
    private val uploadMutex = Mutex()
    /** 进程唯一的上报循环 Job。重复 start 只换引用不叠循环。 */
    @Volatile private var loopJob: kotlinx.coroutines.Job? = null
    /** 前台标志：循环只在前台周期执行；后台不做常驻轮询（只保留网络恢复/手动的一次性补传）。 */
    @Volatile private var foreground: Boolean = true

    /**
     * 绑定/替换上报器：配好（或换绑）后调用。**baseUrl 必须是已校验的合法 HTTPS 上传入口**；
     * 空串表示没有可信入口（不建 uploader、不上报、不发 token）。不硬编码任何 crew 域名。
     */
    fun bindUploader(deviceId: String?, credential: String?, baseUrl: String) {
        if (deviceId.isNullOrBlank() || credential.isNullOrBlank() || !DiagUploader.validEndpoint(baseUrl)) {
            // 无有效凭据或无可信入口：不上报。保留本地环形，等有可信入口再绑。
            synchronized(uploaderLock) { uploader = null }
            return
        }
        synchronized(uploaderLock) {
            uploader = DiagUploader(
                store = store,
                transport = RealTransport(),
                baseUrl = baseUrl,
                deviceId = deviceId,
                credential = credential,
                online = { online },
                clock = { System.currentTimeMillis() },
            )
        }
        // 配好/换绑后**立即**催一轮（经单飞），把这之前攒的本地队列补传掉，不必等周期、不必重启。
        flushSoon()
    }

    /** 解绑（退出配对等）：不建 uploader、不上报。 */
    fun unbindUploader() { synchronized(uploaderLock) { uploader = null } }

    /**
     * 单飞跑一轮上报。**所有入口**（周期循环 / 网络恢复 / 手动 / 配好补传）都只调它——
     * 手动不再自己复制一份 mutex/uploadOnce，避免漏 IO 上下文或重复并发。
     *
     * 关键：整个上传（含 [DiagUploader.uploadOnce] 里 blocking 的 HttpURLConnection）都在
     * `Dispatchers.IO` 上跑。上传是网络 IO，绝不能在 UI 主线程执行（否则 NetworkOnMainThreadException
     * 被 catch 伪装成 post_failed —— 正是真机手动补传永远失败的根因）。这里统一兜住，不要求每个 caller 记住。
     */
    private suspend fun uploadSingleFlight(): DiagUploader.Outcome? = withContext(Dispatchers.IO) {
        if (!enabled) return@withContext null
        val u = synchronized(uploaderLock) { uploader } ?: return@withContext null
        uploadMutex.withLock { u.uploadOnce() }
    }

    /**
     * 记一条上传失败日志：**只记异常类名**（不记 message/headers/token/URL），
     * 便于日后区分「App 线程错（NetworkOnMainThreadException）」和真的 DNS/TLS/连接失败，且绝不把凭据落日志。
     */
    private fun logUploadFailure(where: String, t: Throwable) {
        Log.w(TAG, "诊断补传失败[$where] 类=${ClientDiag.errOf(t)}")
    }

    /** 催一轮上报（异步、失败忽略）。配好/网络恢复/换绑后调。 */
    fun flushSoon() {        scope.launch {
            try { uploadSingleFlight() } catch (t: Throwable) { logUploadFailure("flushSoon", t) }
        }
    }

    /**
     * 起**进程唯一**的上报循环。重复调用只保证一个 Job（旧 Job 取消后再起，绝不叠加）。
     * 循环只在前台周期跑；后台不轮询（避免无限后台常驻、耗电/耗流量）。网络恢复/手动走 flushSoon 的一次性补传。
     */
    fun startUploadLoop() {
        loopJob?.cancel()
        loopJob = scope.launch {
            while (true) {
                try { if (foreground) uploadSingleFlight() } catch (t: Throwable) { logUploadFailure("loop", t) }
                kotlinx.coroutines.delay(UPLOAD_INTERVAL_MS)
            }
        }
    }

    /**
     * 前台/后台切换。进前台：立即补传一轮 + 恢复周期（前台每 [UPLOAD_INTERVAL_MS] 一次小批合并）。
     * 进后台：**不强停已在途的单次补传**，只停周期轮询；并做**一次**「已有生命周期最后一批」补传（不造保活 service）。
     */
    fun setForeground(value: Boolean) {
        foreground = value
        if (value) {
            flushSoon()
        } else {
            // 退后台前把当前队列尽量送一批（best-effort，一次），之后不再周期轮询；下次启动/回前台再补。
            flushSoon()
        }
    }

    /** 手动补传（诊断页按钮）。走**同一个** [uploadSingleFlight] 中央入口（已 withContext(IO)+Mutex 单飞），
     *  不在 UI 主线程直接调 uploadOnce。文案由纯函数 [DiagUploader.describe] 给（可单测）。 */
    suspend fun uploadNow(): String {
        if (!enabled) return "诊断记录已关闭，不上报"
        if (synchronized(uploaderLock) { uploader } == null) return "还没配对或无可信上传入口，暂不能上报"
        val o = uploadSingleFlight() ?: return "还没配对或无可信上传入口，暂不能上报"
        return DiagUploader.describe(o)
    }

    /**
     * 记一条事件。这是**唯一写入点**。开关关了直接返回；事件序列化不过白名单的（route 不合规等）也不写。
     *
     * @param type [ClientDiag.EventType]
     * @param route 可含 query 的原始路径——这里用 [ClientDiag.routeOf] 切干净，无法切干净就不记。
     */
    fun record(type: ClientDiag.EventType, route: String, method: String? = null, status: Int? = null,
               ms: Long? = null, err: String? = null, extra: Map<String, String> = emptyMap()) {
        if (!enabled) return
        try {
            val ev = ClientDiag.Event(
                id = ClientDiag.newId(),
                at = ClientDiag.nowIso(),
                event = type.wire,
                route = route,
                method = method,
                status = status,
                ms = ms,
                err = err,
                session = currentSession.takeIf { ClientDiag.isShortWord(it) },
                extra = mergeBaseExtra(extra),
            )
            val row = ClientDiag.toWire(ev) ?: return
            store.append(row)
        } catch (t: Throwable) {
            // 记录本身绝不抛给调用方：诊断是外挂，不该把业务拖下水。
            Log.w(TAG, "记录诊断事件失败（忽略）", t)
        }
    }

    /** 记一次未捕获崩溃：只留结构帧 + 最近 breadcrumbs。 */
    fun recordCrash(errorClassRaw: String, stackRaw: String?, breadcrumbs: List<JSONObject>) {
        if (!enabled) return
        try {
            // breadcrumbs 直接取环形里已白名单序列化过的行；toWire(Crash) 里再兜一次 route/敏感。
            val crash = ClientDiag.Crash(
                id = ClientDiag.newId(),
                at = ClientDiag.nowIso(),
                errorClass = if (ClientDiag.isShortWord(errorClassRaw)) errorClassRaw else "Error",
                stack = ClientDiag.sanitizeStack(stackRaw),
                breadcrumbs = breadcrumbs.take(ClientDiag.MAX_CRUMBS),
                extra = mergeBaseExtra(emptyMap()),
            )
            ClientDiag.toWire(crash)?.let { store.append(it) }
        } catch (t: Throwable) {
            Log.w(TAG, "记录崩溃事件失败（忽略）", t)
        }
    }

    /** 记录前后台切换，并驱动上传循环的前台/后台策略（前台周期+立即补传；后台不轮询）。 */
    fun recordLifecycle(foreground: Boolean) {
        setForeground(foreground)
        record(ClientDiag.EventType.LIFECYCLE, "/app/lifecycle", extra = mapOf("phase" to if (foreground) "foreground" else "background"))
    }

    /** 由 CrewClient 换路回调更新 routeKind（不进环形，只是给后续事件带 extra）。 */
    fun noteRouteKind(kind: String) { routeKind = kind }

    /** 记录一次 route 切换事件。 */
    fun recordRouteSwitch(kind: String) {
        routeKind = kind
        record(ClientDiag.EventType.ROUTE_SWITCH, "/app/route", extra = mapOf("routeKind" to kind))
    }

    /** 最近 ring 记录（诊断页列表用）。 */
    fun recent(limit: Int = 200): List<JSONObject> = store.readAll().takeLast(limit)

    /** 导出：把环形内容拼成可分享的 JSONL 文本。**导出前脱敏断言**：任一命中敏感就拒绝。 */
    fun exportText(): String {
        val rows = store.readAll()
        // 断言：任何一条的文本命中敏感形态，整份拒绝导出（宁可空，不泄明文）。
        for (row in rows) {
            if (ClientDiag.looksSensitive(row.toString())) {
                return "检测到可能的敏感内容（token/凭据形态），已拒绝导出。请先清理后再试。"
            }
        }
        return rows.joinToString("\n") { it.toString() }
    }

    /** 清理本地。 */
    fun clear() = store.clear()

    fun stats(): DiagRingStore.Stats = store.stats()

    /** 当前持久隔离集条数（诊断页显示「隔离 N 条」，不再只保内存状态）。 */
    fun quarantinedCount(): Int = store.quarantinedIds().size

    private fun mergeBaseExtra(extra: Map<String, String>): Map<String, String> {
        val base = HashMap<String, String>()
        base["networkKind"] = networkKind
        if (routeKind.isNotEmpty()) base["routeKind"] = routeKind
        base["version"] = BuildInfo.VERSION_NAME
        base.putAll(extra)
        return base
    }

    // ---- 网络回调 ----
    fun updateNetwork(active: Network?) {
        val cm = app.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        val caps = active?.let { cm.getNetworkCapabilities(it) }
        val wasKind = networkKind
        val wasOnline = online
        when {
            caps == null -> { online = false; networkKind = "none" }
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> { online = true; networkKind = "wifi" }
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> { online = true; networkKind = "cellular" }
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> { online = true; networkKind = "ethernet" }
            else -> { online = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET); networkKind = "other" }
        }
        // 网络种类变化记一条（网络切换响应的事实依据）。
        if (wasKind != networkKind) {
            record(ClientDiag.EventType.OTHER, "/app/network",
                extra = mapOf("phase" to "network", "networkKind" to networkKind))
        }
        if (!wasOnline && online) {
            // 恢复联网：立刻经单飞催一轮上报（非新起常驻循环）。
            flushSoon()
        }
        onNetworkChanged?.invoke()
    }

    /** 网络变化回调（给路由层清冷却/重判）。 */
    @Volatile var onNetworkChanged: (() -> Unit)? = null

    fun currentNetworkOnline(): Boolean = online

    // ---- 未捕获异常 ----

    /** 装全局未捕获异常处理器：记一条崩溃，再交给原处理器（不改变原有崩溃行为）。 */
    fun installCrashHandler() {
        if (prevHandler != null) return
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        prevHandler = prev
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            try {
                val bread = store.readAll().takeLast(ClientDiag.MAX_CRUMBS)
                recordCrash(ClientDiag.errOf(error), error.stackTraceToString(), bread)
            } catch (_: Throwable) {
                // 崩溃路径里绝不再抛。
            }
            (prev ?: Thread.getDefaultUncaughtExceptionHandler())?.uncaughtException(thread, error)
        }
    }

    /**
     * 真实 HTTP 传输（HttpURLConnection）。凭据只放请求头，绝不进 URL/body。
     *
     * blocking HttpURLConnection 一律在 `Dispatchers.IO` 上跑（模块级兜底）：即使某个 caller 忘了切线程，
     * 也不会在主线程抛 NetworkOnMainThreadException 后被伪装成「网络异常」。
     */
    private class RealTransport : DiagUploader.Transport {
        override suspend fun post(url: String, deviceId: String?, credential: String?, body: String): DiagUploader.RawResponse =
            withContext(Dispatchers.IO) {
                val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = 8_000
                    readTimeout = 15_000
                    // 绝不让 30x 被跟随后把前端 200 当上传成功：关掉自动跟随，非 2xx 一律按失败处理。
                    instanceFollowRedirects = false
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                    deviceId?.let { setRequestProperty("x-crew-device", it) }
                    credential?.let { setRequestProperty("x-crew-credential", it) }
                }
                try {
                    conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                    val status = conn.responseCode
                    val ct = conn.contentType
                    val stream = if (status in 200..299) conn.inputStream else conn.errorStream
                    val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }
                    val retryAfter = conn.getHeaderField("Retry-After")?.trim()?.toIntOrNull()
                    DiagUploader.RawResponse(status, ct, text, retryAfter)
                } finally {
                    conn.disconnect()
                }
            }
    }

    companion object {
        private const val TAG = "CrewDiag"

        /**
         * 前台补传间隔：10 秒一轮小批合并（约 6 轮/分钟，低于后端每 device 30 批/分钟上限，且尊重 Retry-After）。
         * 后台不周期轮询（只在生命周期最后一批/回前台/下次启动补传），不造保活 service。
         */
        const val UPLOAD_INTERVAL_MS = 10_000L

        @Volatile private var instance: DiagRuntime? = null

        fun get(context: Context): DiagRuntime = instance ?: synchronized(this) {
            instance ?: DiagRuntime(context.applicationContext).also { instance = it }
        }
    }
}
