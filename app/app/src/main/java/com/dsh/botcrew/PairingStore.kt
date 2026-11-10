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
    fun stored(): PairedCrew? {
        val device = store.getString("deviceId", null) ?: return null
        val token = store.getString("token", null) ?: return null
        val base = store.getString("base", null) ?: return null
        return PairedCrew(device, token, base)
    }

    fun save(paired: PairedCrew) {
        store.edit()
            .putString("deviceId", paired.deviceId)
            .putString("token", paired.token)
            .putString("base", paired.base)
            .apply()
    }

    /** 忘掉这台电脑。断开连接用它，不是「退出登录」。 */
    fun clear() {
        store.edit().clear().apply()
    }
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
