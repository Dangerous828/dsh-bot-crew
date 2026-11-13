package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 入口表的运行期重排。
 *
 * P2P 是后台接上的：接通之前表里没有它，接通之后必须立刻排到最前面，否则这一整次会话
 * 都还在绕远路。重排还得干净 —— 不重复、不丢别的路、空地址不进表。
 *
 * 只测纯逻辑：真的发请求要网络，不在这里跑。
 */
class CrewClientRouteTest {

    private fun client(vararg entries: String) = CrewClient(entries.toList(), token = "tok-1")

    // 接通的 P2P 排到最前，其余按原来的先后跟在后面。
    @Test
    fun aPromotedEntryJumpsToTheFrontAndTheRestKeepTheirOrder() {
        val crew = client("http://192.168.31.127:43499", "https://crew.example.top")
        crew.promote("http://127.0.0.1:43001")
        assertEquals(
            listOf("http://127.0.0.1:43001", "http://192.168.31.127:43499", "https://crew.example.top"),
            crew.routeOrder(),
        )
    }

    // 已经在表里的那条被提到最前时是「挪」不是「再添一条」：同一条路试两遍只是多等一次超时。
    @Test
    fun promotingAnEntryAlreadyInTheTableMovesItInsteadOfDuplicating() {
        val crew = client("http://a:1", "http://b:1")
        crew.promote("http://b:1")
        assertEquals(listOf("http://b:1", "http://a:1"), crew.routeOrder())
    }

    // 反复提同一条：表不动，也不会越提越长。
    @Test
    fun promotingTheSameEntryTwiceChangesNothing() {
        val crew = client("http://a:1", "http://b:1")
        crew.promote("http://a:1")
        crew.promote("http://a:1")
        assertEquals(listOf("http://a:1", "http://b:1"), crew.routeOrder())
    }

    // 空地址不许进表：它不指向任何地方，留着只会让请求先白等一次超时。
    @Test
    fun anEmptyEntryIsNeverPromotedIntoTheTable() {
        val crew = client("http://a:1")
        crew.promote("")
        crew.promote("   ")
        assertEquals(listOf("http://a:1"), crew.routeOrder())
    }

    // 构造时就把空地址丢掉（配对记录坏掉时会是空串）。
    @Test
    fun blankEntriesAreDroppedWhenTheTableIsBuilt() {
        assertEquals(listOf("http://a:1"), client("", "  ", "http://a:1").routeOrder())
    }

    // 手输的地址要归一化：少个 scheme、多个尾斜杠都会让拼出来的 URL 连不上。
    @Test
    fun aHandWrittenEntryIsNormalisedBeforeItEntersTheTable() {
        assertEquals(listOf("http://10.0.0.9:43499"), client("10.0.0.9:43499/").routeOrder())
    }

    // 重新发现换了地址：整张表换掉，归一化 + 去重。
    @Test
    fun replacingTheTableSwapsInTheFreshAddress() {
        val crew = client("http://192.168.31.127:43499", "https://crew.example.top")
        crew.replaceEntries(listOf("10.0.0.9:43499/", "https://crew.example.top", "https://crew.example.top"))
        assertEquals(
            listOf("http://10.0.0.9:43499", "https://crew.example.top"),
            crew.routeOrder(),
        )
    }

    // 当前在用的 P2P 代理若还在新表里，必须继续用它 —— 换表不许打断正在跑的隧道。
    @Test
    fun replacingTheTableKeepsTheCurrentP2pEntry() {
        val crew = client("http://192.168.31.127:43499")
        val proxy = "http://127.0.0.1:43001"
        crew.promote(proxy)
        assertEquals(proxy, crew.currentEntry())
        crew.replaceEntries(listOf("http://10.0.0.9:43499", proxy, "https://crew.example.top"))
        assertEquals(
            listOf("http://10.0.0.9:43499", proxy, "https://crew.example.top"),
            crew.routeOrder(),
        )
        // 表换了，但「当前入口」仍是 P2P 代理，没被强行拉回旧 LAN。
        assertEquals(proxy, crew.currentEntry())
    }

    // 当前入口不在新表里时才回落到第一条。
    @Test
    fun aCurrentEntryMissingFromTheNewTableFallsBackToTheFirst() {
        val crew = client("http://old:1", "http://keep:2")
        crew.promote("http://old:1")
        crew.replaceEntries(listOf("http://new:3", "http://keep:2"))
        assertEquals("http://new:3", crew.currentEntry())
    }

    // 空表不许把入口清光：那样每条请求都会直接报「没有可用的入口」。
    @Test
    fun anEmptyReplacementNeverWipesTheTable() {
        val crew = client("http://a:1")
        crew.replaceEntries(emptyList())
        crew.replaceEntries(listOf("", "  "))
        assertEquals(listOf("http://a:1"), crew.routeOrder())
    }
}
