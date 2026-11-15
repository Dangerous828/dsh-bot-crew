package com.dsh.botcrew

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 调试口的归属：一条 abstract socket 属于**进程**，不属于某一届 Activity。
 *
 * 这里钉的是转屏那个真缺陷的时序（真机复现三次，17:27 / 17:35 / 17:49）：
 * Activity 重建时旧 listener 的 `close()` 与 accept 线程里那次阻塞的 `accept()` 不同步，
 * 新实例 `bind()` 撞 `Address already in use`，之后整个进程再也没有调试口，直到杀进程。
 * 判据就在下面这几条：**换人绝不重开 socket**，**老实例的收尾不许碰新实例的口**。
 */
class CrewDebugPortsTest {

    /** 挂载点的替身：这一层只关心「现在挂的是谁」，不关心动作。 */
    private class StubTarget(val tag: String) : CrewDebugTarget {
        override fun snapshot(): JSONObject = JSONObject()
        override fun sessions(): DebugReply = DebugReply.ok()
        override fun reloadSessions(): DebugReply = DebugReply.ok()
        override fun refresh(): DebugReply = DebugReply.ok()
        override fun switchSession(id: String): DebugReply = DebugReply.ok()
        override fun send(text: String, requestId: String): DebugReply = DebugReply.ok()
        override fun setTab(name: String): DebugReply = DebugReply.ok()
        override fun setMode(name: String): DebugReply = DebugReply.ok()
        override fun pause(ticketId: String?): DebugReply = DebugReply.ok()
        override fun resume(): DebugReply = DebugReply.ok()
    }

    /**
     * 真的 socket 的替身。`kernelBound` 复刻内核的规矩：同一个名字在**已经绑着**的时候再 bind，
     * 就是真机上那条 `java.io.IOException: Address already in use` —— 这条断言才咬得住旧实现。
     */
    private class FakePort : CrewDebugPort {
        var opens = 0
        var failOpen = false
        var kernelBound = false
        var bound: CrewDebugTarget? = null

        override fun open(): Boolean {
            opens += 1
            if (failOpen) return false
            if (kernelBound) return false
            kernelBound = true
            return true
        }

        override fun bind(target: CrewDebugTarget) {
            bound = target
        }

        override fun unbind() {
            bound = null
        }

        var closed = false

        override fun close() {
            closed = true
            kernelBound = false
            bound = null
        }
    }

    // 转屏重建：新的 Activity 进场时 socket 已经开着 —— 只换人换挂载点，不许再 bind 一次。
    // 旧实现每届 Activity 各建一个 server，这条断言会读到 opens=2（正是真机上的那次撞车）。
    @Test
    fun aSecondActivityTakesOverWithoutOpeningTheSocketAgain() {
        val port = FakePort()
        val ports = CrewDebugPorts(port)
        val first = Any()
        val second = Any()
        val firstTarget = StubTarget("first")
        val secondTarget = StubTarget("second")

        assertTrue(ports.attach(first, firstTarget))
        assertTrue(ports.attach(second, secondTarget))

        assertEquals("socket 只许开一次：转屏重建不是重开", 1, port.opens)
        assertSame(secondTarget, port.bound)
        assertSame(second, ports.currentOwner)
    }

    // 真机上最要命的那一半：老实例的 onStop/onDestroy 晚于新实例的 onCreate 时，
    // 它叫过来的 detach 不许把新实例刚接上的口摘掉。
    @Test
    fun aDeadActivitysDetachLeavesTheNewOwnerAlone() {
        val port = FakePort()
        val ports = CrewDebugPorts(port)
        val old = Any()
        val fresh = Any()
        val freshTarget = StubTarget("fresh")

        ports.attach(old, StubTarget("old"))
        ports.attach(fresh, freshTarget)
        ports.detach(old)

        assertTrue(ports.isOpen)
        assertSame("老实例的收尾不许摘新实例的挂载点", freshTarget, port.bound)
        assertSame(fresh, ports.currentOwner)
    }

    // 现任 owner 退场：摘挂载点，但 socket 照旧开着。
    // 关掉再开就是原来那个竞态（close 与阻塞中的 accept 不同步），所以这里不许关。
    @Test
    fun theCurrentOwnerDetachingUnbindsButKeepsTheSocketOpen() {
        val port = FakePort()
        val ports = CrewDebugPorts(port)
        val only = Any()

        ports.attach(only, StubTarget("only"))
        ports.detach(only)

        assertTrue(ports.isOpen)
        assertNull("没人挂在台前时如实是「没挂载点」，不拿旧 target 冒充", port.bound)
        assertNull(ports.currentOwner)
        assertEquals(1, port.opens)
    }

    // 幂等：同一届重复 attach / 重复 detach 都不该多开一次、也不该把口弄丢。
    // 真机上这两下会发生（重建期间回调重入、进程被系统 kill 前的重复收尾）。
    @Test
    fun attachAndDetachAreIdempotentForTheSameActivity() {
        val port = FakePort()
        val ports = CrewDebugPorts(port)
        val who = Any()
        val target = StubTarget("only")

        assertTrue(ports.attach(who, target))
        assertTrue(ports.attach(who, target))
        assertEquals("重复 attach 不许再开一次", 1, port.opens)
        assertSame(target, port.bound)

        ports.detach(who)
        ports.detach(who)
        assertTrue(ports.isOpen)
        assertNull(port.bound)
    }

    // 开失败如实返回 false，且不吞：下一届 Activity 进场会再试一次（每届一次，不是循环重试）。
    @Test
    fun aFailedOpenIsReportedAndRetriedByTheNextActivity() {
        val port = FakePort().apply { failOpen = true }
        val ports = CrewDebugPorts(port)

        assertFalse(ports.attach(Any(), StubTarget("first")))
        assertFalse(ports.isOpen)

        port.failOpen = false
        assertTrue(ports.attach(Any(), StubTarget("second")))
        assertTrue(ports.isOpen)
        assertEquals(2, port.opens)
    }

    // 转屏那一下的真实顺序：新的 onCreate 先 attach，旧的 onDestroy 后 detach，
    // 中间没有任何一次 bind 撞车 —— 这就是真机上「Address already in use」消失的判据。
    @Test
    fun aRotationNeverHitsAddressAlreadyInUse() {
        val port = FakePort()
        val ports = CrewDebugPorts(port)
        val old = Any()
        val fresh = Any()

        ports.attach(old, StubTarget("old"))
        // 新的先上台：名字已经被自己这一届绑着，旧实现会在这里报 EADDRINUSE。
        assertTrue("转屏重建时新实例必须能接上", ports.attach(fresh, StubTarget("fresh")))
        // 旧的晚到：不许把新的摘掉，也不许 close。
        ports.detach(old)

        assertTrue(ports.isOpen)
        assertFalse("进程内不许再出现未绑定状态", port.closed)
        assertEquals(1, port.opens)
    }
}
