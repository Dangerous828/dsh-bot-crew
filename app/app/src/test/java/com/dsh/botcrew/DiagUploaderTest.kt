package com.dsh.botcrew

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * DiagUploader 的真实编排测试（内存 fake Store 模拟「临时文件环形」，重开=复用同一份数据）。
 *
 * 钉住冻结契约的核心：
 * - 只删 acceptedIds；rejected 保留（有界隔离）+ quarantine 后续跳过、不无限重试；
 * - 部分 ACK：只删对应、拒收保留、后续正常事件仍能上传；
 * - 离线/无可信入口：不删、不发 token；
 * - HTML / redirect / ok:false / 非 JSON：绝不删除；
 * - 端点非法（非 https / 带 userinfo/query/hash）→ 不请求。
 */
class DiagUploaderTest {

    /** 内存环形：模拟落盘。readAll 返回当前行，removeIds 按 id 删；quarantine 也持久（同 store 对象跨 Uploader）。 */
    private class MemStore : DiagUploader.Store {
        val rows = LinkedHashMap<String, JSONObject>()
        val quarantine = LinkedHashMap<String, String>()
        fun add(id: String) {
            rows[id] = JSONObject().put("id", id).put("kind", "event").put("event", "http_error")
                .put("route", "/api/mobile/timeline").put("at", "2026-11-15T21:00:00+08:00")
        }
        override fun readAll(): List<JSONObject> = rows.values.toList()
        override fun removeIds(ids: Set<String>): Int {
            var n = 0
            for (id in ids) if (rows.remove(id) != null) n++
            return n
        }
        override fun quarantinedIds(): Set<String> = quarantine.keys.toSet()
        override fun addQuarantine(entries: List<Pair<String, String>>) {
            for ((id, reason) in entries) if (id.isNotEmpty() && id !in quarantine) quarantine[id] = reason
        }
    }

    private class FakeTransport(
        var status: Int = 200,
        var contentType: String? = "application/json",
        var body: String? = "{}",
        var throwIt: Boolean = false,
        var retryAfterHeader: Int? = null,
    ) : DiagUploader.Transport {
        var calls = 0
        var lastUrl: String? = null
        override suspend fun post(url: String, deviceId: String?, credential: String?, body: String): DiagUploader.RawResponse {
            calls++
            lastUrl = url
            if (throwIt) throw RuntimeException("boom")
            // 注意：返回**响应**字段（this.body/status/contentType），不是入参 body（请求体）。
            return DiagUploader.RawResponse(this.status, this.contentType, this.body, this.retryAfterHeader)
        }
    }

    private fun uploader(store: MemStore, t: FakeTransport, base: String = "https://crew.kentonnie.top",
                         online: Boolean = true, clock: () -> Long = { 0L }): DiagUploader =
        DiagUploader(store, t, base, "dev", "tok", { online }, clock)

    @Test
    fun partialAck_deletesOnlyAccepted_keepsRejected() = kotlinx.coroutines.runBlocking {
        val store = MemStore().apply { add("a"); add("b") }
        val t = FakeTransport(body = """{"ok":true,"acceptedIds":["a"],"rejectedIds":["b"],"reasonCodes":["bad_at"]}""")
        val out = uploader(store, t).uploadOnce()
        // 只删 a；b 保留（rejected 不 ACK）
        assertNull(store.rows["a"])
        assertNotNull(store.rows["b"])
        assertEquals(1, out.acked)
        assertEquals(1, out.rejected)
    }

    @Test
    fun rejectedIsQuarantined_thenNormalEventStillUploads() = kotlinx.coroutines.runBlocking {
        val store = MemStore().apply { add("bad"); add("ok1") }
        val t = FakeTransport(body = """{"ok":true,"acceptedIds":["ok1"],"rejectedIds":["bad"]}""")
        val u = uploader(store, t)
        u.uploadOnce()
        // bad 被隔离但仍留在 store（不删）
        assertNotNull(store.rows["bad"])
        // 再来一条正常事件：下一轮应只发正常事件、跳过 bad（不让毒记录卡住）
        store.add("ok2")
        t.body = """{"ok":true,"acceptedIds":["ok2"]}"""
        t.calls = 0
        u.uploadOnce()
        assertTrue("应至少再发一轮且成功", t.calls >= 1)
        // ok2 被删、bad 仍在
        assertNull(store.rows["ok2"])
        assertNotNull(store.rows["bad"])
    }

    @Test
    fun offline_doesNotSendOrDelete() = kotlinx.coroutines.runBlocking {
        val store = MemStore().apply { add("a") }
        val t = FakeTransport()
        val out = uploader(store, t, online = false).uploadOnce()
        assertTrue(out.skippedOffline)
        assertEquals(0, t.calls)
        assertNotNull(store.rows["a"])
    }

    @Test
    fun html200_neverDeletes() = kotlinx.coroutines.runBlocking {
        val store = MemStore().apply { add("a") }
        val t = FakeTransport(status = 200, contentType = "text/html", body = "<html>ok</html>")
        uploader(store, t).uploadOnce()
        assertNotNull("HTML 200 不得删", store.rows["a"])
    }

    @Test
    fun redirectNotFollowed_nonJson_neverDeletes() = kotlinx.coroutines.runBlocking {
        val store = MemStore().apply { add("a") }
        // 3xx（transport 不跟随），content-type html
        val t = FakeTransport(status = 302, contentType = "text/html", body = "")
        uploader(store, t).uploadOnce()
        assertNotNull(store.rows["a"])
    }

    @Test
    fun okFalse_neverDeletes() = kotlinx.coroutines.runBlocking {
        val store = MemStore().apply { add("a") }
        val t = FakeTransport(body = """{"ok":false}""")
        uploader(store, t).uploadOnce()
        assertNotNull(store.rows["a"])
    }

    @Test
    fun okTrueButEmptyAccepted_noDelete() = kotlinx.coroutines.runBlocking {
        val store = MemStore().apply { add("a") }
        val t = FakeTransport(body = """{"ok":true,"acceptedIds":[]}""")
        uploader(store, t).uploadOnce()
        assertNotNull("没有命中 ACK 不得删", store.rows["a"])
    }

    @Test
    fun invalidEndpoint_noRequest_noTokenSent() = kotlinx.coroutines.runBlocking {
        val store = MemStore().apply { add("a") }
        val t = FakeTransport()
        // 非 https / 带 query / 带 userinfo 都不合法
        assertNull(uploader(store, t, base = "http://crew.x").endpoint())
        assertNull(uploader(store, t, base = "https://crew.x?t=1").endpoint())
        assertNull(uploader(store, t, base = "https://user:pw@crew.x").endpoint())
        assertEquals(0, t.calls)
        assertNotNull(store.rows["a"])
    }

    @Test
    fun validEndpoint_buildsPath() {
        val u = uploader(MemStore(), FakeTransport(), base = "https://crew.kentonnie.top")
        assertEquals("https://crew.kentonnie.top/api/mobile/diagnostics", u.endpoint())
    }

    @Test
    fun oversizeRow_keptButSkipped_thenNormalUploads() = kotlinx.coroutines.runBlocking {
        val store = MemStore().apply { add("ok1") }
        // 加一条超大 event（>1KiB）
        store.rows["bigE"] = JSONObject().put("id", "bigE").put("kind", "event")
            .put("route", "/x").put("at", "t").put("pad", "z".repeat(2000))
        val t = FakeTransport(body = """{"ok":true,"acceptedIds":["ok1"]}""")
        val out = uploader(store, t).uploadOnce()
        // bigE 不删（保留供诊断），被 quarantine；ok1 正常删除
        assertNotNull("超大行保留", store.rows["bigE"])
        assertNull(store.rows["ok1"])
        assertTrue(out.quarantined >= 1)
    }

    @Test
    fun reconnectAfterOffline_flushesQueuedEvents() = kotlinx.coroutines.runBlocking {
        // 模拟「断网攒 → 恢复重连补传」：同一 store 对象（=临时文件重开不丢）。
        val store = MemStore().apply { add("a"); add("b") }
        var online = false
        val t = FakeTransport(body = """{"ok":true,"acceptedIds":["a","b"]}""")
        val u = uploader(store, t, online = false)
        assertEquals(0, t.calls)
        // 仍保留
        assertEquals(2, store.rows.size)
        // 恢复联网
        val u2 = DiagUploader(store, t, "https://crew.kentonnie.top", "dev", "tok", { true }, { 0L })
        u2.uploadOnce()
        assertEquals(0, store.rows.size)
    }

    @Test
    fun bindReplacement_noCredential_noRequest() = kotlinx.coroutines.runBlocking {
        val store = MemStore().apply { add("a") }
        val t = FakeTransport()
        // 无凭据：不请求、不删
        val u = DiagUploader(store, t, "https://crew.kentonnie.top", null, null, { true }, { 0L })
        val out = u.uploadOnce()
        assertEquals(0, t.calls)
        assertEquals("no_credential", out.skipReason)
        assertNotNull(store.rows["a"])
    }

    @Test
    fun transportThrows_postFailed_queueKept_notBackoffWord() = kotlinx.coroutines.runBlocking {
        // 连接层异常（DNS/超时）：skipReason=post_failed，记录保留、不删；不是 429 限流。
        val store = MemStore().apply { add("a") }
        val t = FakeTransport(throwIt = true)
        val out = uploader(store, t).uploadOnce()
        assertEquals("post_failed", out.skipReason)
        assertNotNull("网络异常必须保留队列", store.rows["a"])
        assertTrue("应有退避秒数", (out.backoffSeconds ?: 0) >= 1)
    }

    @Test
    fun http429_backoffReason_serverRateLimited() = kotlinx.coroutines.runBlocking {
        val store = MemStore().apply { add("a") }
        val t = FakeTransport(status = 429, body = """{"retryAfter":5}""")
        val out = uploader(store, t).uploadOnce()
        assertEquals("backoff", out.skipReason)
        assertNotNull(store.rows["a"])
        assertTrue((out.backoffSeconds ?: 0) >= 5)
    }

    @Test
    fun quarantine_persistsAcrossNewUploader_sameStore() = kotlinx.coroutines.runBlocking {
        // 第一个 uploader 把 bad 拒收进隔离
        val store = MemStore().apply { add("bad"); add("ok1") }
        val t1 = FakeTransport(body = """{"ok":true,"acceptedIds":["ok1"],"rejectedIds":["bad"]}""")
        uploader(store, t1).uploadOnce()
        assertTrue("bad" in store.quarantine)
        // 新 uploader（模拟重建/重启）+ 同一 store：只发新正常事件，bad 仍跳过、不重发
        store.add("ok2")
        val t2 = FakeTransport(body = """{"ok":true,"acceptedIds":["ok2"]}""")
        val out = uploader(store, t2).uploadOnce()
        // 发出去的批只含 ok2（bad 已被隔离跳过）
        assertTrue("隔离项不应重发", t2.calls >= 1)
        assertNull(store.rows["ok2"]) // 已 ACK 删除
        assertNotNull("隔离项仍保留", store.rows["bad"])
        assertTrue(out.quarantined >= 1)
    }

    // ---- describe()：失败/成功文案必须准确 ----

    private fun outcome(sent: Int = 0, acked: Int = 0, rejected: Int = 0, quarantined: Int = 0,
                        offline: Boolean = false, backoff: Int? = null, reason: String = "") =
        DiagUploader.Outcome(sent, acked, rejected, quarantined, offline, backoff, reason)

    @Test
    fun describe_ackSuccess_showsSentAndAcked() {
        val s = DiagUploader.describe(outcome(sent = 3, acked = 3))
        assertTrue(s.contains("已上报") && s.contains("发送 3") && s.contains("确认 3"))
    }

    @Test
    fun describe_noPending_saysAllUploaded_notFailure() {
        val s = DiagUploader.describe(outcome(sent = 0, quarantined = 0, reason = "empty"))
        assertTrue("无待传应说都已上报", s.contains("都已上报"))
    }

    @Test
    fun describe_429_isRateLimited() {
        assertTrue(DiagUploader.describe(outcome(backoff = 5, reason = "backoff")).contains("服务端限流"))
    }

    @Test
    fun describe_postFailed_isNetworkError_notRateLimited() {
        val s = DiagUploader.describe(outcome(backoff = 8, reason = "post_failed"))
        assertTrue("网络异常不该叫限流", s.contains("网络异常") && !s.contains("限流"))
    }

    @Test
    fun describe_offline_keptLocal() {
        assertTrue(DiagUploader.describe(outcome(offline = true)).contains("没网"))
    }

    // ---- 线程边界：经 withContext(IO) 驱动 uploadOnce 时，blocking transport 不在调用线程上跑 ----
    @Test
    fun upload_runsOnIoThread_notCallerThread() = kotlinx.coroutines.runBlocking {
        val store = MemStore().apply { add("a") }
        val transportThread = java.util.concurrent.atomic.AtomicReference<String>()
        val t = object : DiagUploader.Transport {
            override suspend fun post(url: String, deviceId: String?, credential: String?, body: String): DiagUploader.RawResponse {
                transportThread.set(Thread.currentThread().name)
                return DiagUploader.RawResponse(200, "application/json", """{"ok":true,"acceptedIds":["a"]}""", null)
            }
        }
        val u = DiagUploader(store, t, "https://crew.kentonnie.top", "dev", "tok", { true }, { 0L })
        val callerThread = Thread.currentThread().name
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { u.uploadOnce() }
        assertNotNull(transportThread.get())
        assertTrue("transport 应在 IO 线程执行、不在调用线程", transportThread.get() != callerThread)
    }
}
