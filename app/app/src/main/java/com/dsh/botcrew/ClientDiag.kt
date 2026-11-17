package com.dsh.botcrew

import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * 客户端诊断日志的**纯逻辑**：事件模型、白名单序列化、脱敏断言、切批。
 *
 * 存在的理由：`POST /api/mobile/diagnostics` 只收白名单字段（契约 §5.9），且服务端会在白名单
 * 之上再剥一层敏感形态。客户端这一侧必须**一开始就不产生** token/query/headers/body/text/聊天正文，
 * 而不是指望服务端兜底。所有「记什么、怎么序列化、怎么切批」都做成纯函数，JVM 单测直接跑。
 *
 * 与 Android 无关：不碰文件、不碰网络、不碰 Compose。落盘在 [DiagRingStore]，上传在 [DiagUploader]。
 *
 * ## 字段（逐字对齐契约 §5.9）
 *
 * 普通事件：`id / kind(event) / at / event / route / method / status / ms / err / session /
 * appVersion / versionCode / extra{phase,networkKind,model,version,routeKind}`。
 * 崩溃：`kind=crash` 另带 `errorClass / stack(仅结构帧) / breadcrumbs(≤50)`，单条 ≤16KiB。
 *
 * ## 硬边界（写死在这里，不留"约定俗成"）
 *
 * - `route` 只放**不含 query/hash 的 pathname**；带 `?`/`#` 或百分号编码的一律不产生（见 [routeOf]）。
 * - `err` / `errorClass` 只放 `[A-Za-z0-9._/-]` 短词；带空格标点的异常 message 不产生（防夹凭据）。
 * - `extra` 只放白名单键，值命中敏感形态整条丢弃。
 * - 单 event ≤[MAX_EVENT_BYTES]、crash ≤[MAX_CRASH_BYTES]、batch ≤[MAX_BATCH]、整体 ≤[MAX_BODY_BYTES]。
 */
object ClientDiag {

    const val APP = "BotCrew"

    /** 契约 §5.9：整批 ≤64KiB、≤50 条；普通单条 ≤1KiB、crash ≤16KiB。 */
    const val MAX_BODY_BYTES = 64 * 1024
    const val MAX_BATCH = 50
    const val MAX_EVENT_BYTES = 1024
    const val MAX_CRASH_BYTES = 16 * 1024
    const val MAX_STACK_BYTES = 8 * 1024
    const val MAX_CRUMBS = 50

    /** 幂等键与短词的长度上限（契约：id 1..128；短词 1..64/128 各自）。 */
    const val MAX_ID = 128
    const val MAX_EVENT_WORD = 64
    const val MAX_WORD = 128

    /** 事件类型短词（客户端侧的全部取值；未知类型按 [EventType.OTHER] 归一）。 */
    enum class EventType(val wire: String) {
        HTTP_ERROR("http_error"),
        NET_FAIL("net_fail"),
        CONNECT_FAIL("connect_fail"),
        UI_EXCEPTION("ui_exception"),
        SCREEN_CRASH("screen_crash"),
        ROUTE_SWITCH("route_switch"),
        LIFECYCLE("lifecycle"),
        OTHER("other"),
    }

    /** `extra` 白名单键（契约 §5.9 只放行这五个）。 */
    val EXTRA_KEYS = setOf("phase", "networkKind", "model", "version", "routeKind")

    /**
     * 一条诊断事件。全部字段都是**白名单内**的；序列化时再过滤一次（见 [toWire]）。
     *
     * [id] 由 [newId] 生成（UUID），既作服务端幂等键，也作本地环形的删除依据。
     * [at] 是 ISO8601 带时区，服务端仍会另记 receivedAt（不信任本地时钟）。
     */
    data class Event(
        val id: String,
        val at: String,
        val event: String,
        val route: String,
        val method: String? = null,
        val status: Int? = null,
        val ms: Long? = null,
        val err: String? = null,
        val session: String? = null,
        val appVersion: String = BuildInfo.VERSION_NAME,
        val versionCode: Int = BuildInfo.VERSION_CODE,
        val extra: Map<String, String> = emptyMap(),
        /**
         * **捕获时刻**的构建标记（BuildInfo.BUILD_ID 的快照）。固化在事件上，升级后旧队列行不会被
         * 当前 BuildInfo 冒充成新包。落盘在 row 的内部键（wire 前剥离，不进服务端白名单）。
         */
        val captureBuild: String = BuildInfo.buildIdLabel(),
    )

    /** 一条崩溃事件。`stack` 只放结构帧（[sanitizeStack]），`breadcrumbs` 是最近若干条**已序列化**的普通事件。 */
    data class Crash(
        val id: String,
        val at: String,
        val errorClass: String,
        val stack: String,
        val breadcrumbs: List<JSONObject>,
        val appVersion: String = BuildInfo.VERSION_NAME,
        val versionCode: Int = BuildInfo.VERSION_CODE,
        val extra: Map<String, String> = emptyMap(),
        val captureBuild: String = BuildInfo.buildIdLabel(),
    )

    /** 生成一个幂等键。UUID 去掉连字符，落在 `[A-Za-z0-9]` 内，长度 32，稳过契约的 id 约束。 */
    fun newId(): String = java.util.UUID.randomUUID().toString().replace("-", "")

    /** 现在这一刻的 ISO8601（带本机时区偏移，例 `2026-11-15T21:14:18+08:00`）。 */
    fun nowIso(now: Long = System.currentTimeMillis()): String {
        val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.US)
        fmt.timeZone = TimeZone.getDefault()
        return fmt.format(Date(now))
    }

    /**
     * 把一条 URL/路径归一成**可上报的 route**：只保留 pathname，去掉 scheme/host/query/hash，
     * 并把百分号编码解不开的部分判为不可上报（返回空串表示这条不记 route）。
     *
     * 为什么不能直接传原始 URL：query 里可能有 `?token=…`，hash 也可能是敏感定位；契约 §5.9
     * 明确「客户端传不带 query/hash 的 pathname」，服务端也会拒 `route_sensitive`。
     * 这里先一步把它切成 pathname；切完若仍含 `%`（多重编码）或 `?`/`#` 残留，判空——宁可不记。
     */
    fun routeOf(raw: String): String {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return ""
        // 去掉 scheme://host，只留从第一个 '/' 起的 path；纯路径输入原样保留。
        val pathPart = if ("://" in trimmed) {
            val rest = trimmed.substringAfter("://")
            val slash = rest.indexOf('/')
            if (slash < 0) "/" else rest.substring(slash)
        } else {
            trimmed
        }
        // 到 query/hash 为止。
        val cut = pathPart.substringBefore('?').substringBefore('#')
        // 多重/歧义百分号编码：不记（宁可空）。
        if (cut.contains('%')) return ""
        // 归一成恰好一个前导 '/'。
        val norm = "/" + cut.trimStart('/')
        return norm
    }

    /**
     * 一条短词是否合契约的 `[A-Za-z0-9._/-]{1,limit}`。`err` / `errorClass` / `event` 用它。
     * 带空格标点的异常 message 会在这里被挡掉（防夹凭据）。
     */
    fun isShortWord(value: String, limit: Int = MAX_WORD): Boolean {
        if (value.isEmpty() || value.length > limit) return false
        return value.all { it.isLetterOrDigit() || it == '.' || it == '_' || it == '/' || it == '-' }
    }

    /**
     * 从一个异常里取**只合短词**的类别名：优先 simpleName，不合规就退回通用词。
     * 绝不返回 `message`（可能带 token/URL/聊天原文）。
     */
    fun errOf(error: Throwable): String {
        val simple = error::class.java.simpleName
        return if (isShortWord(simple)) simple else "Error"
    }

    /**
     * 把异常堆栈裁成**只含结构帧**的字符串（契约 §5.9：异常 message、URL、聊天原文等非帧行整条丢弃）。
     *
     * 只保留形如 `at pkg.C.m(File.java:123)`、`at pkg.C.m(File.kt:12)`、`at pkg.C.m(NativeMethod)` 的行，
     * 以及 `Caused by: <class>` 的类别头；`message:` 那一行与任何其它自由文本一律丢。
     * 超过 [MAX_STACK_BYTES] 截断。
     */
    fun sanitizeStack(raw: String?): String {
        if (raw.isNullOrBlank()) return ""
        val keep = StringBuilder()
        val causedBy = Regex("^Caused by: ([A-Za-z0-9_.$]+)$")
        for (line in raw.lineSequence()) {
            val t = line.trim()
            // 只认三种纯结构行：`at ...` 帧、`Caused by: <class>`（后面不许再有 message）、`... N more`。
            val isFrame = t.startsWith("at ")
            val isCausedBy = causedBy.matches(t)
            val isMore = Regex("^\\.\\.\\. \\d+ more$").matches(t)
            if (!(isFrame || isCausedBy || isMore)) continue
            // 帧里正常不含 URL/token；多一道兜底，命中就丢。
            if (t.contains("://") || t.contains("token", ignoreCase = true) || t.contains("secret", ignoreCase = true)) continue
            if (keep.length + t.length + 1 > MAX_STACK_BYTES) break
            keep.append(t).append('\n')
        }
        return keep.toString().trimEnd()
    }

    /**
     * 敏感形态扫描：`extra` 的值或 `route` 命中就判敏感。用于客户端侧**导出前的脱敏断言**
     * （导出给人看/分享，绝不能让 token/密码出现在明文日志里）。
     */
    private val SENSITIVE = listOf(
        Regex("(?i)bearer\\s+[A-Za-z0-9._-]{8,}"),
        Regex("(?i)(token|password|secret|credential|authorization)\\s*[=:]", RegexOption.IGNORE_CASE),
        Regex("sk_live_[A-Za-z0-9]+"),
        Regex("(?i)x-crew-(device|credential)"),
    )

    fun looksSensitive(value: String): Boolean = SENSITIVE.any { it.containsMatchIn(value) }

    /**
     * 把一条 Event 序列化成契约的 wire JSONObject。构造期就是白名单：不在这里出现任何额外字段。
     * 若 `route` 不合规（空/带 query/敏感），整条返回 null——宁可不报，也不报一条会被服务端拒的。
     */
    fun toWire(event: Event): JSONObject? {
        val route = routeOf(event.route)
        if (route.isEmpty()) return null
        if (looksSensitive(route)) return null
        val obj = JSONObject()
            .put("id", event.id.take(MAX_ID))
            .put("kind", "event")
            .put("at", event.at)
            .put("event", normalizeEventWord(event.event))
            .put("route", route)
        event.method?.let { obj.put("method", it.uppercase(Locale.US).take(MAX_WORD)) }
        event.status?.let { obj.put("status", it.coerceIn(0, 999)) }
        event.ms?.let { obj.put("ms", it.coerceAtLeast(0L)) }
        event.err?.takeIf { isShortWord(it) }?.let { obj.put("err", it) }
        event.session?.takeIf { isShortWord(it) }?.let { obj.put("session", it) }
        if (event.appVersion.isNotBlank()) obj.put("appVersion", event.appVersion.take(MAX_WORD))
        if (event.versionCode >= 0) obj.put("versionCode", event.versionCode)
        wireExtra(event.extra)?.let { obj.put("extra", it) }
        // 捕获构建标记：落盘在 row 的内部键（服务端 wire 前由 buildBody 剥离，不进白名单）。
        obj.put(CAPTURE_BUILD_KEY, event.captureBuild.take(MAX_WORD))
        return obj
    }

    /** 崩溃事件序列化。`stack` 已按 [sanitizeStack] 净过；breadcrumbs 逐项走 [toWire] 的 event 规则。 */
    fun toWire(crash: Crash): JSONObject? {
        val obj = JSONObject()
            .put("id", crash.id.take(MAX_ID))
            .put("kind", "crash")
            .put("at", crash.at)
            .put("errorClass", if (isShortWord(crash.errorClass)) crash.errorClass else "Error")
        if (crash.appVersion.isNotBlank()) obj.put("appVersion", crash.appVersion.take(MAX_WORD))
        if (crash.versionCode >= 0) obj.put("versionCode", crash.versionCode)
        wireExtra(crash.extra)?.let { obj.put("extra", it) }
        obj.put(CAPTURE_BUILD_KEY, crash.captureBuild.take(MAX_WORD))
        val frames = sanitizeStack(crash.stack)
        if (frames.isNotEmpty()) obj.put("stack", frames.takeBytes(MAX_STACK_BYTES))
        if (crash.breadcrumbs.isNotEmpty()) {
            val arr = JSONArray()
            for (crumb in crash.breadcrumbs.take(MAX_CRUMBS)) {
                // breadcrumbs 已是白名单序列化过的普通事件；这里再走一次 wireExtra/route 兜底，并剥内部键。
                val route = routeOf(crumb.optString("route"))
                if (route.isEmpty() || looksSensitive(route)) continue
                arr.put(stripInternal(crumb))
            }
            if (arr.length() > 0) obj.put("breadcrumbs", arr)
        }
        return obj
    }

    /** row 落盘的内部键（捕获构建标记）。服务端 wire 前由 [buildBody] 剥离，绝不进请求体。 */
    const val CAPTURE_BUILD_KEY = "_cb"
    /** 历史无标签行的捕获标记（升级前落盘的老行没有 `_cb`）。不自动打新 tag。 */
    const val UNKNOWN_CAPTURE = "unknown-capture"

    /** 读一行 row 的捕获构建标记；无（历史行）→ [UNKNOWN_CAPTURE]。 */
    fun captureBuildOf(row: JSONObject): String {
        val v = row.optString(CAPTURE_BUILD_KEY).trim()
        return if (v.isEmpty()) UNKNOWN_CAPTURE else v
    }

    /** 剥掉内部键，得到真实 wire 行（不进服务端）。 */
    fun stripInternal(row: JSONObject): JSONObject {
        val copy = JSONObject(row.toString())
        copy.remove(CAPTURE_BUILD_KEY)
        return copy
    }

    /** 事件类型归一：只认白名单短词，不认识的落到 `other`。 */
    fun normalizeEventWord(raw: String): String {
        val t = raw.trim()
        EventType.values().firstOrNull { it.wire == t }?.let { return it.wire }
        return if (isShortWord(t, MAX_EVENT_WORD)) t else EventType.OTHER.wire
    }

    /** `extra` 白名单过滤 + 敏感值整条丢弃。全空返回 null（不写空对象）。 */
    fun wireExtra(extra: Map<String, String>): JSONObject? {
        if (extra.isEmpty()) return null
        val obj = JSONObject()
        for ((k, v) in extra) {
            if (k !in EXTRA_KEYS) continue
            val val0 = v.trim()
            if (val0.isEmpty() || val0.length > MAX_WORD) continue
            if (looksSensitive(val0)) continue
            obj.put(k, val0)
        }
        return if (obj.length() > 0) obj else null
    }

    /** 一条已序列化记录的字节数（用 UTF-8 计，与服务端 64KiB/1KiB/16KiB 口径一致）。 */
    fun bytesOf(row: JSONObject): Int = row.toString().toByteArray(Charsets.UTF_8).size

    /**
     * 把一批已序列化的记录切成**符合契约**的批：每批 ≤[MAX_BATCH] 条、每批 UTF-8 ≤[MAX_BODY_BYTES]（留批外壳余量）。
     *
     * 单条超自身上限（event>[MAX_EVENT_BYTES]/crash>[MAX_CRASH_BYTES]）的**不进任何批**，随 [oversizeIds] 返回，
     * 由调用方从本地删掉并计入自丢——不上报一条注定被拒的记录。
     */
    data class BatchPlan(
        val batches: List<List<JSONObject>>,
        val oversizeIds: List<String>,
        val acceptedIds: List<String>, // 进了批的记录 id（用于本地保留判断）
    )

    fun planBatches(rows: List<JSONObject>, bodyLimit: Int = MAX_BODY_BYTES): BatchPlan {
        val oversize = ArrayList<String>()
        val batchable = ArrayList<JSONObject>()
        for (row in rows) {
            val kindCrash = row.optString("kind") == "crash"
            val cap = if (kindCrash) MAX_CRASH_BYTES else MAX_EVENT_BYTES
            if (bytesOf(row) > cap) {
                oversize.add(row.optString("id"))
            } else {
                batchable.add(row)
            }
        }
        // 按捕获构建标记分组：同一批只含同一 captureBuild 的行（顶层 build 取该批捕获值，不被当前 BuildInfo 冒充）。
        // 组内再按条数/字节切批；保持原相对顺序。
        val batches = ArrayList<List<JSONObject>>()
        val byCapture = LinkedHashMap<String, ArrayList<JSONObject>>()
        for (row in batchable) byCapture.getOrPut(captureBuildOf(row)) { ArrayList() }.add(row)
        val shell = 256
        for ((_, group) in byCapture) {
            var cur = ArrayList<JSONObject>()
            var curBytes = 0
            for (row in group) {
                val b = bytesOf(row) + 1 // 逗号余量
                if (cur.isNotEmpty() && (cur.size >= MAX_BATCH || curBytes + b + shell > bodyLimit)) {
                    batches.add(cur)
                    cur = ArrayList()
                    curBytes = 0
                }
                cur.add(row)
                curBytes += b
            }
            if (cur.isNotEmpty()) batches.add(cur)
        }
        val ids = batchable.map { it.optString("id") }
        return BatchPlan(batches, oversize, ids)
    }

    /**
     * 组装一整个请求体（纯函数，方便单测字节数）。
     *
     * - 顶层 `build` 取**该批行的捕获构建标记**（[captureBuildOf]），不使用当前 [BuildInfo] ——
     *   升级后补传旧队列不会把旧故障冒充成新包。批内若混入 captureBuild（不应发生，planBatches 已按组切），
     *   以首行捕获值为准；旧无标签行= `unknown-capture`。
     * - 每行先 [stripInternal] 剥掉内部键（`_cb`），绝不把内部键发给服务端。
     */
    fun buildBody(batch: List<JSONObject>): String {
        val arr = JSONArray()
        for (row in batch) arr.put(stripInternal(row))
        val capture = batch.firstOrNull()?.let { captureBuildOf(it) } ?: UNKNOWN_CAPTURE
        // build = appVersion(verCode)/capture；appVersion/versionCode 也取该批行的实际值（不用当前 BuildInfo）。
        val first = batch.firstOrNull()
        val verName = first?.optString("appVersion").orEmpty().ifBlank { BuildInfo.VERSION_NAME }
        val verCode = first?.optInt("versionCode", BuildInfo.VERSION_CODE) ?: BuildInfo.VERSION_CODE
        val build = if (capture == UNKNOWN_CAPTURE) "$verName($verCode)/$UNKNOWN_CAPTURE"
        else "$verName($verCode)/$capture"
        return JSONObject()
            .put("app", APP)
            .put("build", build)
            .put("batch", arr)
            .toString()
    }

    /** UTF-8 安全截断到 [limit] 字节（不切断多字节字符）。 */
    private fun String.takeBytes(limit: Int): String {
        val bytes = toByteArray(Charsets.UTF_8)
        if (bytes.size <= limit) return this
        var end = limit
        // 回退到不落在多字节字符中间的位置。
        while (end > 0 && (bytes[end].toInt() and 0xC0) == 0x80) end--
        return String(bytes, 0, end, Charsets.UTF_8)
    }
}

/**
 * 构建期版本信息。抽出来是为了让纯逻辑单测不依赖 BuildConfig（JVM 单测里没有）。
 *
 * 真机由 [DiagRuntime] 在初始化时用 `BuildConfig.VERSION_NAME/VERSION_CODE` 覆盖默认值；
 * 单测直接用默认值，不碰 Android。
 */
object BuildInfo {
    @Volatile var VERSION_NAME: String = "0.1.0"
    @Volatile var VERSION_CODE: Int = 1
    /** 构建标记（BuildConfig.CREW_BUILD_ID）。generic 默认 "local"；发布包为 cellular-20261115-r1 之类。 */
    @Volatile var BUILD_ID: String = "local"

    /**
     * body.build 字符串：便于服务端对照「哪个真实 APK」。
     * 有明确构建标记时是 `0.1.0(1)/cellular-20261115-r1`；generic、local 时退回 `0.1.0(1)`。
     */
    fun buildLabel(): String {
        val base = "$VERSION_NAME($VERSION_CODE)"
        val id = BUILD_ID.trim()
        return if (id.isEmpty() || id == "local") base else "$base/$id"
    }

    /** 诊断页显示的构建标记（原样，人读）。 */
    fun buildIdLabel(): String = BUILD_ID.trim().ifEmpty { "local" }
}
