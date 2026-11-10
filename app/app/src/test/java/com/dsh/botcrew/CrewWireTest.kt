package com.dsh.botcrew

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 消息面契约：角色只有两种，客户端不能把 Bot 的话读丢。 */
class CrewWireTest {

    // 从网关实际返回里截的一段：人和 Bot 各一条，外加一个这个版本还不认识的字段。
    private val timeline = """
        {
          "items": [
            {"id": "m1", "role": "user", "text": "@写手 你好", "at": "2026-11-09T11:47:23.000Z"},
            {"id": "r1", "role": "agent", "bot_id": "scribbler", "text": "在的", "at": "2026-11-09T11:47:31.000Z"},
            {"id": "m2", "role": "user", "text": "还有人吗", "at": "2026-11-09T11:48:02.000Z", "future_field": 1}
          ],
          "bots": [
            {"id": "lead", "name": "大哥", "role": "default"},
            {"id": "scribbler", "name": "写手", "role": "member", "persona": "负责文案"}
          ],
          "default_bot_id": "lead"
        }
    """.trimIndent()

    @Test
    fun readsBothSidesOfTheConversation() {
        val conversation = CrewWire.parseTimeline(timeline)
        assertEquals(3, conversation.messages.size)
        assertFalse(conversation.messages[0].fromBot)
        assertEquals("@写手 你好", conversation.messages[0].text)
        assertTrue(conversation.messages[1].fromBot)
        assertEquals("scribbler", conversation.messages[1].botId)
        assertEquals("在的", conversation.messages[1].text)
        assertEquals(2, conversation.bots.size)
        assertEquals("负责文案", conversation.bots[1].persona)
        assertEquals("lead", conversation.defaultBotId)
    }

    @Test
    fun keepsTheTextItDoesNotUnderstand() {
        val conversation = CrewWire.parseTimeline(timeline)
        // 不认识的字段不该让解析失败，那条消息必须还在。
        assertEquals("还有人吗", conversation.messages[2].text)
    }

    @Test
    fun buildsASendBodyWithAnIdempotencyKey() {
        val body = CrewWire.sendBody("在吗", listOf("scribbler"), "req-1")
        val parsed = JSONObject(body)
        assertEquals("在吗", parsed.getString("text"))
        assertEquals("req-1", parsed.getString("request_id"))
        assertEquals("scribbler", parsed.getJSONArray("mentions").getString(0))
        // 客户端不自称身份：服务端认 owner。
        assertFalse(parsed.has("sender"))
    }

    @Test
    fun mentionsAreFoundByHeaderNameAndId() {
        val bots = listOf(
            BotCard("lead", "大哥", "default", ""),
            BotCard("scribbler", "写手", "member", "负责文案"),
        )
        assertEquals(listOf("scribbler"), CrewWire.mentionsIn("@写手 你好", bots))
        assertEquals(listOf("scribbler"), CrewWire.mentionsIn("@scribbler 你好", bots))
        // 不写 @ 只是提到名字，不是点名。
        assertTrue(CrewWire.mentionsIn("大哥你看看", bots).isEmpty())
        assertTrue(CrewWire.mentionsIn("随便说一句", bots).isEmpty())
    }

    @Test
    fun mentionsStopAtAWordBoundary() {
        val bots = listOf(
            BotCard("a", "甲", "member", ""),
            BotCard("ab", "甲乙", "member", ""),
        )
        // @ab 不能同时点名 a：名字是前缀不算命中。
        assertEquals(listOf("ab"), CrewWire.mentionsIn("@ab 看一下", bots))
        assertEquals(listOf("a"), CrewWire.mentionsIn("@a 看一下", bots))
    }
}

class TicketAndStatusTest {

    // 后台看到的工单，字段名跟消息面一致。
    @Test
    fun readsTicketsAndWaitingReasons() {
        val body = """
            {"items": [], "bots": [], "default_bot_id": "lead",
             "tasks": [
               {"id":"tk1","title":"调开间距","state":"work","bot_id":"lin"},
               {"id":"tk2","title":"确认合同","state":"person","bot_id":"zhou","needs_person":"等你确认付款条款"}
             ],
             "status": {"runtime":"ready","mobile":"on","paused":false}}
        """.trimIndent()
        val conversation = CrewWire.parseTimeline(body)
        assertEquals(2, conversation.tickets.size)
        assertEquals("等你确认付款条款", conversation.tickets[1].needsPerson)
        assertEquals(true, conversation.status.ready())
    }

    @Test
    fun pausedCrewIsNotReady() {
        assertEquals(false, CrewStatus("ready", "on", true).ready())
        assertEquals(false, CrewStatus("starting", "on", false).ready())
        assertEquals(true, CrewStatus("ready", "on", false).ready())
    }

    @Test
    fun readsQueuedRequests() {
        val body = """{"items":[],"bots":[],"default_bot_id":"lead","tasks":[],"queued":["req-2"],"status":{"runtime":"ready"}}"""
        val conversation = CrewWire.parseTimeline(body)
        assertEquals(listOf("req-2"), conversation.queued)
    }

    // 子代理还能再派子代理：三层要原样读出来，不能压平。
    @Test
    fun readsNestedSubagents() {
        val body = """
            {"ticket_id":"tk1","agents":[
              {"id":"worker-tk1","label":"工单","state":"working","children":[
                {"id":"sub-a","label":"子代理","state":"done","children":[
                  {"id":"sub-a-1","label":"子代理","state":"done","children":[]}
                ]},
                {"id":"sub-b","label":"子代理","state":"working","children":[]}
              ]}
            ]}
        """.trimIndent()
        val tree = AgentWire.parse(body)
        assertEquals(1, tree.size)
        assertEquals(2, tree[0].children.size)
        assertEquals("sub-a-1", tree[0].children[0].children[0].id)
    }

    @Test
    fun anEmptyTreeIsNotAnError() {
        assertEquals(emptyList<AgentNode>(), AgentWire.parse("""{"ticket_id":"tk1","agents":[]}"""))
    }

    // 配对走的是和消息面不同的一条路：还没有凭据时也得能到达，所以它单独一组方法。
    @Test
    fun readsTheReachAddressesAlreadyShapedAsUrls() {
        val body = """{"addresses":[{"address":"192.168.31.127","family":"IPv4","url":"http://192.168.31.127"},{"address":"2409::1","family":"IPv6","url":"http://[2409::1]"}]}"""
        val reaches = CrewWire.parseReach(body)
        assertEquals(2, reaches.size)
        // IPv6 已经带好方括号，客户端直接拼端口就行。
        assertTrue(reaches[1].url.endsWith("]"))
    }

    @Test
    fun aPairingRefusalIsNotACredential() {
        // 403 的响应体里没有 token；解析不能把它当成配好了。
        assertNull(CrewWire.parseCredential("""{"error":"Pairing refused"}"""))
        val ok = CrewWire.parseCredential("""{"deviceId":"phone-1","token":"abc"}""")
        assertEquals("abc", ok?.token)
    }
}

class WorkWireTest {
    @Test
    fun readsTheStepsOfOneTicket() {
        val body = """{"ticket_id":"tk1","title":"调开间距","stage":"done","steps":[
          {"at":"2026-11-09T10:00:00.000Z","kind":"did","text":"改了 login.tsx 两处"},
          {"at":"2026-11-09T10:03:00.000Z","kind":"said","text":"在 390 宽度复查"}]}"""
        val steps = WorkWire.parse(body)
        assertEquals(2, steps.size)
        assertEquals("改了 login.tsx 两处", steps[0].text)
    }

    @Test
    fun dropsStepsWithNoText() {
        // 没写结论的一步是噪声，不是进度。
        val steps = WorkWire.parse("""{"steps":[{"at":"x","kind":"did","text":""}]}""")
        assertEquals(0, steps.size)
    }
}

class DeviceCredentialTest {
    @Test
    fun theLanEntryCarriesBothHalves() {
        // 独立监听那道门要两样：设备号 + 凭据。少一样就是 401，而且分不出少了哪样。
        val body = deviceBody("phone-1", "tok")
        assertEquals("phone-1", body.get("deviceId"))
        assertEquals("tok", body.get("token"))
    }

    @Test
    fun theCrewBaseNeverEndsWithASlash() {
        // 地址后面拼路径，多一个斜杠会拼成 //api，有些服务端会 404。
        assertEquals("http://h:1", CrewPairing.normalize("http://h:1/"))
        assertEquals("http://h:1", CrewPairing.normalize("http://h:1"))
        assertEquals("http://h:1", CrewPairing.normalize("  http://h:1//  "))
    }

    @Test
    fun anAddressWithoutSchemeGetsHttp() {
        // 用户会打 192.168.31.127:43499，不带协议。
        assertEquals("http://192.168.31.127:43499", CrewPairing.normalize("192.168.31.127:43499"))
        // 已经带了的不要重复加。
        assertEquals("https://h", CrewPairing.normalize("https://h"))
    }
}

class ClientPathTest {
    @Test
    fun everyOperationGoesThroughThePhoneSurface() {
        // 消息面在 /api/mobile 下面。漏了前缀会得到一个 404，而不是「路径写错」这种明确信息。
        val source = java.io.File("src/main/java/com/dsh/botcrew/CrewClient.kt").readText()
        // 请求统一走 read(...)；open(...) 只剩底层那一个定义。
        val paths = Regex("""\b(?:read|open)\("(/[^"]*)"""").findAll(source).map { it.groupValues[1] }.toList()
        assertTrue("CrewClient 里应该有几条路径", paths.isNotEmpty())
        for (path in paths) {
            assertTrue("路径 $path 少了 /api/mobile 前缀", path.startsWith("/api/mobile/"))
        }
    }
}

class LiveShapeTest {
    @Test
    fun readsTheRosterTheBackendActuallySends() {
        // 真实配置里是三个 bot（大哥/写手/码农），字段名是 bots + default_bot_id。
        val body = """{"items":[{"role":"user","text":"hi","at":"2026-11-09T09:59:00Z","id":"m1"}],
          "bots":[{"id":"lead","name":"大哥","role":"default","persona":"队伍里的大哥"},
                  {"id":"scribbler","name":"写手","role":"member"}],
          "default_bot_id":"lead","tasks":[],"status":{"worker":"ok"}}"""
        val timeline = CrewWire.parseTimeline(body)
        assertEquals(2, timeline.bots.size)
        assertEquals("大哥", timeline.bots[0].name)
        assertEquals("lead", timeline.defaultBotId)
    }

    // 页签归属与重试入口由后端给的布尔决定，不再让客户端解释 state 的词表。
    @Test
    fun readsWhetherATicketIsOpenAndRetryable() {
        val body = """
            {"items":[],"bots":[],"default_bot_id":"","tasks":[
              {"id":"t1","title":"在跑","state":"working","bot_id":"b","open":true,"retryable":false},
              {"id":"t2","title":"完了","state":"completed","bot_id":"b","open":false,"retryable":true}
            ],"status":{},"queued":[],"declined":[]}
        """.trimIndent()
        val tickets = CrewWire.parseTimeline(body).tickets
        assertTrue(tickets[0].open)
        assertFalse(tickets[0].retryable)
        assertFalse(tickets[1].open)
        assertTrue(tickets[1].retryable)
    }
}

/** 工作区与花名册的新接口。解析宽容：字段缺席时给确定的默认，不崩、不猜。 */
class ControlSurfaceWireTest {
    @Test
    fun readsTheScreenAnswerAsTheBackendWroteIt() {
        val view = ScreenWire.parse("""{"state":"unavailable","reason":"后端还没有画面源：worker 不跑浏览器"}""")
        assertEquals("unavailable", view.state)
        assertEquals("后端还没有画面源：worker 不跑浏览器", view.reason)
        // 空对象也算「没有」：默认态是 unavailable，不是 live。
        assertEquals("unavailable", ScreenWire.parse("{}").state)
    }

    @Test
    fun buildsACreateBodyWithoutAnEmptyPersona() {
        val body = JSONObject(BotsWire.createBody("coder_1", "码农", ""))
        assertEquals("coder_1", body.getString("bot_id"))
        assertEquals("码农", body.getString("name"))
        assertFalse(body.has("persona"))
        assertEquals("写代码", JSONObject(BotsWire.createBody("c", "码农", "写代码")).getString("persona"))
    }

    @Test
    fun aTimelineTaskCarriesTheBotItBelongsTo() {
        // 手机要按 Bot 找「他手上那张票」，所以 tasks 里的 bot_id 必须读得出来。
        val conversation = CrewWire.parseTimeline("""{"items":[],"bots":[],"default_bot_id":"",
          "tasks":[{"id":"t1","title":"改一行","state":"work","bot_id":"coder_1"}]}""")
        assertEquals("coder_1", conversation.tickets.single().botId)
    }
}

class ReadableTextTest {
    @Test
    fun decodesAUrlEncodedHistoryMessage() {
        // 真实数据里有一条正文就是这串，它是「App发的一句」被当正文发了进去。
        assertEquals("App发的一句", readable("App%e5%8F%91%e7%9A%84%e4%B8%80%e5%8F%A5"))
    }

    @Test
    fun leavesOrdinaryTextAlone() {
        // 没有 %XX 就不该动：百分号在正常文本里也常见。
        assertEquals("完成了 50% 的进度", readable("完成了 50% 的进度"))
        assertEquals("@写手 用一句话介绍你自己", readable("@写手 用一句话介绍你自己"))
    }

    @Test
    fun keepsTheOriginalWhenItCannotBeDecoded() {
        // 坏掉的序列不能被吞成空串。
        assertEquals("100%zz", readable("100%zz"))
    }
}
