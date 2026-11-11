package com.dsh.botcrew

import java.time.ZoneId
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

    // 后端给了 elapsed_seconds 就接住，一层层都接住：子代理的子代理也带耗时。
    @Test
    fun readsTheElapsedSecondsTheBackendSent() {
        val body = """
            {"ticket_id":"tk1","agents":[
              {"id":"worker-tk1","label":"工单","state":"completed","elapsed_seconds":42,"children":[
                {"id":"sub-a","label":"子代理","state":"completed","elapsed_seconds":65.5,"children":[]}
              ]}
            ]}
        """.trimIndent()
        val tree = AgentWire.parse(body)
        assertEquals(42.0, tree[0].elapsedSeconds)
        assertEquals(65.5, tree[0].children[0].elapsedSeconds)
        // 一句话也要对得上：有值才画「· 42 秒」，量级与画板一致。
        assertEquals("已完成 · 42 秒", AgentCopy.status(tree[0], working = false))
        // 65.5 正好练到进位：与桌面端 `int(seconds + 0.5)` 同一个取法，65.5 → 66 → 「1 分 6 秒」。
        assertEquals("已完成 · 1 分 6 秒", AgentCopy.status(tree[0].children[0], working = false))
    }

    // 后端今天还不发这个字段：缺席就是 null，界面上不画那一截，绝不编一个数。
    @Test
    fun aNodeWithoutElapsedHasNone() {
        val body = """
            {"ticket_id":"tk1","agents":[
              {"id":"worker-tk1","label":"工单","state":"completed","children":[
                {"id":"sub-a","label":"子代理","state":"completed","elapsed_seconds":null,"children":[]}
              ]}
            ]}
        """.trimIndent()
        val tree = AgentWire.parse(body)
        // 字段缺席，与显式给 null，是同一件事：都没有值。
        assertNull(tree[0].elapsedSeconds)
        assertNull(tree[0].children[0].elapsedSeconds)
        assertEquals("已完成", AgentCopy.status(tree[0], working = false))
        assertNull(AgentCopy.elapsed(null))
    }

    // 在跑的不画耗时：它还没跑完，这个数此刻不成立。用词是「在跑」，不是工单卡的「在做」。
    @Test
    fun aRunningAgentSaysItIsRunningAndShowsNoTime() {
        val running = AgentNode(id = "sub-b", label = "子代理", state = "working", elapsedSeconds = 42.0, children = emptyList())
        assertEquals("在跑", AgentCopy.status(running, working = true))
        assertEquals("在跑", AgentCopy.word("working"))
        // 工单卡上说的是「在做」（CrewUi 的 stateWord），子代理行说的是「在跑」：
        // 同一件事在两个语境里不是一个词，混用会有一边不像画板。
        assertNotEquals("在做", AgentCopy.word("working"))
        // 终态也要说人话，不是把后端的英文词原样贴出来。
        assertEquals("已完成", AgentCopy.word("completed"))
        assertEquals("已停下", AgentCopy.word("failed"))
        assertEquals("已放弃", AgentCopy.word("dropped"))
    }

    // 耗时读坏了（负数、NaN、无穷、超过一天）就整段不画，不能画一个负数或一个孤零零的「· 」。
    @Test
    fun aBrokenElapsedDrawsNothing() {
        for (value in listOf(-1.0, -0.5, Double.NaN, Double.POSITIVE_INFINITY, 24.0 * 60 * 60 + 1)) {
            val node = AgentNode(id = "a", label = "子代理", state = "completed", elapsedSeconds = value, children = emptyList())
            assertEquals("耗时 $value 读坏了，却画成了别的", "已完成", AgentCopy.status(node, working = false))
            assertNull(AgentCopy.elapsed(value))
        }
        // 秒数的说法：一分钟以内说秒，超过就说「N 分 M 秒」。
        assertEquals("0 秒", AgentCopy.elapsed(0.0))
        assertEquals("59 秒", AgentCopy.elapsed(59.4))
        assertEquals("1 分 0 秒", AgentCopy.elapsed(60.0))
        assertEquals("7 分 7 秒", AgentCopy.elapsed(427.0))
    }

    // 分词着色，与桌面端 syntax_test.go 是同一组断言。
    // 这一层唯一不能错的地方：拼回去必须与原文逐字相同 ——
    // 高亮是装饰，吃掉一个字符就是把代码改错了给人看。
    @Test
    fun tokenizingNeverDropsCharacters() {
        for (line in listOf(
            "gap: 12px;",
            """color: "#FFF";""",
            "// 注释",
            """const a = "a\"b";""",
            "x := 0x1f + 1.85",
            "没有数字也没有引号",
            "",
            "/* 块注释 */",
            "SELECT * FROM t -- SQL 注释",
            """不配对的引号 " 后面还有字""",
        )) {
            val joined = CodeSyntax.segments(CodeLine(line, "")).joinToString("") { it.text }
            assertEquals("  $line", joined)
        }
        // 行首空白会被剥掉：segments 里 trimStart，与旧渲染同一行为（那一格缩进由行首
        // 那两格前缀代表，正文不再重复带自己的缩进）。除了这两格前缀，一个字都不能少。
        assertEquals(
            "  # 井号开头",
            CodeSyntax.segments(CodeLine("  # 井号开头", "")).joinToString("") { it.text },
        )
    }

    // 画板 Desktop.dc.html:133 那一行：上下文整行暖灰，只有值 `12px` 是赭色。
    @Test
    fun theBoardLineMarksItsValueAsANumber() {
        val tokens = CodeSyntax.tokenize("gap: 12px;")
        // 三段：`gap: `、`12px`、`;`。值那一段是数字，另外两段是普通文字。
        assertEquals(listOf("gap: ", "12px", ";"), tokens.map { it.text })
        assertEquals(CodeSyntax.Kind.Number, tokens[1].kind)
        assertEquals(1, tokens.count { it.kind == CodeSyntax.Kind.Number })
    }

    // 字符串里的数字不该被单独染色：整段是字符串。
    @Test
    fun aNumberInsideAStringStaysAString() {
        val tokens = CodeSyntax.tokenize("""margin: "12px";""")
        assertEquals(0, tokens.count { it.kind == CodeSyntax.Kind.Number })
        assertEquals("\"12px\"", tokens.first { it.kind == CodeSyntax.Kind.Quoted }.text)
    }

    // 颜色值里的 # 不是注释：判成注释会让整整一行变成注释色，值就看不见了。
    // 而贴着行首（或前面只有空白）的 # 才算注释。
    @Test
    fun aHashInsideAColorIsNotAComment() {
        assertEquals(0, CodeSyntax.tokenize("color: #FFF;").count { it.kind == CodeSyntax.Kind.Comment })
        assertEquals(CodeSyntax.Kind.Comment, CodeSyntax.tokenize("# 真注释")[0].kind)
        val indented = CodeSyntax.tokenize("   # 缩进后的注释")
        // 前面那几格空白先成一段普通文字，注释是第二段。
        assertTrue(indented.size >= 2)
        assertEquals(CodeSyntax.Kind.Comment, indented[1].kind)
    }

    // 自减不是注释：`i--` 里的 `--` 贴着内容。
    @Test
    fun aDecrementIsNotAComment() {
        assertEquals(0, CodeSyntax.tokenize("i--;").count { it.kind == CodeSyntax.Kind.Comment })
    }

    // 改动行整行一段、不拆词：画板里改动的就是整行，行内再分色看不出哪一行变了。
    @Test
    fun aChangedLineStaysOnePieces() {
        val added = CodeSyntax.segments(CodeLine("  gap: 16px;", "added"))
        assertEquals(1, added.size)
        assertEquals("+ gap: 16px;", added[0].text)
        val removed = CodeSyntax.segments(CodeLine("- gap: 16px;", "removed"))
        assertEquals(1, removed.size)
        assertEquals("- gap: 16px;", removed[0].text)
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
        // 没有文件名时说的是「这段改动」，不会变成「采用  这段改动」，也不会说成
        // 「采用 这段改动 这段改动」。增删统计仍然要说 —— 那是这条消息里唯一有用的信息。
        assertEquals("采用 这段改动，删 1 行，按这个改。",
            CodeCopy.adoptText(CodeBlock("", 0, 1, emptyList()), null, null))
        assertEquals("采用 这段改动，按这个改。",
            CodeCopy.adoptText(CodeBlock("", 0, 0, emptyList()), null, null))
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

/**
 * 消息结果条（契约 §5.4 末节）。
 *
 * 四条规则：消息带 ticket_ref、读的是那一张、只有 live 才画、empty/unavailable/失败都不画。
 * 这里钉住每一处「宁可不画也不编」的断面 —— 结果条一旦把故障或别的票画成成果，
 * 人就会以为那件事真的做完了。
 */
class OutputsBarTest {

    private val liveBody = """
        {"items":[
           {"id":"tk-1|a.png","ticket_id":"tk-1","path":"a.png","title":"a.png","kind":"image","writes":2,"at":"2026-11-11T10:05:00Z"},
           {"id":"tk-1|b.ts","ticket_id":"tk-1","path":"b.ts","title":"b.ts","kind":"file","writes":1,"at":"2026-11-11T10:04:00Z"}],
         "state":"live","counts":{"file":1,"image":1},"ticket_id":"tk-1"}
    """.trimIndent()

    private fun view(body: String): OutputsView = OutputsWire.parse(body)

    @Test
    fun readsWhatTheCrewHandedOver() {
        val parsed = view(liveBody)
        assertEquals("live", parsed.state)
        assertEquals(2, parsed.items.size)
        assertEquals("tk-1|a.png", parsed.items[0].id)
        assertEquals("image", parsed.items[0].kind)
        assertEquals("tk-1", parsed.ticketId)
        assertEquals(OutputCounts(file = 1, image = 1), parsed.counts)
    }

    @Test
    fun theLineIsBuiltFromCountsTheSameWayAsTheDesktop() {
        // 逐字对齐桌面端 outputResultLine：两端同一句话，人才不会以为是两件事。
        assertEquals("1 个文件 · 2 张图片已放进产出",
            OutputsCopy.resultLine(OutputsView(emptyList(), "live", OutputCounts(1, 2))))
        assertEquals("2 张图片已放进产出",
            OutputsCopy.resultLine(OutputsView(emptyList(), "live", OutputCounts(0, 2))))
        assertEquals("3 个文件已放进产出",
            OutputsCopy.resultLine(OutputsView(emptyList(), "live", OutputCounts(3, 0))))
        // 两类都是 0：一句话也拼不出来，调用方据此不画。
        assertEquals("", OutputsCopy.resultLine(OutputsView(emptyList(), "live", OutputCounts(0, 0))))
    }

    @Test
    fun onlyLiveOutputsMakeABar() {
        assertEquals("1 个文件 · 1 张图片已放进产出", OutputsCopy.barLine(view(liveBody)))
        // empty：读得到、确实没有 —— 不画。
        assertNull(OutputsCopy.barLine(view("""{"items":[],"state":"empty","counts":{"file":0,"image":0}}""")))
        // unavailable：读不到 —— 也不画。把故障画成成果是最糟的一种假。
        assertNull(OutputsCopy.barLine(view(
            """{"items":[],"state":"unavailable","counts":{"file":0,"image":0},"reason":"这张工单的执行记录读不出来了"}""")))
        // 请求失败：缓存里连 view 都没有。
        assertNull(OutputsCopy.barLine(null))
        // 说 live 却一条都没有：仍然不画，不给它编一个「0 个文件」。
        assertNull(OutputsCopy.barLine(view("""{"items":[],"state":"live","counts":{"file":0,"image":0}}""")))
        // 缺席的状态落到 unavailable（说读不到，不说没有）；不认识的取值原样留着，
        // 界面只认 live，所以照样不画。
        assertEquals("unavailable", view("""{"items":[]}""").state)
        assertNull(OutputsCopy.barLine(view("""{"items":[],"state":"weird"}""")))
    }

    @Test
    fun theBarOnlyReadsTheMessagesOwnTicket() {
        fun message(raw: String): Message =
            CrewWire.parseTimeline("""{"items":[$raw],"bots":[],"default_bot_id":""}""").messages.single()
        // 带票号：读这一张。
        assertEquals("tk-1", OutputsCopy.barTicket(message(
            """{"id":"r1","role":"agent","bot_id":"coder","text":"改好了","ticket_ref":"tk-1"}""")))
        // 没带票号：空串。界面据此什么都不读，绝不按时间猜一张最近的票。
        assertEquals("", OutputsCopy.barTicket(message(
            """{"id":"r2","role":"agent","bot_id":"coder","text":"改好了"}""")))
        // 空白票号也算没带，让「没有」只有一种形状。
        assertEquals("", OutputsCopy.barTicket(message(
            """{"id":"r3","role":"agent","bot_id":"coder","text":"x","ticket_ref":"  "}""")))
    }

    @Test
    fun theCacheRemembersWhatItTriedAndOnlyAsksOnce() {
        val cache = OutputsCache()
        val epoch = 1
        assertFalse("没有票号就不发请求", cache.need("", epoch))
        assertFalse("没有票号也不记成在读", cache.start("", epoch))
        assertTrue(cache.need("tk-1", epoch))
        assertTrue(cache.start("tk-1", epoch))
        assertFalse("同一张票在同一轮里不并发发第二个请求", cache.start("tk-1", epoch))

        cache.finish("tk-1", view(liveBody), epoch)
        assertFalse("读到了就不必再读", cache.need("tk-1", epoch))
        assertEquals("1 个文件 · 1 张图片已放进产出", cache.line("tk-1", epoch))

        // 读不到也记一笔：结果条不画，但同样不再重发请求。
        assertTrue(cache.start("tk-2", epoch))
        cache.finish("tk-2", null, epoch)
        assertTrue(cache.tried("tk-2", epoch))
        assertFalse(cache.need("tk-2", epoch))
        assertNull(cache.line("tk-2", epoch))
    }

    @Test
    fun aNewTimelineMakesTheCacheReadAgain() {
        val cache = OutputsCache()
        cache.start("tk-1", 1)
        cache.finish("tk-1", view(liveBody), 1)
        // 同一轮里反复问：不再发请求。
        assertFalse(cache.need("tk-1", 1))
        assertEquals("1 个文件 · 1 张图片已放进产出", cache.line("tk-1", 1))
        // 时间线又读回来一次（第 2 轮）：worker 可能只写了个文件、一句新话也没说，
        // 所以这一轮必须重读，而不是继续拿第 1 轮的结果画。
        assertTrue(cache.need("tk-1", 2))
        assertNull("上一轮的结果不拿来画这一轮", cache.line("tk-1", 2))
        assertTrue(cache.start("tk-1", 2))
        // 第 1 轮的请求这会儿才回来：它不能把第 2 轮的账本改成旧数据，
        // 更不能把第 2 轮「正在读」的记号抹掉 —— 那会让这一轮永远停在「读过、没有」。
        cache.finish("tk-1", view(liveBody), 1)
        assertNull(cache.line("tk-1", 2))
        assertFalse("第 2 轮仍在读，不该再发第二个请求", cache.need("tk-1", 2))
        // 这一轮自己读回来，才开始算数。
        cache.finish("tk-1", view(liveBody), 2)
        assertFalse(cache.need("tk-1", 2))
        assertEquals("1 个文件 · 1 张图片已放进产出", cache.line("tk-1", 2))
    }

    @Test
    fun aCancelledReadIsNotRecordedAsUnreadable() {
        val cache = OutputsCache()
        assertTrue(cache.start("tk-9", 1))
        cache.abandon("tk-9", 1)
        assertFalse("取消不是读不到", cache.tried("tk-9", 1))
        assertTrue("滚回来还要再读一次", cache.start("tk-9", 1))
        cache.finish("tk-9", null, 1)
        assertTrue(cache.tried("tk-9", 1))
    }

    // ── 结果条挂在哪一条（同一张票只挂最后一次）───────────────────

    /** 把若干条原始 item 读成时间线，顺序就是测试给的顺序。 */
    private fun timelineOf(vararg items: String): List<Message> =
        CrewWire.parseTimeline("""{"items":[${items.joinToString(",")}],"bots":[],"default_bot_id":""}""").messages

    @Test
    fun onlyTheLastMessageOfATicketShowsTheBar() {
        // 同一张票挂在「收到」和「报结果」两条回复上：前面那条不画，只有最后一条画。
        val messages = timelineOf(
            """{"id":"r1","role":"agent","bot_id":"coder","text":"收到，这就去改","ticket_ref":"tk-1"}""",
            """{"id":"r2","role":"agent","bot_id":"coder","text":"开始改了","ticket_ref":"tk-1"}""",
            """{"id":"r3","role":"agent","bot_id":"coder","text":"改好了","ticket_ref":"tk-1"}""",
        )
        assertFalse("前面的同票号回复不挂结果条", OutputsCopy.lastOfTicket(messages, 0))
        assertFalse(OutputsCopy.lastOfTicket(messages, 1))
        assertTrue("最后一条带 tk-1 的回复才挂", OutputsCopy.lastOfTicket(messages, 2))
        // 只有一条、带票号：它就是最后一条。
        assertTrue(OutputsCopy.lastOfTicket(messages.take(1), 0))
    }

    @Test
    fun theLastOneRuleStillOnlyReadsThatMessagesOwnTicket() {
        val messages = timelineOf(
            // 没票号的那条永远不画，也绝不因为「后面那条也没票号」就替它认一张票。
            """{"id":"r1","role":"agent","bot_id":"coder","text":"在的"}""",
            """{"id":"r2","role":"agent","bot_id":"coder","text":"x","ticket_ref":"  "}""",
        )
        assertFalse("没带票号不挂结果条", OutputsCopy.lastOfTicket(messages, 0))
        assertFalse("空白票号也算没带", OutputsCopy.lastOfTicket(messages, 1))
        // 两张票各论各的，互不压盖。
        val two = timelineOf(
            """{"id":"r1","role":"agent","bot_id":"coder","text":"tk-3 收到","ticket_ref":"tk-3"}""",
            """{"id":"r2","role":"agent","bot_id":"coder","text":"tk-4 收到","ticket_ref":"tk-4"}""",
        )
        assertTrue(OutputsCopy.lastOfTicket(two, 0))
        assertTrue(OutputsCopy.lastOfTicket(two, 1))
    }

    @Test
    fun onlyBotRepliesCanHoldTheBar() {
        // 自己发的话不挂结果条，所以它带同票号也不算「压住上面那条回复」。
        val messages = timelineOf(
            """{"id":"r1","role":"agent","bot_id":"coder","text":"改好了","ticket_ref":"tk-2"}""",
            """{"id":"m1","role":"user","text":"@coder 再看看","ticket_ref":"tk-2"}""",
        )
        assertTrue("后面只有人说的话，Bot 那条仍是最后一条", OutputsCopy.lastOfTicket(messages, 0))
        assertFalse("自己发的话不挂结果条", OutputsCopy.lastOfTicket(messages, 1))
        // 反过来：人说的话夹在两条 Bot 回复中间，不能把上一条的「最后一条」顶掉。
        val sandwiched = timelineOf(
            """{"id":"r1","role":"agent","bot_id":"coder","text":"收到","ticket_ref":"tk-5"}""",
            """{"id":"m1","role":"user","text":"快点"}""",
            """{"id":"r2","role":"agent","bot_id":"coder","text":"好了","ticket_ref":"tk-5"}""",
        )
        assertFalse(OutputsCopy.lastOfTicket(sandwiched, 0))
        assertTrue(OutputsCopy.lastOfTicket(sandwiched, 2))
    }

    @Test
    fun aBadIndexIsQuiet() {
        val messages = timelineOf(
            """{"id":"r1","role":"agent","bot_id":"coder","text":"x","ticket_ref":"tk-1"}""",
        )
        // 越界的下标安静地返回 false，别让调用方一处写错就炸掉整屏。
        assertFalse(OutputsCopy.lastOfTicket(messages, 1))
        assertFalse(OutputsCopy.lastOfTicket(messages, -1))
        assertFalse(OutputsCopy.lastOfTicket(emptyList(), 0))
    }

    // ── 未读（契约 §5.6）────────────────────────────────────────
    // 手机只认后端那个数。最容易出的错是把「算不出来」读成 0 —— 那会在界面上
    // 说「都读过了」，而实际是网关根本没报告。

    @Test
    fun readsTheUnreadCountTheBackendReported() {
        val body = """{"items":[],"bots":[],"default_bot_id":"","unread":{"count":2,"state":"live"}}"""
        assertEquals(2, CrewWire.parseTimeline(body).unread)
        // 读得到、确实是 0 条：0 是真话，不是「不知道」。
        val empty = """{"items":[],"unread":{"count":0,"state":"live"}}"""
        assertEquals(0, CrewWire.parseTimeline(empty).unread)
    }

    @Test
    fun anUncountableTimelineIsNotZero() {
        // state 不是 live：后端明说算不出来，count 一律不认。
        val unknown = """{"items":[],"unread":{"count":null,"state":"unknown","reason":"没报告"}}"""
        assertNull(CrewWire.parseTimeline(unknown).unread)
        // 老后端整段没有这个字段：同样不下结论。
        assertNull(CrewWire.parseTimeline("""{"items":[]}""").unread)
        // state 说 live 却没有 count，是自相矛盾的一份，也不能当成 0。
        assertNull(CrewWire.parseTimeline("""{"items":[],"unread":{"state":"live"}}""").unread)
    }

    @Test
    fun theBadgeNeverGrowsPastTwoDigits() {
        // 15dp 的胶囊放不下三位数；99 是它能完整写下的最大值。
        assertEquals("1", unreadBadge(1))
        assertEquals("99", unreadBadge(99))
        assertEquals("99+", unreadBadge(100))
    }
}

/**
 * 工单进度（契约 §进度）：分母只能来自后端下发的计划。
 *
 * 这几条钉的是同一件事的几面：没计划不画、分子分母都读后端的、越界要夹回来、
 * 只来一半字段时怎么退化、0 与负数不能当分母、计划改小时进度可以回退（不做单调化），
 * 以及概览行不会因为某一段空着就留下悬空的分隔符。
 */
class TicketProgressTest {

    private fun ticket(json: String): WorkTicket =
        CrewWire.parseTimeline(
            """{"items":[],"bots":[],"default_bot_id":"","tasks":[""" + json + "]}"
        ).tickets.single()

    @Test
    fun readsTotalStepsAndStepsDone() {
        val ticket = ticket(
            """{"id":"tk-1","title":"改首页","state":"working","bot_id":"lin","total_steps":3,"steps_done":1}"""
        )
        assertEquals(3, ticket.totalSteps)
        assertEquals(1, ticket.stepsDone)
        assertEquals(1 to 3, progressOf(ticket))
        assertEquals("第 1 步 / 共 3 步", stepOf(ticket))
    }

    @Test
    fun aTicketWithoutAPlanHasNoDenominator() {
        // 后端没发 total_steps / steps_done：两个字段都落到 0，进度条整条不画。
        val ticket = ticket("""{"id":"tk-2","title":"没计划","state":"working","bot_id":"lin"}""")
        assertEquals(0, ticket.totalSteps)
        assertEquals(0, ticket.stepsDone)
        assertEquals(0 to 0, progressOf(ticket))
        assertEquals("", stepOf(ticket))
    }

    @Test
    fun aContradictoryDoneCountIsClampedInsteadOfOverflowing() {
        // 后端版本不一致时可能给出比计划还大的步数：宽度不许超过 100%。
        val over = ticket(
            """{"id":"tk-3","title":"越界","state":"working","bot_id":"lin","total_steps":2,"steps_done":5}"""
        )
        assertEquals(2 to 2, progressOf(over))
        val negative = ticket(
            """{"id":"tk-4","title":"负数","state":"working","bot_id":"lin","total_steps":2,"steps_done":-1}"""
        )
        assertEquals(0 to 2, progressOf(negative))
        // 一步没走完只说「共 2 步」，不编一个「第 0 步」。
        assertEquals("共 2 步", stepOf(negative))
    }

    @Test
    fun aHalfSentPlanIsStillNoPlan() {
        // 契约说两个字段要么一起来、要么一起缺。真遇到只来一半（版本错位）时：
        // 有 total_steps 没 steps_done，就当「一步没走完」——分母有出处，分子缺省为 0，
        // 画一条空轨道；反过来只有 steps_done 没有分母，整条不画。
        val halfA = ticket(
            """{"id":"tk-6","title":"只给分母","state":"working","bot_id":"lin","total_steps":3}"""
        )
        assertEquals(0 to 3, progressOf(halfA))
        assertEquals("共 3 步", stepOf(halfA))
        val halfB = ticket(
            """{"id":"tk-7","title":"只给分子","state":"working","bot_id":"lin","steps_done":2}"""
        )
        assertEquals(0 to 0, progressOf(halfB))
        assertEquals("", stepOf(halfB))
    }

    @Test
    fun aZeroOrNegativePlanIsNeverDividedBy() {
        // total_steps 必须 ≥ 1（契约）。真给了 0 或负数时，宁可当「没有计划」，
        // 也不许拿它当分母 —— 除以 0 的宽度算出来是 NaN / 无穷，画出来是一条满格或崩掉的条。
        val zero = ticket(
            """{"id":"tk-8","title":"零步","state":"working","bot_id":"lin","total_steps":0,"steps_done":0}"""
        )
        assertEquals(0 to 0, progressOf(zero))
        assertEquals("", stepOf(zero))
        val negative = ticket(
            """{"id":"tk-9","title":"负数计划","state":"working","bot_id":"lin","total_steps":-2,"steps_done":1}"""
        )
        assertEquals(0 to 0, progressOf(negative))
        assertEquals("", stepOf(negative))
    }

    @Test
    fun aFinishedPlanSaysTheLastStep() {
        // 走完时分子等于分母：条是满的，文案说「第 3 步 / 共 3 步」而不是停在「共 3 步」。
        val ticket = ticket(
            """{"id":"tk-10","title":"走完","state":"completed","bot_id":"lin","total_steps":3,"steps_done":3}"""
        )
        assertEquals(3 to 3, progressOf(ticket))
        assertEquals("第 3 步 / 共 3 步", stepOf(ticket))
    }

    @Test
    fun theDetailLineNeverLeavesADanglingSeparator() {
        // 后端不发 bot_id 时 owner 是空串。直接插值会拼出「在做 ·  · 共 3 步」。
        assertEquals("在做 · 林 · 第 1 步 / 共 3 步", ticketDetail("在做", "林", "第 1 步 / 共 3 步"))
        assertEquals("在做 · 第 1 步 / 共 3 步", ticketDetail("在做", "", "第 1 步 / 共 3 步"))
        assertEquals("在做 · 林", ticketDetail("在做", "林", ""))
        assertEquals("在做", ticketDetail("在做", "", ""))
    }

    @Test
    fun aShrinkingPlanMayShowLessProgress() {
        // 计划被改小是真话：进度回退不单调化，分母跟着变小。
        val before = ticket(
            """{"id":"tk-5","title":"改计划","state":"working","bot_id":"lin","total_steps":5,"steps_done":4}"""
        )
        val after = ticket(
            """{"id":"tk-5","title":"改计划","state":"working","bot_id":"lin","total_steps":2,"steps_done":2}"""
        )
        assertEquals(4 to 5, progressOf(before))
        assertEquals(2 to 2, progressOf(after))
    }
}

/**
 * 常规任务（契约 §5.5）。
 *
 * 这一屏最容易错的地方不是画得丑，是「说了句其实没发生的事」：
 * 把读不到说成没有、给没跑过的账编一个日期、把不认识的周期猜成「每天」、
 * 或者把账本画成「到点会自己跑」。这里把每一处断面都钉住。
 */
class RoutinesBarTest {

    private val liveBody = """
        {"items":[
           {"id":"daily-standup","title":"每天站会","cycle":"daily","bot_id":"lead","enabled":true,
            "created_at":"2026-11-11T09:00:00.000Z","next_run":"2026-11-12T09:00:00.000Z","overdue":false},
           {"id":"weekly-review","title":"周报","cycle":"weekly","enabled":false,
            "created_at":"2026-11-01T09:00:00.000Z","last_run":"2026-11-08T09:00:00.000Z",
            "next_run":"2026-11-15T09:00:00.000Z","overdue":true}],
         "state":"live","counts":{"enabled":1,"paused":1},"runner":"none"}
    """.trimIndent()

    private fun view(body: String): RoutinesView = RoutinesWire.parse(body)

    @Test
    fun readsWhatTheSurfaceSends() {
        val parsed = view(liveBody)
        assertEquals("live", parsed.state)
        assertTrue(parsed.live)
        assertEquals(2, parsed.items.size)
        assertEquals(RoutineCounts(enabled = 1, paused = 1), parsed.counts)
        // 后端还没有调度器：这一栏不许被读成「已排好」。
        assertEquals("none", parsed.runner)

        val first = parsed.items[0]
        assertEquals("daily-standup", first.id)
        assertEquals("每天站会", first.title)
        assertEquals("daily", first.cycle)
        assertEquals("lead", first.botId)
        assertTrue(first.enabled)
        assertFalse(first.overdue)
        assertEquals("2026-11-12T09:00:00.000Z", first.nextRun)
        // 没跑过就是没跑过：last_run 缺席不该被解出一个日期。
        assertEquals("", first.lastRun)

        val second = parsed.items[1]
        assertEquals("weekly", second.cycle)
        assertFalse(second.enabled)
        assertTrue("关着的那条也照实说它逾期了", second.overdue)
        assertEquals("2026-11-08T09:00:00.000Z", second.lastRun)
        // 账本允许不指定负责人：空串就是没有，不编一个 default。
        assertEquals("", second.botId)
    }

    @Test
    fun emptyAndUnreadableAreTwoDifferentSentences() {
        // empty：读得到、确实一条都没有。
        val empty = view(
            """{"items":[],"state":"empty","counts":{"enabled":0,"paused":0},"reason":"账本里还没有常规任务","runner":"none"}"""
        )
        assertEquals("empty", empty.state)
        assertFalse(empty.live)
        assertTrue(empty.items.isEmpty())
        assertEquals("账本里还没有常规任务", empty.reason)

        // unavailable：读不到。同一份 items 是空数组，但说的必须是另一句话。
        val broken = view(
            """{"items":[],"state":"unavailable","counts":{"enabled":0,"paused":0},"reason":"常规任务的账本读不出来"}"""
        )
        assertEquals("unavailable", broken.state)
        assertFalse(broken.live)
        assertEquals("常规任务的账本读不出来", broken.reason)
        // 两句话不能互相顶替 —— 这是这一栏最要紧的一条。
        assertEquals("还没有常规任务", RoutinesCopy.EMPTY_TITLE)
        assertEquals("读不到常规任务", RoutinesCopy.UNREADABLE_TITLE)
        assertNotEquals(RoutinesCopy.EMPTY_TITLE, RoutinesCopy.UNREADABLE_TITLE)
    }

    @Test
    fun aMissingStateIsUnreadableNotEmpty() {
        // 缺 state：说「读不到」是实话，说「没有」是编的。
        assertEquals("unavailable", view("""{"items":[]}""").state)
        // 不认识的 state 原样留着，界面只认 live，照样不当成有账。
        val weird = view("""{"items":[],"state":"weird"}""")
        assertEquals("weird", weird.state)
        assertFalse(weird.live)
        // 后端没发 runner 时按 none 走：保守地说「不会自己跑」。
        assertEquals("none", weird.runner)
    }

    @Test
    fun halfRecordsAreSkippedInsteadOfBeingPadded() {
        val parsed = view(
            """
            {"items":[
               {"title":"没有 id 的一条","cycle":"daily","next_run":"2026-11-12T09:00:00Z"},
               {"id":"no-title","cycle":"daily","next_run":"2026-11-12T09:00:00Z"},
               {"id":"blank-title","title":"   ","cycle":"hourly"},
               {"id":"ok","title":"好的那条","cycle":"daily"}],
             "state":"live","counts":{"enabled":1,"paused":0},"runner":"none"}
            """.trimIndent()
        )
        // 没有 id 就指认不了，没有标题那一行就是空白：两种都不画，不拿半个字段凑一行。
        assertEquals(1, parsed.items.size)
        assertEquals("ok", parsed.items.single().id)
    }

    @Test
    fun anUnknownCycleIsShownAsIs() {
        assertEquals("每小时", RoutinesCopy.cycleName("hourly"))
        assertEquals("每天", RoutinesCopy.cycleName("daily"))
        assertEquals("每周", RoutinesCopy.cycleName("weekly"))
        // 不认识的周期不猜成「每天」：猜错的那一格会让人以为它明天早上就会跑。
        assertEquals("fortnightly", RoutinesCopy.cycleName("fortnightly"))
        // 缺 cycle 时整条不该读丢（后端已经算好 next_run），只是那一段说「周期没写」。
        assertEquals("周期没写 · 开着", RoutinesCopy.detailLine(RoutineItem("x", "x", "")))
    }

    @Test
    fun theLastRunLineNeverInventsADate() {
        // 没有就是没有：只说「还没跑过」，不拿 created_at 冒充。
        assertEquals("还没跑过", RoutinesCopy.lastRunLine(""))
        assertEquals("还没跑过", RoutinesCopy.lastRunLine("昨天"))
        // 读得懂才写时间，且跟着设备时区走。
        assertEquals("上次 11-08 17:00", RoutinesCopy.lastRunLine("2026-11-08T09:00:00.000Z", UTC8))
        // 认不出的时间不把原始串甩给人看。
        assertEquals("", RoutinesCopy.time("2026-13-45T99:00:00Z", UTC8))
    }

    @Test
    fun theNextRunLineSaysTheTruthAboutOverdue() {
        val open = RoutineItem(
            "a", "每天站会", "daily",
            enabled = true, nextRun = "2026-11-12T01:00:00.000Z", overdue = false,
        )
        assertEquals("按周期算下一次 11-12 09:00", RoutinesCopy.nextRunLine(open, UTC8))
        // 逾期写「该跑了」而不是「下一次」：确实没有人会去跑它。
        val late = open.copy(nextRun = "2026-11-11T01:00:00.000Z", overdue = true)
        assertEquals("该跑了（11-11 09:00）", RoutinesCopy.nextRunLine(late, UTC8))
        // 关掉的那条不算「下一次」，否则关着也像随时会跑。
        assertEquals("关着，不算下一次", RoutinesCopy.nextRunLine(late.copy(enabled = false), UTC8))
        // 时间读不懂就整格不说。
        assertEquals("", RoutinesCopy.nextRunLine(open.copy(nextRun = ""), UTC8))
    }

    @Test
    fun theWhenLineNeverLeavesADanglingSeparator() {
        assertEquals(
            "还没跑过 · 该跑了（11-11 09:00）",
            RoutinesCopy.whenLine("还没跑过", "该跑了（11-11 09:00）"),
        )
        assertEquals("", RoutinesCopy.whenLine("", ""))
        assertEquals("上次 11-11 09:00", RoutinesCopy.whenLine("上次 11-11 09:00", ""))
        assertEquals("关着，不算下一次", RoutinesCopy.whenLine("", "关着，不算下一次"))
    }

    @Test
    fun theDetailLineDropsTheEmptyParts() {
        val item = RoutineItem("a", "每天站会", "daily", botId = "lead", enabled = true)
        assertEquals("每天 · 大哥 负责 · 开着", RoutinesCopy.detailLine(item, "大哥"))
        // 花名册上没有这个人：退回 id，不空着。
        assertEquals("每天 · lead 负责 · 开着", RoutinesCopy.detailLine(item, ""))
        // 没指定负责人：那半句整个不写，不留一个悬空的「 · 」。
        assertEquals("每天 · 关着", RoutinesCopy.detailLine(item.copy(botId = "", enabled = false)))
    }

    @Test
    fun theSummaryUsesTheCountsTheSurfaceSent() {
        assertEquals(
            "2 条开着 · 1 条关着",
            RoutinesCopy.summary(RoutinesView(emptyList(), "live", RoutineCounts(2, 1))),
        )
        assertEquals(
            "1 条开着",
            RoutinesCopy.summary(RoutinesView(emptyList(), "live", RoutineCounts(1, 0))),
        )
        // 都是 0：一个字也不拼，调用方据此整行不画。
        assertEquals("", RoutinesCopy.summary(RoutinesView(emptyList(), "live", RoutineCounts(0, 0))))
    }

    @Test
    fun theFootnoteOnlyAppearsWhenThereIsALedger() {
        // 有账才说「这些账到点不会自己跑」——与桌面端逐字同一句。
        assertEquals(
            "这些账到点不会自己跑：后端还没有调度器，逾期只是提醒。",
            RoutinesCopy.footnote(view(liveBody)),
        )
        // 还没读回来、读不到、空态：清单不存在或被换成了别的话，这句脚注不叠上去。
        assertNull(RoutinesCopy.footnote(null))
        assertNull(RoutinesCopy.footnote(view("""{"items":[],"state":"unavailable","reason":"读不出来"}""")))
        assertNull(RoutinesCopy.footnote(view("""{"items":[],"state":"empty"}""")))
        // runner 真的变成 live（将来的调度器）时，这句话就该收起来 —— 那时它就不成立了。
        assertNull(RoutinesCopy.footnote(view(liveBody.replace("\"none\"", "\"live\""))))
        // 认不出的 runner 照样说：说多了只是保守，说少了是假装有人会跑。
        assertEquals(
            RoutinesCopy.NO_SCHEDULER,
            RoutinesCopy.footnote(view(liveBody.replace("\"none\"", "\"weird\""))),
        )
    }

    private companion object {
        /** 测试固定在东八区：断言里写的是人看到的本地时间，跟着 CI 的默认时区漂就没意义了。 */
        val UTC8: ZoneId = ZoneId.of("Asia/Shanghai")
    }
}
