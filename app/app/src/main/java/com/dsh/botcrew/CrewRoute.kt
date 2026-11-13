package com.dsh.botcrew

import java.net.URLEncoder
import org.json.JSONObject

/**
 * 三条路谁先谁后，以及「现在走的是哪条」。
 *
 * 顺序是 P2P → 局域网 → 公网，不做成开关：隧道直连最快（同网段实测 1.4ms），局域网少一跳
 * 且不用隧道注册，公网是打不通时的兜底。三条都留着 —— 任何一条断了，下一跳自动接上。
 *
 * 隧道这条只说「连上了」加实测往返：往返时间证明不了走的是打洞直连还是 DERP 中继
 * （同网段打洞 1.4ms、经东京中继 130–146ms 是两次实测，不是一条判据），拿 RTT 反推路径
 * 就是替网络下结论。所以不再分「直连 / 中继」两种措辞，统一报连上了，把实测数摆出来让人自己看。
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

    /** 失败探测按 1/2/4/8/16/30 秒退避，前台恢复会重新从第一档开始。 */
    fun retryDelay(failures: Int): Long = (1_000L shl failures.coerceIn(0, 5)).coerceAtMost(30_000L)

    /** 本地回环代理的前缀。`CrewClient.replaceEntries` 靠它认出「这条是 P2P 主路，别踢掉」。 */
    const val LOCAL_PROXY_PREFIX = "http://127.0.0.1:"

    /** 手机这一侧的入口。绑在回环上，所以换 Wi-Fi、开热点都不会变。 */
    fun proxyBase(port: Int): String = "$LOCAL_PROXY_PREFIX$port"

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

    /**
     * 手上这条入口是哪条路。认不出来（手输了一个没见过的地址）返回 null。
     *
     * 判定按地址的内容而不是它存在哪一格：人完全可能把公网地址直接填进「电脑地址」那一栏，
     * 按位置判就会把出门那条路说成局域网。所以先排除空串（两格都没配时不能拿空串碰空串
     * 就认成某条路），再看它是不是电脑公布的出门地址 —— 命中就是公网，不管写在哪一格。
     */
    fun kindOf(entry: String, paired: PairedCrew, proxyPort: Int?): Way? {
        val here = CrewPairing.normalize(entry)
        if (here.isEmpty()) return null
        val fallback = CrewPairing.normalize(paired.fallbackBase)
        return when {
            proxyPort != null && here == CrewPairing.normalize(proxyBase(proxyPort)) -> Way.P2P
            fallback.isNotEmpty() && here == fallback -> Way.PUBLIC
            here == CrewPairing.normalize(paired.base) -> Way.LAN
            else -> null
        }
    }

    /**
     * 隧道那条路的措辞。
     *
     * 只说「连上了」加实测往返。曾经按 40ms 分界把慢的写成「隧道中继」、快的写成「P2P 直连」，
     * 但往返时间证明不了路径：同网段打洞 1.4ms、经东京 DERP 130–146ms 只是两次实测，
     * 蜂窝网络下的直连也能到几十毫秒。拿 RTT 反推「直连还是中继」是在替网络下结论，
     * 猜错一次就让人以为 137ms 是 1.4ms。所以把实测数摆出来，不补路径判断。
     *
     * 没有实测值（null）时只说连上了 —— 只有探通过才会走到这句话，探通本身就说明请求
     * 确实是经这条隧道回去的，只是没量到时间。
     */
    fun tunnelLabel(millis: Long?): String =
        if (millis == null) "隧道已连接" else "隧道已连接（${millis}ms）"

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

/**
 * 会话这一段的纯路径规则（契约 §1）。
 *
 * 传输形态只走 query：网关 `session_of()` 只读 `urlsplit(path).query`，body 与 header 一概不认。
 * 默认 `main` 与显式 `main` 都**不带参数** —— 老路径逐字不变，只有非 main 才追加。
 * 拼路径与判 id 都放在这里，不塞进网络层：单元测试直接钉住拼出来的那一条 request line。
 */
object SessionRoute {
    /** 缺省会话。老调用、老响应、锁 main 都落到它。 */
    const val MAIN = "main"

    /** 与 S1 `SESSION_ID` 逐字一致：小写字母/数字开头，其后允许 `-`，总长 1..32。 */
    private val ID = Regex("^[a-z0-9][a-z0-9-]{0,31}$")

    fun validId(id: String): Boolean = ID.matches(id)

    /**
     * 给一条会话相关的路径追加 `session_id`。
     *
     * 已经有别的 query 时接着拼 `&`，不覆盖原参数；main/null/空串一律原样返回。
     * URLEncoder 是因为 id 万一带着 `&` 也不能拼出第二个参数（本地校验先挡，这里再兜一层）。
     */
    fun path(raw: String, sessionId: String?): String {
        if (sessionId.isNullOrEmpty() || sessionId == MAIN) return raw
        val separator = if ('?' in raw) '&' else '?'
        return raw + separator + "session_id=" + URLEncoder.encode(sessionId, "UTF-8")
    }

    /** `POST /api/mobile/sessions` 的请求体只有一个 id（契约 §2）。 */
    fun body(id: String): String = JSONObject().put("id", id).toString()
}
