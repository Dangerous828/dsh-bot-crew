package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 工作区页的文字。
 *
 * 这一页现在接真接口，可测的仍然是它对外承诺的话：后端给的没有理由就原样写、
 * 给不出理由才落到兜底、动作结果按后端回的 scope 说清恢复在哪。
 * 这些话一旦改成「加载中」「请稍候」这种，就等于把「没有」画成了「有」—— 这条测试挡住它。
 */
class WorkspaceCopyTest {

    private val lin = BotCard(id = "lin", name = "林", role = "default", persona = "")

    @Test
    fun theScreenAreaWritesTheBackendsOwnReason() {
        // 后端说没有画面源，那一行就写它给的理由，不自己再编一句。
        assertEquals("后端还没有画面源：worker 不跑浏览器", WorkspaceCopy.screenText("后端还没有画面源：worker 不跑浏览器"))
        // 没有理由（比如字段缺席）才落到兜底，且兜底说的是「读不到」，不是「没有」。
        assertEquals("读不到它的画面", WorkspaceCopy.screenText(""))
        assertEquals("读不到它的画面", WorkspaceCopy.screenText(null))
    }

    @Test
    fun theEntryPointAdmitsItDoesNotHaveTheScreenYet() {
        // 和桌面端同一句话：同一件事两端不该说两种话。
        assertEquals("还看不到它的屏幕：这一步还没接上", WorkspaceCopy.NOT_READY)
    }

    @Test
    fun actionResultsSayWhatActuallyHappened() {
        assertEquals("已接手，这个工单停了", WorkspaceCopy.TAKEOVER_DONE)
        assertEquals("它手上没有活儿", WorkspaceCopy.TAKEOVER_IDLE)
        // 停一下停的是执行器：必须把「恢复要去面板」说出来，别让人在手机上找。
        assertEquals("已让它停一下（全局执行器，恢复要去面板）", WorkspaceCopy.pauseDone("executor"))
        assertEquals("已让它停一下", WorkspaceCopy.pauseDone("ticket"))
        // 失败原话带后端理由，不粉饰；没理由时也不留空。
        assertEquals("没做成：Bot already exists", WorkspaceCopy.failed("Bot already exists"))
        assertEquals("没做成：队伍没回话", WorkspaceCopy.failed(null))
    }

    @Test
    fun botIdsUseTheSameShapeAsTheBackend() {
        // 与 crew/directory.ts 的 BOT_ID、TeamConfig 的 schema 同一个正则。
        assertEquals(true, BotsWire.ID.matches("coder_1"))
        assertEquals(true, BotsWire.ID.matches("scribe"))
        assertEquals(false, BotsWire.ID.matches("Bad Id"))
        assertEquals(false, BotsWire.ID.matches("码农"))
        assertEquals(false, BotsWire.ID.matches(""))
    }

    @Test
    fun actionLabelsAreTheOnesOnTheBoard() {
        assertEquals("接手操作", WorkspaceAction.Takeover.label)
        assertEquals("让它停一下", WorkspaceAction.Pause.label)
    }

    @Test
    fun titleNamesWhoseScreenItIs() {
        // 画板上是「林 的屏幕」，中间一个空格。
        assertEquals("林 的屏幕", WorkspaceCopy.title(lin))
        // 名字从线上数据来，前导空白不该把它带进标题。
        assertEquals("小林 的屏幕", WorkspaceCopy.title(lin.copy(name = " 小林 ")))
    }

    @Test
    fun initialTakesOneCharacterAndSurvivesABlankName() {
        assertEquals("林", WorkspaceCopy.initial(lin))
        // 没有名字时不是崩，也不是画一个问号：返回空串，交给调用方决定画不画。
        assertEquals("", WorkspaceCopy.initial(lin.copy(name = "")))
        assertEquals("", WorkspaceCopy.initial(lin.copy(name = "   ")))
    }

    @Test
    fun situationIsNullWhenThereIsNothingTrueToSay() {
        // 缺数据不画成「未知」—— 这是名片上「认识多久」同一条规矩。
        assertNull(WorkspaceCopy.situation(""))
        assertNull(WorkspaceCopy.situation("paused"))
        assertEquals("正在干活", WorkspaceCopy.situation("work"))
        assertEquals("在等你决定", WorkspaceCopy.situation("person"))
        assertEquals("这一步失败了", WorkspaceCopy.situation("failed"))
    }
}
