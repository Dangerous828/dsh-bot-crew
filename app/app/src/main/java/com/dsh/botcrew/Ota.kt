package com.dsh.botcrew

import org.json.JSONObject
import java.net.URI

/**
 * OTA 的纯策略层：manifest 契约、同源与路径约束、版本判定、安装候选一致性、下载状态机。
 *
 * 只依赖 JDK + org.json，JVM 单测直接跑；碰 PackageManager / 文件 / 网络 / FileProvider 的部分全在
 * [OtaRuntime]。这样「什么算合法的更新」「什么算装对了包」可以在没有真机的情况下钉住。
 *
 * ## 与配对通道无关
 *
 * manifest 与 APK 都走 HTTPS 同 origin，**不带**任何已有配对 token/凭据：更新通道是公开静态资源，
 * 不放 [CrewClient] 的头。APK 地址只由 manifest 的 origin + [Manifest.apkPath] 拼，
 * 不采信 manifest 里出现的任何其它 host。
 */
object Ota {
    /** 缺省更新入口。可被 gradle 属性 crewUpdateUrl 覆盖（[BuildConfig.OTA_MANIFEST_URL]）。 */
    const val DEFAULT_MANIFEST_URL = "https://crew.kentonnie.top/updates/android/manifest.json"

    /** 契约包名。隔离验证包用 crewAppId 换包名时由调用方传实际 applicationId。 */
    const val PACKAGE = "com.dsh.botcrew"
    const val SCHEMA_VERSION = 1
    const val APK_PATH_PREFIX = "/updates/android/"

    /** 64 位小写 hex（sha256 / signerSha256）。 */
    private val HEX64 = Regex("^[0-9a-f]{64}$")

    // 有界字段：与发布脚本/CLI 同一口径，超界一律当契约不符（不截断、不猜测）。
    /** versionCode 上界：与 Android 的整数版本号上限同一量级，留足递增空间。 */
    const val MAX_VERSION_CODE = 2_100_000_000L
    /** APK 体积上界：比现实包大很多，但足以挡住「size 填成天文数字把磁盘写满」。 */
    const val MAX_SIZE = 256L * 1024 * 1024
    /** minSdk 下界；上界给个现实值，挡住乱填。 */
    const val MIN_SDK_FLOOR = 21
    const val MIN_SDK_CEIL = 1000
    private const val MAX_BUILD_ID = 64
    private const val MAX_VERSION_NAME = 64
    private const val MAX_NOTES = 2000
    private const val MAX_APK_PATH = 256

    /** 校验过的更新入口：manifestUrl 是完整地址，origin 用来钉住 APK 与重定向不跨站。 */
    data class Endpoint(val manifestUrl: String, val origin: String)

    /**
     * 入口校验：只收 HTTPS，且不带 userinfo / query / fragment（避免把凭据或一次性参数塞进更新地址）。
     * 非法返回 null —— 调用方据此「不检查、不发请求」。
     */
    fun endpoint(raw: String): Endpoint? {
        val text = raw.trim()
        if (text.isEmpty()) return null
        return try {
            val u = URI(text)
            if (!u.scheme.equals("https", true)) return null
            if (u.host.isNullOrBlank()) return null
            if (u.rawUserInfo != null || u.rawQuery != null || u.rawFragment != null) return null
            Endpoint(text, originOf(u) ?: return null)
        } catch (_: Exception) {
            null
        }
    }

    /** url 是否与 origin 同源（scheme+host+port，443 与省略端口等价）。重定向、APK 地址都过这一关。 */
    fun sameOrigin(url: String, origin: String): Boolean {
        val parsed = try { URI(url.trim()) } catch (_: Exception) { return false }
        if (!parsed.scheme.equals("https", true)) return false
        return originOf(parsed) == origin
    }

    private fun originOf(u: URI): String? {
        val host = u.host ?: return null
        val port = u.port
        return if (port == -1 || port == 443) "https://$host" else "https://$host:$port"
    }

    /** manifest 契约全量。字段缺失、类型不符、越界、路径不自洽，一律 [parse] 返回 null。 */
    data class Manifest(
        val schemaVersion: Int,
        val packageName: String,
        val versionCode: Long,
        val versionName: String,
        val buildId: String,
        val minSdk: Int,
        val sha256: String,
        val size: Long,
        val signerSha256: String,
        val apkPath: String,
        val notes: String,
        /** 由 endpoint.origin + apkPath 拼出，**不是** manifest 里的字段。 */
        val apkUrl: String,
    )

    /**
     * 严格解析。逐条要求（全部与发布脚本/CLI 同一口径）：
     * - schemaVersion 必须**正好**是 1（按 Long 比，先 toInt 会溢出绕过）；
     * - packageName == expectedPackage；versionCode 为 1..[MAX_VERSION_CODE] 的整数；
     * - versionName 非空、无首尾空格、不超过 [MAX_VERSION_NAME]；
     * - buildId 非空且不超过 [MAX_BUILD_ID]；
     * - minSdk 为 [MIN_SDK_FLOOR]..[MIN_SDK_CEIL]；sha256 / signerSha256 为 64 位小写 hex；
     * - size 为 1..[MAX_SIZE]；apkPath 必须**恰好**是 /updates/android/<versionCode>/<sha256>.apk；
     * - notes 可选，不超过 [MAX_NOTES]。
     */
    fun parse(raw: String, endpoint: Endpoint, expectedPackage: String = PACKAGE): Manifest? {
        val o = try { JSONObject(raw) } catch (_: Exception) { return null }
        val schema = long(o, "schemaVersion") ?: return null
        if (schema != SCHEMA_VERSION.toLong()) return null
        val pkg = o.optString("packageName")
        if (pkg != expectedPackage) return null
        val code = long(o, "versionCode") ?: return null
        if (code < 1L || code > MAX_VERSION_CODE) return null
        val name = o.optString("versionName")
        if (name.isBlank() || name.trim() != name || name.length > MAX_VERSION_NAME) return null
        val buildId = o.optString("buildId")
        if (buildId.isBlank() || buildId.length > MAX_BUILD_ID) return null
        val minSdkLong = long(o, "minSdk") ?: return null
        if (minSdkLong < MIN_SDK_FLOOR || minSdkLong > MIN_SDK_CEIL) return null
        val minSdk = minSdkLong.toInt()
        val sha = o.optString("sha256")
        if (!HEX64.matches(sha)) return null
        val size = long(o, "size") ?: return null
        if (size < 1L || size > MAX_SIZE) return null
        val signer = o.optString("signerSha256")
        if (!HEX64.matches(signer)) return null
        val apkPath = o.optString("apkPath")
        if (apkPath.length > MAX_APK_PATH) return null
        if (apkPath != APK_PATH_PREFIX + code + "/" + sha + ".apk") return null
        val notes = if (o.has("notes")) o.optString("notes") else ""
        if (notes.length > MAX_NOTES) return null
        return Manifest(
            schemaVersion = schema.toInt(), packageName = pkg, versionCode = code, versionName = name,
            buildId = buildId, minSdk = minSdk, sha256 = sha, size = size,
            signerSha256 = signer, apkPath = apkPath, notes = notes,
            apkUrl = endpoint.origin + apkPath,
        )
    }

    /** 只接受 JSON 整数（Number 且无小数）：「3」这种字符串不算，避免类型松掉。 */
    private fun long(o: JSONObject, key: String): Long? {
        val v = o.opt(key) ?: return null
        return when (v) {
            is Int -> v.toLong()
            is Long -> v
            is Short -> v.toLong()
            is Byte -> v.toLong()
            else -> null
        }
    }

    enum class Verdict { Newer, Same, Downgrade, Incompatible }

    /** 版本判定：先看兼容，再看大小。只有 [Verdict.Newer] 才允许进入下载。 */
    fun verdict(manifest: Manifest, currentVersionCode: Long, deviceSdk: Int): Verdict = when {
        manifest.minSdk > deviceSdk -> Verdict.Incompatible
        manifest.versionCode > currentVersionCode -> Verdict.Newer
        manifest.versionCode == currentVersionCode -> Verdict.Same
        else -> Verdict.Downgrade
    }

    /** 从 APK 里读出来的事实（getPackageArchiveInfo）。null = 读不出来。 */
    data class ArchiveFacts(
        val packageName: String,
        val versionCode: Long,
        val signerSha256: Set<String>,
    )

    /** 安装候选的全部输入。installed* 来自 PackageManager 当前已装包，不猜、不硬编码。 */
    data class Candidate(
        val manifest: Manifest,
        val fileBytes: Long,
        val fileSha256: String,
        val archive: ArchiveFacts?,
        val installedPackage: String,
        val installedVersionCode: Long,
        val installedSignerSha256: Set<String>,
    )

    sealed interface Check {
        object Ok : Check
        /** reason 是稳定短码，界面文案在 UI 层映射，不在这里拼中文。 */
        data class Reject(val reason: String) : Check
    }

    /**
     * 装机前的一致性：长度 → hash → 包名/版本 → 签名（APK 实际签名 == 当前已装签名，且 == manifest 声明）。
     * 顺序按「便宜且能早否定的先来」。任何一条不符都拒绝，绝不装错包 / 不降级。
     */
    fun checkInstall(c: Candidate): Check {
        val m = c.manifest
        if (c.fileBytes != m.size) return Check.Reject("size_mismatch")
        if (!c.fileSha256.equals(m.sha256, ignoreCase = false)) return Check.Reject("sha_mismatch")
        val archive = c.archive ?: return Check.Reject("archive_unreadable")
        if (archive.packageName != m.packageName) return Check.Reject("package_mismatch")
        if (archive.versionCode != m.versionCode) return Check.Reject("version_mismatch")
        if (c.installedPackage != m.packageName) return Check.Reject("target_package_mismatch")
        // 升级方向：manifest 已保证 > 当前，这里再用已装版本核一次（万一装的是更高版本）。
        if (m.versionCode <= c.installedVersionCode) return Check.Reject("not_newer")
        // 签名必须与当前已装 App 严格一致：否则同包名另一个签名的包也「看着合法」。
        if (c.installedSignerSha256.isEmpty()) return Check.Reject("signer_unknown")
        if (archive.signerSha256 != c.installedSignerSha256) return Check.Reject("signer_mismatch")
        // manifest 声明的 signer 也要对得上（发布脚本写错时早失败）。
        if (m.signerSha256 !in archive.signerSha256) return Check.Reject("signer_manifest_mismatch")
        return Check.Ok
    }

    enum class Stage { Idle, Checking, Available, Downloading, Verifying, Ready, Failed }

    /**
     * 界面唯一读的状态。note 只放**异常与必须用户操作**的短句，不放教学文案。
     * [downloaded] 对 Available 表示「已落盘可续传的字节」，对 Downloading 表示进度。
     */
    data class State(
        val stage: Stage = Stage.Idle,
        val manifest: Manifest? = null,
        val downloaded: Long = 0L,
        val note: String = "",
    ) {
        val size: Long get() = manifest?.size ?: 0L
        /** 0..100；没有可用总量时为 null（不画一条假进度条）。 */
        val percent: Int? get() = if (size > 0L) ((downloaded * 100) / size).toInt().coerceIn(0, 100) else null
        val resumable: Boolean get() = stage == Stage.Available && downloaded > 0L
    }

    /**
     * 落盘残量与 manifest 对账，得到**可恢复**的状态。进程被杀 / Activity 重建 / 权限往返后都走这一条，
     * 所以不存在「一直显示下载中」：没有活着的下载任务时，状态只由磁盘长度决定。
     */
    fun recover(manifest: Manifest?, storedVersionCode: Long, storedSize: Long, fileBytes: Long): State {
        if (manifest == null) return State()
        val same = storedVersionCode == manifest.versionCode && storedSize == manifest.size
        val bytes = if (same) fileBytes.coerceAtLeast(0L) else 0L
        return when {
            bytes > manifest.size -> State(Stage.Available, manifest, 0L)
            bytes > 0L && bytes == manifest.size -> State(Stage.Verifying, manifest, bytes)
            bytes > 0L -> State(Stage.Available, manifest, bytes)
            else -> State(Stage.Available, manifest, 0L)
        }
    }

    /**
     * 206 的 `Content-Range: bytes <start>-<end>/<total>` 是否**正好**是「从 [from] 一直续到文件末尾」。
     *
     * 我们的请求永远是开放区间 `bytes=<from>-`，所以服务端正确的回答只能是
     * `start == from && end == total-1 && total == 期望总长`。任何一项不符都是服务端在给别的段
     * （或代理改写过），必须删残包重下 —— 只检查 start/total 会把「截断的一段」当成整段接上去。
     * 同时守住 0 <= start <= end < total，`*`、缺头、格式错一律 false。
     */
    fun contentRangeOk(raw: String?, from: Long, total: Long): Boolean {
        val text = raw?.trim() ?: return false
        if (!text.startsWith("bytes ", ignoreCase = true)) return false
        val rest = text.substringAfter(' ').trim()
        val range = rest.substringBefore('/')
        val totalText = rest.substringAfter('/', "").trim()
        val gotTotal = totalText.toLongOrNull() ?: return false
        val startText = range.substringBefore('-')
        val endText = range.substringAfter('-', "")
        if (endText.isBlank()) return false
        val gotStart = startText.toLongOrNull() ?: return false
        val gotEnd = endText.toLongOrNull() ?: return false
        if (gotStart < 0L || gotEnd < gotStart || gotEnd >= gotTotal) return false
        return gotStart == from && gotTotal == total && gotEnd == total - 1L
    }

    /**
     * 磁盘上的残量与这份 manifest 是否同属一个包。文件名只有一份（`update.apk.part`），
     * 所以换版本/换 hash 之后必须能认出「这是上一个包的半截」，否则会拿旧字节当新包续传：
     * hash 关最后能拦住，但白下一遍、且恢复出来的状态是错的。
     *
     * 三个字段一起比：只比 versionCode 会漏掉「同版本号重发（不同签名/内容）」。
     *
     * @param recordedCode 持久记录里的 versionCode（0 = 没有记录）
     * @param recordedSize 持久记录里的 size（0 = 没有记录）
     * @param recordedSha  持久记录里的 sha256（空 = 没有记录）
     */
    fun residueBelongs(manifest: Manifest, recordedCode: Long, recordedSize: Long, recordedSha: String): Boolean =
        recordedCode == manifest.versionCode && recordedSize == manifest.size && recordedSha == manifest.sha256

    /** 未发布/无更新版本：不是错误，界面只说一句「暂无更新」。 */
    fun noUpdate(note: String = "暂无更新"): State = State(Stage.Idle, null, 0L, note)

    /** 下载中：进度字节到达。到量就转校验，不在这里宣布成功。 */
    fun onProgress(manifest: Manifest, bytes: Long): State = when {
        bytes >= manifest.size -> State(Stage.Verifying, manifest, bytes)
        else -> State(Stage.Downloading, manifest, bytes.coerceAtLeast(0L))
    }

    /** 取消：保住已落盘的字节，回到可续传的 Available（永远不会停在 Downloading）。 */
    fun onCancel(manifest: Manifest?, keptBytes: Long): State =
        if (manifest == null) State() else State(Stage.Available, manifest, keptBytes.coerceIn(0L, manifest.size))

    /** 失败：保留残量供续传或重试，note 写一句实话。 */
    fun onFailure(manifest: Manifest?, keptBytes: Long, note: String): State = State(
        stage = Stage.Failed, manifest = manifest,
        downloaded = manifest?.let { keptBytes.coerceIn(0L, it.size) } ?: 0L, note = note,
    )

    /** 校验结果落地：通过 → Ready（按钮变「安装」）；不通过 → Failed + 短码原因。 */
    fun onVerified(manifest: Manifest, result: Check): State = when (result) {
        is Check.Ok -> State(Stage.Ready, manifest, manifest.size)
        is Check.Reject -> State(Stage.Failed, manifest, 0L, result.reason)
    }
}
