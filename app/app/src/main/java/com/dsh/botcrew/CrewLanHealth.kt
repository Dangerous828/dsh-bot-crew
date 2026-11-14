package com.dsh.botcrew

/**
 * 配对记录里那条局域网地址还活着吗。
 *
 * 为什么要有这一层：配对那一刻存下的 `base` 是**网段相关**的，电脑换个 Wi-Fi 就变成另一台
 * 甚至不存在。而 `CrewClient` 的换路是「先试当前这条，连不上再绕一圈」—— 死地址不会被踢掉，
 * 它只是每次都先白等一次连接超时，然后悄悄退回公网。界面上只有「公网中转」四个字，
 * 人看不出「本来该走局域网、现在为什么没走」。
 *
 * 所以这里只做一件事：把「这条 LAN 地址看起来已经失效」变成一个**可判定、可测试**的结论，
 * 再让界面把结论说出来。判定用两个条件同时成立（缺一不可）：
 *
 * 1. **连续 N 次连不上** —— 一次失败可能是电脑刚重启、Wi-Fi 抖了一下；
 * 2. **该地址与手机当前网络不在同一网段** —— 同一网段里连不上，多半是电脑没开，
 *    地址本身还是对的；跨网段才是「这台机器已经不在这个网络里了」。
 *
 * 两条都成立才说「已失效」。只成立第一条时如实说「连不上」，不把临时故障说成地址失效 ——
 * 那是替网络下结论，猜错一次就让人白换一次配对。
 *
 * 全是纯函数：只拿字符串和次数判断，不碰网络、不碰 Android，JVM 单测直接跑。
 */
object CrewLanHealth {

    /**
     * 结论。
     *
     * [OK] 不动界面；[UNREACHABLE] 与 [STALE] 都要说人话，但说的不是同一件事：
     * 前者是「这条路现在不通」，后者是「这条路已经指向别处了」。
     */
    enum class Verdict {
        /** 没证据说它坏了：次数不够、网段对得上、或者这条正在用。 */
        OK,

        /** 连续失败，但地址仍在手机当前网段里：电脑可能没开，地址本身没错。 */
        UNREACHABLE,

        /** 连续失败**且**跨网段：这台电脑换过 IP，这条地址指向的地方已经没有它了。 */
        STALE,
    }

    /**
     * 一次判定的结果。[host] 与 [subnet] 只为说清「凭什么这么判」，界面不直接显示，
     * 调试口的快照里读得到。
     */
    data class Report(
        val verdict: Verdict = Verdict.OK,
        val host: String = "",
        val subnet: String = "",
        val failures: Int = 0,
    )

    /** 连续几次连不上才算数。死地址每次要等一次连接超时，两次已经足够定性。 */
    const val FAILURES = 2

    /** 网段按 /24 比。家里那几种路由器（192.168.31.x、192.168.113.x）都是 /24。 */
    const val PREFIX = 24

    /**
     * 判一次。
     *
     * [inUse] 是「当前在用的入口就是这条 LAN」：正在用就说明它通，任何历史失败都不算数 ——
     * 网络恢复之后计数还没清的那种时序不能反过来把一条好路说成坏的。
     *
     * [localAddresses] 是手机当前网卡上的地址（wlan0 的 inet）。取不到（权限、刚断网、
     * 只有 IPv6）时传空表：那时**不做网段判断**，最坏也只到 [Verdict.UNREACHABLE]，
     * 不会凭一个不知道的网段说地址失效。
     */
    fun judge(
        lanBase: String,
        failures: Int,
        localAddresses: List<String>,
        inUse: Boolean,
    ): Report {
        val host = hostOf(lanBase)
        if (inUse) return Report(Verdict.OK, host, "", failures)
        // 认不出这条地址是哪个 IPv4（域名、IPv6、手输坏掉的）就不判：网段这件事无从谈起。
        if (host.isEmpty()) return Report(Verdict.OK, "", "", failures)
        if (failures < FAILURES) return Report(Verdict.OK, host, "", failures)

        val subnet = subnetOf(host)
        val local = localAddresses.mapNotNull(::subnetOf).toSet()
        // 不知道手机在哪一段时只说「连不上」。判失效要两条证据，缺一条就不下这个结论。
        if (local.isEmpty()) return Report(Verdict.UNREACHABLE, host, subnet, failures)
        val verdict = if (subnet in local) Verdict.UNREACHABLE else Verdict.STALE
        return Report(verdict, host, subnet, failures)
    }

    /**
     * 一句人话。空串表示没什么要说的 —— 界面那一行原样不动。
     *
     * 措辞只说**观察到的事实**：跨网段只能说明「这条地址指向的地方已经没有那台电脑」，
     * 「电脑换过 IP」是最常见的那一种原因，所以带一个「可能」，不把推断说成事实。
     */
    fun sentence(report: Report): String = when (report.verdict) {
        Verdict.OK -> ""
        Verdict.UNREACHABLE -> "局域网地址连不上"
        Verdict.STALE -> "局域网地址已失效（电脑可能换过 IP）"
    }

    /**
     * 界面上那一行最终写成什么。
     *
     * 走公网且地址已失效时换成整句「局域网地址已失效（电脑换过 IP），现在走公网中转」——
     * 人一眼要读到的是「为什么绕了远路」，而不是先看到「公网中转」再去括号里找原因。
     *
     * 走 P2P 时不追加：隧道是网域无关的主路，局域网那条失效在这里**不是问题**，
     * 挂在界面上只会让人以为出了故障（真要看，调试口的快照里有）。
     * 走局域网时也不追加：正在用它，说明它通。
     */
    fun routeLine(label: String, report: Report, way: CrewRoute.Way?): String {
        val text = sentence(report)
        if (text.isEmpty() || way == CrewRoute.Way.LAN || way == CrewRoute.Way.P2P) return label
        return if (way == CrewRoute.Way.PUBLIC) "$text，现在走公网中转" else "$label · $text"
    }

    /**
     * 从一条入口里取出 IPv4 字面量。取不到返回空串。
     *
     * 只认纯 IPv4：域名要过一次 DNS 才知道是哪个地址，那已经超出「看一眼就知道网段」的范围；
     * IPv6 的网段前缀与 /24 不是一回事，拿它比只会得出错误结论。
     */
    fun hostOf(entry: String): String {
        val raw = entry.trim()
        if (raw.isEmpty()) return ""
        // 去掉 scheme、路径、query：`http://192.168.31.127:43499/api/x` 里只要那个 host。
        val withoutScheme = raw.substringAfter("://", raw)
        val authority = withoutScheme.substringBefore('/').substringBefore('?')
        // 带方括号的是 IPv6（`[::1]:43499`），不参与网段判断。
        if (authority.startsWith("[")) return ""
        val host = authority.substringBeforeLast(':', authority)
        return if (isIpv4(host)) host else ""
    }

    /** 前三段，例 `192.168.31`。不是 IPv4 时返回空串。 */
    fun subnetOf(address: String): String {
        val host = address.trim()
        if (!isIpv4(host)) return ""
        val parts = host.split('.')
        return parts.take(PREFIX / 8).joinToString(".")
    }

    /** 严格的 IPv4 字面量：四段、每段十进制 0..255、不许有多余字符。 */
    private fun isIpv4(raw: String): Boolean {
        val parts = raw.split('.')
        if (parts.size != 4) return false
        return parts.all { part ->
            part.isNotEmpty() && part.length <= 3 && part.all { it in '0'..'9' } && part.toInt() in 0..255
        }
    }
}

/**
 * 手机自己现在在哪些网段上。
 *
 * 只取**已启用、非回环**网卡上的 IPv4：隧道那条 utun、回环代理都不代表「我和电脑在同一个
 * 局域网里」，把它们算进来会让任何地址都「同网段」，失效判定永远不成立。
 *
 * 取不到时返回空表 —— 调用方（[CrewLanHealth.judge]）据此退到「只说连不上」，
 * 不拿一个猜出来的网段去下结论。
 */
object LanAddresses {
    fun current(): List<String> = try {
        java.net.NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
            .filter { it.isUp && !it.isLoopback }
            .flatMap { card -> card.inetAddresses.toList() }
            .mapNotNull { it.hostAddress }
            .filter { ':' !in it }
    } catch (t: Throwable) {
        // 取不到网卡列表不是错误：没有它只是判不了「跨网段」这一条。
        emptyList()
    }
}
