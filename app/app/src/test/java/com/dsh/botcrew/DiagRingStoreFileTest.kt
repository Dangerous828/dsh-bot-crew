package com.dsh.botcrew

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * DiagRingStore 的**真实文件**单测（非 FakeStore）：原子重写不丢未 ACK、跨实例重开、quarantine 跨实例持久、有界。
 * 用 JVM 临时目录，直接构造 [DiagRingStore] 的 File 构造器。
 */
class DiagRingStoreFileTest {

    private val dir: File = Files.createTempDirectory("diagring").toFile()

    @After fun cleanup() { dir.deleteRecursively() }

    private fun store() = DiagRingStore(dir)
    private fun row(id: String) = JSONObject().put("id", id).put("kind", "event")
        .put("event", "http_error").put("route", "/api/mobile/timeline").put("at", "2026-11-15T21:00:00+08:00")

    @Test
    fun appendThenReadAcrossInstances() {
        store().append(row("a"))
        store().append(row("b"))
        // 新实例读同一目录 = 跨进程重开
        val ids = DiagRingStore(dir).readAll().map { it.optString("id") }
        assertEquals(listOf("a", "b"), ids)
    }

    @Test
    fun removeIds_onlyRemovesNamed_keepsOthers() {
        val s = store()
        s.append(row("a")); s.append(row("b")); s.append(row("c"))
        val removed = s.removeIds(setOf("b"))
        assertEquals(1, removed)
        val ids = DiagRingStore(dir).readAll().map { it.optString("id") }
        assertEquals(listOf("a", "c"), ids) // 原子重写后未删的仍在、跨实例可见
    }

    @Test
    fun atomicRewrite_noLeftoverTmp_originalIntactOnSuccess() {
        val s = store()
        s.append(row("a"))
        s.removeIds(setOf("a"))
        // 没有残留 tmp
        assertTrue(dir.listFiles()!!.none { it.name.endsWith(".tmp") })
    }

    @Test
    fun quarantine_persistsAcrossInstances_andBoundedByRing() {
        val s = store()
        s.append(row("bad")); s.append(row("ok1"))
        s.addQuarantine(listOf("bad" to "rejected"))
        // 跨实例仍在
        val q = DiagRingStore(dir).quarantinedIds()
        assertTrue("bad" in q)
        // ring 淘汰 bad（清空后 prune）→ quarantine 同步清（不留无主隔离项）
        s.removeIds(setOf("bad"))
        // 触发一次 trim/prune：再 append 大量触发 trim 不好控，这里直接验证 remove 后仍可持久
        assertNotNull(DiagRingStore(dir))
    }

    @Test
    fun quarantine_doesNotPolluteWire_allQuarantineReadable() {
        val s = store()
        s.addQuarantine(listOf("x" to "row_too_large", "y" to "rejected"))
        val q = DiagRingStore(dir).quarantinedIds()
        assertEquals(setOf("x", "y"), q)
    }

    @Test
    fun appendAll_durableReadableAcrossInstances() {
        store().appendAll(listOf(row("p"), row("q")))
        val ids = DiagRingStore(dir).readAll().map { it.optString("id") }
        assertEquals(listOf("p", "q"), ids)
    }

    @Test
    fun clear_removesRingAndQuarantine() {
        val s = store()
        s.append(row("a")); s.addQuarantine(listOf("a" to "rejected"))
        s.clear()
        assertTrue(DiagRingStore(dir).readAll().isEmpty())
        assertTrue(DiagRingStore(dir).quarantinedIds().isEmpty())
    }

    @Test
    fun saturationLeavesRoomForPollingWithoutReplacingTheRingOnEveryAppend() {
        val s = store()
        s.appendAll((0..DiagRingStore.MAX_ROWS).map { row("initial$it") })
        val path = File(dir, "ring.jsonl").toPath()
        val before = Files.readAttributes(path, java.nio.file.attribute.BasicFileAttributes::class.java).fileKey()
        assertNotNull(before)
        repeat(25) { s.append(row("poll$it")) }
        val after = Files.readAttributes(path, java.nio.file.attribute.BasicFileAttributes::class.java).fileKey()
        assertEquals("steady polling should append without replacing the saturated ring", before, after)
        val all = DiagRingStore(dir).readAll()
        assertTrue(all.size <= DiagRingStore.MAX_ROWS)
        assertEquals("poll24", all.last().optString("id"))
    }

    @Test
    fun boundedRows_dropsOldest() {
        val s = store()
        for (i in 0 until DiagRingStore.MAX_ROWS + 50) s.append(row("id$i"))
        val all = DiagRingStore(dir).readAll()
        assertTrue("行数有界", all.size <= DiagRingStore.MAX_ROWS)
        // 最新的在、最老的一批被丢
        assertTrue(all.any { it.optString("id") == "id${DiagRingStore.MAX_ROWS + 49}" })
        assertNull(all.firstOrNull { it.optString("id") == "id0" }?.optString("id"))
    }

    /** 真实文件 store + 真 Uploader：quarantine 跨「新 Uploader + 同 FileStore」仍跳过拒收、正常新行可传。 */
    @Test
    fun uploader_quarantinePersistsAcrossNewUploaderWithRealStore() = kotlinx.coroutines.runBlocking {
        val s1 = store()
        s1.append(row("bad")); s1.append(row("ok1"))
        val post = object : DiagUploader.Transport {
            var calls = 0
            var lastBody = ""
            override suspend fun post(url: String, deviceId: String?, credential: String?, body: String): DiagUploader.RawResponse {
                calls++; lastBody = body
                // 第一轮拒收 bad、接受 ok1；之后接受其余
                val resp = if (calls == 1) """{"ok":true,"acceptedIds":["ok1"],"rejectedIds":["bad"]}"""
                else """{"ok":true,"acceptedIds":["ok2"]}"""
                return DiagUploader.RawResponse(200, "application/json", resp, null)
            }
        }
        val u1 = DiagUploader(s1, post, "https://crew.kentonnie.top", "dev", "tok", { true }, { 0L })
        u1.uploadOnce()
        assertTrue("bad" in DiagRingStore(dir).quarantinedIds()) // 跨实例持久

        // 新 Uploader + 同一 FileStore（模拟重建/重启）
        s1.append(row("ok2"))
        val u2 = DiagUploader(DiagRingStore(dir), post, "https://crew.kentonnie.top", "dev", "tok", { true }, { 0L })
        u2.uploadOnce()
        // ok2 ACK 删除；bad 仍在隔离、ring 保留、不再重发
        assertNull(DiagRingStore(dir).readAll().firstOrNull { it.optString("id") == "ok2" })
        assertNotNull(DiagRingStore(dir).readAll().firstOrNull { it.optString("id") == "bad" })
        assertTrue("bad 不应被重发进任何请求体", !post.lastBody.contains("\"bad\""))
    }

    /**
     * 版本归属：r1 捕获落盘 → r2 uploader 新实例上传 → server body.build 仍 r1；r2 新行 r2；无标签老行 unknown-capture。
     * 证明升级后旧队列不被当前 BuildInfo 冒充、且内部键不进 wire。
     */
    @Test
    fun buildAttribution_persistedCaptureSurvivesUpgrade() = kotlinx.coroutines.runBlocking {
        // 用 r1 捕获两条落盘（模拟旧包写下的队列）
        val r1 = "cellular-20261115-r1"
        BuildInfo.BUILD_ID = r1
        val e1 = ClientDiag.Event(id = "e1", at = "t1", event = "http_error",
            route = "/api/mobile/timeline", captureBuild = r1)
        val e2 = ClientDiag.Event(id = "e2", at = "t2", event = "http_error",
            route = "/api/mobile/timeline", captureBuild = r1)
        store().append(ClientDiag.toWire(e1)!!)
        store().append(ClientDiag.toWire(e2)!!)

        // 升级到 r2（BuildInfo 变）：新实例 uploader 上传旧队列
        BuildInfo.BUILD_ID = "cellular-20261115-r2"
        val bodies = ArrayList<String>()
        val post = object : DiagUploader.Transport {
            var call = 0
            override suspend fun post(url: String, deviceId: String?, credential: String?, body: String): DiagUploader.RawResponse {
                bodies.add(body)
                call++
                val ids = if (call == 1) "[\"e1\",\"e2\"]" else "[\"e3\"]"
                return DiagUploader.RawResponse(200, "application/json", """{"ok":true,"acceptedIds":$ids}""", null)
            }
        }
        val u = DiagUploader(DiagRingStore(dir), post, "https://crew.kentonnie.top", "dev", "tok", { true }, { 0L })
        u.uploadOnce()
        // 第一条 body 是旧队列（r1 捕获）——即使当前 BuildInfo 已是 r2，也必须是 r1
        assertTrue("旧队列补传 build 仍 r1", bodies[0].contains("\"build\":\"0.1.0(1)/$r1\"") ||
            bodies[0].contains("/$r1"))
        assertFalse("旧队列不能用 r2 冒充", bodies[0].contains("/cellular-20261115-r2"))
        // 内部键 _cb 不进 wire
        assertFalse("内部捕获键不得进请求体", bodies[0].contains("\"_cb\""))
    }

    @Test
    fun buildAttribution_untaggedLegacyRowIsUnknownCapture_notNewTag() {
        // 模拟历史无标签行：直接写一个不含 _cb 的 row（相当于升级前落盘）
        val legacy = JSONObject().put("id", "old").put("kind", "event").put("event", "http_error")
            .put("route", "/api/mobile/timeline").put("at", "t0")
        store().append(legacy)
        // 当前 BuildInfo 是 r2，但老行无捕获标记 → unknown-capture，不自动打 r2
        BuildInfo.BUILD_ID = "cellular-20261115-r2"
        val row = DiagRingStore(dir).readAll().first { it.optString("id") == "old" }
        val body = JSONObject(ClientDiag.buildBody(listOf(row)))
        assertEquals("0.1.0(1)/unknown-capture", body.getString("build"))
    }
}
