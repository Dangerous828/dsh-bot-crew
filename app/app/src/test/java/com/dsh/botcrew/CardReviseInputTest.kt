package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 卡内输入行的展开条件。
 *
 * 实机上它默认就摊在那儿，和底部聊天输入长得几乎一样（同样的浅底、同样的高度、
 * 同样右侧一个小按钮），两者只隔 117px —— 人分不清哪个是「回这张卡」、哪个是
 * 「跟队伍说一句」。规矩：默认收起，只有点了「修改内容」才出现。
 */
class CardReviseInputTest {

    private val go = AttentionOption("go", "确认执行这一次")
    private val stop = AttentionOption("stop", "取消这一次（任务继续）")
    private val revise = AttentionOption("revise", "修改内容")
    private val options = listOf(go, stop, revise)

    @Test
    fun noChoiceMeansCollapsed() {
        assertFalse("还没点任何一项时，卡里不该有一个输入框", CardReviseInput.expanded(null, options))
    }

    @Test
    fun choosingModifyOpensIt() {
        assertTrue(CardReviseInput.expanded(revise, options))
    }

    @Test
    fun choosingSomethingElseKeepsItClosed() {
        assertFalse(CardReviseInput.expanded(go, options))
        assertFalse(CardReviseInput.expanded(stop, options))
    }

    @Test
    fun aCardWithoutOptionsStillGetsAnInputRow() {
        // 审批卡却一个选项都没解析出来（或后端已经把这张卡换成「请写下新的做法」）：
        // 再不给输入行，这张卡就彻底没法答了。
        assertTrue(CardReviseInput.expanded(null, emptyList()))
    }

    @Test
    fun reviseIsRecognisedByIdNotByLabel() {
        // 只认 id：label 是给人看的一句话，改文案不该改掉行为。
        assertTrue(CardReviseInput.isRevise(AttentionOption("revise", "换个说法")))
        assertFalse(CardReviseInput.isRevise(AttentionOption("go", "修改内容")))
        assertFalse(CardReviseInput.isRevise(AttentionOption("", "修改内容")))
        // 大小写与前后空白不算另一种选项。
        assertTrue(CardReviseInput.isRevise(AttentionOption(" Revise ", "修改内容")))
    }

    @Test
    fun hintSaysWhatTheSendButtonDoes() {
        // 这一行说明是「它只影响这一次审批」的唯一出处，缺了就又变成第二个聊天框。
        assertEquals("改完点右侧发送，只影响这一次审批", CardReviseInput.HINT)
    }
}
