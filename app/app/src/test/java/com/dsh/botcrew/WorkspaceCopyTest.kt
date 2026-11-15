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
        // 后端说没有可读记录，那一行就写它给的理由，不自己再编一句。
        assertEquals("这张工单还没有可读的执行记录", WorkspaceCopy.screenText("这张工单还没有可读的执行记录"))
        // 没有理由（比如字段缺席）才落到兜底，且兜底说的是「读不到」，不是「没有」。
        assertEquals("读不到它的画面", WorkspaceCopy.screenText(""))
        assertEquals("读不到它的画面", WorkspaceCopy.screenText(null))
    }

    @Test
    fun actionResultsSayWhatActuallyHappened() {
        assertEquals("已接手，这个工单停了", WorkspaceCopy.TAKEOVER_DONE)
        assertEquals("它手上没有活儿", WorkspaceCopy.TAKEOVER_IDLE)
        // 停一下停的是执行器；同一个按钮按第二下就继续 —— 那句话要指向按钮，不是面板。
        assertEquals("已让它停一下（全局执行器，再按一下继续）", WorkspaceCopy.pauseDone("executor"))
        assertEquals("已让它停一下", WorkspaceCopy.pauseDone("ticket"))
        assertEquals("已继续执行（全局执行器）", WorkspaceCopy.RESUMED)
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

    /**
     * 暂停按钮停了之后必须换成「继续执行」—— #19 第 3 项的判据就是这一格的字。
     *
     * 这一条与真机那一步是同一句判断：真机上按下去之后 paused 翻成 true，这一格就该是
     * 「继续执行」。抽成纯函数才好在锁屏（读不到像素）时也有断言可依。
     */
    @Test
    fun thePauseButtonFlipsToResumeWhenTheExecutorIsPaused() {
        assertEquals("让它停一下", WorkspaceCopy.pauseLabel(paused = false))
        assertEquals("继续执行", WorkspaceCopy.pauseLabel(paused = true))
        assertEquals(WorkspaceCopy.RESUME_LABEL, WorkspaceCopy.pauseLabel(paused = true))
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
