package com.dsh.botcrew

/**
 * 配对屏上「同一个 Wi-Fi 里找到了谁」这件小事。
 *
 * 三件事混在一起最容易写错，所以单独放在这里，不碰 Compose：
 * 表怎么维护、地址该不该自动填、要不要申请附近设备那个运行时权限。
 * 都是纯函数 —— 屏幕只负责把这些结果画出来。
 */
object CrewNearby {
    /**
     * 表的一行：名字是服务实例名（认人的），base 是填进地址框的那个，publicBase 是出门那条路（可空），
     * p2pAddr 是隧道地址（可为空）。后两格都得跟着这一行走：配对时要从这里一起存下去，
     * 丢一格就等于少了那条路 —— 而且不会报错，只是永远走不到。
     */
    data class Spot(
        val name: String,
        val base: String,
        val publicBase: String = "",
        val p2pAddr: String = "",
        /** 与网卡无关的队伍指纹；配对时一起存下，重新发现时按它认同一台。 */
        val crew: String = "",
        /**
         * 最后一次听见它的时刻（毫秒，取调用方的单调时钟）。
         *
         * `0` 表示「这一格没被记过」—— 那时界面不许说它旧，见 [stale]。
         * 它不是过期判据：**条目什么时候消失仍然只听系统的 `onServiceLost`**（见 #31 的结论）。
         * 它只用来把「这一行有多久没再响过」如实说出来，并在点它之前先确认一次连通。
         */
        val foundAt: Long = 0L,
    )

    /**
     * 把一台并进表里：同一台（按服务名）只留一行，位置不动，地址以最新一次为准。
     *
     * 「位置不动」是有意的：只做追加的话，某台重新广播时它的行会从上跳到最下面，
     * 手指正好按在上面就会点错人。
     */
    fun add(spots: List<Spot>, beacon: CrewBeacon, now: Long = 0L): List<Spot> {
        val spot = Spot(beacon.name, beacon.base, beacon.publicBase, beacon.p2pAddr, beacon.crew, now)
        val at = spots.indexOfFirst { it.name == beacon.name }
        return if (at < 0) spots + spot else spots.toMutableList().also { it[at] = spot }
    }

    /** 一台不见了就把那行摘掉；本来就不在表里时什么也不做。 */
    fun remove(spots: List<Spot>, name: String): List<Spot> = spots.filterNot { it.name == name }

    /** 把一条 [CrewSighting] 并进表里，两种事件走同一处。 */
    fun merge(spots: List<Spot>, sighting: CrewSighting, now: Long = 0L): List<Spot> = when (sighting) {
        is CrewSighting.Found -> add(spots, sighting.beacon, now)
        is CrewSighting.Lost -> remove(spots, sighting.name)
    }

    /**
     * 这一行有多久没再听见了。没有时钟证据（[Spot.foundAt] 为 0）时返回 0。
     *
     * 负数（时钟被往回拨）也压成 0：说「负几秒前」比不说更糟。
     */
    fun silence(spot: Spot, now: Long): Long {
        if (spot.foundAt <= 0L || now <= spot.foundAt) return 0L
        return now - spot.foundAt
    }

    /**
     * 这一行算不算「该复核了」。
     *
     * ## 它不做的事（#31 的结论）
     *
     * 它**不删行**。条目什么时候消失只听系统 `onServiceLost` —— 真机实测那是 75–90 秒
     * 的缓存时延，是本机的 NSD 契约，不是我们漏处理（见 review 报告）。在这里自造一个
     * 过期阈值去摘行，等于用「一段时间没听见」冒充「它已经关了」，同网段里正常的重复广播
     * 间隔一旦拉长（bonjour 的再播是 1/3/9/27/81… 秒）就会误删一台活着的队伍。
     *
     * 所以它只回答一件事：这一行还值不值得直接填进地址框。不值得就先敲一次端口，
     * 通了照填，不通就不填 —— 判据是可证伪的网络事实，不是时长猜测。
     *
     * 阈值取 [STALE_AFTER_MS]：小于它的沉默按「刚响过」处理，点它不产生任何额外等待。
     */
    fun stale(spot: Spot, now: Long, thresholdMs: Long = STALE_AFTER_MS): Boolean =
        spot.foundAt > 0L && silence(spot, now) >= thresholdMs

    /** 默认的「该复核了」门槛。见 [stale]：它只触发一次连通确认，不触发删除。 */
    const val STALE_AFTER_MS = 30_000L

    /**
     * 一条广播的「内容签名」：服务名 + 地址 + 两条出门路 + 指纹。
     *
     * 发现流用它去重：完全相同的重复上报只发一次，但**地址或任一路由变了就必须是新的一条**。
     * 只按服务名去重会漏掉「同一台换了 IP 重新广播」，那正是地址要跟着寻址走的关键一拍。
     */
    fun signature(beacon: CrewBeacon): String = listOf(
        beacon.name, beacon.base, beacon.publicBase, beacon.p2pAddr, beacon.crew,
    ).joinToString("\u0000")

    /**
     * 重新发现到一台队伍时，把**网段相关**的那格地址更新成当次广播的地址。
     *
     * 配好之后电脑可能换 Wi-Fi、IP 全变，或者重启后 `pub` / `p2p` 换了。这些都不该靠
     * 「记住上一次哪条通」——网段一换，记住的地址就是另一台机器甚至不存在。认同一台
     * 只用 mDNS 的 `crew` 指纹（stateDir 派生，与网卡无关），地址一律取当次广播。
     *
     * ## 配对记录里没有指纹的老记录（真机上就是这个状态）
     *
     * `crew` 是后加的字段。加之前配好的记录里没有它，于是 `paired.crew` 是空串，
     * 这条地址就**永远不会**自更新 —— 这正是 issue 里「死地址一直绕公网」的第一环。
     *
     * 补一条身份判据，仍然不猜：隧道地址 `tc-addr` 里内嵌的是**这台电脑的密钥**，
     * 两台机器不可能撞上。所以「已存的 p2pAddr 与广播里的逐字相同」就是同一台的硬证据 ——
     * 它比 stateDir 指纹更强，只是晚到（P2P 起来才有）。用上它，并顺手把指纹补进配对记录，
     * 下一次就走强判据。
     *
     * 公网入口不参与认人：同一个域名可能被反代到别处，它证明不了「还是那台机器」。
     *
     * 认不出就返回 null：没存指纹、广播里没有、指纹对不上、也没有可比的隧道地址，
     * 一律不猜，配好的是什么就保持什么。同一网段里有好几台时也不会把别人的地址写进来。
     *
     * `pub` / `p2p` 只在广播给了非空值时更新：一次短暂的广播缺项不该把已经存好的、能跨网
     * 用的那条路抹掉（那是手机出了门唯一能走的路）。地址这格则每次都取广播的现值。
     * 没有任何变化时返回 null，调用方据此不写盘、不重建连接。
     */
    fun refresh(paired: PairedCrew, beacon: CrewBeacon): PairedCrew? {
        if (!sameMachine(paired, beacon)) return null
        val fresh = paired.copy(
            base = CrewPairing.normalize(beacon.base),
            fallbackBase = beacon.publicBase.ifEmpty { paired.fallbackBase },
            p2pAddr = beacon.p2pAddr.ifEmpty { paired.p2pAddr },
            // 老记录没有指纹：这次既然认出来了，就补上，下次走强判据。
            crew = paired.crew.ifEmpty { beacon.crew },
        )
        return if (fresh == paired) null else fresh
    }

    /**
     * 广播里这一台，是不是配对记录里那台。
     *
     * 两条判据，都不靠猜：
     * 1. `crew` 指纹两侧都有且相同 —— 正路，与网卡、网段、密钥轮换都无关；
     * 2. 配对记录没有指纹时，退回隧道地址逐字相同 —— `tc-addr` 里是这台电脑的密钥，
     *    撞不上。只在两侧都非空时成立，一次短暂广播缺 `p2p` 不会让它误认。
     */
    fun sameMachine(paired: PairedCrew, beacon: CrewBeacon): Boolean {
        if (paired.crew.isNotEmpty() && beacon.crew.isNotEmpty()) return paired.crew == beacon.crew
        if (paired.crew.isEmpty() && paired.p2pAddr.isNotEmpty() && beacon.p2pAddr.isNotEmpty()) {
            return paired.p2pAddr == beacon.p2pAddr
        }
        return false
    }

    /**
     * 这条配对记录能不能靠广播自更新。
     *
     * 不能的时候界面要说清「地址没法自动跟着走」：那意味着电脑下次换 IP 时，
     * 只能人工重配对 —— 让人自己发现这件事，比让他对着一条死地址猜要诚实得多。
     */
    fun canSelfUpdate(paired: PairedCrew): Boolean =
        paired.crew.isNotEmpty() || paired.p2pAddr.isNotEmpty()

    /**
     * 自动填地址的条件：只有一台，而且人还没动过地址框。
     *
     * 多台时不填 —— 替人挑一台，等于让他念完码才发现连错了电脑。
     * 人动过之后也不填 —— 他手打的地址就是他要的那台，抢走比不填更糟。
     *
     * 只有一台时返回那一台；其余情况返回 null，界面保持原样。
     */
    fun autoPick(spots: List<Spot>, touched: Boolean): Spot? =
        if (touched || spots.size != 1) null else spots.first()

    /**
     * 地址框里现在是不是这一台。
     *
     * 两边都过一遍 [CrewPairing.normalize]：人可能把 `192.168.31.127:8788` 原样打进去，
     * 也可能带着尾斜杠复制过来，那都是同一台电脑。
     */
    fun holds(address: String, base: String): Boolean =
        CrewPairing.normalize(address) == CrewPairing.normalize(base)

    /**
     * 地址框下面该列哪几行。
     *
     * 多台：全列出来，人选一台。
     * 只有一台：只在地址**还不是它**时列 —— 人刚把它手改成别的地址，这一行是换回去的唯一入口。
     * 已经是它：不列。上面那句「已自动找到 X，地址已填好」已经把它说完了，再列一行是废话。
     */
    fun rows(spots: List<Spot>, address: String): List<Spot> = when {
        spots.size > 1 -> spots
        spots.size == 1 && !holds(address, spots[0].base) -> spots
        else -> emptyList()
    }

    /**
     * 要不要申请「附近的 Wi-Fi 设备」。Android 13（API 33）起 NSD 发现要这个运行时权限；
     * 更低版本没有这项权限，申请了也会被系统直接拒。
     */
    fun needsPermission(sdk: Int): Boolean = sdk >= 33

    /**
     * 现在要不要弹系统权限框。这条判据要**跨 composable 生命周期**成立（#34）。
     *
     * 三件事一起看：
     * - 版本：13 以下没这项权限，问只会被系统当场拒（[needsPermission]）；
     * - 现状：已经给了就不用问；
     * - 问过没有：[asked] 来自持久层，不是 `rememberSaveable`。
     *
     * 已问过且仍被拒 ⇒ 不弹。人要去系统设置里给，那边给了之后 `permitted` 就是 true，
     * 发现自己回来；而「再找一次」按钮只重看 `permitted`，从不重新弹框。
     */
    fun shouldAsk(sdk: Int, permitted: Boolean, asked: Boolean): Boolean =
        needsPermission(sdk) && !permitted && !asked

    /**
     * 点「用它」之前要不要先确认这一行还活着。
     *
     * 只在**有沉默证据**时才确认：`foundAt` 没记过（0）就不确认，那种行是刚进表、或者
     * 从老代码路径来的，凭空多等一次握手只会让人觉得 App 卡。
     */
    fun needsCheck(spot: Spot, now: Long, thresholdMs: Long = STALE_AFTER_MS): Boolean =
        stale(spot, now, thresholdMs)
}

/**
 * 「电脑地址」这一格的状态机。
 *
 * ## 为什么它是个类而不是 data class
 *
 * 这个类要保证的唯一一件事是：**改地址只能经过三种带语义的转移**（[typed] / [picked] /
 * [autoFilled]），其中只有 [autoFilled] 允许在不置 `touched` 的情况下改值。
 *
 * 写成 `data class` 就漏了：自动生成的 `copy(address = it)` 是一条谁都能走的旁路，
 * 屏幕上一行 `field = field.copy(address = it)` 就能绕过 [typed] 把「人改过」丢掉 ——
 * 编译通过、单测全绿，真机上变成「边打字边被抢」。这正是 #32 说的假保障：
 * 测试测的是 `AddressField` 的方法，而屏幕可以根本不调它。
 *
 * 所以这里不给 `copy`：构造函数私有、只留 [start] 造初值，改值只有三条语义路径。
 * 旁路不是「靠记得别用」，而是**写不出来**。真机行为另由 phone-final 的屏幕验收覆盖。
 */
class AddressField private constructor(
    val address: String,
    /** 人动过这一格没有。一旦为真，[autoFilled] 永远不再改地址。 */
    val touched: Boolean,
) {
    /** 人在输入框里打字（含删字、粘贴）。置位在这里，不在屏幕上 —— 所以它被测得到。 */
    fun typed(value: String): AddressField = AddressField(value, touched = true)

    /** 人点了列表里的一行：那是明确的选择，可以覆盖手改过的地址。 */
    fun picked(spot: CrewNearby.Spot): AddressField = AddressField(spot.base, touched = true)

    /**
     * 发现流来了一条之后，这一格要不要跟着变。
     *
     * 只有「一台、且人没动过」才会变（判据在 [CrewNearby.autoPick]）。没变时返回 `this`
     * —— 相等即不触发重组，不会和调用方的 effect 互相推动。
     */
    fun autoFilled(spots: List<CrewNearby.Spot>): AddressField {
        val pick = CrewNearby.autoPick(spots, touched) ?: return this
        if (CrewNearby.holds(address, pick.base)) return this
        return AddressField(pick.base, touched)
    }

    /** 现在填的是不是这一台。 */
    fun holds(spot: CrewNearby.Spot): Boolean = CrewNearby.holds(address, spot.base)

    // Compose 的 mutableStateOf 靠 equals 判「变没变」，所以这两个必须手写。
    override fun equals(other: Any?): Boolean =
        this === other || (other is AddressField && other.address == address && other.touched == touched)

    override fun hashCode(): Int = 31 * address.hashCode() + touched.hashCode()

    override fun toString(): String = "AddressField(address=$address, touched=$touched)"

    companion object {
        /** 初值：进屏时预填的那一条。它不算「人改过」。 */
        fun start(address: String): AddressField = AddressField(address, touched = false)
    }
}

/**
 * 发现出来的那几行下面写什么字。
 *
 * 三档各有各的话，且「没找到」「被拒了」都不是错误 —— 它们只是退回手输地址，
 * 所以这里没有「失败」「出错了」这种字。
 */
object NearbyCopy {
    const val NO_PERMISSION = "没有附近设备权限，自动发现关了，地址可以手填"
    const val NONE_FOUND = "没找到附近的队伍，地址可以手填"

    /**
     * 问过、被拒了（#34）。不把这句说成「没有权限」就完事 —— 人要能看出
     * 「系统不会再弹了，得自己去设置里给」，以及回来之后该按哪个按钮。
     */
    const val DENIED =
        "附近设备权限被拒过，系统不会再弹框。要开就去系统设置里给「附近的设备」，回来点「再找一次」。地址也可以手填。"

    /** 一句「多久以前」，给 [one] 与 [staleRow] 共用。 */
    fun age(seconds: Long): String = when {
        seconds < 60 -> "${seconds} 秒前"
        seconds < 3_600 -> "${seconds / 60} 分钟前"
        else -> "${seconds / 3_600} 小时前"
    }

    /**
     * 只有一台时上面那句话。
     *
     * [filled] 是「地址框里就是这一台」；[handEdited] 是「人自己改过地址框」（#32）。
     * 这两档必须分开说：地址是人手打的 `10.9.9.9:1`、而广播里只有一台时，
     * 说「已自动找到 X，点一下填上地址」读起来像「已经帮你填成 X 了」—— 与事实相反。
     *
     * [staleSeconds] 非空表示这一行已经有一阵没再响过（#31）。它不改结论，只把
     * 「多久没响」和「点它会先确认」如实说出来 —— 行不会被偷偷摘掉，也不会被当成死的。
     */
    fun one(
        name: String,
        filled: Boolean,
        handEdited: Boolean = false,
        staleSeconds: Long? = null,
    ): String {
        val line = when {
            filled -> "已自动找到 $name，地址已填好。"
            handEdited -> "找到 $name，地址是你自己填的；要换成它点下面那行。"
            else -> "已自动找到 $name，点一下填上地址。"
        }
        return if (staleSeconds == null) line else "$line（上次发现 ${age(staleSeconds)}，点它会先确认。）"
    }

    /**
     * 多台：先说可以选，再由下面那几行自己说清是哪几台。
     *
     * 人点过一台之后就不再催他「点一台」了。传进来的是**地址框里那一行**，不是「上次点了谁」——
     * 他后来又把地址手改掉，这句话就自动退回「点一台填上地址」。
     */
    fun several(count: Int, picked: String? = null): String =
        if (picked == null) "找到 $count 台队伍，点一台填上地址。"
        else "已选中 $picked，地址已填好。"

    /** 列表里那一行下面的小字：这一台有多久没再响过（#31）。 */
    fun staleRow(seconds: Long): String = "上次发现 ${age(seconds)} · 待复核"
}
