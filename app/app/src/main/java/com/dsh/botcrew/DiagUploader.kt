package com.dsh.botcrew

import org.json.JSONObject

/**
 * 把本地环形里的事件**批量补传**到 `POST /api/mobile/diagnostics`。
 *
 * ## 只删 acceptedIds（冻结契约）
 *
 * 服务端 ACK 只对 `acceptedIds` 成立；`rejectedIds`（坏记录）与本地超限的单条**不删**——
 * 它们是「有界隔离/失败态」，保留供诊断页查看导出。为免毒记录无限重试，用一个进程内
 * **quarantine 集合**记住这些 id，后续批次自动跳过（不删、不再发），普通新事件照常上报。
 *
 * ## 上传入口校验（不硬编码域名、不给别的 crew 送 token）
 *
 * 取不到合法上传地址（非 HTTPS / 带 userinfo/query/hash / 空）→ 不上报、不发 token。
 * 地址必须来自已登记同 crew 的 serverPublicBase / 验证过的 fallback HTTPS，或注入且 crew 匹配的 DIAG_BASE。
 * 端点校验在 [Transport] 调用**之前**做。
 *
 * ## 不递归
 *
 * 上传走独立 [Transport]（HttpURLConnection），不经 `ClientDiag` 记录点 / `CrewClient.read()`，
 * 故上传请求不进环形、不自我循环上报。
 *
 * ## 线程
 *
 * [uploadOnce] 是 `suspend`，编排单飞由 [DiagRuntime] 的 Mutex 保证；这里不自开线程。纯逻辑用假 Transport + 假时钟单测。
 */
class DiagUploader(
    private val store: Store,
    private val transport: Transport,
    /** 上传地址（完整 URL，不含 path）。**必须** 经 [validEndpoint] 校验；空/非法→不上报。 */
    private val baseUrl: String,
    private val deviceId: String?,
    private val credential: String?,
    /** 当前网络是否可用。断网时不发（`false`）。 */
    private val online: () -> Boolean,
    /** 现在（毫秒），注入以便测退避。 */
    private val clock: () -> Long = { System.currentTimeMillis() },
) {

    /**
     * 环形存储的最小接口。抽出来是为了让上传编排能在 JVM 单测里跑（真实现 [DiagRingStore] 需要 Android Context）。
     * quarantine 也走它持久化——隔离状态跨进程/上传器重建仍在，不靠内存 set。
     */
    interface Store {
        fun readAll(): List<JSONObject>
        fun removeIds(ids: Set<String>): Int
        /** 当前持久隔离的 id 集（跨进程/重建仍在）。默认空（纯 FakeStore 可只实现 ring）。 */
        fun quarantinedIds(): Set<String> = emptySet()
        /** 把一批 (id, reasonCode) 持久记入隔离集。默认空操作。 */
        fun addQuarantine(entries: List<Pair<String, String>>) {}
    }

    /** 传输层：发一批，回一个原始应答。[Status] -1 表示连接层失败。 */
    interface Transport {
        suspend fun post(url: String, deviceId: String?, credential: String?, body: String): RawResponse
    }

    data class RawResponse(val status: Int, val contentType: String?, val body: String?, val retryAfterHeader: Int? = null)

    /** 一次上报的结果，给诊断页显示用。 */
    data class Outcome(
        val sent: Int,
        val acked: Int,
        val rejected: Int,
        val quarantined: Int,
        val skippedOffline: Boolean,
        val backoffSeconds: Int?,
        val skipReason: String = "",
    )

    private var backoffUntil = 0L
    private var attempt = 0
    /** 现在是否还在退避窗口里（诊断页/循环用）。 */
    fun inBackoff(): Boolean = clock() < backoffUntil

    /**
     * 跑一轮：把当前环形里能发的都尽量发掉。断网、退避中、或上传地址非法时直接跳过（不发 token）。
     *
     * 隔离（quarantine）状态**持久在 store**（不是内存 set）：跨上传器重建/进程重启仍跳过拒收毒记录，
     * 正常新行照常上报。每轮最多连发 [MAX_BATCHES_PER_ROUND] 批；任一批失败/429 就停，等下一轮。
     */
    suspend fun uploadOnce(maxBatches: Int = MAX_BATCHES_PER_ROUND): Outcome {
        if (!online()) return Outcome(0, 0, 0, 0, skippedOffline = true, backoffSeconds = null)
        if (inBackoff()) return Outcome(0, 0, 0, 0, false, ((backoffUntil - clock()) / 1000).toInt().coerceAtLeast(1), "backoff")

        // 上传入口必须在发 token 前校验；非法直接不上报（不给陌生 host 送凭据）。
        val ep = endpoint()
        if (ep == null) return Outcome(0, 0, 0, 0, false, null, "no_valid_endpoint")
        if (deviceId.isNullOrBlank() || credential.isNullOrBlank()) {
            return Outcome(0, 0, 0, 0, false, null, "no_credential")
        }

        // 隔离 id 从 store 持久读（跨进程/重建都在）。
        val quarantine = store.quarantinedIds()
        val rows = store.readAll().filter { it.optString("id").isNotEmpty() && it.optString("id") !in quarantine }
        if (rows.isEmpty()) return Outcome(0, 0, 0, quarantine.size, false, null, "empty")

        val plan = ClientDiag.planBatches(rows)
        // 本地超限的单条：不删（保留供诊断），持久记入隔离集，后续跳过。
        if (plan.oversizeIds.isNotEmpty()) {
            store.addQuarantine(plan.oversizeIds.map { it to "row_too_large" })
        }

        var sent = 0
        var acked = 0
        var rejected = 0
        var batchesDone = 0
        for (batch in plan.batches) {
            if (batchesDone >= maxBatches) break
            val sentIds = batch.mapNotNull { it.optString("id").takeIf { id -> id.isNotEmpty() } }.toSet()
            if (sentIds.isEmpty()) continue
            val body = ClientDiag.buildBody(batch)
            val raw = try {
                transport.post(ep, deviceId, credential, body)
            } catch (t: Throwable) {
                scheduleBackoff(null)
                return Outcome(sent, acked, rejected, store.quarantinedIds().size, false, ((backoffUntil - clock()) / 1000).toInt().coerceAtLeast(1), "post_failed")
            }
            sent += batch.size
            val result = DiagAck.parse(raw.status, raw.contentType, raw.body, sentIds)
            val effectiveRetry = result.retryAfterSeconds ?: raw.retryAfterHeader

            // 只删 acceptedIds —— rejected 保留（有界隔离），持久记入 quarantine 后续跳过。
            if (result.ackedIds.isNotEmpty()) {
                store.removeIds(result.ackedIds)
                acked += result.ackedIds.size
            }
            if (result.rejectedIds.isNotEmpty()) {
                store.addQuarantine(result.rejectedIds.map { it to "rejected" })
                rejected += result.rejectedIds.size
            }
            val qSize = store.quarantinedIds().size

            if (result.shouldBackoff) {
                scheduleBackoff(effectiveRetry)
                return Outcome(sent, acked, rejected, qSize, false, ((backoffUntil - clock()) / 1000).toInt().coerceAtLeast(1), "backoff")
            }
            if (result.nothingAcked && result.rejectedIds.isEmpty()) {
                // 2xx 但 ok!=true / 非 JSON / HTML / redirect / 401：整批没 ACK，别空转，停一轮（不删任何东西）。
                return Outcome(sent, acked, rejected, qSize, false, null, "not_acked")
            }
            attempt = 0
            batchesDone++
        }
        return Outcome(sent, acked, rejected, store.quarantinedIds().size, false, null)
    }

    private fun scheduleBackoff(retryAfterSeconds: Int?) {
        val secs = DiagAck.backoffSeconds(attempt, retryAfterSeconds)
        backoffUntil = clock() + secs * 1000L
        attempt = (attempt + 1).coerceAtMost(6)
    }

    /** 完整上传 URL；地址非法（非 HTTPS / 带 userinfo/query/hash / 空）返回 null（不上报）。 */
    fun endpoint(): String? {
        if (!validEndpoint(baseUrl)) return null
        return baseUrl.trimEnd('/') + PATH
    }

    companion object {
        const val PATH = "/api/mobile/diagnostics"
        const val MAX_BATCHES_PER_ROUND = 4

        /**
         * 把一次上传结果翻成给人看的一句话（纯函数，可单测）。诊断页手动补传按钮用它。
         *
         * 关键：只有 `skipReason=="backoff"`（真 429）才叫「服务端限流」；`post_failed`（DNS/连接/超时/线程错）
         * 说「暂未成功（网络异常）」，不谎报限流；发送 0 且无隔离说「都已上报」，不把「失败文字准确」当按钮功能通过。
         */
        fun describe(o: Outcome): String = when {
            o.skipReason == "no_valid_endpoint" -> "没有可信上传入口（域名未登记/非 HTTPS），不上报"
            o.skipReason == "no_credential" -> "还没配对，暂不能上报"
            o.skippedOffline -> "当前没网，已留在本地，联网后自动补传"
            o.skipReason == "post_failed" -> "暂未成功（网络异常），记录已保留，${o.backoffSeconds ?: 0} 秒后重试"
            o.skipReason == "backoff" && o.backoffSeconds != null -> "服务端限流，${o.backoffSeconds} 秒后重试（已留本地）"
            o.sent == 0 && o.quarantined == 0 -> "本地没有待上报的记录（都已上报）"
            o.sent == 0 -> "没有可上报的记录（隔离 ${o.quarantined} 条已保留）"
            else -> "已上报：发送 ${o.sent}，服务端确认 ${o.acked}，拒收隔离 ${o.rejected + o.quarantined}（保留供诊断）"
        }

        /**
         * 上传地址是否合法：**必须 HTTPS**、有 host、**无 userinfo/query/hash**（凭据只放 header，绝不进 URL）。
         * 空/非 https/带 `@`(userinfo)/`?`/`#` → 非法。绝不硬编码任何 crew 域名作默认。
         */
        fun validEndpoint(url: String): Boolean {
            val u = url.trim()
            if (u.isEmpty()) return false
            if (!u.startsWith("https://")) return false
            if (u.contains('?') || u.contains('#')) return false
            val afterScheme = u.removePrefix("https://")
            if (afterScheme.isEmpty()) return false
            val authority = afterScheme.substringBefore('/')
            if (authority.isEmpty() || authority.contains('@')) return false // userinfo 禁
            return true
        }
    }
}
