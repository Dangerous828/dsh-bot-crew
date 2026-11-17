package com.dsh.botcrew

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 独立契约 review 的**差分**测试（task-15）。只钉 owner 现有单测
 * （DiagUploaderTest / DiagAckTest / RoutePolicyTest / ClientDiagTest / BootstrapGateTest）
 * 未覆盖的缝；不镜像其用例、不改产品源码。纯 JVM（无 Android）。
 *
 * 覆盖差集：
 *  A. 传输层抛异常（DNS/连接/超时）→ uploadOnce 的 Outcome：skipReason="post_failed" 且 backoffSeconds>0；
 *     ——owner `FakeTransport.throwIt` 定义了却没用过，这条 Outcome 未被任何测试钉住。
 *     它正是 `DiagRuntime.uploadNow` 文案分支的依据（网络失败 ≠ 429 限流）。
 *  B. 429（HTTP）→ Outcome skipReason="backoff"（与 A 可区分）。
 *  C. 蜂窝 + 可信 public 已排到最前（lead=public）时，按 lead 口径 public 已是起手、**不应再冗余短探**；
 *     当前实现 `plan.quickProbePublic=true`（且 owner RoutePolicyTest 断言 true）→ 本用例按 lead 冻结口径断言 false，
 *     **当前会红**，作为「实现 vs lead 规格」差异记录，由 owner/lead 裁决（非我改源码）。
 */
class DiagContractReviewTest {

    /** 与 owner 同款内存环形的极简替身（这里自建，不 import owner 测试，避免耦合）。 */
    private class MemStore : DiagUploader.Store {
        val rows = LinkedHashMap<String, JSONObject>()
        fun add(id: String) {
            rows[id] = JSONObject()
                .put("id", id).put("kind", "event").put("at", "2026-11-15T10:00:00+08:00")
                .put("event", "net_fail").put("route", "/api/mobile/timeline")
        }
        override fun readAll(): List<JSONObject> = rows.values.toList()
        override fun removeIds(ids: Set<String>): Int {
            var n = 0
            for (id in ids) if (rows.remove(id) != null) n++
            return n
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
        override suspend fun post(url: String, deviceId: String?, credential: String?, body: String): DiagUploader.RawResponse {
            calls++
            if (throwIt) throw RuntimeException("boom-dns-connect")
            return DiagUploader.RawResponse(status, contentType, body, retryAfterHeader)
        }
    }

    private fun uploader(store: DiagUploader.Store, t: DiagUploader.Transport, online: Boolean = true) =
        DiagUploader(store, t, "https://crew.kentonnie.top", "dev", "tok", { online }, { 0L })

    // ── A. 传输异常 → post_failed（网络失败，非限流）──────────────────
    @Test
    fun transportThrow_isPostFailedWithBackoff_notRateLimit() = kotlinx.coroutines.runBlocking {
        val store = MemStore().apply { add("a") }
        val t = FakeTransport(throwIt = true)
        val o = uploader(store, t).uploadOnce()
        // 网络/DNS/连接失败：明确是 post_failed（不是 429 的 "backoff"），且已进入退避窗口。
        assertEquals("post_failed", o.skipReason)
        assertNotNull("传输异常应给出退避秒数", o.backoffSeconds)
        assertTrue("退避秒数应 > 0", (o.backoffSeconds ?: 0) > 0)
        // 本地记录一条都不能删（没 ACK）。
        assertEquals(1, store.rows.size)
        assertEquals(1, t.calls)
    }

    // ── B. 429 → backoff（可区分）────────────────────────────────────
    @Test
    fun http429_isBackoffReason_distinctFromNetworkFailure() = kotlinx.coroutines.runBlocking {
        val store = MemStore().apply { add("a") }
        val t = FakeTransport(status = 429, contentType = "application/json", body = "{\"retryAfter\":7}")
        val o = uploader(store, t).uploadOnce()
        assertEquals("backoff", o.skipReason)
        assertTrue((o.backoffSeconds ?: 0) > 0)
        assertEquals(1, store.rows.size) // 429 不删
    }

    // ── C. lead 最终不变量：public first → 不重复 preprobe ─────────────
    @Test
    fun cellularWithPublicAlreadyLead_noRedundantQuickProbe_perLeadSpec() {
        val p2p = "p2p:1"; val lan = "http://192.168.1.9:43499"; val pub = "https://crew.kentonnie.top"
        val kind: (String) -> RoutePolicy.Kind = {
            when (it) { p2p -> RoutePolicy.Kind.P2P; lan -> RoutePolicy.Kind.LAN; pub -> RoutePolicy.Kind.PUBLIC; else -> RoutePolicy.Kind.UNKNOWN }
        }
        // 蜂窝：健康证据已被 onNetworkChanged 清空。
        val plan = RoutePolicy.plan(listOf(p2p, lan, pub), kind, { null }, now = 0L, networkKind = "cellular")
        assertEquals("公网应被提到起手位", pub, plan.order.first())
        // lead 最终不变量：PUBLIC 已排首位 → 直接真实业务请求即探测，不再对同一 public 额外 quickProbe
        // （避免同一入口无必要双 HTTP、真实 LTE 多一次 RTT）。未知 LAN/P2P leading 需跳 public 时仍可 quickProbe。
        assertFalse("public first 不得重复 preprobe（lead 裁决不变量）", plan.quickProbePublic)
        // 蜂窝冷启动 public 短 connect；LAN/P2P 作后备短档。
        assertEquals(RoutePolicy.SHORT_CONNECT_MS, plan.connectTimeoutFor[lan])
    }

    // ══ 真实 tmp 文件：store↔uploader 持久隔离的端到端缝（owner DiagRingStoreFileTest 只测 store 单边）══
    // 直用 DiagRingStore 的 internal File 构造器（同 module 测试可见）+ 真实 DiagUploader，
    // 复现 lead 指出的「重新 bind / App 重启后忘拒收」缝。

    private fun tmpDir(): java.io.File = java.nio.file.Files.createTempDirectory("diagreview").toFile()
    private fun crow(id: String): JSONObject = JSONObject()
        .put("id", id).put("kind", "event").put("at", "2026-11-15T21:00:00+08:00")
        .put("event", "http_error").put("route", "/api/mobile/timeline")

    /** 计数 transport：把每次 post 的 body 里出现的 id 记下来，供断言「跨实例是否又重投了隔离项」。 */
    private class CountingTransport(var resp: DiagUploader.RawResponse) : DiagUploader.Transport {
        val sentIds = ArrayList<String>()
        override suspend fun post(url: String, deviceId: String?, credential: String?, body: String): DiagUploader.RawResponse {
            val root = org.json.JSONObject(body)
            val arr = root.optJSONArray("batch")
            if (arr != null) for (i in 0 until arr.length()) sentIds.add(arr.getJSONObject(i).optString("id"))
            return resp
        }
    }

    // D. 新实例（模拟 App 重启 / uploader 重新 bind）必须**从磁盘**记得隔离项、不再重投它；
    //    同时普通新事件仍能上报（隔离不毒阻后续）。
    @Test
    fun uploaderOnNewInstance_skipsPersistedQuarantine_butUploadsNewOnes() = kotlinx.coroutines.runBlocking {
        val dir = tmpDir()
        try {
            // 实例 1：写一行并持久隔离 bad
            val s1 = DiagRingStore(dir)
            s1.append(crow("bad")); s1.append(crow("good"))
            s1.addQuarantine(listOf("bad" to "rejected"))

            // 实例 2（= 重启后新 uploader 绑同一目录）：server 全 ACK。
            val t = CountingTransport(DiagUploader.RawResponse(200, "application/json",
                "{\"ok\":true,\"acceptedIds\":[\"good\"],\"rejectedIds\":[]}"))
            val s2 = DiagRingStore(dir)
            val u = DiagUploader(s2, t, "https://crew.kentonnie.top", "dev", "tok", { true }, { 0L })
            u.uploadOnce()

            // 关键：隔离项 bad 不得出现在任何重投批次（跨实例记得）；普通 good 正常上报。
            assertFalse("重启后不得再重投已隔离的 bad", "bad" in t.sentIds)
            assertTrue("普通新事件应正常上报", "good" in t.sentIds)
        } finally { dir.deleteRecursively() }
    }

    // E. 隔离集有界：加超过 MAX_QUARANTINE → 落盘封顶不无界。
    @Test
    fun quarantine_isBoundedByMax() {
        val dir = tmpDir()
        try {
            val s = DiagRingStore(dir)
            val many = (0 until DiagRingStore.MAX_QUARANTINE + 120).map { "q$it" to "rejected" }
            s.addQuarantine(many)
            val q = DiagRingStore(dir).quarantinedIds()
            assertTrue("隔离集不得无界：实际=${q.size} 上限=${DiagRingStore.MAX_QUARANTINE}",
                q.size <= DiagRingStore.MAX_QUARANTINE)
        } finally { dir.deleteRecursively() }
    }

    // F. ring 淘汰某 id 后，隔离集对应项被 prune（不留无主隔离项）。
    //    注意：prune 在 trimLocked（ring 超限触发）里跑——所以这里必须让 ring 真正溢出才触发，不能靠小规模 append。
    //    该「prune 仅在 ring 溢出路径」本身是设计（cap 已兜住有界性）；本用例只验证溢出淘汰时确实 prune。
    @Test
    fun quarantine_orphanPrunedAfterRingEviction() {
        val dir = tmpDir()
        try {
            val s = DiagRingStore(dir)
            s.append(crow("orphan"))
            s.addQuarantine(listOf("orphan" to "rejected"))
            assertTrue("orphan" in DiagRingStore(dir).quarantinedIds())
            // 让 ring 溢出 MAX_ROWS，触发 trim→prune；orphan 仍在 ring 里会被保留，故先删 orphan 再溢出。
            s.removeIds(setOf("orphan"))
            for (i in 0 until DiagRingStore.MAX_ROWS + 20) s.append(crow("f$i"))
            assertFalse("ring 已无 orphan，溢出 trim 时应 prune 掉该隔离项", "orphan" in DiagRingStore(dir).quarantinedIds())
        } finally { dir.deleteRecursively() }
    }
}
