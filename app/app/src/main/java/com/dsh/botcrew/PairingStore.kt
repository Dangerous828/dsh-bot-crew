package com.dsh.botcrew

import android.content.Context

/**
 * 配好的电脑存在本机。下次开 App 直接连，不用再输码。
 *
 * 用 SharedPreferences 而不是明文文件：这里存的是能否进这台电脑的凭据，
 * 放在应用私有目录里已经够了，不需要再叠一层加密（那会引出一个要自己保管的密钥）。
 */
class PairingStore(context: Context) {
    private val store = context.getSharedPreferences("crew-pairing", Context.MODE_PRIVATE)

    fun load(): PairedCrew? {
        val saved = stored()
        if (saved != null) return saved
        // 没有存过就回落到构建期内置的那份。调试包用它直接进队伍，不用手输地址和码。
        val device = BuildConfig.CREW_DEVICE
        val credential = BuildConfig.CREW_CREDENTIAL
        if (device.isNotBlank() && credential.isNotBlank()) {
            return PairedCrew(device, credential, CrewPairing.normalize(BuildConfig.GW_BASE))
        }
        return null
    }

    /** 本机真的存过的那份；内置的那份不算，它在 load 里作为回落。 */
    fun stored(): PairedCrew? = PairingRecord.read(store.all)

    fun save(paired: PairedCrew) {
        // 先清再写：字段是一组固定的键，逐条 put 会把上次残留的、这次不该有的值留在盘上。
        val editor = store.edit().clear()
        for ((key, value) in PairingRecord.write(paired)) editor.putString(key, value)
        editor.apply()
    }

    /** 忘掉这台电脑。断开连接用它，不是「退出登录」。 */
    fun clear() {
        store.edit().clear().apply()
    }
}

/**
 * 盘上那几格与 [PairedCrew] 之间的搬运。
 *
 * 单独抽出来是因为 SharedPreferences 在 JVM 单测里跑不了，而这层映射必须被测到：
 * 少读一格不会报错，只会表现为「每次启动都当成没配过」，或者某个入口静默消失。
 */
object PairingRecord {
    const val DEVICE = "deviceId"
    const val TOKEN = "token"
    const val BASE = "base"
    const val FALLBACK = "fallbackBase"
    const val P2P = "p2pAddr"
    const val CREW = "crew"

    /** 缺前三格就不算一份配对；其余几格缺了读成空串，那是「这台电脑没有这项」。 */
    fun read(values: Map<String, Any?>): PairedCrew? {
        val device = values[DEVICE] as? String ?: return null
        val token = values[TOKEN] as? String ?: return null
        val base = values[BASE] as? String ?: return null
        return PairedCrew(
            deviceId = device,
            token = token,
            base = base,
            fallbackBase = values[FALLBACK] as? String ?: "",
            p2pAddr = values[P2P] as? String ?: "",
            crew = values[CREW] as? String ?: "",
        )
    }

    fun write(paired: PairedCrew): Map<String, String> = mapOf(
        DEVICE to paired.deviceId,
        TOKEN to paired.token,
        BASE to paired.base,
        FALLBACK to paired.fallbackBase,
        P2P to paired.p2pAddr,
        CREW to paired.crew,
    )
}

/** 设备自报的名字。配对时电脑靠它认人，所以取个能一眼认出来的。 */
fun deviceName(): String {
    val brand = android.os.Build.BRAND.orEmpty()
    val model = android.os.Build.MODEL.orEmpty()
    return listOf(brand, model).filter(String::isNotBlank).joinToString(" ").ifBlank { "Android 设备" }
}

/** deviceId 只要稳定且不重复；ANDROID_ID 在重装应用前不变。 */
fun deviceId(context: Context): String {
    @Suppress("HardwareIds")
    val id = android.provider.Settings.Secure.getString(context.contentResolver, android.provider.Settings.Secure.ANDROID_ID)
    return id?.takeIf { it.isNotBlank() } ?: "android-unknown"
}
