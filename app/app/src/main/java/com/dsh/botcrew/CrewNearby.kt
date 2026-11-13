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
     * 认不出就返回 null：没存指纹、广播里没有、或者指纹对不上，一律不猜，配好的是什么
     * 就保持什么。同一网段里有好几台时也不会把别人的地址写进来。
     *
     * `pub` / `p2p` 只在广播给了非空值时更新：一次短暂的广播缺项不该把已经存好的、能跨网
     * 用的那条路抹掉（那是手机出了门唯一能走的路）。地址这格则每次都取广播的现值。
     * 没有任何变化时返回 null，调用方据此不写盘、不重建连接。
     */
    fun refresh(paired: PairedCrew, beacon: CrewBeacon): PairedCrew? {
        if (paired.crew.isEmpty() || beacon.crew.isEmpty() || paired.crew != beacon.crew) return null
        val fresh = paired.copy(
            base = CrewPairing.normalize(beacon.base),
            fallbackBase = beacon.publicBase.ifEmpty { paired.fallbackBase },
            p2pAddr = beacon.p2pAddr.ifEmpty { paired.p2pAddr },
        )
        return if (fresh == paired) null else fresh
    }

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
