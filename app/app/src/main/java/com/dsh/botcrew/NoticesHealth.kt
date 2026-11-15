package com.dsh.botcrew

/**
 * 设备推送（notices 轮询）的可观察健康度。
 *
 * 真机问题（task-10 第三根因）：轮询的 `try { client.notices() } catch (_: Exception) {}`
 * 把失败**完全吞掉**——UI 一直显示「隧道已连接」，用户看不到 notices 一条都拉不到。
 * 这里把「连续失败了几次、最后一次是什么错」做成可读状态，界面据此如实显示
 * 「推送获取失败，重连中」而不是保持假绿；成功一次即清零并退回正常文案。
 *
 * 纯数据 + 纯函数，不碰 Android / 网络，JVM 单测直接钉住。
 */
data class NoticesHealth(
    /** 连续失败次数；0 表示最近一次轮询成功（或还没跑过）。 */
    val consecutiveFailures: Int = 0,
    /** 最后一次失败的人话原因；成功或没跑过时为空串。 */
    val lastError: String = "",
    /** 最近一次轮询是否已成功过至少一次（区分「从没跑过」与「跑通又断」）。 */
    val everSucceeded: Boolean = false,
) {
    /** 现在是不是处于「拉不到推送」的状态。 */
    val failing: Boolean get() = consecutiveFailures > 0

    /** 记一次成功：清零失败计数，标记曾成功过。 */
    fun onSuccess(): NoticesHealth = copy(consecutiveFailures = 0, lastError = "", everSucceeded = true)

    /** 记一次失败：累加并留存原因（保留曾经成功过的事实）。 */
    fun onFailure(reason: String): NoticesHealth =
        copy(consecutiveFailures = consecutiveFailures + 1, lastError = reason.ifBlank { "推送拉取失败" })

    /**
     * 界面上那行提示；不处于失败态时返回空串（正常时不占位）。
     *
     * 只报事实 + 正在重连，不承诺「马上就好」，也不冒充「已连接」。
     */
    fun line(): String {
        if (!failing) return ""
        val base = "推送获取失败，正在重连（第 $consecutiveFailures 次）"
        return if (lastError.isBlank()) base else "$base · $lastError"
    }
}
