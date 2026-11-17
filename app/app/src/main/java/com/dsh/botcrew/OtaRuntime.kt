package com.dsh.botcrew

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import androidx.core.content.FileProvider
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import java.io.File
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * OTA 的 Android 装配层：检查 → 下载（可续传）→ 校验 → 交系统安装器。
 *
 * ## 为什么不用 DownloadManager
 *
 * 它把文件放 external files（多一层路径语义）、进度靠查 cursor、取消靠 remove(id)、且无法拒绝跨 origin
 * 重定向。这里只需要「同 origin 的 HTTPS 文件流 + Range 续传 + 进度 + 一键取消」，两段代码就够，
 * 且字节落点和校验读的是同一个文件，[Ota.recover] 能纯靠磁盘长度恢复状态。不引新依赖。
 *
 * ## 不会变成「永久下载中」
 *
 * 状态**只**由三段本地事实推出来：磁盘残量（[Ota.recover]）、当前进程里活着且属于 [generation] 的任务、
 * 以及一次成功的 manifest 检查结果。进页面 / 重建 Activity / 权限往返都重新走 [restore]；
 * 取消与失败显式落 Available/Failed 并保留 .part 供续传。
 *
 * ## 取消必须是「真的断了」
 *
 * `Job.cancel()` 不会立刻打断阻塞的 socket read。所以 [cancel] 先让代际失效、再 cancel 协程、再
 * `disconnect()` 断连接；槽位由协程 finally 释放，**收尾之后**才允许重试。两个下载协程同时写 .part、
 * 或旧协程晚到的进度/失败覆盖新状态，都由代际挡掉。
 *
 * ## 不碰配对、不静默安装
 *
 * 更新请求不带 [CrewClient] 的任何 token/凭据。校验通过后只把内容 URI 交给系统安装器，确认框由系统弹；
 * 未授权时只报一句「需要允许」并跳系统设置页。
 */
class OtaRuntime private constructor(private val app: Context) {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val prefs = app.getSharedPreferences("ota", Context.MODE_PRIVATE)
    private val gate = Any()

    /** 当前这一代下载任务的代际：每次 start/cancel 自增，旧协程的回调据此丢弃。 */
    @Volatile private var generation = 0L
    /** 正在跑的那次下载（协程 + 连接）。同一时刻最多一个。 */
    @Volatile private var download: Download? = null
    @Volatile private var _state: Ota.State = Ota.State()
    /** 在跑的检查请求。restore()（进页面/回前台）不能把「正在检查」覆盖成磁盘旧态。 */
    @Volatile private var checkJob: Job? = null
    /** 取消后用户马上又点了「继续下载」：等收尾完自动补跑一次，不吞掉这次点按。 */
    @Volatile private var retryPending = false
    /** 页面注册的唯一观察者：页面重建后重新挂上就不会漏掉正在跑的下载进度。 */
    @Volatile private var observer: ((Ota.State) -> Unit)? = null

    /** 状态只有一个写入口：改值就通知观察者（主线程）。晚到的旧回调由代际挡在写之前。 */
    private var state: Ota.State
        get() = _state
        set(value) {
            _state = value
            observer?.let { sink -> deliver { sink(value) } }
        }

    /**
     * 一次下载。槽位在协程的 finally 里才清空 —— 于是「取消」之后到真的收尾（关掉写盘句柄）之间，
     * [download] 仍然占着，重试会被挡回；这正是「串行收尾后才允许 retry」，且不必阻塞 UI 线程等待。
     */
    private class Download(val gen: Long) {
        @Volatile var job: Job? = null
        @Volatile var conn: HttpURLConnection? = null
        /** 协程已彻底结束（含「还没开始就被取消」）：写盘句柄已关，槽位可让给下一次。 */
        @Volatile var finished: Boolean = false
    }

    private val main = Handler(Looper.getMainLooper())
    private val dir: File get() = File(app.filesDir, "ota").apply { mkdirs() }
    private val part: File get() = File(dir, "update.apk.part")
    private val ready: File get() = File(dir, "update.apk")
    private val endpoint: Ota.Endpoint? get() = Ota.endpoint(BuildConfig.OTA_MANIFEST_URL)

    fun current(): Ota.State = state

    /** 挂/摘页面观察者（传 null 摘掉）。回调在主线程。 */
    fun observe(listener: ((Ota.State) -> Unit)?) { observer = listener }

    /** 当前已装版本：读 PackageManager，不读 BuildConfig（诊断包/隔离包以真实安装为准）。 */
    fun installedVersionCode(): Long = try {
        info(0).let { if (Build.VERSION.SDK_INT >= 28) it.longVersionCode else @Suppress("DEPRECATION") it.versionCode.toLong() }
    } catch (_: Exception) {
        0L
    }

    fun installedVersionName(): String = try { info(0).versionName.orEmpty() } catch (_: Exception) { "" }

    /** 有下载在跑，或刚取消还没收尾完（这两种都不允许再起一个下载）。 */
    fun isBusy(): Boolean = download?.let { !it.finished } == true

    /**
     * 对齐一次：装完新版本（已装版本 ≥ 记录版本）→ 清残留；否则按磁盘残量恢复。
     * 进页面、Activity 重建、从系统设置返回都调它，所以「下载中」不会凭空停在界面上。
     */
    fun restore() {
        // 下载或检查正在进行：以在途任务为准，不拿磁盘旧态去覆盖它（否则界面会闪回「可更新」）。
        if (isBusy() || checkJob?.isActive == true) return
        val manifest = storedManifest()
        if (manifest == null) { state = Ota.State(); return }
        if (installedVersionCode() >= manifest.versionCode) {
            // 已经装上（或装了更高版本）：记录、残包、校验标记一起清掉。
            clearFiles()
            state = Ota.State()
            return
        }
        state = stateFor(manifest)
    }

    /**
     * 这一版当前该显示什么。**按磁盘残量归类到这份 manifest 名下之前**先确认残包属于它：
     * 换了版本/换了 sha（同版本号重发）时旧 .part 必须丢掉，否则会被当新包的半截续传，
     * 最后虽被 hash 拦住，但白下一遍且恢复出的进度是假的。
     */
    private fun stateFor(manifest: Ota.Manifest, previous: Ota.Manifest? = storedManifest()): Ota.State {
        val code = previous?.versionCode ?: prefs.getLong(KEY_RECORDED_CODE, 0L)
        val size = previous?.size ?: prefs.getLong(KEY_RECORDED_SIZE, 0L)
        val sha = previous?.sha256 ?: prefs.getString(KEY_RECORDED_SHA, "").orEmpty()
        if (!Ota.residueBelongs(manifest, code, size, sha)) clearFiles(keepManifest = true)
        if (isVerified(manifest)) return Ota.State(Ota.Stage.Ready, manifest, manifest.size)
        // 长度已满但没有校验通过标记：可能是校验中途被杀、也可能是坏包。不冒充「可安装」。
        if (currentBytes() == manifest.size) clearFiles(keepManifest = true)
        return Ota.recover(manifest, manifest.versionCode, manifest.size, usableBytes())
    }

    /** 记录这一版：manifest 原文 + 校验通过标记清理都由 [stateFor] 的结果决定。 */
    private fun commitManifest(raw: String, manifest: Ota.Manifest) {
        prefs.edit()
            .putString(KEY_MANIFEST, raw)
            .putLong(KEY_RECORDED_CODE, manifest.versionCode)
            .putLong(KEY_RECORDED_SIZE, manifest.size)
            .putString(KEY_RECORDED_SHA, manifest.sha256)
            .putLong(KEY_CHECKED_AT, System.currentTimeMillis())
            .apply()
    }

    private fun currentBytes(): Long = when {
        ready.exists() -> ready.length()
        part.exists() -> part.length()
        else -> 0L
    }

    /**
     * 检查更新。force=false 时遵守前台冷却 [COOLDOWN_MS]。
     *
     * 404（未发布）/ 网络失败 / 契约不符都**不**落成永久错误：404 是「暂无更新」，
     * 其余是一句可重试的短说明。任何时候都不自动下载。
     */
    fun check(force: Boolean = false, onDone: (Ota.State) -> Unit = {}) {
        // 下载进行中不改代际：否则活着的下载会被判成「旧协程」而白跑一趟。
        if (isBusy()) { deliver { onDone(state) }; return }
        val ep = endpoint
        if (ep == null) {
            state = Ota.State(Ota.Stage.Failed, null, 0L, "更新地址无效")
            deliver { onDone(state) }; return
        }
        if (!force && System.currentTimeMillis() - prefs.getLong(KEY_CHECKED_AT, 0L) < COOLDOWN_MS) {
            restore(); deliver { onDone(state) }; return
        }
        // 检查本身也占一代：慢回的旧检查不能覆盖新的，也不能与下载抢写记录；
        // 这一代的结果（含 prefs）只在 post(gen) 内落，代际不符整份丢弃。
        val gen = ++generation
        state = Ota.State(Ota.Stage.Checking, state.manifest, state.downloaded)
        deliver { onDone(state) }
        checkJob = scope.launch {
            val result = try {
                fetchText(ep.manifestUrl)
            } catch (e: NotFound) {
                // 未发布：这不是错误，落回「暂无更新」，下拉/再点一次仍可重试。
                post(gen) { state = Ota.noUpdate() }
                post(gen) { deliver { onDone(state) } }
                return@launch
            } catch (e: Exception) {
                Log.w(TAG, "manifest fetch failed", e)
                post(gen) { state = Ota.State(Ota.Stage.Failed, null, 0L, "检查失败，稍后重试") }
                post(gen) { deliver { onDone(state) } }
                return@launch
            }
            val manifest = Ota.parse(result, ep, app.packageName)
            if (manifest == null) {
                post(gen) { state = Ota.State(Ota.Stage.Failed, null, 0L, "更新信息不匹配") }
                post(gen) { deliver { onDone(state) } }
                return@launch
            }
            // 落的必须是「当前这一代」的结果：一次慢回的旧检查不能盖掉更新的 manifest、
            // 也不能把用户已经续到一半的记录改写掉。判定与落盘、状态更新一起在代际内做。
            post(gen) {
                val verdict = Ota.verdict(manifest, installedVersionCode(), Build.VERSION.SDK_INT)
                val next = when (verdict) {
                    Ota.Verdict.Newer -> {
                        val previous = storedManifest()
                        // 先按新 manifest 认领/丢弃残包，再记录：记录之后磁盘状态必须与它一致。
                        val derived = stateFor(manifest, previous)
                        commitManifest(result, manifest)
                        derived
                    }
                    Ota.Verdict.Incompatible -> {
                        // 不兼容就不留这一版的残包，免得住进「可继续」的假状态。
                        discardResidue()
                        Ota.State(Ota.Stage.Failed, manifest, 0L, "此版本不支持本机")
                    }
                    Ota.Verdict.Same, Ota.Verdict.Downgrade -> {
                        discardResidue()
                        Ota.noUpdate()
                    }
                }
                state = next
                deliver { onDone(next) }
            }
        }
    }

    /** 开始或继续下载；已落满直接进校验。同一时刻只有一个下载（[gate] + [generation]）。 */
    fun download(onProgress: (Ota.State) -> Unit = {}, onDone: (Ota.State) -> Unit = {}) {
        val manifest = state.manifest ?: return
        var notify: Ota.State? = null
        synchronized(gate) {
            val current = download
            if (current != null) {
                // 还在收尾（已取消但阻塞 read 未返回）：记下这次请求，收尾后自动补跑，
                // 既不同时写 .part，也不会让用户那一下白点。
                if (!current.finished) { retryPending = true; return }
                download = null
            }
            if (ready.exists() && ready.length() == manifest.size) {
                if (isVerified(manifest)) state = Ota.State(Ota.Stage.Ready, manifest, manifest.size)
                else scope.launch { verify(manifest, onDone) }
                return
            }
            val start = if (part.exists()) part.length().coerceAtMost(manifest.size) else 0L
            state = Ota.onProgress(manifest, start)
            notify = state
            val gen = ++generation
            val fresh = Download(gen)
            download = fresh
            fresh.job = scope.launch { runDownload(fresh, manifest, start, onProgress, onDone) }
            // 体没开始就被取消时 finally 不会跑；invokeOnCompletion 一定跑，槽位不会永远占着。
            fresh.job?.invokeOnCompletion {
                fresh.finished = true
                synchronized(gate) { if (download === fresh) download = null }
                if (retryPending) {
                    retryPending = false
                    deliver { download() }
                }
            }
        }
        notify?.let { s -> deliver { onProgress(s) } }
    }

    private suspend fun runDownload(
        held: Download,
        manifest: Ota.Manifest,
        start: Long,
        onProgress: (Ota.State) -> Unit,
        onDone: (Ota.State) -> Unit,
    ) {
        try {
            stream(held, manifest, start) { done ->
                if (held.gen == generation) {
                    state = Ota.onProgress(manifest, done)
                    deliver { onProgress(state) }
                }
            }
            if (held.gen != generation) return   // 被取消/被取代：不校验、不覆盖状态
            verify(manifest, onDone)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (held.gen == generation) {
                Log.w(TAG, "download failed", e)
                state = Ota.onFailure(manifest, usableBytes(), "下载中断，可继续")
                deliver { onDone(state) }
            }
        }
    }

    /**
     * 取消：先让代际失效（旧协程的回调全部作废）→ cancel 协程 → disconnect 断掉阻塞 read。
     * 槽位由 `invokeOnCompletion` 释放，所以界面立刻是「可继续」，而真正的重试要等收尾完；
     * 收尾前用户再点「继续下载」会被记住，收尾后自动补跑一次。
     */
    fun cancel() {
        val held = synchronized(gate) {
            generation++
            retryPending = false
            download.also { if (it != null && it.finished) download = null }
        }
        state = Ota.onCancel(state.manifest, usableBytes())
        held?.job?.cancel()
        runCatching { held?.conn?.disconnect() }
    }

    /** REQUEST_INSTALL_PACKAGES 的运行时开关（Android 8+ 按 App 授权）。 */
    fun canInstall(): Boolean = app.packageManager.canRequestPackageInstalls()

    /** 打开系统「安装未知应用」设置页；打不开返回 false，由 UI 说一句实话。 */
    fun openInstallSettings(): Boolean = try {
        app.startActivity(
            Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
                .setData(Uri.parse("package:${app.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        true
    } catch (_: Exception) {
        false
    }

    /**
     * 把已校验的 APK 交给系统安装器（系统确认页）。
     *
     * **不信缓存标记**：权限往返、去过系统设置、文件可能被别的进程改过，所以交给系统安装器之前
     * 当场重算长度/hash/包名/版本/签名（[Ota.checkInstall]）。重算在 IO 线程做（大文件 hash 不能卡 UI），
     * 结果回主线程。被改过的文件删掉并退回可下载态，绝不让它进系统安装器。
     */
    fun install(onDone: (Boolean) -> Unit = {}) {
        val manifest = state.manifest
        val apk = ready.takeIf { it.exists() }
        if (!canInstall() || manifest == null || apk == null) { deliver { onDone(false) }; return }
        scope.launch {
            val recheck = Ota.checkInstall(
                Ota.Candidate(
                    manifest = manifest,
                    fileBytes = apk.length(),
                    fileSha256 = sha256(apk),
                    archive = archiveFacts(apk),
                    installedPackage = app.packageName,
                    installedVersionCode = installedVersionCode(),
                    installedSignerSha256 = installedSigners(),
                ),
            )
            if (recheck !is Ota.Check.Ok) {
                runCatching { apk.delete() }
                prefs.edit().remove(KEY_VERIFIED).apply()
                state = Ota.onVerified(manifest, recheck)
                deliver { onDone(false) }
                return@launch
            }
            val ok = try {
                val uri = FileProvider.getUriForFile(app, "${app.packageName}.ota", apk)
                app.startActivity(
                    Intent(Intent.ACTION_VIEW)
                        .setDataAndType(uri, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
                )
                true
            } catch (e: Exception) {
                Log.w(TAG, "install intent failed", e)
                false
            }
            deliver { onDone(ok) }
        }
    }

    // ── 下载 ──────────────────────────────────────────────────────────────────

    /**
     * 从 [start] 续到 manifest.size。
     *
     * - 206：必须带 `Content-Range: bytes start-end/total`，起点 == start、total == manifest.size，
     *   否则视为服务端不一致，删残包、落失败（绝不把错位字节接到一起）。
     * - 200：忽略 Range → **丢弃残包**，从 0 重写，绝不追加。
     * - 重定向由 [open] 手动逐跳跟随，每一跳都必须与 manifest 同 origin。
     */
    private suspend fun stream(held: Download, manifest: Ota.Manifest, start: Long, onTick: (Long) -> Unit) {
        val origin = endpoint?.origin ?: ""
        val conn = open(manifest.apkUrl, start, origin) { c -> held.conn = c }
        try {
            val code = conn.responseCode
            val from = when (code) {
                206 -> {
                    if (!Ota.contentRangeOk(conn.getHeaderField("Content-Range"), start, manifest.size)) {
                        // 起点或总长对不上：删残包重来，绝不把错位字节接到一起。
                        part.delete()
                        throw IllegalStateException("bad content-range")
                    }
                    start
                }
                200 -> {
                    if (start > 0L) part.delete()  // 服务端忽略 Range：重置，不追加
                    0L
                }
                else -> throw IllegalStateException("http $code")
            }
            // 续传点必须真的是文件末尾：seek 超过 EOF 会写出零洞，那是最坏的一种「看着接上了」。
            if (from > 0L && part.length() != from) throw IllegalStateException("resume drift")
            RandomAccessFile(part, "rw").use { raf ->
                raf.seek(from)
                conn.inputStream.use { input ->
                    val buf = ByteArray(64 * 1024)
                    var total = from
                    var last = 0L
                    while (true) {
                        currentCoroutineContext().ensureActive()
                        val n = input.read(buf)
                        if (n < 0) break
                        raf.write(buf, 0, n)
                        total += n
                        val now = System.currentTimeMillis()
                        if (now - last >= TICK_MS) { last = now; onTick(total) }
                    }
                    raf.fd.sync()
                    onTick(total)
                }
            }
        } finally {
            held.conn = null
            runCatching { conn.disconnect() }
        }
        currentCoroutineContext().ensureActive()
        if (held.gen != generation) return
        if (part.length() != manifest.size) throw IllegalStateException("size ${part.length()}")
        if (!part.renameTo(ready)) throw IllegalStateException("rename")
    }

    /**
     * 打开连接并**手动**跟随重定向：每一跳都要与 manifest 同 origin，最多 [MAX_REDIRECTS] 跳。
     * HttpURLConnection 的自动跟随会跨站，更新通道不允许。
     */
    private fun open(
        url: String,
        start: Long,
        origin: String,
        onConn: (HttpURLConnection) -> Unit,
    ): HttpURLConnection {
        var target = url
        repeat(MAX_REDIRECTS + 1) { hop ->
            val conn = URL(target).openConnection() as HttpURLConnection
            conn.requestMethod = "GET"
            conn.connectTimeout = 15_000
            conn.readTimeout = 30_000
            conn.instanceFollowRedirects = false
            // 更新通道不带应用凭据：这条请求不是 CrewClient 的。
            conn.setRequestProperty("Accept", "application/octet-stream, application/json")
            if (start > 0L) conn.setRequestProperty("Range", "bytes=$start-")
            conn.connect()
            onConn(conn)
            val code = conn.responseCode
            if (code in 300..399) {
                val location = conn.getHeaderField("Location")
                conn.disconnect()
                if (location.isNullOrBlank()) throw IllegalStateException("redirect without location")
                target = URL(URL(target), location).toString()
                if (!Ota.sameOrigin(target, origin)) throw IllegalStateException("cross-origin redirect")
                if (hop >= MAX_REDIRECTS) throw IllegalStateException("too many redirects")
            } else {
                return conn
            }
        }
        throw IllegalStateException("redirect loop")
    }

    private fun fetchText(url: String): String {
        val origin = endpoint?.origin ?: ""
        val conn = open(url, 0L, origin) {}
        try {
            return when (val code = conn.responseCode) {
                404, 410 -> throw NotFound()
                in 200..299 -> conn.inputStream.bufferedReader().use { it.readText() }
                else -> throw IllegalStateException("http $code")
            }
        } finally {
            runCatching { conn.disconnect() }
        }
    }

    private class NotFound : Exception()

    // ── 校验 ──────────────────────────────────────────────────────────────────

    private fun verify(manifest: Ota.Manifest, onDone: (Ota.State) -> Unit) {
        state = Ota.State(Ota.Stage.Verifying, manifest, manifest.size)
        deliver { onDone(state) }
        if (!ready.exists()) {
            state = Ota.onFailure(manifest, 0L, "文件缺失，请重试")
            deliver { onDone(state) }; return
        }
        val candidate = Ota.Candidate(
            manifest = manifest,
            fileBytes = ready.length(),
            fileSha256 = sha256(ready),
            archive = archiveFacts(ready),
            installedPackage = app.packageName,
            installedVersionCode = installedVersionCode(),
            installedSignerSha256 = installedSigners(),
        )
        state = Ota.onVerified(manifest, Ota.checkInstall(candidate))
        when (state.stage) {
            // 记住「这一版这个 hash 校验过」，进程重建后仍能直接给「安装」而不是重下。
            Ota.Stage.Ready -> prefs.edit().putString(KEY_VERIFIED, verifiedKey(manifest)).apply()
            // 校验不过就删掉，别留一个「看着能装」的坏包；残包 .part 已不在，重试即重下。
            else -> { prefs.edit().remove(KEY_VERIFIED).apply(); runCatching { ready.delete() } }
        }
        deliver { onDone(state) }
    }

    /** 包名 / longVersionCode / 签名。读不出返回 null（等同拒绝装）。 */
    private fun archiveFacts(apk: File): Ota.ArchiveFacts? {
        val pm = app.packageManager
        val flags = signerFlag()
        val pi = if (Build.VERSION.SDK_INT >= 33) {
            pm.getPackageArchiveInfo(apk.absolutePath, PackageManager.PackageInfoFlags.of(flags.toLong()))
        } else {
            @Suppress("DEPRECATION") pm.getPackageArchiveInfo(apk.absolutePath, flags)
        } ?: return null
        val signers = signersOf(pi)
        if (signers.isEmpty()) return null
        return Ota.ArchiveFacts(
            packageName = pi.packageName,
            versionCode = if (Build.VERSION.SDK_INT >= 28) pi.longVersionCode else @Suppress("DEPRECATION") pi.versionCode.toLong(),
            signerSha256 = signers,
        )
    }

    /** 当前已装 App 的签名指纹（运行期读 PM，不硬编码证书摘要）。 */
    private fun installedSigners(): Set<String> = try {
        signersOf(info(signerFlag()))
    } catch (_: Exception) {
        emptySet()
    }

    private fun signerFlag(): Int =
        if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else @Suppress("DEPRECATION") PackageManager.GET_SIGNATURES

    private fun info(flags: Int): PackageInfo =
        if (Build.VERSION.SDK_INT >= 33) {
            app.packageManager.getPackageInfo(app.packageName, PackageManager.PackageInfoFlags.of(flags.toLong()))
        } else {
            @Suppress("DEPRECATION") app.packageManager.getPackageInfo(app.packageName, flags)
        }

    private fun signersOf(pi: PackageInfo): Set<String> {
        val sigs = if (Build.VERSION.SDK_INT >= 28) {
            pi.signingInfo?.apkContentsSigners
        } else {
            @Suppress("DEPRECATION") pi.signatures
        } ?: return emptySet()
        return sigs.mapNotNull { sha256(it.toByteArray()) }.filter { it.isNotEmpty() }.toSet()
    }

    private fun sha256(file: File): String = try {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) { val n = input.read(buf); if (n < 0) break; md.update(buf, 0, n) }
        }
        md.digest().hex()
    } catch (_: Exception) {
        ""
    }

    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).hex()

    private fun ByteArray.hex(): String = joinToString("") { "%02x".format(it) }

    // ── 磁盘与持久化 ──────────────────────────────────────────────────────────

    private fun verifiedKey(manifest: Ota.Manifest): String = "${manifest.versionCode}:${manifest.sha256}"

    private fun isVerified(manifest: Ota.Manifest): Boolean =
        ready.exists() && ready.length() == manifest.size &&
            prefs.getString(KEY_VERIFIED, "") == verifiedKey(manifest)

    private fun usableBytes(): Long = when {
        part.exists() -> part.length()
        ready.exists() -> ready.length()
        else -> 0L
    }

    private fun storedManifest(): Ota.Manifest? {
        val raw = prefs.getString(KEY_MANIFEST, null) ?: return null
        val ep = endpoint ?: return null
        return Ota.parse(raw, ep, app.packageName)
    }

    private fun clearFiles(keepManifest: Boolean = false) {
        runCatching { part.delete() }
        runCatching { ready.delete() }
        val edit = prefs.edit().remove(KEY_VERIFIED)
        if (!keepManifest) {
            edit.remove(KEY_MANIFEST).remove(KEY_RECORDED_CODE).remove(KEY_RECORDED_SIZE).remove(KEY_RECORDED_SHA)
        }
        edit.apply()
    }

    /** 丢掉磁盘上的残包与校验标记，但留着「检查过哪一版」的记录（已是最新时用）。 */
    private fun discardResidue() {
        runCatching { part.delete() }
        runCatching { ready.delete() }
        prefs.edit().remove(KEY_VERIFIED).apply()
    }

    /** 回调统一回主线程：Compose 写状态与启动安装 Intent 都在主线程。 */
    private fun deliver(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post(block)
    }

    /** 只在还是当前代际时写状态，晚到的旧协程不能覆盖新状态。 */
    private inline fun post(gen: Long, block: () -> Unit) {
        synchronized(gate) { if (gen == generation) block() }
    }

    companion object {
        private const val TAG = "CrewOta"
        private const val KEY_MANIFEST = "manifest"
        private const val KEY_CHECKED_AT = "checkedAt"
        private const val KEY_VERIFIED = "verified"
        private const val KEY_RECORDED_CODE = "recordedCode"
        private const val KEY_RECORDED_SIZE = "recordedSize"
        private const val KEY_RECORDED_SHA = "recordedSha"
        /** 前台冷却：进页面自动检查最多这么久一次。不后台轮询、不自动下载。 */
        const val COOLDOWN_MS = 6 * 60 * 60 * 1000L
        private const val TICK_MS = 250L
        private const val MAX_REDIRECTS = 3

        @Volatile private var instance: OtaRuntime? = null

        fun get(context: Context): OtaRuntime = instance ?: synchronized(this) {
            instance ?: OtaRuntime(context.applicationContext).also { instance = it }
        }
    }
}
