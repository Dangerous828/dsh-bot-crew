package com.dsh.botcrew

import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 名片上「认识多久」那一行。
 *
 * 后台取不到时间就不返回 since，所以这条线有三个断面要钉住：有值怎么读、
 * 没有或读不懂时给什么、以及线上多一个/少一个字段时解析会不会崩。
 */
class BotSinceTest {

    private val shanghai: ZoneId = ZoneId.of("Asia/Shanghai")

    @Test
    fun aTimestampBecomesTheLocalDate() {
        // 03:00Z 在东八区是 11:00，同一天。时间部分不出现，只到日期。
        assertEquals("从 2026-09-14 起", BotSince.label("2026-09-14T03:00:00.000Z", shanghai))
    }

    @Test
    fun theDateFollowsTheDeviceZoneNotTheUtcDate() {
        // 同一个时刻：东八区已经是 15 号凌晨，UTC 还停在 14 号晚上。
        // 直接截字符串会把「认识多久」记成前一天，所以这一条必须跟着设备时区走。
        assertEquals("从 2026-09-15 起", BotSince.label("2026-09-14T16:30:00.000Z", shanghai))
        assertEquals("从 2026-09-14 起", BotSince.label("2026-09-14T16:30:00.000Z", ZoneId.of("UTC")))
    }

    @Test
    fun aTimestampWithoutZoneIsReadAsLocal() {
        assertEquals("从 2026-09-14 起", BotSince.label("2026-09-14T03:00:00", shanghai))
    }

    @Test
    fun nothingToShowMeansNoLine() {
        // null 就是「这一行别画」。界面上没有占位文字，这里也就没有占位值。
        assertNull(BotSince.label(null, shanghai))
        assertNull(BotSince.label("", shanghai))
        assertNull(BotSince.label("   ", shanghai))
    }

    @Test
    fun anUnreadableTimeIsTreatedAsNothingRatherThanGuessed() {
        assertNull(BotSince.label("刚认识", shanghai))
        assertNull(BotSince.label("2026-13-45T99:00:00Z", shanghai))
    }

    @Test
    fun aRosterWithoutSinceParsesAndLeavesItEmpty() {
        // 后台取不到时间时根本不返回 since：解析不能因此抛，值落到 null。
        val body = """
            {
              "items": [],
              "bots": [
                {"id": "lead", "name": "大哥", "role": "default", "persona": ""},
                {"id": "scribe", "name": "写手", "role": "member", "since": "2026-09-14T03:00:00.000Z"}
              ],
              "default_bot_id": "lead"
            }
        """.trimIndent()

        val bots = CrewWire.parseTimeline(body).bots

        assertEquals(2, bots.size)
        assertNull(bots[0].since)
        assertEquals("2026-09-14T03:00:00.000Z", bots[1].since)
        assertNull(BotSince.label(bots[0].since, shanghai))
        assertEquals("从 2026-09-14 起", BotSince.label(bots[1].since, shanghai))
    }

    @Test
    fun anEmptySinceIsTheSameAsAMissingOne() {
        // 后台偶尔给空串而不是省略字段；这两种都要落成「没有」，否则界面会画出一行空的。
        val body = """{"items": [], "bots": [{"id": "lead", "name": "大哥", "role": "default", "since": ""}]}"""
        assertNull(CrewWire.parseTimeline(body).bots[0].since)
    }
}
