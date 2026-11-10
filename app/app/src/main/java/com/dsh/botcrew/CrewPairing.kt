package com.dsh.botcrew

/**
 * 地址归一化。用户会打 `192.168.31.127:43499` 这种不带协议的形式，
 * 也常带着尾斜杠复制过来 —— 两者直接拼路径都会出错。
 */
object CrewPairing {
    fun normalize(raw: String): String {
        val trimmed = raw.trim().trimEnd('/')
        if (trimmed.isEmpty()) return trimmed
        // 判协议要用 startsWith，不能用 contains："https" 里也含 "http"。
        return if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) trimmed else "http://$trimmed"
    }
}
