package com.dsh.botcrew

import android.content.Context

/**
 * 配好的电脑存在本机。下次开 App 直接连，不用再输码。
 *
 * 用 SharedPreferences 而不是明文文件：这里存的是能否进这台电脑的凭据，
 * 放在应用私有目录里已经够了，不需要再叠一层加密（那会引出一个要自己保管的密钥）。
 */
class PairingStore(context: Context) {
    private val store = context.getSharedPreferences(PairingRecord.PAIRING_PREFS, Context.MODE_PRIVATE)

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

    /**
     * 启动诊断用：区分 prefs 的三种真实状态，**不**用「读到 null 就当没配对」掩盖 parse 错误。
     *
     * - [PairingRecord.ReadState.MISSING]：三个必填键（device/token/base）一个都没有 —— 真没存过。
     * - [PairingRecord.ReadState.LOADED]：三键齐全且形状合法 —— 读到了一份配对。
     * - [PairingRecord.ReadState.PARSE_ERROR]：三键有残留但形状不合法（缺 base、值不是字符串、base 归一后为空等）。
     *
     * 只读不改盘：parse_error 时**保留原始损坏 prefs**，绝不自动配对覆盖，留待人修。
     * 汇报里带 [PairingRecord.ReadState.detail]（键名层面，不含凭据值）。
     */
    fun probeReadState(): PairingRecord.ReadState = PairingRecord.probeState(store.all)

    fun save(paired: PairedCrew) {
        // 先清再写：字段是一组固定的键，逐条 put 会把上次残留的、这次不该有的值留在盘上。
        // SESSION 是唯一例外 —— 当前会话只有一个写入口 [saveSession]。
        // 重新发现 / 刷新入口表这类全量写必须保留盘上现值，否则一次广播就把人切到的
        // 会话抹回 main。机制落在这一层，不靠每个调用点记得补值。
        val currentSession = session()
        val editor = store.edit().clear()
        for ((key, value) in PairingRecord.writeForSave(paired, currentSession)) editor.putString(key, value)
        editor.apply()
    }

    /**
     * 上次停在哪个会话。名单不落盘（每次启动从后端拉），只持久化当前这一格。
     * 缺键 / 坏值一律回落 main，与 [PairingRecord.read] 同一条规矩。
     */
    fun session(): String = PairingRecord.session(store.all)

    /**
     * 只改当前会话这一个键：不动凭据与三条路，也不重建连接。
     *
     * 切会话时改 `paired` 状态会重启 MainActivity 的 P2P 隧道（那段 LaunchedEffect
     * 以 paired 为 key），所以这里刻意单独写盘，界面状态与隧道都留在原处。
     */
    fun saveSession(session: String) {
        store.edit().putString(PairingRecord.SESSION, session).apply()
    }

    /** 忘掉这台电脑。断开连接用它，不是「退出登录」。 */
    fun clear() {
        store.edit().clear().apply()
    }
}

/**
 * 「附近设备权限问过没有」。**跨 composable 生命周期、跨进程重启**成立（#34）。
 *
 * ## 为什么它是独立的一层，而不是 [PairingStore] 里的一格
 *
 * 真机上那个 bug 的机制是：判据存在 composable 级 `rememberSaveable` 里，从队伍页点
 * 「重新配对」时 `PairingScreen` 重新进场、那一格不恢复，于是又弹一次系统框
 * （18:14 拒绝、18:21 重进又弹）。把判据落盘就够了吗？不够 —— 落进**配对记录那个文件**
 * 一样会被抹掉：`PairingStore.save()` 是「先 clear 再写」，而 `clear()` 抹的是整个文件、
 * **不看键名**。一次 mDNS 广播刷新（`refresh` → `save`）就会把「问过」抹回「没问过」。
 *
 * 所以隔离不能靠「键名不撞」这种约定，得靠**所有权**：这一格归 [PermissionStore]，
 * [PairingStore] 根本不认识它，两个类各开各的文件。谁想把它挪回去，就得先改构造、再删类 ——
 * 那是一次看得见的改动。
 *
 * ## 为什么判定与读写分成两半
 *
 * SharedPreferences 在 JVM 单测里跑不了，而这一格出错的表现是「每次重新配对都弹一次框」，
 * 必须能测。所以「盘上那份 map → 问过没有」是 [PermissionRecord] 的纯函数，读写在 [PermissionStore]。
 */
class PermissionStore(context: Context) {
    /** 与 `crew-pairing` 是不同的文件。见类注释：save() 的 clear 不看键名。 */
    private val store = context.getSharedPreferences(PERMISSION_PREFS, Context.MODE_PRIVATE)

    fun asked(): Boolean = PermissionRecord.asked(store.all)

    /**
     * 记下「问过了」。在**弹框那一刻**就写，不等回调：进程在弹框期间被杀，
     * 下次进来也不该再问一遍。
     */
    fun markAsked() {
        val editor = store.edit()
        for ((key, value) in PermissionRecord.write()) editor.putBoolean(key, value)
        editor.apply()
    }

    companion object {
        /** 「问过没有」那个 prefs 文件。与 [PairingRecord.PAIRING_PREFS] 必须不同名。 */
        const val PERMISSION_PREFS = "crew-permission"
    }
}

/** 盘上那一格与「问过没有」之间的搬运。缺键 / 坏值一律当没问过：宁可多问一次。 */
object PermissionRecord {
    /** 只表示「问过一次」，不表示「给了」：给没给永远以 checkSelfPermission 为准。 */
    const val ASKED = "askedNearby"

    fun asked(values: Map<String, Any?>): Boolean = values[ASKED] as? Boolean ?: false

    fun write(): Map<String, Boolean> = mapOf(ASKED to true)
}

/**
 * 盘上那几格与 [PairedCrew] 之间的搬运。
 *
 * 单独抽出来是因为 SharedPreferences 在 JVM 单测里跑不了，而这层映射必须被测到：
 * 少读一格不会报错，只会表现为「每次启动都当成没配过」，或者某个入口静默消失。
 */
object PairingRecord {
    /** 配对记录那个 prefs 文件。`PairingStore.save()` 会 clear 它，所以别的状态不许住这儿。 */
    const val PAIRING_PREFS = "crew-pairing"

    const val DEVICE = "deviceId"
    const val TOKEN = "token"
    const val BASE = "base"
    const val FALLBACK = "fallbackBase"
    const val P2P = "p2pAddr"
    const val CREW = "crew"
    /** 当前会话。老装机没有这一格：读成 main，行为与旧版逐字一致。 */
    const val SESSION = "session"
    /** 服务器自报身份指纹（timeline `server.crew`）与可信公网入口（`server.public_base`）。老记录没有这两格。 */
    const val SERVER_CREW = "serverCrew"
    const val SERVER_PUBLIC_BASE = "serverPublicBase"

    /** 当前会话单独读：缺键、空串、形状不对都回落 main。 */
    fun session(values: Map<String, Any?>): String {
        val saved = values[SESSION] as? String ?: return SessionRoute.MAIN
        return saved.trim().takeIf(SessionRoute::validId) ?: SessionRoute.MAIN
    }

    /** 启动诊断状态。detail 只描述键名层面的问题，绝不带凭据值。 */
    data class ReadState(val state: String, val detail: String = "") {
        companion object {
            const val MISSING = "missing"
            const val LOADED = "loaded"
            const val PARSE_ERROR = "parse_error"
        }
    }

    /**
     * 判定盘上那份配对的真实状态（纯函数，可单测）。
     *
     * 区分三态是为了让「启动快照」真实可观测：旧代码读不到就一律回 null，把「prefs 损坏」伪装成
     * 「没配对」。这里分开：三键全无=MISSING；三键齐全且形状合法=LOADED；有残留但形状不合法=PARSE_ERROR。
     * 解析用与 [read] 同一套门槛（device/token/base 必须是非空字符串，base 归一后非空）。
     */
    fun probeState(values: Map<String, Any?>): ReadState {
        val hasDevice = values.containsKey(DEVICE)
        val hasToken = values.containsKey(TOKEN)
        val hasBase = values.containsKey(BASE)
        if (!hasDevice && !hasToken && !hasBase) return ReadState(ReadState.MISSING)
        val device = values[DEVICE] as? String
        val token = values[TOKEN] as? String
        val base = values[BASE] as? String
        val problems = ArrayList<String>()
        if (device.isNullOrBlank()) problems.add("deviceId 缺失或非文本")
        if (token.isNullOrBlank()) problems.add("token 缺失或非文本")
        if (base.isNullOrBlank() || CrewPairing.normalize(base).isEmpty()) problems.add("base 缺失/非法")
        return if (problems.isEmpty()) ReadState(ReadState.LOADED)
        else ReadState(ReadState.PARSE_ERROR, problems.joinToString("；"))
    }

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
            session = session(values),
            serverCrew = values[SERVER_CREW] as? String ?: "",
            serverPublicBase = values[SERVER_PUBLIC_BASE] as? String ?: "",
        )
    }

    fun write(paired: PairedCrew): Map<String, String> = mapOf(
        DEVICE to paired.deviceId,
        TOKEN to paired.token,
        BASE to paired.base,
        FALLBACK to paired.fallbackBase,
        P2P to paired.p2pAddr,
        CREW to paired.crew,
        SESSION to paired.session,
        SERVER_CREW to paired.serverCrew,
        SERVER_PUBLIC_BASE to paired.serverPublicBase,
    )

    /**
     * 整份保存时用的映射：SESSION 取盘上现值，不取传入的 [PairedCrew.session]。
     *
     * 抽成纯函数是为了给「全量写不会抹掉当前会话」留测试证据 ——
     * SharedPreferences 本身在 JVM 单测里跑不了，机制这一层必须测得到。
     */
    fun writeForSave(paired: PairedCrew, currentSession: String): Map<String, String> =
        write(paired) + (SESSION to currentSession)
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
