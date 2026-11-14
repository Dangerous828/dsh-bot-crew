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
    )

    /**
     * 把一台并进表里：同一台（按服务名）只留一行，位置不动，地址以最新一次为准。
     *
     * 「位置不动」是有意的：只做追加的话，某台重新广播时它的行会从上跳到最下面，
     * 手指正好按在上面就会点错人。
     */
    fun add(spots: List<Spot>, beacon: CrewBeacon): List<Spot> {
        val spot = Spot(beacon.name, beacon.base, beacon.publicBase, beacon.p2pAddr, beacon.crew)
        val at = spots.indexOfFirst { it.name == beacon.name }
        return if (at < 0) spots + spot else spots.toMutableList().also { it[at] = spot }
    }

    /** 一台不见了就把那行摘掉；本来就不在表里时什么也不做。 */
    fun remove(spots: List<Spot>, name: String): List<Spot> = spots.filterNot { it.name == name }

    /** 把一条 [CrewSighting] 并进表里，两种事件走同一处。 */
    fun merge(spots: List<Spot>, sighting: CrewSighting): List<Spot> = when (sighting) {
        is CrewSighting.Found -> add(spots, sighting.beacon)
        is CrewSighting.Lost -> remove(spots, sighting.name)
    }

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

    /** 只有一台：原来的那句话不变。有人（或自动）填过地址才说得上「已填好」。 */
    fun one(name: String, filled: Boolean): String =
        if (filled) "已自动找到 $name，地址已填好。" else "已自动找到 $name，点一下填上地址。"

    /**
     * 多台：先说可以选，再由下面那几行自己说清是哪几台。
     *
     * 人点过一台之后就不再催他「点一台」了。传进来的是**地址框里那一行**，不是「上次点了谁」——
     * 他后来又把地址手改掉，这句话就自动退回「点一台填上地址」。
     */
    fun several(count: Int, picked: String? = null): String =
        if (picked == null) "找到 $count 台队伍，点一台填上地址。"
        else "已选中 $picked，地址已填好。"
}
