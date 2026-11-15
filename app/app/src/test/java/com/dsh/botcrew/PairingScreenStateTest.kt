package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 配对屏上三件事的行为回归：#31 待复核、#32 手改不被抢、#34 问过不再弹。
 *
 * 这里测的是**屏幕真的会走的那段代码**，不是「同名的纯函数」：
 *
 * - #32 的置位在 [AddressField] 里，屏幕改地址只能产出一个新的 `AddressField` ——
 *   所以「onValueChange 之后 autoPick 恒 null」这条断言测的就是真路径。旧版把置位写成
 *   屏幕里的一行 `touched = true`，纯函数测试全绿也证明不了它还在，那正是 #32 说的假保障。
 * - #34 的判据是 [CrewNearby.shouldAsk]，它的输入全部来自屏幕实际会读的地方
 *   （SDK 版本 / checkSelfPermission / 持久层的 asked）。`asked` 落盘语义见
 *   `PairingRecordTest`（同一层 SharedPreferences 的键），这里钉判定表。
 * - #31 的判据是 [CrewNearby.stale] + [NearbyCopy.staleRow] + [NearbyCopy.one]：
 *   它们只**显示**与**触发一次确认**，绝不摘行 —— 摘行仍然只听 `onServiceLost`。
 */
class PairingScreenStateTest {

    private fun spot(name: String, base: String = "http://10.0.0.1:8788", foundAt: Long = 0L) =
        CrewNearby.Spot(name, base, foundAt = foundAt)

    // ── #32：手改之后，任何后续发现都不许改地址 ────────────────────────────────

    // 这一条是 #32 的核心：模拟屏幕真的收到一次输入事件（onValueChange → typed），
    // 然后模拟发现流又来了新的一台。地址必须一个字都不变。
    @Test
    fun typingThenAnotherBeaconNeverOverwritesTheAddress() {
        var field = AddressField.start("http://192.168.31.127:43499")
        // 人在输入框里打成了别的地址 —— 这就是 onValueChange 走的那一步。
        field = field.typed("10.9.9.9:1")
        assertEquals("10.9.9.9:1", field.address)
        assertTrue(field.touched)

        // 发现流来一台（单台，正是「会被自动填」的那个条件）。
        field = field.autoFilled(listOf(spot("dsh-crew-a")))
        assertEquals("10.9.9.9:1", field.address)

        // 再来一台、再走一台，仍然不许动。
        field = field.autoFilled(listOf(spot("dsh-crew-a"), spot("dsh-crew-b")))
        assertEquals("10.9.9.9:1", field.address)
        field = field.autoFilled(listOf(spot("dsh-crew-b", "http://10.0.0.2:8788")))
        assertEquals("10.9.9.9:1", field.address)

        // 最后只剩一台、地址又不是它：还是不许动。换回去的入口是列表那一行，不是自动填。
        field = field.autoFilled(listOf(spot("dsh-crew-a")))
        assertEquals("10.9.9.9:1", field.address)
        assertTrue(field.touched)
    }

    // 反过来：人没动过时，单台必须填上 —— 否则这条回归锁会把「自动填」也锁死。
    @Test
    fun anUntouchedFieldStillGetsFilledByASingleCrew() {
        val field = AddressField.start("http://192.168.31.127:43499").autoFilled(listOf(spot("dsh-crew-a")))
        assertEquals("http://10.0.0.1:8788", field.address)
        // 自动填不是「人改过」：之后仍然允许跟着广播走（同一台换了端口要跟上）。
        assertFalse(field.touched)
    }

    // 人点列表里那一行是明确的选择，可以覆盖手改过的地址（这是唯一能覆盖的路径）。
    @Test
    fun pickingARowIsTheOnlyWayToOverrideAHandEditedAddress() {
        val field = AddressField.start("10.9.9.9:1").typed("10.9.9.9:1").picked(spot("dsh-crew-a"))
        assertEquals("http://10.0.0.1:8788", field.address)
        assertTrue(field.touched)
    }

    // 自动填在「已经是它」时必须原样返回同一个实例：返回新对象会让调用方的 effect
    // 每次都认为状态变了，和重组互相推动。
    @Test
    fun autoFillThatChangesNothingReturnsTheSameInstance() {
        val already = AddressField.start("http://10.0.0.1:8788")
        val same = already.autoFilled(listOf(spot("dsh-crew-a")))
        assertTrue("没有变化时必须是同一个实例", same === already)
        // 多台 / 人改过这两档也一样：不产生新值。
        val many = already.autoFilled(listOf(spot("a"), spot("b")))
        assertTrue(many === already)
        val touched = AddressField.start("10.9.9.9:1").typed("10.9.9.9:1")
        assertTrue(touched.autoFilled(listOf(spot("a"))) === touched)
    }

    // ── #32：文案在「手改过 + 单台在列」时不许说「已自动找到 X」──────────────

    // 真机那个状态：地址框是 10.9.9.9:1，广播里只有 dsh-crew-0kvcc5t。
    // 旧文案「已自动找到 X，点一下填上地址」读起来像「已经帮你填成 X 了」—— 与事实相反。
    @Test
    fun theSingleCrewLineDoesNotClaimItFilledAHandEditedAddress() {
        val line = NearbyCopy.one("dsh-crew-0kvcc5t", filled = false, handEdited = true)
        assertFalse("不许说成已自动找到", line.contains("已自动找到"))
        assertTrue("要说清地址是人自己填的", line.contains("你自己填的"))
        assertTrue("要指出换回去的入口", line.contains("点下面那行"))
    }

    // 三档话必须彼此可分：没填过 / 填好了 / 人改过。
    @Test
    fun theThreeSingleCrewStatesReadDifferently() {
        val untouched = NearbyCopy.one("X", filled = false)
        val filled = NearbyCopy.one("X", filled = true)
        val edited = NearbyCopy.one("X", filled = false, handEdited = true)
        assertEquals("已自动找到 X，点一下填上地址。", untouched)
        assertEquals("已自动找到 X，地址已填好。", filled)
        assertTrue(untouched != filled && filled != edited && untouched != edited)
    }

    // ── #31：待复核只显示 + 只触发确认，绝不摘行 ─────────────────────────────

    // 一行「刚响过」不算待复核：门槛内点它不产生额外等待。
    @Test
    fun aRowHeardJustNowIsNotUpForReview() {
        val fresh = spot("a", foundAt = 1_000)
        assertFalse(CrewNearby.stale(fresh, now = 1_000))
        assertFalse(CrewNearby.stale(fresh, now = 1_000 + CrewNearby.STALE_AFTER_MS - 1))
        assertFalse(CrewNearby.needsCheck(fresh, now = 1_000))
    }

    // 超过门槛才算待复核；门槛取的是「大于一次正常重复广播间隔」的那一档。
    @Test
    fun aRowThatHasBeenQuietPastTheThresholdIsUpForReview() {
        val quiet = spot("a", foundAt = 1_000)
        assertTrue(CrewNearby.stale(quiet, now = 1_000 + CrewNearby.STALE_AFTER_MS))
        assertTrue(CrewNearby.needsCheck(quiet, now = 1_000 + CrewNearby.STALE_AFTER_MS))
        // 待复核要能点出「多久以前」，单位是秒。
        assertEquals(90L, CrewNearby.silence(spot("a", foundAt = 1_000), now = 1_000 + 90_000) / 1_000)
    }

    // 没有时钟证据（老路径来的行 / 没记过 foundAt）一律不算待复核：
    // 凭空多等一次握手只会让人觉得 App 卡。
    @Test
    fun aRowWithoutAClockIsNeverUpForReview() {
        val unknown = spot("a", foundAt = 0)
        assertFalse(CrewNearby.stale(unknown, now = 999_999_999))
        assertFalse(CrewNearby.needsCheck(unknown, now = 999_999_999))
        assertEquals(0L, CrewNearby.silence(unknown, now = 999_999_999))
    }

    // 时钟被往回拨：沉默时长压成 0，不说「负几秒前」。
    @Test
    fun aClockThatWentBackwardsDoesNotProduceNegativeSilence() {
        val s = spot("a", foundAt = 10_000)
        assertEquals(0L, CrewNearby.silence(s, now = 5_000))
        assertFalse(CrewNearby.stale(s, now = 5_000))
    }

    // **这条是 #31 的边界锁**：待复核的行仍然留在表里，哪怕之后又有别的队伍广播进来。
    // 判据（stale）不参与表的增删 —— 表的增删只有 Found / Lost 两个入口。
    @Test
    fun aStaleRowStaysInTheTableUntilTheSystemReportsItLost() {
        var spots = emptyList<CrewNearby.Spot>()
        spots = CrewNearby.merge(spots, CrewSighting.Found(CrewBeacon("a", "http://10.0.0.1:1")), now = 1_000)
        spots = CrewNearby.merge(spots, CrewSighting.Found(CrewBeacon("b", "http://10.0.0.2:1")), now = 1_000)
        val veryLate = 10 * 60 * 1000L
        // 十分钟后 b 又响了一次（正常再播）。这一刻 a 早已「待复核」——
        // 但表里必须还是两行：按时长摘行就是误删一台可能还活着的队伍。
        spots = CrewNearby.merge(spots, CrewSighting.Found(CrewBeacon("b", "http://10.0.0.2:1")), now = veryLate)
        assertEquals(listOf("a", "b"), spots.map { it.name })
        assertTrue("a 该被标成待复核", CrewNearby.stale(spots[0], veryLate))
        assertFalse("b 刚响过，不该被标", CrewNearby.stale(spots[1], veryLate))
        // 只有 Lost 才摘，且只摘那一行。
        spots = CrewNearby.merge(spots, CrewSighting.Lost("a"), now = veryLate)
        assertEquals(listOf("b"), spots.map { it.name })
    }

    // 每来一条 Found 都要刷新 foundAt：不然「多久没响」永远停在第一次的时刻，
    // 一台每 20 秒正常再播的电脑会被误判成待复核。
    @Test
    fun everyFoundRefreshesTheLastHeardClock() {
        var spots = CrewNearby.merge(emptyList(), CrewSighting.Found(CrewBeacon("a", "http://10.0.0.1:1")), now = 1_000)
        assertEquals(1_000L, spots[0].foundAt)
        spots = CrewNearby.merge(spots, CrewSighting.Found(CrewBeacon("a", "http://10.0.0.1:1")), now = 41_000)
        assertEquals(41_000L, spots[0].foundAt)
        // 刚刷新过：不算待复核。
        assertFalse(CrewNearby.stale(spots[0], now = 41_000))
        // 位置与条数不变（同一台只一行）。
        assertEquals(1, spots.size)
    }

    // 小字与那句提示都要能读出来，且不许出现「失败」「出错」这类字 ——
    // 待复核不是错误，只是「点它之前先确认一下」。
    @Test
    fun theReviewLineSaysWhatItKnowsNotWhatWentWrong() {
        assertEquals("上次发现 45 秒前 · 待复核", NearbyCopy.staleRow(45))
        assertEquals("上次发现 2 分钟前 · 待复核", NearbyCopy.staleRow(120))
        assertEquals("上次发现 2 小时前 · 待复核", NearbyCopy.staleRow(2 * 3_600))
        val line = NearbyCopy.one("X", filled = true, staleSeconds = 45)
        assertTrue(line.startsWith("已自动找到 X，地址已填好。"))
        assertTrue(line.contains("上次发现 45 秒前"))
        assertTrue(line.contains("先确认"))
        for (word in listOf("失败", "出错", "错误")) {
            assertFalse("$word 不该出现在待复核的说明里", line.contains(word))
        }
    }

    // 复核那句「上次发现于 X」必须把 silence(毫秒) 换成秒再交给 age()。
    // 真机实测抓到的单位 bug：直接传毫秒，2 分钟前被显示成「33 小时前」。
    // 这里钉死：把 silence() 的毫秒按 1000 折算后，age() 说人话。
    @Test
    fun theRecheckSentenceConvertsMillisToSecondsBeforeAging() {
        // foundAt=1000ms，now=121000ms → silence=120000ms=2 分钟。
        val spot = spot("a", foundAt = 1_000)
        val silenceMs = CrewNearby.silence(spot, now = 121_000)
        assertEquals(120_000L, silenceMs)
        // 正确折算：先 /1000 再 age，得到「2 分钟前」。
        assertEquals("2 分钟前", NearbyCopy.age(silenceMs / 1_000))
        // 反面：直接把毫秒喂给 age 会得到荒谬的小时数 —— 证明这个 /1000 是必需的、不能省。
        assertNotEquals("2 分钟前", NearbyCopy.age(silenceMs))
    }

    // ── #34：问过就不许再弹 ─────────────────────────────────────────────────

    // 13+、没给、没问过：问。这是唯一该弹的情形。
    @Test
    fun thePermissionIsAskedOnlyOnceOnAndroid13AndUp() {
        assertTrue(CrewNearby.shouldAsk(sdk = 33, permitted = false, asked = false))
        assertTrue(CrewNearby.shouldAsk(sdk = 34, permitted = false, asked = false))
    }

    // 13+、没给、**问过**：不弹。这是 #34 的根因所在 —— 旧判据用 composable 级
    // rememberSaveable 存「问过」，从队伍页点「重新配对」重新进场时不恢复，于是又弹一次。
    @Test
    fun aDeniedAnswerIsNeverAskedAgain() {
        assertFalse(CrewNearby.shouldAsk(sdk = 34, permitted = false, asked = true))
    }

    // 已经给了：不弹（不管问没问过）。
    @Test
    fun anAlreadyGrantedPermissionIsNotAsked() {
        assertFalse(CrewNearby.shouldAsk(sdk = 34, permitted = true, asked = false))
        assertFalse(CrewNearby.shouldAsk(sdk = 34, permitted = true, asked = true))
    }

    // 12 及以下没有这项权限：问了只会被系统当场拒，所以从不问。
    @Test
    fun devicesWithoutThatPermissionAreNeverAsked() {
        assertFalse(CrewNearby.shouldAsk(sdk = 26, permitted = false, asked = false))
        assertFalse(CrewNearby.shouldAsk(sdk = 32, permitted = false, asked = false))
    }

    // 拒绝之后那句提示要指出「系统不会再弹」和「回来按哪个按钮」——
    // 否则人只会以为这 App 忘了（#34 的另一半：不把永久拒绝掩盖成「没有权限」）。
    @Test
    fun theDeniedLineExplainsWhyNoDialogWillAppearAgain() {
        assertTrue(NearbyCopy.DENIED.contains("被拒过"))
        assertTrue(NearbyCopy.DENIED.contains("不会再弹框"))
        assertTrue(NearbyCopy.DENIED.contains("系统设置"))
        assertTrue(NearbyCopy.DENIED.contains("再找一次"))
        // 与「没问过」那一档必须分开：那是「没给」，不是「拒过」。
        assertTrue(NearbyCopy.DENIED != NearbyCopy.NO_PERMISSION)
    }

    // 「再找一次」只重看权限、重开发现，不许再触发弹框：它的判据是 shouldAsk，
    // 而问过之后 shouldAsk 恒 false。
    @Test
    fun retryingNeverReopensTheSystemDialog() {
        val asked = true
        assertFalse(CrewNearby.shouldAsk(sdk = 34, permitted = false, asked = asked))
        // 人去系统设置里给了之后回来：permitted 变 true，发现自己回来，仍然不弹。
        assertFalse(CrewNearby.shouldAsk(sdk = 34, permitted = true, asked = asked))
    }

    // 判据与「要不要这项权限」是两件事：13+ 需要，12 不需要；但「该不该弹」还要求没问过。
    @Test
    fun needingThePermissionIsNotTheSameAsHavingToAskForIt() {
        assertTrue(CrewNearby.needsPermission(33))
        assertFalse(CrewNearby.shouldAsk(33, permitted = false, asked = true))
        assertFalse(CrewNearby.needsPermission(32))
        assertFalse(CrewNearby.shouldAsk(32, permitted = false, asked = false))
    }

    // 地址归一化与「填的是不是这一台」不受这次改动影响，但它是上面所有分支的前提：
    // 人打 `10.0.0.1:8788` 与广播里的 `http://10.0.0.1:8788` 必须认成同一台。
    @Test
    fun theFieldRecognisesTheSameAddressWrittenDifferently() {
        val field = AddressField.start("10.0.0.1:8788")
        assertTrue(field.holds(spot("a", "http://10.0.0.1:8788")))
        assertFalse(field.holds(spot("b", "http://10.0.0.2:8788")))
        assertNull(CrewNearby.autoPick(listOf(spot("a"), spot("b")), touched = false))
    }
}
