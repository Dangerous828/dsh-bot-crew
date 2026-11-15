package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「附近设备权限问过没有」这一格的持久化（#34）。
 *
 * 真机上那个 bug 的机制是：判据存在 composable 级 `rememberSaveable` 里，
 * 从队伍页点「重新配对」时 `PairingScreen` 重新进场、那一格不恢复，于是又弹一次系统框
 * （18:14 拒绝、18:21 重进又弹）。修法是把判据落盘 —— 所以这里钉的就是**落盘那层**：
 *
 * - 写一次、读回来是 true（进程重启后仍在，因为 SharedPreferences 本来就是跨进程的）；
 * - 缺键 / 坏值一律读成「没问过」：宁可多问一次，也不要把「没问过」误判成「问过」而
 *   永远不给自动发现；
 * - 键名与配对记录不相交：`PairingStore.save()` 是「先 clear 再写」，同文件同键会在一次
 *   广播刷新时被抹掉，那等于把 #34 修回去。
 *
 * 「屏幕会不会据此不再弹」在 `PairingScreenStateTest` 里钉（判据是 CrewNearby.shouldAsk）。
 */
class PermissionRecordTest {

    // 弹框那一刻写、下次读回来还是「问过」。这一条对应进程被杀后重进、以及重启 App。
    @Test
    fun askingOnceIsRememberedAcrossRestarts() {
        assertFalse("没写过就是没问过", PermissionRecord.asked(emptyMap()))
        val afterAsking = PermissionRecord.write()
        assertTrue("写过之后就是问过了", PermissionRecord.asked(afterAsking))
        // 「重启」在这层就是重新读一次盘：同一份 map 再判一次，结论不变。
        assertTrue(PermissionRecord.asked(afterAsking))
    }

    // 缺键 / 空值 / 类型不对：一律当没问过。
    // 反过来（把「没问过」当成「问过」）会让自动发现永远不启动，那是更糟的失败方向。
    @Test
    fun aMissingOrBrokenValueMeansNeverAsked() {
        assertFalse(PermissionRecord.asked(mapOf()))
        assertFalse(PermissionRecord.asked(mapOf(PermissionRecord.ASKED to null)))
        assertFalse(PermissionRecord.asked(mapOf(PermissionRecord.ASKED to "true")))
        assertFalse(PermissionRecord.asked(mapOf(PermissionRecord.ASKED to 1)))
        assertTrue(PermissionRecord.asked(mapOf(PermissionRecord.ASKED to true)))
    }

    /**
     * #34 的隔离决策：这一格归 [PermissionStore]，不归 [PairingStore]。
     *
     * `PairingStore.save()` 是「先 clear 再写」，而 `clear()` 抹的是整个文件、**不看键名** ——
     * 所以「键名不撞」保护不了它：并进同一个文件，一次 mDNS 广播刷新（`refresh` → `save`）
     * 就会把「问过」抹回「没问过」，重新配对时又弹一次框，正是 #34 换个地方复发。
     *
     * ## 这条测试能证明什么、不能证明什么
     *
     * 能证明：两个 prefs 文件的名字不同 —— 这是隔离的**决策**。
     * 不能证明：`getSharedPreferences` 那一行真的引用了这个常量（把它换成字面量，测试仍绿）。
     * 这个 seam 在 JVM 上不存在：SharedPreferences 要真 Context，项目没引 mock 框架。
     * 所以「实现真的用了另一个文件」由两样东西兜：编译期 `PairingStore` 没有这个 API
     * （写不出调用），以及真机上 `run-as <pkg> ls shared_prefs/` 必须同时有
     * `crew-pairing.xml` 与 `crew-permission.xml`（已写进给 phone-final 的验收步骤）。
     * 不在这里假装测到了。
     */
    @Test
    fun theAskedFlagLivesInADifferentPreferencesFileThanThePairingRecord() {
        assertTrue(
            "「问过」必须与配对记录分文件：save() 的 clear 不看键名",
            PermissionStore.PERMISSION_PREFS != PairingRecord.PAIRING_PREFS,
        )
        assertFalse(PermissionStore.PERMISSION_PREFS.isBlank())
        assertFalse(PairingRecord.PAIRING_PREFS.isBlank())
        // 写出去的键集合只该有那一格：多写一格就是多一处会被 clear 语义牵连的状态。
        assertEquals(setOf(PermissionRecord.ASKED), PermissionRecord.write().keys)
    }

    // 「问过」那一格不许占用配对记录的键名。分文件已经挡住了 clear，这条是第二道：
    // 万一将来有人把两个文件合回去，键名相撞会让 save() 直接覆盖它。
    @Test
    fun theAskedKeyIsNotOneOfThePairingRecordKeys() {
        val pairingKeys = setOf(
            PairingRecord.DEVICE,
            PairingRecord.TOKEN,
            PairingRecord.BASE,
            PairingRecord.FALLBACK,
            PairingRecord.P2P,
            PairingRecord.CREW,
            PairingRecord.SESSION,
        )
        assertFalse(PermissionRecord.ASKED in pairingKeys)
    }

    // 写完再读，与「屏幕上第一次进这一屏读到的东西」一致：
    // 首次进屏读 false（于是会问一次），问过之后读 true（于是永不重问）。
    @Test
    fun theFirstVisitAsksAndEveryLaterVisitDoesNot() {
        // 首次：盘上没有。
        val firstVisit = PermissionRecord.asked(emptyMap())
        assertTrue(
            "首次进屏该问一次",
            CrewNearby.shouldAsk(sdk = 34, permitted = false, asked = firstVisit),
        )
        // 弹框那一刻落盘。
        val onDisk = PermissionRecord.write()
        // 之后每一次进屏（重新配对、转屏重建、杀进程重启）读到的都是 true。
        val laterVisit = PermissionRecord.asked(onDisk)
        assertFalse(
            "问过之后重新配对不许再弹",
            CrewNearby.shouldAsk(sdk = 34, permitted = false, asked = laterVisit),
        )
        // 人去系统设置里给了权限再回来：permitted 变 true，更不该弹。
        assertFalse(CrewNearby.shouldAsk(sdk = 34, permitted = true, asked = laterVisit))
    }
}
