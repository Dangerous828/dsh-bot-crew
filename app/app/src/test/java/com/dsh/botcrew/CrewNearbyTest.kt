package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 配对屏上「附近找到了谁」这本账。
 *
 * 三条老毛病各有一节：谁进来都覆盖地址（人打了一半的被抢走）、最后一台赢（同网段几台只能连
 * 最后广播的那台）、13+ 不问权限就静默找不到。前两条这里钉死，第三条只钉「什么版本该问」——
 * 系统弹不弹框不是这段代码能测的。
 *
 * 只测纯逻辑。`CrewDiscovery.find` 要真的 NSD、配对屏要真的 Compose，两者都不在 JVM 单测里跑。
 */
class CrewNearbyTest {

    private fun spot(name: String, base: String = "http://10.0.0.1:8788") = CrewNearby.Spot(name, base)

    // 一台进来一行，两台进来两行。
    @Test
    fun everyCrewInTheNetworkKeepsItsOwnRow() {
        var spots = emptyList<CrewNearby.Spot>()
        spots = CrewNearby.add(spots, CrewBeacon("dsh-crew-a", "http://10.0.0.1:8788"))
        spots = CrewNearby.add(spots, CrewBeacon("dsh-crew-b", "http://10.0.0.2:8788"))
        assertEquals(listOf("dsh-crew-a", "dsh-crew-b"), spots.map { it.name })
        assertEquals("http://10.0.0.2:8788", spots[1].base)
    }

    // 同一个实例被系统重复上报时不能长成两行，地址以最新一次为准。
    @Test
    fun theSameCrewRepeatsIntoOneRowWithTheLatestAddress() {
        var spots = CrewNearby.add(emptyList(), CrewBeacon("dsh-crew-a", "http://10.0.0.1:8788"))
        spots = CrewNearby.add(spots, CrewBeacon("dsh-crew-a", "http://10.0.0.9:8788"))
        assertEquals(1, spots.size)
        assertEquals("http://10.0.0.9:8788", spots[0].base)
    }

    // 地址变了但位置不动：行在列表里跳一下，手指正好按在上面就点错人了。
    @Test
    fun aRepeatDoesNotMoveTheRowToTheBottom() {
        var spots = CrewNearby.add(emptyList(), CrewBeacon("a", "http://10.0.0.1:1"))
        spots = CrewNearby.add(spots, CrewBeacon("b", "http://10.0.0.2:1"))
        spots = CrewNearby.add(spots, CrewBeacon("a", "http://10.0.0.3:1"))
        assertEquals(listOf("a", "b"), spots.map { it.name })
    }

    // 关掉的那台要摘掉，否则列表里留一条点不通的记录。
    @Test
    fun aCrewThatGoesAwayLeavesTheTable() {
        val spots = listOf(spot("a"), spot("b"))
        assertEquals(listOf("b"), CrewNearby.remove(spots, "a").map { it.name })
        // 摘一台本来就不在的：什么也不做，不能顺手把别人删了。
        assertEquals(listOf("a", "b"), CrewNearby.remove(spots, "c").map { it.name })
    }

    @Test
    fun findAndLostEventsBothLandInTheSameTable() {
        var spots = emptyList<CrewNearby.Spot>()
        spots = CrewNearby.merge(spots, CrewSighting.Found(CrewBeacon("a", "http://10.0.0.1:1")))
        spots = CrewNearby.merge(spots, CrewSighting.Found(CrewBeacon("b", "http://10.0.0.2:1")))
        spots = CrewNearby.merge(spots, CrewSighting.Lost("a"))
        assertEquals(listOf("b"), spots.map { it.name })
    }

    // 只有一台、人也没动过：自动填。
    @Test
    fun aSingleCrewFillsTheAddressByItself() {
        assertEquals("a", CrewNearby.autoPick(listOf(spot("a")), touched = false)?.name)
    }

    // 人动过地址框就不再自动填 —— 他手打的就是他要的那台。
    @Test
    fun aHandEditedAddressIsNeverOverwritten() {
        assertNull(CrewNearby.autoPick(listOf(spot("a")), touched = true))
    }

    // 多台不替人挑：随便填一台，等于让人念完码才发现连错了电脑。
    @Test
    fun severalCrewsAreNeverPickedForTheUser() {
        assertNull(CrewNearby.autoPick(listOf(spot("a"), spot("b")), touched = false))
    }

    @Test
    fun nothingFoundMeansNothingToFill() {
        assertNull(CrewNearby.autoPick(emptyList(), touched = false))
    }

    // 「地址框里现在是不是这一台」要认得出没写协议、带尾斜杠的写法，那都是同一台电脑。
    @Test
    fun theSameAddressWrittenDifferentlyStillCountsAsFilled() {
        assertTrue(CrewNearby.holds("http://10.0.0.1:8788", "http://10.0.0.1:8788"))
        assertTrue(CrewNearby.holds("10.0.0.1:8788", "http://10.0.0.1:8788"))
        assertTrue(CrewNearby.holds("http://10.0.0.1:8788/", "http://10.0.0.1:8788"))
        assertFalse(CrewNearby.holds("http://10.0.0.2:8788", "http://10.0.0.1:8788"))
    }

    // 多台就列出来让人选；一台且地址已经是它就不必再列一遍。
    @Test
    fun theListUnderTheFieldOnlyAppearsWhenThereIsAChoice() {
        val a = spot("a", "http://10.0.0.1:8788")
        val b = spot("b", "http://10.0.0.2:8788")
        // 两台：不管地址现在是什么，两行都在。选了谁由那一行的边色说，不靠把别人藏起来。
        assertEquals(2, CrewNearby.rows(listOf(a, b), "http://10.0.0.1:8788").size)
        assertEquals(2, CrewNearby.rows(listOf(a, b), "http://10.0.0.3:9").size)
        // 一台且地址已经填成它：上面那句「已自动找到…」说完了，不重复。
        assertTrue(CrewNearby.rows(listOf(a), "http://10.0.0.1:8788").isEmpty())
        // 一台但地址被手改成别的：这一行是「换回它」的唯一入口，得留着。
        assertEquals(listOf("a"), CrewNearby.rows(listOf(a), "http://10.0.0.7:1").map { it.name })
        assertTrue(CrewNearby.rows(emptyList(), "http://10.0.0.1:8788").isEmpty())
    }

    // 权限只在 Android 13（API 33）起才要：更低版本没这项权限，询问只会被系统直接拒。
    @Test
    fun theNearbyPermissionIsOnlyAskedFromAndroid13() {
        assertFalse(CrewNearby.needsPermission(26))
        assertFalse(CrewNearby.needsPermission(32))
        assertTrue(CrewNearby.needsPermission(33))
        assertTrue(CrewNearby.needsPermission(35))
    }

    // 三档话都不许说成「失败」：没权限、没找到都只是退回手输，手输那条路一直是通的。
    @Test
    fun theQuietLinesSayHowToGoOnNotWhatWentWrong() {
        assertEquals("没有附近设备权限，自动发现关了，地址可以手填", NearbyCopy.NO_PERMISSION)
        assertEquals("没找到附近的队伍，地址可以手填", NearbyCopy.NONE_FOUND)
        assertEquals("已自动找到 林的书房，地址已填好。", NearbyCopy.one("林的书房", filled = true))
        assertEquals("已自动找到 林的书房，点一下填上地址。", NearbyCopy.one("林的书房", filled = false))
    }

    // 多台时先催人挑；点过一台之后改口成「已选中」，别在人家选完之后还催。
    @Test
    fun theSeveralLineStopsAskingOnceOneIsChosen() {
        assertEquals("找到 2 台队伍，点一台填上地址。", NearbyCopy.several(2))
        assertEquals("找到 3 台队伍，点一台填上地址。", NearbyCopy.several(3, picked = null))
        assertEquals("已选中 林的书房，地址已填好。", NearbyCopy.several(3, picked = "林的书房"))
    }
}
