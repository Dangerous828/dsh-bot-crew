package com.dsh.botcrew

/**
 * 换路策略的**纯函数**核心（不改网络栈，只决定「下一个请求该从哪条入口起手、要不要快速跳过死 LAN」）。
 *
 * ## 根因（已在源码 + 现场确认，见设计 §六）
 *
 * `CrewClient.read()` 串行逐条试入口：`current` 在最前，某条抛 IOException 才试下一条。
 * 业务请求用 `connectTimeout=15s`。蜂窝下旧 LAN（RFC1918 不可路由）**不是秒拒**，而是
 * connect 阻塞满 15s 才抛 → 每个业务请求先吃满 15s 再落域名。后台探测循环的
 * `retryDelay(1/2/4/8/16/30s)` 只护探测频率，**护不到每请求的 read()**。
 *
 * ## 修根因的三件事（都在这层做决定，`CrewClient` 只执行）
 *
 * 1. **healthy entry sticky**：一条入口刚成功过，就是「健康证据」。短 TTL 内别再把它排到非健康入口之后。
 * 2. **失败冷却**：一条入口连续失败（connect/不可路由）后进入冷却期，冷却期内**不再作为起手入口**，
 *    免得每个请求都先撞它一次 15s。冷却随「网络变化」清空——换了网络旧证据作废。
 * 3. **短 LAN 快速切域名**：起手若在 LAN/未知且已知健康公网入口存在，先用**短超时**探公网，探通就
 *    立刻以公网起手（而不是傻等 LAN 15s）。已有健康公网时，LAN 的 connect 超时降到短档。
 *
 * 全部纯函数：拿「已知健康集/失败计数/网络代次/入口种类」算出「这次该怎么试」，JVM 单测直接跑。
 * 不碰 HttpURLConnection、不碰 Android。
 */
object RoutePolicy {

    /** 入口种类（与 [CrewRoute.Way] 同义，但这里是策略入参，独立一份便于单测）。 */
    enum class Kind { P2P, LAN, PUBLIC, UNKNOWN }

    /** 一次「怎么试」的决定。 */
    data class Plan(
        /** 建议的起手顺序（已按 sticky/冷却/优先级重排）。 */
        val order: List<String>,
        /** 本次对各入口用的 connect 超时（ms）。缺省用 [defaultConnectMs]。 */
        val connectTimeoutFor: Map<String, Int>,
        /** 起手前是否需要先用短超时探一次公网（探通则先走它）。 */
        val quickProbePublic: Boolean,
    )

    /** 缺省 connect 超时（与 CrewClient.open 现状一致：15s）。 */
    const val DEFAULT_CONNECT_MS = 15_000

    /** 「短档」：已知有健康公网时，对非健康 LAN 用这个——不为一条大概率死的 LAN 等满 15s。 */
    const val SHORT_CONNECT_MS = 3_000

    /** 快速探公网用的短超时。 */
    const val QUICK_PROBE_MS = 3_000

    /** 健康证据的有效期：成功一次算 [HEALTHY_TTL_MS] 内健康。 */
    const val HEALTHY_TTL_MS = 60_000L

    /** 失败冷却期：连续失败后，这段时间内不作为起手入口。 */
    const val COOLDOWN_MS = 30_000L

    /** 连续失败到几次进入冷却（与 CrewLanHealth.FAILURES 同口径：两次足够定性）。 */
    const val FAIL_TO_COOLDOWN = 2

    /** 一条入口的健康记录：最近成功时刻、最近失败时刻、连续失败数。网络代次变了整体作废。 */
    data class Health(
        val entry: String,
        val kind: Kind,
        val lastSuccessAt: Long = 0L,
        val lastFailureAt: Long = 0L,
        val consecutiveFailures: Int = 0,
        val netGen: Int = 0,
    )

    fun healthy(health: Health, now: Long): Boolean =
        health.consecutiveFailures == 0 && now - health.lastSuccessAt <= HEALTHY_TTL_MS && health.lastSuccessAt > 0

    fun coolingDown(health: Health, now: Long): Boolean =
        health.consecutiveFailures >= FAIL_TO_COOLDOWN && now - health.lastFailureAt <= COOLDOWN_MS

    /**
     * 记一次成功：清零失败、刷新成功时刻、认这个网络代次。
     */
    fun onSuccess(health: Health, now: Long, netGen: Int): Health =
        health.copy(lastSuccessAt = now, consecutiveFailures = 0, netGen = netGen)

    /**
     * 记一次失败：连续失败 +1、刷新失败时刻。网络代次不同则视为新网络，从 1 起算（旧证据作废）。
     */
    fun onFailure(health: Health, now: Long, netGen: Int): Health {
        val base = if (health.netGen != netGen) 0 else health.consecutiveFailures
        return health.copy(
            lastFailureAt = now,
            consecutiveFailures = base + 1,
            netGen = netGen,
            // 网络变了，成功证据不再可信。
            lastSuccessAt = if (health.netGen != netGen) 0L else health.lastSuccessAt,
        )
    }

    /** 网络变化：所有入口的成功/失败证据作废（换了网络，旧 LAN 是否可达、旧公网是否还通都要重判）。 */
    fun onNetworkChanged(heaths: List<Health>, netGen: Int): List<Health> =
        heaths.map { it.copy(netGen = netGen, consecutiveFailures = 0, lastSuccessAt = 0L, lastFailureAt = 0L) }

    /**
     * **核心**：给这一趟请求算一个试入口的计划。
     *
     * 规则（按优先级）：
     * 1. 健康入口（TTL 内刚成功过）排前面，且用默认超时；同一档内保持传入的原始优先级序。
     * 2. 冷却中的入口排到最后；若还有别的非冷却入口，冷却入口用短超时；若全在冷却，维持默认超时（别无选择）。
     * 3. **蜂窝优先公网**：已确认 CELLULAR 且表里有可信(非冷却)PUBLIC 时，先短探 PUBLIC、以它起手——不先耗
     *    死 P2P/LAN 的 15s。这是「首次跨网请求（健康证据已被网络切换清空）」的根因覆盖。
     * 4. 已知有健康公网、且表里 LAN/UNKNOWN 不健康：给 LAN 用 [SHORT_CONNECT_MS]。
     *
     * @param entries 原始入口表（已按 P2P>LAN>PUBLIC 优先级排好）。
     * @param kindOf 入口 → 种类。
     * @param healthOf 入口 → 健康记录。
     * @param now 单调/墙钟毫秒（调用方注入，便于单测）。
     * @param networkKind 实际连接种类（"cellular"/"wifi"/"none"/…）；cellular 时优先公网。
     */
    fun plan(
        entries: List<String>,
        kindOf: (String) -> Kind,
        healthOf: (String) -> Health?,
        now: Long,
        networkKind: String = "",
    ): Plan {
        if (entries.isEmpty()) return Plan(emptyList(), emptyMap(), false)
        val kinds = entries.associateWith(kindOf)
        val heaths = entries.associateWith { healthOf(it) ?: Health(it, kindOf(it)) }
        val healthySet = entries.filter { healthy(heaths.getValue(it), now) }.toSet()
        val coolingSet = entries.filter { coolingDown(heaths.getValue(it), now) }.toSet()
        val cellular = networkKind.equals("cellular", ignoreCase = true)
        val reusablePublic = entries.firstOrNull { kinds[it] == Kind.PUBLIC && it !in coolingSet }

        // 排序档位：健康=0，普通=1，冷却=2；同档保持原序（stable sort）。
        var ordered = entries.sortedBy { e ->
            when {
                e in healthySet -> 0
                e in coolingSet -> 2
                else -> 1
            }
        }

        val timeouts = HashMap<String, Int>()
        var quickProbePublic = false

        // 蜂窝且可信公网可用：把公网提到最前，直接以它起手 + 对非公网入口用短 connect。
        // 不置 quickProbePublic：公网马上就用来起手，再单独探一次是冗余一趟 3s（lead 口径）。
        // quickProbePublic 只留给「起手是 LAN/UNKNOWN 且不健康」那种情况（见下方）。
        if (cellular && reusablePublic != null) {
            ordered = listOf(reusablePublic) + ordered.filter { it != reusablePublic }
        }

        val publicHealthy = ordered.any { kinds[it] == Kind.PUBLIC && it in healthySet }
        val hasNonCoolingNonLan = ordered.any { it !in coolingSet && kinds[it] != Kind.LAN && kinds[it] != Kind.UNKNOWN }

        for (e in ordered) {
            val k = kinds[e] ?: Kind.UNKNOWN
            val isLanish = k == Kind.LAN || k == Kind.UNKNOWN
            when {
                // 冷却中的入口：有别的可试就短档，否则维持默认。
                e in coolingSet -> timeouts[e] = if (hasNonCoolingNonLan) SHORT_CONNECT_MS else DEFAULT_CONNECT_MS
                // 已知有健康公网、这条是 LAN/未知且本身不健康：短档，别为它等 15s。
                publicHealthy && isLanish && e !in healthySet -> timeouts[e] = SHORT_CONNECT_MS
                // 蜂窝优先公网模式下，非公网入口（P2P/LAN/未知）用短档（公网先起手；它们只是后备，别耗满 15s）。
                cellular && reusablePublic != null && k != Kind.PUBLIC -> timeouts[e] = SHORT_CONNECT_MS
                else -> timeouts[e] = DEFAULT_CONNECT_MS
            }
        }

        // 起手不是 PUBLIC 而公网路径存在、且当前起手是（不健康的）LAN：先快速探公网。
        val lead = ordered.firstOrNull()
        if (lead != null) {
            val leadKind = kinds[lead] ?: Kind.UNKNOWN
            val isLanish = leadKind == Kind.LAN || leadKind == Kind.UNKNOWN
            if (isLanish && lead !in healthySet) {
                quickProbePublic = quickProbePublic || ordered.any { kinds[it] == Kind.PUBLIC && it !in coolingSet }
            }
        }
        return Plan(ordered, timeouts, quickProbePublic)
    }
}
