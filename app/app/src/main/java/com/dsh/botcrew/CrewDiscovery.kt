package com.dsh.botcrew

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow

/**
 * 在同一个 Wi-Fi 上找队伍。
 *
 * 换一次网络就要人重输一次地址，是这套东西最容易卡住人的地方。后端会在 `_dsh-crew._tcp` 上广播自己，
 * 这里用系统的 NSD 把它找出来，配对屏直接把地址填好 —— 人只需要念那六位数。
 *
 * 找到不等于能进：广播里没有凭据，配对仍然要电脑出码。
 */
object CrewDiscovery {
    /** 与后端 `discovery.ts` 里的 `SERVICE_TYPE` 是同一个协议常量，改一边等于两边一起坏。 */
    const val SERVICE_TYPE = "_dsh-crew._tcp."

    /**
     * 一路找下去。每看见一台发一条 [CrewSighting.Found]，哪台不见了发一条 [CrewSighting.Lost]。
     *
     * 报告「不见了」和报告「看见了」一样重要：同一网段常有多台队伍，界面按名字维护一张表，
     * 只进不出的话，关掉的那台会一直留在列表里，点它就连不上。
     *
     * 找失败（没开组播、系统限流、没给附近设备权限）就结束这一路，不抛给界面：找不到只是退回手输地址，
     * 那不是错误，是「这台网络里没有队伍」。
     */
    fun find(context: Context): Flow<CrewSighting> = callbackFlow {
        val manager = context.getSystemService(Context.NSD_SERVICE) as? NsdManager
        if (manager == null) { close(); return@callbackFlow }

        val seen = mutableSetOf<String>()

        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {}

            override fun onServiceFound(info: NsdServiceInfo) {
                // 只认自己的类型；系统有时会把同一网段的别的服务也递过来。
                if (!info.serviceType.startsWith("_dsh-crew")) return
                // 同一个实例系统会重复上报，解析也慢；同名的只发一次，界面那边才是一台一行。
                resolve(manager, info) { beacon ->
                    if (seen.add(beacon.name)) trySend(CrewSighting.Found(beacon))
                }
            }

            override fun onServiceLost(info: NsdServiceInfo) {
                // 报一声「没了」。不在这里再按类型筛一遍：筛选条件一旦和 onServiceFound 有出入，
                // 这一台就永远留在列表里，点它是一台已经关掉的电脑。名字对不上表里任何一行时，
                // 界面那边是一次空操作，多发一条没有代价。
                seen.remove(info.serviceName)
                trySend(CrewSighting.Lost(info.serviceName))
            }

            override fun onDiscoveryStopped(serviceType: String) {}

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                close()
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
                close()
            }
        }

        manager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
        awaitClose { runCatching { manager.stopServiceDiscovery(listener) } }
    }

    /** 解析出一台服务的地址。解析失败就当作没看见：手机列表里出现一条连不上的记录比没有更糟。 */
    private fun resolve(manager: NsdManager, info: NsdServiceInfo, onFound: (CrewBeacon) -> Unit) {
        manager.resolveService(info, object : NsdManager.ResolveListener {
            override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {}

            override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                val host = serviceInfo.host?.hostAddress ?: return
                val port = serviceInfo.port
                if (port <= 0) return
                // IPv6 地址要带方括号，否则拼出来的 URL 是坏的。
                val shaped = if (host.contains(':')) "[$host]" else host
                // TXT 里的 `pub` 是电脑自己说的「出门往哪走」。同一条记录里一起给，所以人只要在
                // 同一个 Wi-Fi 下配过一次，之后换到任何网络都照着它连 —— 这是不装任何客户端
                // 也能跨网的全部机关。没有这一格就只是这台机器没配外网入口，局域网照旧可用。
                val public = serviceInfo.attributes?.get("pub")?.toString(Charsets.UTF_8)?.trim()
                onFound(CrewBeacon(
                    name = serviceInfo.serviceName,
                    base = "http://$shaped:$port",
                    publicBase = public?.takeIf { it.isNotEmpty() }.orEmpty(),
                ))
            }
        })
    }
}

/**
 * 找到的一台队伍：名字给人看，`base` 直接填进地址框。
 *
 * [publicBase] 是同一台电脑的出门地址（`https://...`），空串表示它没配。它不填进地址框 ——
 * 同一 Wi-Fi 下直连更快也更稳；只在局域网那条路连不上时才拿来兜底。
 */
data class CrewBeacon(val name: String, val base: String, val publicBase: String = "")

/**
 * 发现流上的一件事：看见一台，或者一台不见了。
 *
 * 用事件而不是「当前整张表」，是因为表在界面那边（跟着 Compose 的 state 走）；
 * 这里只负责如实报告发生了什么。
 */
sealed interface CrewSighting {
    data class Found(val beacon: CrewBeacon) : CrewSighting

    /** 服务名，不是 beacon：它消失时常常已经解析不出地址了。 */
    data class Lost(val name: String) : CrewSighting
}
