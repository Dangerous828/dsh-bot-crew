package com.dsh.botcrew

import android.content.Context

/**
 * 按 crew 分隔的本地存储命名空间。
 *
 * ## 身份怎么算
 *
 * 只用**配对那一刻就有**的东西，绝不用要等 timeline 回来才登记的 `serverCrew` 当身份：
 * 那个指纹从空变非空会把命名空间整体搬走一次 —— 正好是「首次 bootstrap 之前写的草稿全没了」。
 * 所以是 `device + (fingerprint 或 完整 base)`：
 *
 * - `device`：配对凭据里的设备 id。**单独用它不行** —— 它是手机的 ANDROID_ID，
 *   换一台电脑重新配对还是同一个值，两台电脑的 `main` 会撞在同一格。
 * - 隔离的另一半：有 `serverCrew` 用它（同一台电脑换 IP / 换 LAN 地址都不动它）；
 *   没有时用完整归一的 base（**含 port 与 path**：同 host 的不同 relay 路径是两个实例）。
 *
 * ## 身份变了怎么办
 *
 * 不做「搬走」这种隐式操作，而是**从旧命名空间原样搬过来**（[adopt]），且只搬一次（指针记在盘上）。
 * 典型情形：首次 timeline 回来、`serverCrew` 从空变非空 → 身份从 `o:…` 变成 `c:…`，
 * 那一刻草稿与未确认发送跟着搬过去，**不丢**。同理 base 变了（换了 LAN 地址）也跟过去。
 *
 * 与 `crew-pairing` 不同文件：`PairingStore.save()` 会 clear 整个 `crew-pairing` 文件（不看键名），
 * 本地内容住那儿会被一次 mDNS 广播抹掉。
 */
object CrewNamespace {
    private const val PREFS = "crew-local"

    /** 这个身份在盘上用哪一格。 */
    fun key(paired: PairedCrew?): String {
        if (paired == null) return ""
        val device = paired.deviceId.trim().ifEmpty { "anon" }
        val crew = paired.serverCrew.trim().ifEmpty { paired.crew.trim() }
        if (crew.isNotEmpty()) return "dev:$device|c:$crew"
        return "dev:$device|o:" + origin(paired.base)
    }

    /** 完整归一 base：协议 + 主机 + 端口 + 路径（去尾部 `/`，丢 query/fragment）。 */
    internal fun origin(base: String): String {
        val clean = CrewPairing.normalize(base)
        if (clean.isEmpty()) return ""
        return try {
            val url = java.net.URL(clean)
            val port = if (url.port > 0) ":${url.port}" else ""
            "${url.protocol}://${url.host}$port" + url.path.trimEnd('/')
        } catch (_: Exception) {
            clean.trimEnd('/')
        }
    }

    /**
     * 需要搬哪些键（纯函数，可单测）。
     *
     * 规则：把 `from|<suffix>` 搬到 `to|<suffix>`；**目标格已有值时不搬**（那是这台 crew 上更新的记录）。
     *
     * @return `源键 → 目标键`。身份没变或为空时是空表。
     */
    fun plan(keys: Collection<String>, from: String, to: String): Map<String, String> {
        if (from.isEmpty() || to.isEmpty() || from == to) return emptyMap()
        return keys.filter { it.startsWith("$from|") }.associateWith { to + it.removePrefix(from) }
    }

    /**
     * 把 `prefsName` 里属于旧身份的键搬到新身份下，更新指针。
     *
     * @return 真的看过这件事（调用方据此重读）。身份未变时返回 false。
     */
    fun adopt(context: Context, prefsName: String, identity: String): Boolean {
        if (identity.isEmpty()) return false
        val local = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val pointer = "${prefsName}|adopted"
        val previous = local.getString(pointer, "").orEmpty()
        if (previous == identity) return false
        if (previous.isNotEmpty()) {
            val store = context.getSharedPreferences(prefsName, Context.MODE_PRIVATE)
            val moves = plan(store.all.keys, previous, identity)
            if (moves.isNotEmpty()) {
                val editor = store.edit()
                for ((from, to) in moves) {
                    val value = store.all[from] as? String ?: continue
                    if (!store.contains(to)) editor.putString(to, value)
                }
                editor.apply()
            }
        }
        local.edit().putString(pointer, identity).apply()
        return true
    }

    internal fun clearPointerForTests(context: Context, prefsName: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove("${prefsName}|adopted").apply()
    }
}
