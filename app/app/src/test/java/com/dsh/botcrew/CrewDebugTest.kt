package com.dsh.botcrew

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 调试口的纯逻辑层：协议解析、未知动作、state.dump 形状、开关。
 *
 * socket 那一层（LocalServerSocket）在 JVM 上跑不起来，所以它薄到只剩「收一行 → invoke → 回一行」，
 * 所有能出错的判断都落在 [CrewDebug.invoke] 里 —— 这一份测试钉的就是那些判断。
 */
class CrewDebugTest {

    /** 一个只记「被调了什么」的假目标：动作有没有真的落到界面上，看它的账。 */
    private class FakeTarget : CrewDebugTarget {
        val calls = mutableListOf<String>()
        var snap = JSONObject().put("session", "main")
        var switchable = true
        var sessions = listOf("main", "work")
        var capability = SessionCapability.LIVE

        override fun snapshot(): JSONObject = snap

        override fun sessions(): DebugReply {
            calls += "session.list"
            return DebugReply.ok(
                JSONObject()
                    .put("current", "main")
                    .put("switchable", switchable)
                    .put("sessions", sessions.size),
            )
        }

        override fun refresh(): DebugReply {
            calls += "refresh"
            return DebugReply.ok(JSONObject().put("refreshing", true))
        }

        override fun switchSession(id: String): DebugReply {
            calls += "session.set:$id"
            if (!switchable) return DebugReply.fail("session switching is locked")
            if (id !in sessions) return DebugReply.fail("unknown session: $id")
            return DebugReply.ok(JSONObject().put("session", id))
        }

        override fun send(text: String, requestId: String): DebugReply {
            calls += "send:$text:${requestId.ifEmpty { "<generated>" }}"
            return DebugReply.ok(JSONObject().put("sent", text).put("requestId", requestId))
        }

        override fun setTab(tab: String): DebugReply {
            calls += "tab.set:$tab"
            return DebugReply.ok(JSONObject().put("tab", tab))
        }

        override fun setMode(mode: String): DebugReply {
            calls += "mode.set:$mode"
            return DebugReply.ok(JSONObject().put("mode", mode))
        }
    }

    private fun bus(target: CrewDebugTarget = FakeTarget()) = CrewDebug(target)

    // ── 协议：一行 JSON 进，一行 JSON 出 ────────────────────────────────────

    @Test
    fun anOkReplyIsOneLineWithOkTrueAndResult() {
        val line = DebugReply.ok(JSONObject().put("session", "work")).toLine()
        assertFalse("响应不能带换行：一行一个", line.contains("\n"))
        val parsed = JSONObject(line)
        assertTrue(parsed.getBoolean("ok"))
        assertEquals("work", parsed.getJSONObject("result").getString("session"))
        assertFalse("成功时不带 error 字段", parsed.has("error"))
    }

    @Test
    fun aFailedReplyIsOneLineWithOkFalseAndError() {
        val line = DebugReply.fail("unknown action: nope").toLine()
        assertFalse(line.contains("\n"))
        val parsed = JSONObject(line)
        assertFalse(parsed.getBoolean("ok"))
        assertEquals("unknown action: nope", parsed.getString("error"))
        assertFalse("失败时不带 result 字段", parsed.has("result"))
    }

    @Test
    fun anActionWithNoArgsStillRuns() {
        // 桌面端的写法是 args 可省；这里同样：没有 args 就当一个空对象。
        // 断言按字段读，不比整串字面量 —— JSON 的对象键序不在协议里。
        val reply = bus().invoke("refresh", JSONObject())
        assertTrue(reply.ok)
        val parsed = JSONObject(reply.toLine())
        assertTrue(parsed.getBoolean("ok"))
        assertTrue(parsed.getJSONObject("result").getBoolean("refreshing"))
    }

    // ── 未知动作：明确报错，不静默 ─────────────────────────────────────────

    @Test
    fun anUnknownActionIsAnExplicitError() {
        val reply = bus().invoke("does.not.exist", JSONObject())
        assertFalse(reply.ok)
        assertEquals("unknown action: does.not.exist", reply.error)
    }

    @Test
    fun anEmptyActionNameIsAlsoAnUnknownAction() {
        val reply = bus().invoke("", JSONObject())
        assertFalse(reply.ok)
        assertTrue(reply.error.startsWith("unknown action:"))
    }

    // ── actions.list ──────────────────────────────────────────────────────

    @Test
    fun actionsListNamesEveryActionInAlphabeticalOrder() {
        val reply = bus().invoke("actions.list", JSONObject())
        assertTrue(reply.ok)
        val names = reply.result!!.getJSONArray("actions")
        val got = (0 until names.length()).map { names.getString(it) }
        assertEquals(
            listOf("actions.list", "mode.set", "refresh", "send", "session.list", "session.set", "state.dump", "tab.set"),
            got,
        )
    }

    @Test
    fun everyListedActionActuallyExists() {
        // 名单与实际表不能各说一套：列出来的每一条都得调得动。
        val bus = bus()
        val listed = bus.actionNames()
        for (name in listed) {
            val reply = bus.invoke(name, JSONObject())
            assertFalse("$name 被列出来了却调不动", reply.error.startsWith("unknown action"))
        }
    }

    // ── state.dump 的形状 ─────────────────────────────────────────────────

    @Test
    fun stateDumpCarriesTheSnapshotUnderResult() {
        val target = FakeTarget()
        target.snap = JSONObject().put("session", "work").put("tab", "crew").put("p2p", true)
        val reply = bus(target).invoke("state.dump", JSONObject())
        assertTrue(reply.ok)
        val result = reply.result!!
        assertEquals("work", result.getString("session"))
        assertEquals("crew", result.getString("tab"))
        assertTrue(result.getBoolean("p2p"))
    }

    @Test
    fun stateDumpIsAlwaysAJsonObjectEvenWhenTheScreenIsEmpty() {
        // 界面还没进队伍时快照是空对象：仍然是一个合法的 result，不是 null。
        val reply = bus(FakeTarget().apply { snap = JSONObject() }).invoke("state.dump", JSONObject())
        assertTrue(reply.ok)
        assertNotNull(reply.result)
        assertEquals(0, reply.result!!.length())
    }

    @Test
    fun aScreenSnapshotHasTheFieldsTheDumpContractPromises() {
        // 这里钉的是 CrewDebugScreen 拼出来的键名：脚本按名字读，改名就是破约。
        val state = SessionFlow.accept(
            SessionState(current = "work"),
            SessionsView(listOf(SessionInfo("main"), SessionInfo("work")), sessionApi = true),
        )
        val screen = CrewDebugScreen(
            state = { state },
            tab = { "crew" },
            mode = { "chat" },
            timelineEpoch = { 3 },
            paused = { false },
            problem = { null },
            draft = { "" },
            sending = { false },
            entries = { listOf("http://127.0.0.1:9", "http://192.168.31.127:43499") },
            currentEntry = { "http://127.0.0.1:9" },
            onRefresh = {},
            onEnterSession = {},
            onSend = { _, _ -> },
            onTab = {},
            onMode = {},
        )
        val snap = screen.snapshot()
        for (key in listOf(
            "session", "capability", "switchable", "defaultSession", "note", "error",
            "sessions", "cached", "tab", "mode", "paused", "problem", "draft", "sending",
            "entries", "entry", "p2p", "timeline",
        )) {
            assertTrue("快照缺字段：$key", snap.has(key))
        }
        assertEquals("work", snap.getString("session"))
        assertEquals("live", snap.getString("capability"))
        assertTrue("在用的是本地回环代理 → P2P 通", snap.getBoolean("p2p"))
        assertEquals(2, snap.getJSONArray("sessions").length())
        val timeline = snap.getJSONObject("timeline")
        assertEquals(3, timeline.getInt("epoch"))
        // 还没拉到这一格的时间线：loaded=false 且 messages 是 null，不用 0 冒充「确实是空」。
        assertFalse(timeline.getBoolean("loaded"))
        assertTrue(timeline.isNull("messages"))
    }

    @Test
    fun aLoadedTimelineCountsWhatIsOnScreen() {
        val conversation = Conversation(
            messages = listOf(
                Message("m1", false, null, "一", "2026-11-13T10:00:00Z"),
                Message("m2", true, "lead", "二", "2026-11-13T10:01:00Z"),
            ),
            bots = listOf(BotCard("lead", "领队", "lead", "")),
            defaultBotId = "lead",
            tickets = listOf(WorkTicket("t1", "票", "work", "lead", "")),
            queued = listOf("q1"),
            unread = 2,
            unreadReplies = 1,
        )
        val state = SessionFlow.withConversation(
            SessionFlow.accept(
                SessionState(current = "main"),
                SessionsView(emptyList(), sessionApi = true),
            ),
            "main",
            conversation,
        )
        val snap = CrewDebugScreen(
            state = { state },
            tab = { "crew" },
            mode = { "triage" },
            timelineEpoch = { 1 },
            paused = { true },
            problem = { "连不上队伍" },
            draft = { "草稿" },
            sending = { true },
            entries = { listOf("http://192.168.31.127:43499") },
            currentEntry = { "http://192.168.31.127:43499" },
            onRefresh = {},
            onEnterSession = {},
            onSend = { _, _ -> },
            onTab = {},
            onMode = {},
        ).snapshot()
        val timeline = snap.getJSONObject("timeline")
        assertTrue(timeline.getBoolean("loaded"))
        assertEquals(2, timeline.getInt("messages"))
        assertEquals(1, timeline.getInt("bots"))
        assertEquals(1, timeline.getInt("tickets"))
        assertEquals(1, timeline.getInt("queued"))
        assertEquals(2, timeline.getInt("unread"))
        assertEquals(1, timeline.getInt("unreadReplies"))
        assertEquals("m2", timeline.getString("lastMessage"))
        assertEquals("triage", snap.getString("mode"))
        assertTrue(snap.getBoolean("paused"))
        assertEquals("连不上队伍", snap.getString("problem"))
        assertFalse("不在本地回环代理上 → P2P 不通", snap.getBoolean("p2p"))
    }

    @Test
    fun anUnknownProblemAndUnknownUnreadAreNullNotZero() {
        val conversation = Conversation(
            messages = emptyList(), bots = emptyList(), defaultBotId = "lead",
            unread = null, unreadReplies = null,
        )
        val state = SessionFlow.withConversation(
            SessionFlow.accept(SessionState(), SessionsView(emptyList(), sessionApi = true)),
            "main",
            conversation,
        )
        val snap = CrewDebugScreen(
            state = { state }, tab = { "crew" }, mode = { "chat" }, timelineEpoch = { 0 },
            paused = { false }, problem = { null }, draft = { "" }, sending = { false },
            entries = { emptyList() }, currentEntry = { "" },
            onRefresh = {}, onEnterSession = {}, onSend = { _, _ -> }, onTab = {}, onMode = {},
        ).snapshot()
        assertTrue("problem 没说清时是 null", snap.isNull("problem"))
        val timeline = snap.getJSONObject("timeline")
        assertTrue("说不清的未读是 null，不是 0", timeline.isNull("unread"))
        assertTrue(timeline.isNull("unreadReplies"))
    }

    // ── 参数校验 ─────────────────────────────────────────────────────────

    @Test
    fun sessionSetWithoutAnIdIsAnError() {
        val reply = bus().invoke("session.set", JSONObject())
        assertFalse(reply.ok)
        assertEquals("session is required", reply.error)
    }

    @Test
    fun sendWithoutTextIsAnError() {
        val reply = bus().invoke("send", JSONObject())
        assertFalse(reply.ok)
        assertEquals("text is required", reply.error)
    }

    @Test
    fun tabSetRejectsANameThatIsNotOnTheTabList() {
        val reply = bus().invoke("tab.set", JSONObject().put("tab", "settings"))
        assertFalse(reply.ok)
        assertTrue(reply.error.startsWith("unknown tab: settings"))
    }

    @Test
    fun modeSetRejectsANameOutsideTheTwoModes() {
        val reply = bus().invoke("mode.set", JSONObject().put("mode", "board"))
        assertFalse(reply.ok)
        assertTrue(reply.error.startsWith("unknown mode: board"))
    }

    @Test
    fun blankStringArgumentsCountAsMissing() {
        // 空串与全空格都不算给了值 —— 与桌面端 argString 同一口径。
        assertFalse(bus().invoke("session.set", JSONObject().put("session", "   ")).ok)
        assertFalse(bus().invoke("send", JSONObject().put("text", "")).ok)
    }

    // ── 动作真的落到目标上 ────────────────────────────────────────────────

    @Test
    fun sendForwardsTheTextAndRequestIdToTheTarget() {
        val target = FakeTarget()
        val reply = bus(target).invoke("send", JSONObject().put("text", "看一下构建").put("request_id", "r-1"))
        assertTrue(reply.ok)
        assertEquals(listOf("send:看一下构建:r-1"), target.calls)
        assertEquals("r-1", reply.result!!.getString("requestId"))
    }

    @Test
    fun tabAndModeAndSessionReachTheTarget() {
        val target = FakeTarget()
        val bus = bus(target)
        assertTrue(bus.invoke("tab.set", JSONObject().put("tab", "backend")).ok)
        assertTrue(bus.invoke("mode.set", JSONObject().put("mode", "triage")).ok)
        assertTrue(bus.invoke("session.set", JSONObject().put("session", "work")).ok)
        assertTrue(bus.invoke("refresh", JSONObject()).ok)
        assertTrue(bus.invoke("session.list", JSONObject()).ok)
        assertEquals(
            listOf("tab.set:backend", "mode.set:triage", "session.set:work", "refresh", "session.list"),
            target.calls,
        )
    }

    @Test
    fun sessionSetIsRefusedWhenTheCapabilityBitIsNotLive() {
        // 能力位先验没过就锁着：调试口不许绕过它造出界面做不到的状态。
        val target = FakeTarget().apply { switchable = false; capability = SessionCapability.UNSUPPORTED }
        val reply = bus(target).invoke("session.set", JSONObject().put("session", "work"))
        assertFalse(reply.ok)
        assertTrue(reply.error.startsWith("session switching is locked"))
        assertEquals(listOf("session.set:work"), target.calls)
    }

    @Test
    fun anActionThatThrowsOnlyFailsThatOneCall() {
        val exploding = object : CrewDebugTarget {
            override fun snapshot() = JSONObject()
            override fun sessions() = DebugReply.ok()
            override fun refresh() = throw IllegalStateException("界面炸了")
            override fun switchSession(id: String) = DebugReply.ok()
            override fun send(text: String, requestId: String) = DebugReply.ok()
            override fun setTab(tab: String) = DebugReply.ok()
            override fun setMode(mode: String) = DebugReply.ok()
        }
        val bus = bus(exploding)
        val failed = bus.invoke("refresh", JSONObject())
        assertFalse(failed.ok)
        assertEquals("界面炸了", failed.error)
        // 服务本身还在：下一条动作照常。
        assertTrue(bus.invoke("state.dump", JSONObject()).ok)
    }

    // ── 开关 ─────────────────────────────────────────────────────────────

    @Test
    fun aReleaseBuildNeverOpensThePortEvenWithThePropertySet() {
        // 生产面零暴露：属性写什么都没用。
        assertFalse(CrewDebug.enabled(debugBuild = false, prop = "1"))
        assertFalse(CrewDebug.enabled(debugBuild = false, prop = null))
        assertFalse(CrewDebug.enabled(debugBuild = false, prop = "0"))
    }

    @Test
    fun aDebugBuildOpensByDefault() {
        assertTrue(CrewDebug.enabled(debugBuild = true, prop = null))
        assertTrue(CrewDebug.enabled(debugBuild = true, prop = ""))
        assertTrue(CrewDebug.enabled(debugBuild = true, prop = "1"))
    }

    @Test
    fun aDebugBuildCanBeTurnedOffWithTheProperty() {
        // 除 "0" 之外一律算开；"0" 是唯一能把 debug 包关掉的写法（反向验证用它）。
        assertFalse(CrewDebug.enabled(debugBuild = true, prop = "0"))
        assertFalse(CrewDebug.enabled(debugBuild = true, prop = " 0 "))
        assertTrue(CrewDebug.enabled(debugBuild = true, prop = "off"))
    }

    @Test
    fun theSocketNameIsTheOneAdbForwards() {
        // adb forward tcp:9099 localabstract:crew-debug 用的就是这个字面量。
        assertEquals("crew-debug", CrewDebug.SOCKET_NAME)
        assertEquals("debug.crew.debug", CrewDebug.PROP)
    }

    // ── 桥：还没进队伍时如实说 ────────────────────────────────────────────

    @Test
    fun theBridgeSaysSoWhenTheScreenIsNotUpYet() {
        val bridge = DebugBridge()
        bridge.shell = DebugShell(paired = true, way = "p2p", tunnelMillis = 12L)
        val snap = bridge.snapshot()
        assertTrue(snap.getBoolean("paired"))
        assertFalse("界面还没挂上来", snap.getBoolean("screenReady"))
        assertEquals("p2p", snap.getString("way"))
        assertEquals(12L, snap.getLong("tunnelMillis"))

        val reply = bridge.invokeForTest("refresh")
        assertFalse(reply.ok)
        assertTrue(reply.error.startsWith("界面还没进队伍"))
    }

    @Test
    fun theBridgeTunnelMillisIsNullWhenThereIsNoMeasurement() {
        // 没有实测值就是 null：不拿 0 冒充「量到 0ms」。
        val snap = DebugBridge().snapshot()
        assertTrue(snap.isNull("tunnelMillis"))
        assertFalse(snap.getBoolean("paired"))
        assertNull(snap.optJSONObject("screen")?.takeIf { it.length() > 0 })
    }

    @Test
    fun theBridgeDelegatesToTheScreenOnceItIsUp() {
        val bridge = DebugBridge()
        val target = FakeTarget()
        bridge.screen = target
        assertTrue(bridge.snapshot().getBoolean("screenReady"))
        assertTrue(CrewDebug(bridge).invoke("refresh", JSONObject()).ok)
        assertEquals(listOf("refresh"), target.calls)
    }
}

/** [DebugBridge] 的动作表在 CrewDebug 里；这里给测试一个直通的入口。 */
private fun DebugBridge.invokeForTest(action: String): DebugReply = CrewDebug(this).invoke(action, JSONObject())
