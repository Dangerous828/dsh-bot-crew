package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 草稿持久化的纯逻辑。
 *
 * 每一条都对着一条真实的用户损失：
 * - 切会话 / 进程重建之后草稿还在（按会话各一格）；
 * - 明确成功只清「发出去的那一版」，用户后来打的字不动；
 * - 盘上那份坏了**不覆盖**（覆盖 = 把还没发出去的字抹掉）。
 *
 * 存储本身在 SharedPreferences 里（JVM 跑不了），所以这里测的是 `Map` ↔ 列表那一层。
 */
class DraftRecordTest {

    /** 依次写进几格，返回盘上那份 `Map`（模拟 SharedPreferences 的形状）。 */
    private fun values(vararg drafts: Draft): Map<String, String> {
        var raw: Map<String, String> = mapOf(DraftRecord.DRAFTS to "")
        for (draft in drafts) {
            raw = mapOf(DraftRecord.DRAFTS to (DraftRecord.put(raw, draft) ?: error("写不下去")))
        }
        return raw
    }

    @Test
    fun eachSessionKeepsItsOwnDraftAndSwitchingDoesNotClearIt() {
        // 两格各自独立：写 work 不碰 main（切会话不清草稿就落在这里）。
        val raw = values(Draft("main", "发给 lead 的话"), Draft("work", "work 会话里的半句"))
        val read = DraftRecord.read(raw)
        assertEquals(RecordState.OK, read.state)
        assertEquals("发给 lead 的话", read.items.first { it.sessionKey == "main" }.text)
        assertEquals("work 会话里的半句", read.items.first { it.sessionKey == "work" }.text)
    }

    @Test
    fun anEmptyDraftClearsOnlyThatSession() {
        var raw: Map<String, String> = values(Draft("main", "a"), Draft("work", "b"))
        raw = mapOf(DraftRecord.DRAFTS to (DraftRecord.put(raw, Draft("main", "")) ?: error("写不下去")))
        val items = DraftRecord.read(raw).items
        assertEquals(listOf("work"), items.map { it.sessionKey })
    }

    @Test
    fun onlyTheSentVersionIsCleared() {
        val raw = values(Draft("main", "先发这句"))
        // 发出去的就是这一版 → 清掉。
        val cleared = DraftRecord.clearIfText(raw, "main", "先发这句") ?: error("应当写得下去")
        assertTrue(DraftRecord.read(mapOf(DraftRecord.DRAFTS to cleared)).items.isEmpty())

        // 用户后来又改了字：一次迟到的成功回调（带的是旧正文）不能把它抹掉。
        val edited = mapOf(
            DraftRecord.DRAFTS to (DraftRecord.put(raw, Draft("main", "改成了别的")) ?: error("写不下去")),
        )
        val late = DraftRecord.clearIfText(edited, "main", "先发这句") ?: error("应当写得下去")
        assertEquals("改成了别的", DraftRecord.read(mapOf(DraftRecord.DRAFTS to late)).items.single().text)
    }

    @Test
    fun acorruptRecordIsNotOverwrittenAndIsVisible() {
        val broken = mapOf<String, String>(DraftRecord.DRAFTS to "{not json")
        val read = DraftRecord.read(broken)
        assertEquals(RecordState.CORRUPT, read.state)
        assertTrue(read.corrupt)
        assertEquals("{not json", read.raw)
        // 写回被拒：损坏那份原样留在盘上，不会被「当作空 + put」抹掉。
        assertNull(DraftRecord.put(broken, Draft("main", "新的字")))
        assertNull(DraftRecord.clearIfText(broken, "main", "随便"))
    }

    @Test
    fun aMissingRecordReadsAsMissingNotEmptyCorrupt() {
        assertEquals(RecordState.MISSING, DraftRecord.read(emptyMap<String, String>()).state)
    }

    @Test
    fun anIllegalSessionIdIsDroppedInsteadOfMakingAPhantomCell() {
        val raw = mapOf<String, String>(
            DraftRecord.DRAFTS to """[{"s":"Bad Id","t":"x"},{"s":"main","t":"ok"}]""",
        )
        assertEquals(listOf("main"), DraftRecord.read(raw).items.map { it.sessionKey })
    }
}

/**
 * 未确认发送的账。
 *
 * 这一层错一次就是「一次交代变成两条消息」，所以每条规则都对着一个具体故障。
 */
class SendRecoveryRecordTest {

    private fun raw(vararg sends: UncertainSend): Map<String, String> {
        var current: Map<String, String> = mapOf(SendRecoveryRecord.SENDS to "")
        for (send in sends) {
            val (result, next) = SendRecoveryRecord.put(current, send)
            assertEquals(SendRecoveryRecord.PutResult.WRITTEN, result)
            current = mapOf(SendRecoveryRecord.SENDS to (next ?: error("写不下去")))
        }
        return current
    }

    private val a = UncertainSend("req-a", "main", "第一句", listOf("lead"), "lead", 1)
    private val b = UncertainSend("req-b", "main", "改过的第二句", listOf("lead"), "lead", 2)

    @Test
    fun aNewDraftDoesNotDropTheOlderUncertainSend() {
        val both = raw(a, b)
        assertEquals(listOf("req-a", "req-b"), SendRecoveryRecord.read(both).items.map { it.requestId }.sorted())
        // 明确成功只清自己那一条。
        val afterA = mapOf(SendRecoveryRecord.SENDS to (SendRecoveryRecord.remove(both, "req-a") ?: error("x")))
        assertEquals(listOf("req-b"), SendRecoveryRecord.read(afterA).items.map { it.requestId })
    }

    @Test
    fun theWholeEnvelopeSurvivesSoRetryIsTheSameIntent() {
        val restored = SendRecoveryRecord.read(raw(b)).items.single()
        assertEquals("req-b", restored.requestId)
        assertEquals("main", restored.sessionKey)
        assertEquals("改过的第二句", restored.text)
        assertEquals(listOf("lead"), restored.mentions)
        assertEquals("lead", restored.recipientId)
    }

    @Test
    fun theSameRequestIdCannotBeRepointedAtAnotherPayload() {
        val stored = raw(a)
        // 同 id 换了正文：不是更新，是另一份意图 —— 保留原件、报冲突、调用方不得 POST。
        val (result, next) = SendRecoveryRecord.put(stored, a.copy(text = "完全不同的内容"))
        assertEquals(SendRecoveryRecord.PutResult.CONFLICT, result)
        assertNull(next)
        assertEquals("第一句", SendRecoveryRecord.read(stored).items.single().text)

        // 同一份意图再来一次（重试/重启）：允许，只把时间往前推。
        val (again, same) = SendRecoveryRecord.put(stored, a.copy(at = 9))
        assertEquals(SendRecoveryRecord.PutResult.WRITTEN, again)
        val rewritten = mapOf(SendRecoveryRecord.SENDS to (same ?: error("写不下去")))
        assertEquals(9L, SendRecoveryRecord.read(rewritten).items.single().at)
    }

    @Test
    fun removingOneRecordLeavesTheOthersAlone() {
        val both = raw(a, b)
        val afterForget = mapOf(SendRecoveryRecord.SENDS to (SendRecoveryRecord.remove(both, "req-b") ?: error("x")))
        assertEquals(listOf("req-a"), SendRecoveryRecord.read(afterForget).items.map { it.requestId })
    }

    @Test
    fun aCorruptLedgerRefusesToWrite() {
        val broken = mapOf<String, String>(SendRecoveryRecord.SENDS to "[[[")
        val read = SendRecoveryRecord.read(broken)
        assertEquals(RecordState.CORRUPT, read.state)
        val (result, next) = SendRecoveryRecord.put(broken, a)
        assertEquals(SendRecoveryRecord.PutResult.CORRUPT, result)
        assertNull(next)
        assertNull(SendRecoveryRecord.remove(broken, "req-a"))
    }

    @Test
    fun onlyTheWholeIntentIsReusedSoChangingTheRecipientIsANewSend() {
        val stored = listOf(a) // req-a: session main / "第一句" / mentions=[lead] / recipient=lead
        // 完全同一份意图：复用原 id（重试/重启靠它保持幂等）。
        assertEquals("req-a", SendRecoveryRecord.reuse(stored, "main", "第一句", listOf("lead"), "lead")?.requestId)
        // 同字改收件人 → 另一件事，必须拿新 id（否则落盘判 CONFLICT，新发送被旧记录挡住）。
        assertNull(SendRecoveryRecord.reuse(stored, "main", "第一句", listOf("lead"), "scribe"))
        // 同字改 @ 名单 → 也是另一件事。
        assertNull(SendRecoveryRecord.reuse(stored, "main", "第一句", listOf("lead", "scribe"), "lead"))
        // 同字换会话 → 另一格。
        assertNull(SendRecoveryRecord.reuse(stored, "work", "第一句", listOf("lead"), "lead"))
        // 正文不同 → 另一件事。
        assertNull(SendRecoveryRecord.reuse(stored, "main", "第二句", listOf("lead"), "lead"))
        // 复用出来的那份拿去 put 必须还是 WRITTEN，不会判冲突。
        val replay = SendRecoveryRecord.reuse(stored, "main", "第一句", listOf("lead"), "lead")!!
        assertEquals(SendRecoveryRecord.PutResult.WRITTEN, SendRecoveryRecord.put(raw(a), replay).first)
    }

    @Test
    fun entriesAreGroupedBySessionWithoutMixing() {
        val other = UncertainSend("req-c", "work", "另一格", emptyList(), "", 3)
        val all = raw(a, other)
        assertEquals(listOf("req-a"), SendRecoveryRecord.forSession(all, "main").map { it.requestId })
        assertEquals(listOf("req-c"), SendRecoveryRecord.forSession(all, "work").map { it.requestId })
    }
}

/**
 * 失败/待确认提示的归属与措辞。
 *
 * 三条判据：
 * - A 的失败不会被 B 的成功顺手抹掉；
 * - 已经发出 POST 的异常只能说「发送结果待确认」，不能写成「没发出去」；
 * - 只有请求根本没离开手机时才能说「这条没有发出」。
 */
class SendCopyTest {

    @Test
    fun successClearsOnlyItsOwnNote() {
        var notes = emptyMap<String, List<SendNote>>()
        notes = SendNoteBook.put(notes, "main", SendNote("req-a", "待确认：A"))
        notes = SendNoteBook.put(notes, "main", SendNote("req-b", "待确认：B"))
        assertEquals(2, SendNoteBook.of(notes, "main").size)
        notes = SendNoteBook.clear(notes, "main", "req-b")
        assertEquals(listOf("req-a"), SendNoteBook.of(notes, "main").map { it.requestId })
        // 别的会话不受影响。
        notes = SendNoteBook.put(notes, "work", SendNote("req-c", "待确认：C"))
        notes = SendNoteBook.clear(notes, "main", "req-a")
        assertEquals(listOf("req-c"), SendNoteBook.of(notes, "work").map { it.requestId })
        assertEquals(emptyList<SendNote>(), SendNoteBook.of(notes, "main"))
    }

    @Test
    fun aPostedFailureSaysResultUnknownInsteadOfNotSent() {
        val said = SendCopy.noteFor("帮我看下日志", "timeout", posted = true)
        assertTrue(said, said.startsWith("发送结果待确认"))
        assertFalse("超时不能说成没发出去：$said", said.contains("没有发出"))
        assertTrue("要带原文片段，否则认不出是哪条", said.contains("帮我看下日志"))
        assertTrue("原因可以附上，但不改结论", said.contains("timeout"))
    }

    @Test
    fun onlyAPrePostFailureSaysItWasNotSent() {
        val said = SendCopy.noteFor("帮我看下日志", null, posted = false)
        assertTrue(said, said.startsWith("这条没有发出"))
    }

    @Test
    fun theLocalRecordButtonNeverPretendsItCanRecallTheServerMessage() {
        assertFalse(SendCopy.FORGET.contains("取消发送"))
        assertTrue(SendCopy.FORGET.contains("本机"))
    }
}

/**
 * 存储命名空间：同一台手机换 crew、同一台电脑换端口/路径都必须分开。
 */
class CrewNamespaceTest {

    private fun paired(device: String, base: String, crew: String = "") =
        PairedCrew(deviceId = device, token = "t", base = base, serverCrew = crew)

    @Test
    fun theSamePhoneOnTwoDifferentCrewsGetsTwoNamespaces() {
        // 设备 id 是手机的 ANDROID_ID：只拿它当身份会让两台电脑撞在一格。
        val first = CrewNamespace.key(paired("phone-1", "http://192.168.1.5:43499", crew = "crew-a"))
        val second = CrewNamespace.key(paired("phone-1", "http://192.168.1.5:43499", crew = "crew-b"))
        assertNotEquals(first, second)
    }

    @Test
    fun beforeTheFingerprintArrivesTheFullBaseSeparatesInstances() {
        val sameHostOtherPort = CrewNamespace.key(paired("phone-1", "http://host:43499"))
        val other = CrewNamespace.key(paired("phone-1", "http://host:43500"))
        assertNotEquals(sameHostOtherPort, other)
        // 同 host 同端口、不同 relay 路径也是两个实例。
        val pathA = CrewNamespace.key(paired("phone-1", "https://relay.example/one"))
        val pathB = CrewNamespace.key(paired("phone-1", "https://relay.example/two"))
        assertNotEquals(pathA, pathB)
    }

    @Test
    fun theFingerprintReplacesTheBaseSoALanIpChangeKeepsTheSameNamespace() {
        val beforeIp = CrewNamespace.key(paired("phone-1", "http://192.168.1.5:43499", crew = "crew-a"))
        val afterIp = CrewNamespace.key(paired("phone-1", "http://10.0.0.9:43499", crew = "crew-a"))
        assertEquals(beforeIp, afterIp)
        // 收到指纹就把 base 从身份里彻底去掉：之后再怎么换地址都不会搬命名空间。
        assertTrue(beforeIp.contains("crew-a"))
        assertFalse(beforeIp.contains("192.168"))
    }

    @Test
    fun migrationMovesOnlyTheOldNamespacesKeysAndNeverOverwrites() {
        val keys = listOf(
            "dev:phone-1|o:http://192.168.1.5:43499|drafts",
            "dev:phone-1|o:http://192.168.1.5:43499|uncertain",
            "dev:phone-2|o:http://other|drafts",
        )
        val plan = CrewNamespace.plan(keys, "dev:phone-1|o:http://192.168.1.5:43499", "dev:phone-1|c:crew-a")
        assertEquals(
            mapOf(
                "dev:phone-1|o:http://192.168.1.5:43499|drafts" to "dev:phone-1|c:crew-a|drafts",
                "dev:phone-1|o:http://192.168.1.5:43499|uncertain" to "dev:phone-1|c:crew-a|uncertain",
            ),
            plan,
        )
        // 身份没变、或者空身份：什么都不搬。
        assertTrue(CrewNamespace.plan(keys, "x", "x").isEmpty())
        assertTrue(CrewNamespace.plan(keys, "", "y").isEmpty())
    }
}
