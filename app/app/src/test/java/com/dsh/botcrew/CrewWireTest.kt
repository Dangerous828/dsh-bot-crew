package com.dsh.botcrew

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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
    fun keepsTheRequestIdSoAQueuedMessageCanBeWithdrawn() {
        val body = """{"items":[{"id":"m1","role":"user","text":"改一下","request_id":"req-1","at":"2026-11-09T10:00:00Z"}],
            "bots":[],"default_bot_id":"","tasks":[],"status":{},"queued":["req-1"],"declined":[]}"""
        val conversation = CrewWire.parseTimeline(body)
        assertEquals("req-1", conversation.messages[0].requestId)
        assertEquals(listOf("req-1"), conversation.queued)
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
        val view = ScreenWire.parse("""{"state":"unavailable","reason":"这张工单还没有可读的执行记录"}""")
        assertEquals("unavailable", view.state)
        assertEquals("这张工单还没有可读的执行记录", view.reason)
        // 空对象也算「没有」：默认态是 unavailable，不是 live。
        assertEquals("unavailable", ScreenWire.parse("{}").state)
    }

    @Test
    fun readsTheActivitySnapshotLineByLine() {
        val view = ScreenWire.parse("""{"state":"live","kind":"terminal","live":true,"cwd":"/tmp/work",
            "lines":[{"at":"2026-11-10T10:00:00Z","kind":"command","text":"$ pnpm test"},
                     {"at":"2026-11-10T10:00:05Z","kind":"output","text":"1429 passed"},
                     {"at":"","kind":"said","text":"  "}]}""")
        assertEquals(true, view.live)
        assertEquals("/tmp/work", view.cwd)
        // 空白行不画：留着只会让屏幕中间多一条空缝。
        assertEquals(2, view.lines.size)
        assertEquals("command", view.lines[0].kind)
        assertEquals("$ pnpm test", view.lines[0].text)
        assertEquals("1429 passed", view.lines[1].text)
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

    @Test
    fun readsTheModelCatalogTheBackendSends() {
        val catalog = ModelWire.parseCatalog("""
            {"current":{"provider":"magpie","model":"openconsole/deepseek-v4.1-flash","reasoningEffort":"high"},
             "bot_models":{"coder":{"provider":"deepseek-official","model":"deepseek-v4-pro"}},
             "providers":[{"id":"magpie","name":"Magpie",
               "models":[{"id":"openconsole/deepseek-v4.1-flash","name":"DeepSeek V4.1","description":"fast"}]}],
             "failures":[{"id":"broken","name":"Broken"}]}
        """.trimIndent())
        assertEquals("magpie", catalog.current?.provider)
        assertEquals("high", catalog.current?.reasoningEffort)
        assertEquals("deepseek-v4-pro", catalog.choiceFor("coder")?.model)
        // 没单配的成员跟随全员。
        assertTrue(catalog.followsCrew("scribbler"))
        assertEquals("magpie", catalog.choiceFor("scribbler")?.provider)
        assertEquals(1, catalog.providers.size)
        assertEquals("fast", catalog.providers.single().models.single().description)
        assertEquals("Broken", catalog.failures.single().name)
    }

    @Test
    fun readsEffortsAndTheirDefault() {
        val efforts = ModelWire.parseEfforts("""{"efforts":[{"id":"low","name":"低"},{"id":"high","name":"高"}],"default":"low"}""")
        assertEquals(2, efforts.efforts.size)
        assertEquals("低", efforts.efforts[0].name)
        assertEquals("low", efforts.default)
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

class BotEditBodyTest {
    @Test
    fun anEditSendsThePersonaEvenWhenEmpty() {
        // 新建时空人设不上送（省一个键）；改的时候空人设必须上送 —— 那是「把人设删掉」。
        val body = JSONObject(BotsWire.editBody("coder", "码农甲", ""))
        assertEquals("coder", body.getString("bot_id"))
        assertEquals("码农甲", body.getString("name"))
        assertTrue(body.has("persona"))
        assertEquals("", body.getString("persona"))
    }
}

class BotActionBodyTest {
    @Test
    fun editsAndRemovalsCarryAnActionBecauseTheSurfaceOnlyTakesPost() {
        // DSH 的 Connection 只放行 GET/POST；用 PUT/DELETE 会被挡在插件外面，
        // 界面看起来「点了没反应」。两种写操作都带上 action。
        val edit = JSONObject(BotsWire.editBody("coder", "码农", "写代码"))
        assertEquals("edit", edit.getString("action"))
        assertEquals("coder", edit.getString("bot_id"))
        val remove = JSONObject(BotsWire.removeBody("coder"))
        assertEquals("remove", remove.getString("action"))
        assertEquals("coder", remove.getString("bot_id"))
    }
}

/**
 * 「等你决定」卡上的 A/B。
 *
 * 选项只能来自后端（契约 §5：有且只有 2–4 条，id 唯一，label ≤80 字，缺省表示只有一个自写框）。
 * 这里钉的是几件不看就会错的事 —— 这类错不会抛异常，只会让屏幕上多一句其实没发生过的话。
 */
class PendingOptionsTest {

    private fun timeline(task: String) = """{"items":[],"bots":[{"id":"lin","name":"林","role":"default"}],
        "default_bot_id":"lin","tasks":[$task]}"""

    private val asked = """
        {"id":"tk-1","title":"改首页","state":"person","bot_id":"lin","needs_person":"answer",
         "question":"首页先改哪一块？",
         "options":[{"id":"opt-a","label":"去改首页"},{"id":"opt-b","label":"先放着"}]}
    """.trimIndent()

    @Test
    fun readsTheQuestionAndItsOptions() {
        val ticket = CrewWire.parseTimeline(timeline(asked)).tickets.single()
        assertEquals("首页先改哪一块？", ticket.question)
        assertEquals(listOf("opt-a", "opt-b"), ticket.options.map { it.id })
        assertEquals(listOf("去改首页", "先放着"), ticket.options.map { it.label })
        // needs_person 是「这张票在等人」的依据，这张卡靠它出现。
        assertEquals("answer", ticket.needsPerson)
    }

    @Test
    fun aTicketWithoutAQuestionNeverGetsOptions() {
        // delivery / review / blocked / failed 这几种「等你」没有 question，两个字段都不出现。
        // 万一后端多给了一组 options，前端也不能画 —— 没有题就没有答案。
        val ticket = CrewWire.parseTimeline(timeline("""
            {"id":"tk-2","title":"发布","state":"person","bot_id":"lin","needs_person":"review",
             "options":[{"id":"a","label":"看看"},{"id":"b","label":"算了"}]}
        """.trimIndent())).tickets.single()
        assertEquals("", ticket.question)
        assertTrue(ticket.options.isEmpty())
    }

    @Test
    fun oneOptionIsNotAnABPairSoItFallsBackToTheWriter() {
        // 只有一条时不是「后端给了 1 个选项」，而是这组选项读不成 A/B：
        // 按空处理，卡片退回只有一个自写框 —— 不截一条出来充数。
        val ticket = CrewWire.parseTimeline(timeline("""
            {"id":"tk-3","title":"x","state":"person","bot_id":"lin","needs_person":"answer",
             "question":"做哪个？","options":[{"id":"a","label":"只给了一个"}]}
        """.trimIndent())).tickets.single()
        assertTrue(ticket.options.isEmpty())
    }

    @Test
    fun optionsWithoutAnIdOrALabelAreDropped() {
        // 没 id 的按钮认不出是哪一格（回执会串台）；没 label 的按钮点下去发的是空话。
        val ticket = CrewWire.parseTimeline(timeline("""
            {"id":"tk-4","title":"x","state":"person","bot_id":"lin","needs_person":"answer",
             "question":"选一个",
             "options":[{"id":"","label":"没有 id"},{"id":"b","label":"  "},
                        {"id":"c","label":" 留下这个 "},{"id":"d","label":"还有这个"}]}
        """.trimIndent())).tickets.single()
        assertEquals(listOf("c", "d"), ticket.options.map { it.id })
        // 两头的空白要修掉：发出去的回答不该以空格开头。
        assertEquals("留下这个", ticket.options.first().label)
    }

    @Test
    fun aLabelOverEightyCharactersIsDroppedRatherThanTruncated() {
        // 截断后的那句话发出去之后就不是后端给的那个答案了 —— 宁可少一个按钮。
        val long = "长".repeat(81)
        val ticket = CrewWire.parseTimeline(timeline("""
            {"id":"tk-5","title":"x","state":"person","bot_id":"lin","needs_person":"answer",
             "question":"选一个","options":[{"id":"a","label":"$long"},{"id":"b","label":"短的"},
                                            {"id":"c","label":"另一个"}]}
        """.trimIndent())).tickets.single()
        assertEquals(listOf("b", "c"), ticket.options.map { it.id })
    }

    @Test
    fun aRepeatedOptionIdIsKeptOnce() {
        // 同一个 id 两行会共用「正在发」那一个键：点第二行看着像没反应。
        val ticket = CrewWire.parseTimeline(timeline("""
            {"id":"tk-6","title":"x","state":"person","bot_id":"lin","needs_person":"answer",
             "question":"选一个","options":[{"id":"a","label":"第一行"},{"id":"a","label":"第二行"},
                                            {"id":"b","label":"另一行"}]}
        """.trimIndent())).tickets.single()
        assertEquals(listOf("a", "b"), ticket.options.map { it.id })
        assertEquals("第一行", ticket.options.first().label)
    }

    @Test
    fun theSignatureFollowsTheQuestionAndItsOptions() {
        // 「已按这个答了」只对得上同一组。同一张票换了新题，签名必须跟着变 ——
        // 否则上一道题的回执会挂在新问题下面（桌面端 answerSignature 钉的是同一件事）。
        val base = WorkTicket("tk-1", "x", "person", "lin", "answer", question = "问 A",
            options = listOf(AttentionOption("a", "甲"), AttentionOption("b", "乙")))
        assertEquals(CrewWire.answerSignature(base), CrewWire.answerSignature(base.copy()))

        assertNotEquals(CrewWire.answerSignature(base),
            CrewWire.answerSignature(base.copy(question = "问 B")))
        assertNotEquals(CrewWire.answerSignature(base),
            CrewWire.answerSignature(base.copy(options = listOf(AttentionOption("c", "丙"), AttentionOption("d", "丁")))))
        // 同一句问题、同一组 id，只换了 label 也算另一组：人点的那句话变了。
        assertNotEquals(CrewWire.answerSignature(base),
            CrewWire.answerSignature(base.copy(options = listOf(AttentionOption("a", "甲改"), AttentionOption("b", "乙")))))
    }

    @Test
    fun theCardSaysWhyItWaitsWhenThereIsNoQuestion() {
        // 没问题时退回 needs_person 的人话，不补一个空问题，也不编 A/B。
        val review = WorkTicket("tk-9", "x", "person", "lin", "review")
        assertEquals("这张票卡在等你，原因：活干完了，等你过目", AnswerCopy.body(review))
        assertEquals("这张票卡在等你，原因：做不下去，要你松开", AnswerCopy.body(review.copy(needsPerson = "blocked")))
        // 有问题就读问题，不把 question 拆成选项。
        val askedTicket = review.copy(needsPerson = "answer", question = "首页先改哪一块？")
        assertEquals("首页先改哪一块？", AnswerCopy.body(askedTicket))
        assertTrue(askedTicket.options.isEmpty())
        // 后台页现在也走这一句，不再把 answer / review 这种类别原样画出来。
        assertEquals("在等你回一句话", AnswerCopy.waitingWord("answer"))
        assertEquals("上一轮回话没送到，需要你处理", AnswerCopy.waitingWord("delivery"))
        assertEquals("跑失败了，要你处理", AnswerCopy.waitingWord("failed"))
        // 将来后端加了新类别：不装作认识它，但至少说得清在等的是人。
        assertEquals("在等你回一句话", AnswerCopy.waitingWord("something-new"))
    }

    @Test
    fun optionMarksAreLettersAndTheAnswerIsSlottedPerTicket() {
        assertEquals("A", AnswerCopy.optionMark(0))
        assertEquals("B", AnswerCopy.optionMark(1))
        assertEquals("D", AnswerCopy.optionMark(3))
        // 超过 26 只是兜底：后端最多给四个。
        assertEquals("27", AnswerCopy.optionMark(26))
        // 键是「票号|选项 id」：两张票的 opt-a 不能互相顶掉。
        assertEquals("tk-1|opt-a", CrewWire.answerSlot("tk-1", "opt-a"))
        assertNotEquals(CrewWire.answerSlot("tk-1", "opt-a"), CrewWire.answerSlot("tk-2", "opt-a"))
    }

    @Test
    fun answerResultsSayWhatHappened() {
        assertEquals("已按这个答了，队伍下一步会接上", AnswerCopy.ANSWER_DONE)
        assertEquals("没答上：没有这个对话", AnswerCopy.answerFailed("没有这个对话"))
        assertEquals("没答上：队伍没回话", AnswerCopy.answerFailed(null))
        assertEquals("没答上：队伍没回话", AnswerCopy.answerFailed("   "))
    }
}

/**
 * 代码卡下面那两个按钮（契约 §5）。
 *
 * 两个都不新开接口：采用走 POST /send，看效果走 GET /screen?ticket=…。
 * 这里钉的是「对谁做」那几件：票号只认这段改动自己带的，缺了就说缺了。
 */
class CodeCardButtonsTest {

    private fun messageChain(raw: String): Message =
        CrewWire.parseTimeline("""{"items":[$raw],"bots":[{"id":"coder","name":"码农"}],"default_bot_id":"coder"}""")
            .messages.single()

    private val withTicket = """
        {"id":"r7","role":"agent","bot_id":"coder","text":"改好了","ticket_ref":"tk-1",
         "code":{"path":"login.tsx","added":8,"removed":4,
           "lines":[{"text":"  gap: 12px;","kind":""},{"text":"  gap: 16px;","kind":"added"}]}}
    """.trimIndent()

    @Test
    fun theBlockIsCarriedOnTheMessagesOwnTicket() {
        // 「看看改完的样子」要知道看哪张票：消息上的 ticket_ref 落到代码块里。
        val message = messageChain(withTicket)
        val block = message.code!!
        assertEquals("tk-1", block.ticketRef)
        assertEquals("tk-1", message.ticketRef)
        assertEquals("login.tsx", block.path)
        assertEquals(8, block.added)
        assertEquals(4, block.removed)
        // 没有 id 时用「票号|文件名」拼一个：两张卡的回执才分得开。
        assertEquals("tk-1|login.tsx", block.id)
    }

    @Test
    fun theBlocksOwnTicketWinsOverTheMessages() {
        // 两处都可，代码块里的优先 —— 同一段对话可以挂着不同工单的改动。
        val block = messageChain("""
            {"id":"r8","role":"agent","bot_id":"coder","text":"x","ticket_ref":"tk-outer",
             "code":{"id":"tk-inner|b.ts","path":"b.ts","ticket_ref":"tk-inner",
               "lines":[{"text":"y","kind":""}]}}
        """.trimIndent()).code!!
        assertEquals("tk-inner", block.ticketRef)
        // 后端给了 id 就用后端的，不另拼一个。
        assertEquals("tk-inner|b.ts", block.id)
    }

    @Test
    fun diffNamingIsUnderstoodToo() {
        val block = messageChain("""
            {"id":"r9","role":"agent","bot_id":"coder","text":"x","ticket_ref":"tk-2",
             "diff":{"path":"a.ts","added":1,"removed":0,"lines":[{"text":"x","kind":"added"}]}}
        """.trimIndent()).code!!
        assertEquals("a.ts", block.path)
        assertEquals("tk-2", block.ticketRef)
    }

    @Test
    fun aBlockWithNoLinesIsNoCard() {
        // 没有改动就没有「采用」：只有个文件名的空卡不该画出来，按钮也不该跟着出现。
        val message = messageChain("""
            {"id":"r10","role":"agent","bot_id":"coder","text":"x","ticket_ref":"tk-3",
             "code":{"path":"empty.ts","lines":[]}}
        """.trimIndent())
        assertNull(message.code)
        assertFalse(CodeCardRules.showsButtons(message.code))
    }

    @Test
    fun aMissingTicketIsReportedNotSubstituted() {
        // 缺 ticket_ref 时绝不拿别的票顶上。这里钉「卡片看得见、票号是空的」，
        // 界面按 NO_TICKET 如实说，不去猜一张在跑的票。
        val block = messageChain("""
            {"id":"r11","role":"agent","bot_id":"coder","text":"x",
             "code":{"path":"a.ts","lines":[{"text":"y","kind":"added"}]}}
        """.trimIndent()).code!!
        assertEquals("", block.ticketRef)
        // id 仍然稳定（票号为空时只剩文件名），同一段对话里两张同名卡由文件名区分。
        assertEquals("|a.ts", block.id)
        // 按钮照样画：没有票号的那一下按下去会得到一句实话，而不是一块点不动的空地。
        assertTrue(CodeCardRules.showsButtons(block))
        assertTrue(CodeCopy.NO_TICKET.isNotBlank())
    }

    @Test
    fun adoptTextNamesTheBotThatWroteIt() {
        // 与桌面端 adoptText 逐字一致：两端发出去的话不一样，Bot 读到的就是两件事。
        val block = CodeBlock("login.tsx", 8, 4, emptyList())
        assertEquals(
            "@coder（码农） 采用 login.tsx 这段改动，加 8 行、删 4 行，按这个改。",
            CodeCopy.adoptText(block, "coder", "码农"),
        )
        // 名字与 id 相同时只说一遍：@coder（coder）读起来像写错了。
        assertEquals(
            "@coder 采用 login.tsx 这段改动，加 8 行、删 4 行，按这个改。",
            CodeCopy.adoptText(block, "coder", "coder"),
        )
        // 没有统计就只说采用了哪段，不编一个「加 0 行」。
        assertEquals("采用 a.ts 这段改动，按这个改。",
            CodeCopy.adoptText(CodeBlock("a.ts", 0, 0, emptyList()), null, null))
        // 没有文件名时说的是「这段改动」，不会变成「采用  这段改动」。
        assertEquals("采用 这段改动，按这个改。",
            CodeCopy.adoptText(CodeBlock("", 0, 1, emptyList()), null, null))
    }

    @Test
    fun theSummarySaysOneNumberWhenOnlyOneMoved() {
        assertEquals("加 3 行", CodeCopy.changeSummary(CodeBlock("a", 3, 0, emptyList())))
        assertEquals("删 2 行", CodeCopy.changeSummary(CodeBlock("a", 0, 2, emptyList())))
        assertEquals("", CodeCopy.changeSummary(CodeBlock("a", 0, 0, emptyList())))
    }

    @Test
    fun thePreviewSeparatesTheThreeWaysOfHavingNoPicture() {
        // 真读到画面：不写那一行字，交给上层把快照画出来。
        assertNull(CodeCopy.previewNote(
            ScreenView("live", "", lines = listOf(ScreenLine("", "command", "\$ pnpm test")))))
        // 后端说了理由就写理由 —— 它是真的那句话。
        assertEquals("这张工单还没有可读的执行记录",
            CodeCopy.previewNote(ScreenView("unavailable", "这张工单还没有可读的执行记录")))
        // 后端什么都没说：说「暂时没有」，不说「在加载」。
        assertEquals("这张工单暂时没有可显示的活动", CodeCopy.previewNote(ScreenView("live", "")))
        // 连回答都没有：是读不到，不是没有。
        assertEquals("读不到「改完的样子」：队伍没回话", CodeCopy.previewNote(null))
        assertEquals("读不到「改完的样子」：队伍返回 503：paused", CodeCopy.previewFailed("队伍返回 503：paused"))
    }

    @Test
    fun adoptResultsSayWhatHappened() {
        assertEquals("已请它采用这段改动，下一步会按这个改", CodeCopy.ADOPT_DONE)
        assertEquals("没采用成：队伍返回 503：paused", CodeCopy.adoptFailed("队伍返回 503：paused"))
        assertEquals("没采用成：队伍没回话", CodeCopy.adoptFailed(null))
        // 按钮上的字就是画板上的那几个。
        assertEquals("采用", CodeCopy.ADOPT)
        assertEquals("采用中…", CodeCopy.ADOPTING)
        assertEquals("✓ 已采用", CodeCopy.ADOPTED)
        assertEquals("看看改完的样子", CodeCopy.PREVIEW)
    }
}
