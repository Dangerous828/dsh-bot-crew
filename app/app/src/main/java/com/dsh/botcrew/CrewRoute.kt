package com.dsh.botcrew

/**
 * 三条路谁先谁后，以及「现在走的是哪条」。
 *
 * 顺序是 P2P → 局域网 → 公网，不做成开关：隧道直连最快（同网段实测 1.4ms），局域网少一跳
 * 且不用隧道注册，公网是打不通时的兜底。三条都留着 —— 任何一条断了，下一跳自动接上。
 *
 * 隧道这条要分两种说法：打洞成功是直连，打不通时 tailcat 会退到 DERP 中继（实测 130–146ms）。
 * 两种都在「隧道通」这个事实里，但快慢差两个数量级，所以措辞按实测往返时间分开说 ——
 * 把中继说成直连，人就会以为 137ms 是 1.4ms。
 *
 * 全是纯函数：只拿字符串和毫秒数判断，不碰网络也不碰 Android，单测直接跑。
 */
object CrewRoute {
    enum class Way {
        /** 经隧道直连电脑：手机本地代理那一条。 */
        P2P,

        /** 同一个 Wi-Fi 下直连。 */
        LAN,

        /** 出了家门那条路：中转/隧道入口。 */
        PUBLIC,
    }

    /**
     * tc-addr 的形状下限：`tcp` 加至少 40 位 base64url（公钥段）。与后端 `parseAddr` 用同一个门槛，
     * 两边对上才不会出现「电脑说公布了、手机却当没有」。
     */
    private const val MIN_ADDRESS_LENGTH = 44

    /**
     * 一条 tc-addr 能不能拿去当隧道地址。
     *
     * 只认 `tcp` 开头的长串：mDNS 的 TXT 是纯文本，可能残留上一次的内容，也可能被别的服务
     * 占了这个键；拿半截字符串去建客户端只会换来一句难懂的库错误。空串表示这台电脑没公布。
     * 这里只筛形状，地址本身合不合法归库判断 —— 那是密钥解析，不该在 App 里再做一遍。
     */
    fun cleanAddress(raw: String?): String {
        val trimmed = raw?.trim().orEmpty()
        if (!trimmed.startsWith("tcp") || trimmed.length < MIN_ADDRESS_LENGTH) return ""
        // 中间有空白的一定是拼坏了的（TXT 被截断、两格粘在一起）。
        if (trimmed.any(Char::isWhitespace)) return ""
        return trimmed
    }

    /** 手机这一侧的入口。绑在回环上，所以换 Wi-Fi、开热点都不会变。 */
    fun proxyBase(port: Int): String = "http://127.0.0.1:$port"

    /**
     * 按优先级拼出要试的入口。
     *
     * 代理没起起来（或这台机器没有 P2P）时第一条不出现 —— 把一个连不上的入口留在最前面，
     * 等于每个请求都先白等一次超时。
     */
    fun entries(paired: PairedCrew, proxyPort: Int?): List<String> {
        val all = listOfNotNull(
            proxyPort?.let(::proxyBase),
            paired.base,
            paired.fallbackBase,
        ).map(CrewPairing::normalize).filter(String::isNotBlank)
        // 同一条地址配了两次（人可能直接把公网地址填进电脑地址那一栏）时只试一次。
        return all.distinct()
    }

    /** 手上这条入口是哪条路。认不出来（手输了一个没见过的地址）返回 null。 */
    fun kindOf(entry: String, paired: PairedCrew, proxyPort: Int?): Way? {
        val here = CrewPairing.normalize(entry)
        return when {
            proxyPort != null && here == CrewPairing.normalize(proxyBase(proxyPort)) -> Way.P2P
            here == CrewPairing.normalize(paired.base) -> Way.LAN
            here == CrewPairing.normalize(paired.fallbackBase) -> Way.PUBLIC
            else -> null
        }
    }

    /**
     * 直连与中继的分界线（毫秒）。
     *
     * 依据是实测：同网段打洞成功 1.4ms，跨网段经东京 DERP 中继 130–146ms。40 落在两者中间，
     * 给慢一点的直连留了余量（蜂窝、弱 Wi-Fi 下的直连也就几十毫秒），又远低于 DERP 那一档。
     * 这条线只有一个用途：不许把 137ms 的中继写成「P2P 直连」。
     */
    const val DIRECT_MAX_MILLIS = 40L

    /**
     * 隧道那条路的措辞。
     *
     * 没有实测值（null）时按直连说：只有探通过才会走到这句话，而探通就说明请求确实是经这条隧道
     * 回去的，只是没量到时间。低于阈值才说「P2P 直连」，其余一律把毫秒数摆出来。
     */
    fun tunnelLabel(millis: Long?): String =
        if (millis != null && millis >= DIRECT_MAX_MILLIS) "隧道中继（${millis}ms）" else "P2P 直连"

    /**
     * 界面上那句话。
     *
     * 写的是这条路是什么、有多快，不是「连接正常」：人真正要知道的是现在绕了多远，
     * 出问题时这一行就是第一条线索。
     *
     * [tunnelMillis] 只对隧道这条有意义 —— 换到局域网/公网之后，那个数字跟这句话无关，
     * 不能顺手带出来。`note` 是补在括号里的一句说明（比如 P2P 为什么没用上）。
     */
    fun label(way: Way?, tunnelMillis: Long? = null, note: String = ""): String {
        val text = when (way) {
            Way.P2P -> tunnelLabel(tunnelMillis)
            Way.LAN -> "局域网"
            Way.PUBLIC -> "公网中转"
            null -> "自定义地址"
        }
        return if (note.isEmpty()) text else "$text（$note）"
    }
}
