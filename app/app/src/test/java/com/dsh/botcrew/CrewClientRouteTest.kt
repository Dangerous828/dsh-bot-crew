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
}
