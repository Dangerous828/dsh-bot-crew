package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 工作区页的文字。
 *
 * 这一页整个是「后端还没有」的状态下的界面，所以可测的不是布局，而是它对外承诺的话：
 * 没画面时说「画面还没接上」、按了动作时说哪一步没接上、有名字时抬头写对是谁的屏幕。
 * 这些话一旦改成「加载中」「请稍候」这种，就等于把「没有」画成了「有」—— 这条测试挡住它。
 */
class WorkspaceCopyTest {

    private val lin = BotCard(id = "lin", name = "林", role = "default", persona = "")

    @Test
    fun placeholderSaysThereIsNoPictureInsteadOfLoading() {
        // 灰板上必须写清是「空」而不是「在转」。
        assertEquals("画面还没接上", WorkspaceCopy.PLACEHOLDER)
    }

    @Test
    fun theEntryPointAdmitsItDoesNotHaveTheScreenYet() {
        // 和桌面端同一句话：同一件事两端不该说两种话。
        assertEquals("还看不到它的屏幕：这一步还没接上", WorkspaceCopy.NOT_READY)
    }

    @Test
    fun bothActionsReportThemselvesUnconnectedByName() {
        // 点了要有反馈，而且反馈里得带上是哪个动作 —— 否则两个按钮说同一句话，人就不知道自己按了哪个。
        assertEquals(
            "接手操作这一步还没接上，先别指望它真的动",
            WorkspaceCopy.actionNote(WorkspaceAction.Takeover),
        )
        assertEquals(
            "让它停一下这一步还没接上，先别指望它真的动",
            WorkspaceCopy.actionNote(WorkspaceAction.Pause),
        )
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
