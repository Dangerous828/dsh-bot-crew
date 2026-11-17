package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * OTA 策略回归：这些是**真机走的判定路径**（[Ota] 被 [OtaRuntime] 直接调用），不是同名副本。
 *
 * 覆盖四块：
 * 1. 更新入口与 URL 约束（HTTPS、无 userinfo/query/hash、APK 只由 origin+apkPath 拼、同源）。
 * 2. manifest 字段契约（类型、范围、apkPath 与 versionCode/sha256 自洽）。
 * 3. 版本判定与安装候选一致性（长度/hash/包名/版本/签名）。
 * 4. 状态机出口：取消与失败都不得停在「下载中」。
 */
class OtaPolicyTest {

    private val origin = "https://crew.example.test"
    private val sha = "a".repeat(64)
    private val signer = "ad0e44804142148625ce90427ce3832747c29b795640cfb451745b44540af7eb"
    private val ep = Ota.endpoint("$origin/updates/android/manifest.json")!!

    private fun body(
        code: Long = 7,
        pkg: String = Ota.PACKAGE,
        schema: Int = 1,
        shaValue: String = sha,
        size: Long = 1234,
        signerValue: String = signer,
        apkPath: String = "/updates/android/$code/$sha.apk",
        minSdk: Int = 26,
        buildId: String = "b7",
        versionName: String = "0.7.0",
        notes: String = "修了几个问题",
        schemaRaw: String? = null,
    ) = """
        {"schemaVersion":${schemaRaw ?: schema.toString()},"packageName":"$pkg","versionCode":$code,
         "versionName":"$versionName","buildId":"$buildId","minSdk":$minSdk,"sha256":"$shaValue","size":$size,
         "signerSha256":"$signerValue","apkPath":"$apkPath","notes":"$notes"}
    """.trimIndent()

    // ── 1. 入口与 URL ───────────────────────────────────────────────────────

    @Test
    fun endpoint_rejects_nonHttpsOrCredentialedOrQuery() {
        assertNull(Ota.endpoint("http://crew.example.test/updates/android/manifest.json"))
        assertNull(Ota.endpoint("https://user:pw@crew.example.test/m.json"))
        assertNull(Ota.endpoint("https://crew.example.test/m.json?token=abc"))
        assertNull(Ota.endpoint("https://crew.example.test/m.json#x"))
        assertNull(Ota.endpoint(""))
        assertNotNull(Ota.endpoint("https://crew.example.test/updates/android/manifest.json"))
    }

    @Test
    fun apkUrlIsManifestOriginPlusApkPath_neverAnotherHost() {
        // manifest 里出现别的 host 也只能被忽略：apkUrl 由 origin + apkPath 拼。
        val raw = body().replace("\"notes\"", "\"url\":\"https://evil.test/x.apk\",\"notes\"")
        val m = Ota.parse(raw, ep)!!
        assertEquals("$origin/updates/android/7/$sha.apk", m.apkUrl)
    }

    @Test
    fun sameOrigin_acceptsDefaultPortAndRejectsCrossSite() {
        assertTrue(Ota.sameOrigin("https://crew.example.test:443/a.apk", origin))
        assertTrue(Ota.sameOrigin("https://crew.example.test/a.apk", origin))
        assertFalse(Ota.sameOrigin("https://evil.test/a.apk", origin))
        assertFalse(Ota.sameOrigin("http://crew.example.test/a.apk", origin))
        assertFalse(Ota.sameOrigin("https://crew.example.test.evil.test/a.apk", origin))
    }

    // ── 2. manifest 契约 ────────────────────────────────────────────────────

    @Test
    fun manifest_happyPathParsesEveryField() {
        val m = Ota.parse(body(), ep)!!
        assertEquals(7L, m.versionCode)
        assertEquals("0.7.0", m.versionName)
        assertEquals(1234L, m.size)
        assertEquals(signer, m.signerSha256)
        assertEquals("修了几个问题", m.notes)
    }

    @Test
    fun manifest_rejectsWrongSchemaPackageOrNonPositiveCode() {
        assertNull(Ota.parse(body(schema = 2), ep))
        assertNull(Ota.parse(body(pkg = "com.other.app"), ep))
        assertNull(Ota.parse(body(code = 0, apkPath = "/updates/android/0/$sha.apk"), ep))
    }

    @Test
    fun manifest_rejectsUppercaseOrShortHashAndNonPositiveSize() {
        assertNull(Ota.parse(body(shaValue = sha.uppercase()), ep))
        assertNull(Ota.parse(body(shaValue = "abc"), ep))
        assertNull(Ota.parse(body(size = 0), ep))
        assertNull(Ota.parse(body(signerValue = "zz" + sha.drop(2)), ep))
    }

    @Test
    fun manifest_rejectsApkPathThatDoesNotMatchCodeAndHash() {
        // 包与描述错配是最危险的一种：路径必须逐字等于 <code>/<sha>.apk。
        assertNull(Ota.parse(body(apkPath = "/updates/android/8/$sha.apk"), ep))
        assertNull(Ota.parse(body(apkPath = "/updates/android/7/${"b".repeat(64)}.apk"), ep))
        assertNull(Ota.parse(body(apkPath = "https://evil.test/x.apk"), ep))
        assertNull(Ota.parse(body(apkPath = "/updates/android/7/$sha.apk.bak"), ep))
    }

    @Test
    fun manifest_rejectsNumericFieldsSentAsStringsOrFractions() {
        assertNull(Ota.parse(body().replace("\"versionCode\":7", "\"versionCode\":\"7\""), ep))
        assertNull(Ota.parse(body().replace("\"size\":1234", "\"size\":1234.5"), ep))
        assertNull(Ota.parse(body().replace("\"minSdk\":26", "\"minSdk\":\"26\""), ep))
        assertNull(Ota.parse(body().replace("\"versionName\":\"0.7.0\"", "\"versionName\":\"\""), ep))
    }

    @Test
    fun schema_mustBeExactlyOneEvenWhenLongOverflowsAnInt() {
        // 2^32+1 先 toInt 会回绕成 1：这就是「溢出绕过」，必须按 Long 比。
        assertNull(Ota.parse(body(schemaRaw = "4294967297"), ep))
        assertNull(Ota.parse(body(schemaRaw = "18446744073709551617"), ep))
        assertNull(Ota.parse(body(schemaRaw = "-4294967295"), ep))
        assertNull(Ota.parse(body(schema = 0), ep))
        assertNull(Ota.parse(body(schema = -1), ep))
        // 正常值仍然通过。
        assertNotNull(Ota.parse(body(schemaRaw = "1"), ep))
    }

    @Test
    fun versionCodeAndSizeAreBounded() {
        val maxCode = Ota.MAX_VERSION_CODE
        assertEquals(maxCode, Ota.parse(body(code = maxCode, apkPath = "/updates/android/$maxCode/$sha.apk"), ep)!!.versionCode)
        assertNull(Ota.parse(body(code = maxCode + 1, apkPath = "/updates/android/${maxCode + 1}/$sha.apk"), ep))
        assertNull(Ota.parse(body(code = -1, apkPath = "/updates/android/-1/$sha.apk"), ep))
        assertNull(Ota.parse(body(code = Long.MAX_VALUE, apkPath = "/updates/android/9223372036854775807/$sha.apk"), ep))

        assertEquals(Ota.MAX_SIZE, Ota.parse(body(size = Ota.MAX_SIZE), ep)!!.size)
        assertNull(Ota.parse(body(size = Ota.MAX_SIZE + 1), ep))
        assertNull(Ota.parse(body(size = -5), ep))
    }

    @Test
    fun textFieldsAndMinSdkAreBounded() {
        // buildId 必须非空且不超长（界面/对比都用它，空串等于没有标识）。
        assertNull(Ota.parse(body(buildId = ""), ep))
        assertNull(Ota.parse(body(buildId = "b".repeat(65)), ep))
        assertNotNull(Ota.parse(body(buildId = "b".repeat(64)), ep))
        // versionName 上限与首尾空格。
        assertNull(Ota.parse(body(versionName = "0".repeat(65)), ep))
        assertNull(Ota.parse(body(versionName = " 0.7.0"), ep))
        // notes 有界，不因为一句长备注被拒掉整份 manifest。
        assertNull(Ota.parse(body(notes = "n".repeat(2001)), ep))
        assertNotNull(Ota.parse(body(notes = ""), ep))
        // minSdk 的现实区间。
        assertNull(Ota.parse(body(minSdk = 0), ep))
        assertNull(Ota.parse(body(minSdk = Ota.MIN_SDK_FLOOR - 1), ep))
        assertNull(Ota.parse(body(minSdk = Ota.MIN_SDK_CEIL + 1), ep))
        assertNotNull(Ota.parse(body(minSdk = Ota.MIN_SDK_FLOOR), ep))
    }

    @Test
    fun residueBelongs_requiresCodeSizeAndShaTogether() {
        val m = Ota.parse(body(), ep)!!
        assertTrue(Ota.residueBelongs(m, m.versionCode, m.size, m.sha256))
        // 换了版本号：旧残包不算这一版的。
        assertFalse(Ota.residueBelongs(m, 6, m.size, m.sha256))
        // 同版本号重发、内容不同（hash 变了）：也不能续传旧字节。
        assertFalse(Ota.residueBelongs(m, m.versionCode, m.size, "b".repeat(64)))
        // size 变了同理。
        assertFalse(Ota.residueBelongs(m, m.versionCode, m.size + 1, m.sha256))
        // 没有记录（0/空）：任何残包都不归这份 manifest。
        assertFalse(Ota.residueBelongs(m, 0, 0, ""))
    }

    @Test
    fun manifest_rejectsGarbage() {
        assertNull(Ota.parse("not json", ep))
        assertNull(Ota.parse("[]", ep))
        assertNull(Ota.parse("{}", ep))
    }

    @Test
    fun contentRange_mustStartAtResumePointAndMatchManifestSize() {
        // 正常续传：从 500 一直续到末尾 1233（total-1）。
        assertTrue(Ota.contentRangeOk("bytes 500-1233/1234", from = 500, total = 1234))
        assertTrue(Ota.contentRangeOk("Bytes 500-1233/1234", from = 500, total = 1234))
        // 开放区间请求的正确回答只有「到末尾」：截断的一段不算接上。
        assertFalse(Ota.contentRangeOk("bytes 500-999/1234", from = 500, total = 1234))
        assertFalse(Ota.contentRangeOk("bytes 500-1234/1234", from = 500, total = 1234)) // end >= total
        assertFalse(Ota.contentRangeOk("bytes 500-1232/1234", from = 500, total = 1234))
        // end < start、缺 end、负起点一律拒绝。
        assertFalse(Ota.contentRangeOk("bytes 500-499/1234", from = 500, total = 1234))
        assertFalse(Ota.contentRangeOk("bytes 500-/1234", from = 500, total = 1234))
        assertFalse(Ota.contentRangeOk("bytes -1-1233/1234", from = 500, total = 1234))
        // 起点不对（服务端从 0 开始、或给了别的段）：拒绝，不能接到残包后面。
        assertFalse(Ota.contentRangeOk("bytes 0-1233/1234", from = 500, total = 1234))
        assertFalse(Ota.contentRangeOk("bytes 600-1233/1234", from = 500, total = 1234))
        // 总长与 manifest 不符：拒绝（换了包/被代理改写）。
        assertFalse(Ota.contentRangeOk("bytes 500-999/1000", from = 500, total = 1234))
        // 未知总长、缺头、垃圾：一律拒绝。
        assertFalse(Ota.contentRangeOk("bytes 500-1233/*", from = 500, total = 1234))
        assertFalse(Ota.contentRangeOk(null, from = 500, total = 1234))
        assertFalse(Ota.contentRangeOk("items 500-1233/1234", from = 500, total = 1234))
        assertFalse(Ota.contentRangeOk("bytes abc/1234", from = 500, total = 1234))
    }

    // ── 3. 版本判定与安装候选 ────────────────────────────────────────────────

    @Test
    fun verdict_prefersIncompatibilityThenComparesCodes() {
        val m = Ota.parse(body(code = 7, minSdk = 31), ep)!!
        assertEquals(Ota.Verdict.Incompatible, Ota.verdict(m, 2, 26))
        assertEquals(Ota.Verdict.Newer, Ota.verdict(m, 2, 31))
        assertEquals(Ota.Verdict.Same, Ota.verdict(m, 7, 31))
        assertEquals(Ota.Verdict.Downgrade, Ota.verdict(m, 9, 31))
    }

    private fun candidate(
        manifest: Ota.Manifest = Ota.parse(body(), ep)!!,
        bytes: Long = 1234,
        hash: String = sha,
        archive: Ota.ArchiveFacts? = Ota.ArchiveFacts(Ota.PACKAGE, 7, setOf(signer)),
        installedCode: Long = 2,
        installedSigners: Set<String> = setOf(signer),
        installedPackage: String = Ota.PACKAGE,
    ) = Ota.Candidate(manifest, bytes, hash, archive, installedPackage, installedCode, installedSigners)

    private fun reason(c: Ota.Candidate): String = (Ota.checkInstall(c) as Ota.Check.Reject).reason

    @Test
    fun checkInstall_acceptsOnlyFullyConsistentCandidate() {
        assertTrue(Ota.checkInstall(candidate()) is Ota.Check.Ok)
        // 多签名（签名轮换）时也认：manifest 声明的那个必须在集合里，集合要与已装完全一致。
        val two = setOf(signer, "c".repeat(64))
        assertTrue(Ota.checkInstall(candidate(archive = Ota.ArchiveFacts(Ota.PACKAGE, 7, two), installedSigners = two)) is Ota.Check.Ok)
    }

    @Test
    fun checkInstall_rejectsLengthAndHashFirst() {
        assertEquals("size_mismatch", reason(candidate(bytes = 1233)))
        assertEquals("sha_mismatch", reason(candidate(hash = "d".repeat(64))))
    }

    @Test
    fun checkInstall_rejectsWrongPackageVersionOrDowngrade() {
        assertEquals("archive_unreadable", reason(candidate(archive = null)))
        assertEquals("package_mismatch", reason(candidate(archive = Ota.ArchiveFacts("com.other.app", 7, setOf(signer)))))
        assertEquals("version_mismatch", reason(candidate(archive = Ota.ArchiveFacts(Ota.PACKAGE, 6, setOf(signer)))))
        assertEquals("not_newer", reason(candidate(installedCode = 7)))
        assertEquals("target_package_mismatch", reason(candidate(installedPackage = "com.other.app")))
    }

    @Test
    fun checkInstall_rejectsSignerMismatchEvenWhenPackageAndVersionMatch() {
        // 同包名另一个签名：看着完全合法，必须被签名这一关挡住。
        assertEquals("signer_mismatch", reason(candidate(archive = Ota.ArchiveFacts(Ota.PACKAGE, 7, setOf("e".repeat(64))))))
        assertEquals("signer_unknown", reason(candidate(installedSigners = emptySet())))
        // manifest 声明了别的 signer：发布脚本写错也要早失败。
        val wrongSignerManifest = Ota.parse(body(signerValue = "f".repeat(64)), ep)!!
        assertEquals("signer_manifest_mismatch", reason(candidate(manifest = wrongSignerManifest)))
    }

    // ── 4. 状态机出口 ───────────────────────────────────────────────────────

    @Test
    fun noUpdateIsIdleNotFailure() {
        // 未发布（404）时界面是「暂无更新」，不是可重试的错误态。
        val s = Ota.noUpdate()
        assertEquals(Ota.Stage.Idle, s.stage)
        assertEquals("暂无更新", s.note)
        assertNull(s.manifest)
        assertNull(s.percent)
    }

    @Test
    fun states_neverStayInDownloadingAfterCancelOrFailure() {
        val m = Ota.parse(body(), ep)!!

        val downloading = Ota.onProgress(m, 500)
        assertEquals(Ota.Stage.Downloading, downloading.stage)
        assertEquals(40, downloading.percent) // 500/1234

        val cancelled = Ota.onCancel(m, 500)
        assertEquals(Ota.Stage.Available, cancelled.stage)
        assertTrue(cancelled.resumable)
        assertEquals(500L, cancelled.downloaded)

        val failed = Ota.onFailure(m, 500, "下载中断，可继续")
        assertEquals(Ota.Stage.Failed, failed.stage)
        assertEquals(500L, failed.downloaded)
        assertEquals("下载中断，可继续", failed.note)
    }

    @Test
    fun recover_mapsDiskBytesToResumableVerifyingOrFresh() {
        val m = Ota.parse(body(), ep)!!
        assertEquals(Ota.Stage.Available, Ota.recover(m, m.versionCode, m.size, 0).stage)
        val partial = Ota.recover(m, m.versionCode, m.size, 500)
        assertEquals(Ota.Stage.Available, partial.stage)
        assertTrue(partial.resumable)
        assertEquals(Ota.Stage.Verifying, Ota.recover(m, m.versionCode, m.size, m.size).stage)
        // 残量比 manifest 大（换了版本/脏文件）：回到干净的可下载态，不续传。
        val dirty = Ota.recover(m, m.versionCode, m.size, m.size + 1)
        assertEquals(0L, dirty.downloaded)
        // 记录的是别的版本：残量不算数。
        assertEquals(0L, Ota.recover(m, 6, m.size, 500).downloaded)
        assertEquals(Ota.Stage.Idle, Ota.recover(null, 0, 0, 0).stage)
    }

    @Test
    fun progressAndVerifyReachReadyOrFailedWithReason() {
        val m = Ota.parse(body(), ep)!!
        assertEquals(Ota.Stage.Verifying, Ota.onProgress(m, m.size).stage)
        assertEquals(Ota.Stage.Ready, Ota.onVerified(m, Ota.Check.Ok).stage)
        val bad = Ota.onVerified(m, Ota.Check.Reject("signer_mismatch"))
        assertEquals(Ota.Stage.Failed, bad.stage)
        assertEquals("signer_mismatch", bad.note)
        assertEquals(0L, bad.downloaded)
    }
}
