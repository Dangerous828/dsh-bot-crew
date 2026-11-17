package com.dsh.botcrew

/**
 * 卡内输入行什么时候展开。
 *
 * 实机上这一行和底部聊天输入几乎一模一样（同样的浅底、同样的高度、同样右侧一个小按钮），
 * 两者只隔 117px：y=2595 是卡里的「自己写一句…」，y=2892 是聊天输入框。人分不清哪个是
 * 「回这张卡」、哪个是「跟队伍说一句」，于是把要审批的话打进了卡里，或者把给队伍的话
 * 打进了审批框（后者在服务端就是一次 409：这句话不是任何选项）。
 *
 * 现在的规矩：**默认不展开**，只有点了「修改内容」这一项才出现 —— 那时它才真的是
 * 「这一次审批的修订」，而不是第二个聊天框。展开条件放在这里（纯函数、有单测），
 * Composable 只负责画。
 */
object CardReviseInput {

    /**
     * 后端把「修改内容」这一项的 id 钉死成 `revise`
     * （`backend/src/app/approval.ts` 的 connectionPrompt / taskPrompt 都发这一个 id）。
     * 只认 id 不认 label：label 是给人看的一句话，改文案不该改掉行为。
     */
    const val REVISE_OPTION_ID = "revise"

    /** 卡内输入框里那句说明。 */
    const val HINT = "改完点右侧发送，只影响这一次审批"

    /** 输入行的标签。 */
    const val LABEL = "改这一次的内容"

    /** 这一项是不是「修改内容」。 */
    fun isRevise(option: AttentionOption): Boolean =
        option.id.trim().equals(REVISE_OPTION_ID, ignoreCase = true)

    /**
     * 输入行此刻该不该展开。
     *
     * @param choice 这张卡上**最近点过**的那一项；还没点过是 null。
     * @param options 这张卡摆出来的选项。
     *
     * 三种情形：
     *  - 点了「修改内容」→ 展开（这就是它的唯一入口）；
     *  - 点了别的选项 / 还没点 → 收起（不给第二个聊天框）；
     *  - 卡上一个选项都没有 → 展开（审批卡却一个可点的选项都没解析出来时，
     *    再不给输入行，这张卡就彻底没法答了）。
     */
    fun expanded(choice: AttentionOption?, options: List<AttentionOption>): Boolean {
        if (options.isEmpty()) return true
        return choice != null && isRevise(choice)
    }
}
