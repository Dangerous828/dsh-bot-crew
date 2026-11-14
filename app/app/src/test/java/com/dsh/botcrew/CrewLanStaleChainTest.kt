package com.dsh.botcrew

import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 整条链：配对记录里的死地址 → 主动探测数出失败 → 判定失效 → 界面那一行说人话。
 *
 * 单看每一层都是对的，接起来才可能出错 —— 而这条链的错误形态正是 issue 里的现象：
 * 界面上只写「公网中转」，人看不出「本来该走局域网、现在为什么没走」。
 *
 * 这里的场景照着真机抄：配对记录里存的是 `192.168.113.134`（Mac 早就换走了），
 * 手机现在在 `192.168.31.0/24`，隧道也没起来，请求落在公网那条上。
 */
class CrewLanStaleChainTest {

    /** 一个答一次就关的本地服务。 */
    private fun answerOnce(status: Int, body: String = "{}"): ServerSocket =
        ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).also { socket ->
            socket.soTimeout = 5_000
            Executors.newSingleThreadExecutor().apply {
                submit {
                    runCatching {
                        socket.accept().use { client ->
                            client.soTimeout = 5_000
                            val input = client.getInputStream().buffered()
                            fun line(): String {
                                val text = StringBuilder()
                                while (true) {
                                    val byte = input.read()
                                    if (byte < 0 || byte == '\n'.code) break
                                    if (byte != '\r'.code) text.append(byte.toChar())
                                }
                                return text.toString()
                            }
                            line()
                            var length = 0
                            while (true) {
                                val header = line()
                                if (header.isEmpty()) break
                                if (header.startsWith("Content-Length:", ignoreCase = true)) {
                                    length = header.substringAfter(':').trim().toInt()
                                }
                            }
                            repeat(length) { input.read() }
                            val bytes = body.toByteArray()
                            client.getOutputStream().apply {
                                write(
                                    ("HTTP/1.1 $status Reply\r\nContent-Length: ${bytes.size}\r\n" +
                                        "Connection: close\r\n\r\n").toByteArray(),
                                )
                                write(bytes)
                                flush()
                            }
                        }
                    }
                }
                shutdown()
            }
        }

    private fun closedPort(): Int = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { it.localPort }

    // 真机现场：配对记录指向一条已经不在这个网段的地址，请求落在公网那条上。
    // 主动探测敲两次之后，界面那一行必须说清「为什么没走直连」。
    @Test
    fun aStaleLanAddressEndsUpExplainedOnTheRouteLine() {
        val lan = "http://127.0.0.1:${closedPort()}"
        val public = answerOnce(200)
        val client = CrewClient(listOf(lan, "http://127.0.0.1:${public.localPort}"), "tok-1")
        try {
            // 第一趟请求：LAN 连不上，落到公网那条。这时 LAN 已经有 1 次失败。
            runBlocking { client.timeline() }
            assertEquals(1, client.failureCount(lan))
            // 一次失败还不够定性：界面上此时不该报失效。
            val early = CrewLanHealth.judge(lan, client.failureCount(lan), listOf("192.168.31.55"), inUse = false)
            assertEquals(CrewLanHealth.Verdict.OK, early.verdict)
            assertEquals("公网中转", CrewLanHealth.routeLine("公网中转", early, CrewRoute.Way.PUBLIC))

            // 之后再也不会自动试它（read 从当前入口开始绕，公网通了就返回），
            // 所以靠主动探测补上第二次证据。
            assertFalse(runBlocking { client.probeEntry(lan) })
            assertEquals(CrewLanHealth.FAILURES, client.failureCount(lan))

            val late = CrewLanHealth.judge(lan, client.failureCount(lan), listOf("192.168.31.55"), inUse = false)
            assertEquals(CrewLanHealth.Verdict.STALE, late.verdict)
            assertEquals(
                "局域网地址已失效（电脑可能换过 IP），现在走公网中转",
                CrewLanHealth.routeLine("公网中转", late, CrewRoute.Way.PUBLIC),
            )
        } finally {
            public.close()
        }
    }

    // 反向：地址是活的（只是隧道没通，走公网），界面一个字都不该多 —— 不能误报。
    @Test
    fun aLiveLanAddressNeverDecoratesTheRouteLine() {
        val lan = answerOnce(404)
        val lanEntry = "http://127.0.0.1:${lan.localPort}"
        val client = CrewClient(listOf(lanEntry), "tok-1")
        try {
            assertTrue("对端答了话就是活的", runBlocking { client.probeEntry(lanEntry) })
            assertEquals(0, client.failureCount(lanEntry))
            val report = CrewLanHealth.judge(lanEntry, 0, listOf("127.0.0.1"), inUse = false)
            assertEquals(CrewLanHealth.Verdict.OK, report.verdict)
            assertEquals("公网中转", CrewLanHealth.routeLine("公网中转", report, CrewRoute.Way.PUBLIC))
        } finally {
            lan.close()
        }
    }

    // 地址失效但同网段：说「连不上」，不说「已失效」——
    // 同网段里连不上多半是电脑没开，地址本身没错。说成失效会让人白改一次配对。
    @Test
    fun anUnreachableAddressOnTheSameSubnetSaysUnreachableNotStale() {
        val lan = "http://127.0.0.1:${closedPort()}"
        val client = CrewClient(listOf(lan), "tok-1")
        repeat(CrewLanHealth.FAILURES) { runBlocking { client.probeEntry(lan) } }
        val report = CrewLanHealth.judge(lan, client.failureCount(lan), listOf("127.0.0.1"), inUse = false)
        assertEquals(CrewLanHealth.Verdict.UNREACHABLE, report.verdict)
        assertEquals("局域网地址连不上，现在走公网中转", CrewLanHealth.routeLine("公网中转", report, CrewRoute.Way.PUBLIC))
    }

    // 隧道通了之后，局域网那条失效在界面上不再是问题：隧道是网域无关的主路。
    @Test
    fun aWorkingTunnelHidesTheStaleLanVerdict() {
        val lan = "http://127.0.0.1:${closedPort()}"
        val client = CrewClient(listOf(lan, "http://127.0.0.1:${closedPort()}"), "tok-1")
        repeat(CrewLanHealth.FAILURES) { runBlocking { client.probeEntry(lan) } }
        val report = CrewLanHealth.judge(lan, client.failureCount(lan), listOf("192.168.31.55"), inUse = false)
        assertEquals(CrewLanHealth.Verdict.STALE, report.verdict)
        assertEquals(
            "隧道已连接（18ms）",
            CrewLanHealth.routeLine("隧道已连接（18ms）", report, CrewRoute.Way.P2P),
        )
    }

    // 自更新真的落地之后，判定基准换成新地址，旧地址的失效结论不再挂在新记录上。
    // 这正是「Mac 换 IP 后同网段直连命中」那条验收路径的一半：
    // 广播带来新地址 → 入口表换掉 → 新地址可连 → 界面不再报失效。
    @Test
    fun aRefreshedAddressReplacesTheStaleVerdict() {
        val old = "http://192.168.113.134:43499"
        val paired = PairedCrew(
            deviceId = "dev-1", token = "tok-1", base = old,
            fallbackBase = "https://crew.example.top", p2pAddr = "tcpOLD", crew = "",
        )
        // 老记录没有指纹：靠隧道地址认同一台（真机上这份记录就是这样）。
        val beacon = CrewBeacon(
            name = "dsh-crew-1",
            base = "http://192.168.31.127:43499",
            publicBase = "https://crew.example.top",
            p2pAddr = "tcpOLD",
            crew = "0kvcc5t",
        )
        val refreshed = CrewNearby.refresh(paired, beacon)
        assertEquals("http://192.168.31.127:43499", refreshed?.base)
        // 指纹顺手补上：下次走强判据。
        assertEquals("0kvcc5t", refreshed?.crew)
        assertTrue(CrewNearby.canSelfUpdate(checkNotNull(refreshed)))

        // 新地址是活的（这里用本地服务代表它）：界面不再报失效。
        val live = answerOnce(200)
        val client = CrewClient(listOf("http://127.0.0.1:${live.localPort}"), "tok-1")
        try {
            assertTrue(runBlocking { client.probeEntry("http://127.0.0.1:${live.localPort}") })
            val report = CrewLanHealth.judge(
                "http://127.0.0.1:${live.localPort}",
                client.failureCount("http://127.0.0.1:${live.localPort}"),
                listOf("127.0.0.1"),
                inUse = false,
            )
            assertEquals(CrewLanHealth.Verdict.OK, report.verdict)
            assertEquals("公网中转", CrewLanHealth.routeLine("公网中转", report, CrewRoute.Way.PUBLIC))
        } finally {
            live.close()
        }
    }

    // 老记录两样身份线索都没有：不能自更新，界面要能提前说清「只能人工重配对」。
    @Test
    fun aRecordWithNoIdentityClueCannotFollowTheMachine() {
        val blind = PairedCrew(deviceId = "d", token = "t", base = "http://192.168.113.134:43499")
        assertFalse(CrewNearby.canSelfUpdate(blind))
        // 广播来了也认不出：保持原样，不猜。
        assertNull(
            CrewNearby.refresh(
                blind,
                CrewBeacon("dsh-crew-1", "http://192.168.31.127:43499", crew = "0kvcc5t", p2pAddr = "tcpX"),
            ),
        )
    }

    // 等一次失败要多久决定这条结论多久能到人眼前：连接超时给的是 3 秒，
    // 两次就是 6 秒上下 —— 人打开界面等一会儿就能看到，而不是等到天荒地老。
    @Test
    fun theProbeDoesNotWaitForTheFullRequestTimeout() {
        val dead = "http://127.0.0.1:${closedPort()}"
        val client = CrewClient(listOf(dead), "tok-1")
        val started = System.nanoTime()
        runBlocking { client.probeEntry(dead) }
        val spent = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)
        // 端口没人听会立刻被拒（RST），所以这里量到的是「没有额外等待」。
        // 真正慢的是跨网段丢包那条路径，那个数由 connectTimeoutMs 保证。
        assertTrue("探测不该拖到正常请求那 15 秒的等待：实测 ${spent}ms", spent < 5_000)
    }
}
