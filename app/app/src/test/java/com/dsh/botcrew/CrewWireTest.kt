package com.dsh.botcrew

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
        assertEquals(listOf("lead"), CrewWire.mentionsIn("大哥你看看", bots).ifEmpty { listOf("lead") })
        assertTrue(CrewWire.mentionsIn("随便说一句", bots).isEmpty())
    }
}
