package com.dsh.botcrew

import org.json.JSONObject

/**
 * 诊断上报的**应答判定**与**退避**，全是纯函数。
 *
 * 为什么单独一层：契约 §5.9 的 ACK 判定很窄——「2xx + JSON 正确类型 + 解析 `ok===true` 且
 * acceptedIds 匹配」才算这条记录被服务端 durable 落库。**只看 2xx 就删本地是错的**：
 * 301/302 之后被前端 200 吃掉、或 200 但 body 不是预期 JSON，都不该当成上传成功。
 * 这些判定做成纯函数，单测直接钉住，不靠"约定俗成"。
 */
object DiagAck {

    /**
     * 一次上报的结果。
     *
     * [ackedIds] 是**可以安全删本地**的 id（服务端 ACK 过，含幂等命中的重复 id）。
     * [rejectedIds] 是服务端明确拒收的坏记录（`row_too_large`/`bad_at`/`route_sensitive`…）——**不删**，
     * 由 [DiagUploader] 保留在本地（有界隔离）+ quarantine 后续跳过，供诊断页查看导出（冻结契约：只删 acceptedIds）。
     * [nothingAcked] = 这一次没有任何 id 被 ACK（可能整批态不对），本地全保留、下次重试。
     */
    data class Result(
        val ackedIds: Set<String>,
        val rejectedIds: Set<String>,
        val nothingAcked: Boolean,
        val retryAfterSeconds: Int? = null,
        val shouldBackoff: Boolean = false,
    )

    /**
     * 判定一次 HTTP 应答。**只有** [status] 在 2xx、`content-type` 是 JSON、body 解析出
     * 顶层 `ok === true`（严格布尔真，不是字符串 "true"）时，才认为有 ACK。
     *
     * @param status HTTP 状态码；-1 表示连接层失败（未拿到应答）。
     * @param contentType 响应 Content-Type；缺失时传 null。
     * @param body 响应正文（UTF-8 文本）。
     * @param sentIds 这一批发出去的 id 集合（用于 acceptedIds 交集、判断是否有有效 ACK）。
     */
    fun parse(
        status: Int,
        contentType: String?,
        body: String?,
        sentIds: Set<String>,
    ): Result {
        // 429：明确要退避，读 Retry-After（秒）。本地全保留。
        if (status == 429) {
            val retry = retryAfterOf(body)
            return Result(emptySet(), emptySet(), nothingAcked = true, retryAfterSeconds = retry, shouldBackoff = true)
        }
        // 非 2xx：不定 ACK。5xx 可退避重试；其它（4xx）也不删，但别疯狂重试整批。
        if (status !in 200..299) {
            return Result(emptySet(), emptySet(), nothingAcked = true, shouldBackoff = status >= 500 || status == -1)
        }
        // 2xx 还要过了 JSON 类型这一关：301/302 跟随后的 SPA 200 通常 content-type 是 text/html。
        val ct = contentType?.lowercase().orEmpty()
        if (!ct.contains("json")) {
            return Result(emptySet(), emptySet(), nothingAcked = true)
        }
        val root = try {
            JSONObject(body ?: "")
        } catch (t: Throwable) {
            return Result(emptySet(), emptySet(), nothingAcked = true)
        }
        // ok 必须是严格的 JSON 布尔 true。
        if (!root.has("ok") || root.opt("ok") != true) {
            return Result(emptySet(), emptySet(), nothingAcked = true)
        }
        val acked = readIdSet(root, "acceptedIds").intersect(sentIds)
        val rejected = readIdSet(root, "rejectedIds").intersect(sentIds)
        val anyAck = acked.isNotEmpty() || rejected.isNotEmpty()
        return Result(acked, rejected, nothingAcked = !anyAck)
    }

    private fun readIdSet(root: JSONObject, key: String): Set<String> {
        val arr = root.optJSONArray(key) ?: return emptySet()
        val out = HashSet<String>()
        for (i in 0 until arr.length()) {
            val id = arr.optString(i).trim()
            if (id.isNotEmpty()) out.add(id)
        }
        return out
    }

    /** 从 429 响应体里读 `retryAfter`（秒）；没有或读不到返回 null。body 里可能没带，靠响应头的情况由调用方另处理。 */
    private fun retryAfterOf(body: String?): Int? = try {
        JSONObject(body ?: "").optInt("retryAfter", -1).takeIf { it > 0 }
    } catch (t: Throwable) {
        null
    }

    /**
     * 指数退避序列（秒）：1、2、4、8、16、32、60 封顶。**有界**——不无限高频。
     * 若服务端给了 `Retry-After`，取它与本档的较大值（尊重服务端，但不低于自己的下限）。
     */
    fun backoffSeconds(attempt: Int, retryAfterSeconds: Int? = null): Int {
        val base = (1 shl attempt.coerceIn(0, 6)).coerceAtMost(60)
        val server = retryAfterSeconds?.coerceIn(1, 300) ?: 0
        return maxOf(base, server)
    }
}
