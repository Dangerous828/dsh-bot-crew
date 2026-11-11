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
     * 一路找下去。每发现一台就发一条，重复的同一个实例名不重复发。
     *
     * 找失败（没开组播、系统限流）就结束这一路，不抛给界面：找不到只是退回手输地址，
     * 那不是错误，是「这台网络里没有队伍」。
     */
    fun find(context: Context): Flow<CrewBeacon> = callbackFlow {
        val manager = context.getSystemService(Context.NSD_SERVICE) as? NsdManager
        if (manager == null) { close(); return@callbackFlow }

        val seen = mutableSetOf<String>()

        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {}

            override fun onServiceFound(info: NsdServiceInfo) {
                // 只认自己的类型；系统有时会把同一网段的别的服务也递过来。
                if (!info.serviceType.startsWith("_dsh-crew")) return
                resolve(manager, info) { beacon -> if (seen.add(beacon.name)) trySend(beacon) }
            }

            override fun onServiceLost(info: NsdServiceInfo) {
                seen.remove(info.serviceName)
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
                onFound(CrewBeacon(name = serviceInfo.serviceName, base = "http://$shaped:$port"))
            }
        })
    }
}

/** 找到的一台队伍：名字给人看，`base` 直接填进地址框。 */
data class CrewBeacon(val name: String, val base: String)
