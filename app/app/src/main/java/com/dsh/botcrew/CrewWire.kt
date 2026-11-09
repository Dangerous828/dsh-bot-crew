package com.dsh.botcrew

import org.json.JSONArray
import org.json.JSONObject

/** 一条消息。角色只有两种：人说的，和队伍里某个 Bot 说的。 */
data class Message(val id: String, val fromBot: Boolean, val botId: String?, val text: String, val at: String)

/** 名片上能看到的那些字。它是呈现，不持有任何任务状态。 */
data class BotCard(val id: String, val name: String, val role: String, val persona: String)

data class Conversation(
    val messages: List<Message>,
    val bots: List<BotCard>,
    val defaultBotId: String,
)

/**
 * 消息面的线上格式。只说两件事：把回话读成对话，把一句话写成请求。
 * 解析是宽容的：不认识的字段跳过，不因为多一个字段就整段失败。
 */
object CrewWire {

    fun parseTimeline(body: String): Conversation {
        val root = JSONObject(body)
        val messages = mutableListOf<Message>()
        val items = root.optJSONArray("items") ?: JSONArray()
        for (index in 0 until items.length()) {
            val item = items.optJSONObject(index) ?: continue
            val role = item.optString("role", "")
            // 网关只写 user / agent；别的值当作未知，直接跳过，不猜。
            if (role != "user" && role != "agent") continue
            val botId = item.optString("bot_id").takeIf { it.isNotEmpty() }
            messages.add(
                Message(
                    id = item.optString("id"),
                    fromBot = role == "agent",
                    botId = botId,
                    text = item.optString("text"),
                    at = item.optString("at"),
                ),
            )
        }
        val bots = mutableListOf<BotCard>()
        val cards = root.optJSONArray("bots") ?: JSONArray()
        for (index in 0 until cards.length()) {
            val card = cards.optJSONObject(index) ?: continue
            bots.add(
                BotCard(
                    id = card.optString("id"),
                    name = card.optString("name"),
                    role = card.optString("role"),
                    persona = card.optString("persona"),
                ),
            )
        }
        return Conversation(messages, bots, root.optString("default_bot_id"))
    }

    /** 发消息的请求体。requestId 是幂等键，重试要沿用同一个。 */
    fun sendBody(text: String, mentions: List<String>, requestId: String): String {
        val mentionsJson = JSONArray()
        mentions.forEach { mentionsJson.put(it) }
        return JSONObject()
            .put("text", text)
            .put("request_id", requestId)
            .put("mentions", mentionsJson)
            .toString()
    }

    /** 从一句话里认出被 @ 的 Bot：名片上的名字和 id 都算。 */
    fun mentionsIn(text: String, bots: List<BotCard>): List<String> {
        val found = mutableListOf<String>()
        for (bot in bots) {
            val named = text.contains("@${bot.id}") || (bot.name.isNotEmpty() && text.contains("@${bot.name}"))
            if (named) found.add(bot.id)
        }
        return found
    }
}
