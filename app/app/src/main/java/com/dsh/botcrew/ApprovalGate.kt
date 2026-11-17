package com.dsh.botcrew

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue

/**
 * 审批答复的单题互斥闸门。
 *
 * 解决三个真实毛病：
 *  1. **同题并发**：从前每个选项各存一个「正在发」，A、B 两格能同时点、各发一次 → 同一张卡收到
 *     两个答复。现在一张票任一时刻只允许一个答复在途。
 *  2. **pending 误导**：从前「发出去了但还没回来」就画 ✓，像已经答成。现在分成两段：
 *     HTTP 未回来 = [Phase.Submitting]（画「提交中…」，双禁用，还没答成）；
 *     HTTP 成功 = [Phase.Accepted]（说「答复已受理，等待状态更新」，**继续锁这一题**）。
 *  3. **409 不等于「卡已更新」**：从前后端回 409 就锁住并弹「这张问题卡已更新，请按最新的那张再答」。
 *     但 409 有四种来源（没这张票 / 票已结束 / attention id 不符 / 这句话不是一个可执行的答复），
 *     后两种根本没有「最新那张」可指。现在 409 走 [rejected]：**解锁**并如实转述服务端原话；
 *     「有没有更新的一张」由 [AttentionSupersede] 拿刷新回来的时间线判，判得出来才另出提示条。
 *
 * 锁的释放只认**时间线收敛**：当这一题的签名变了、或这张票不见了（后端把它换掉/结掉了），
 * 才解锁。HTTP 成功本身不解锁 —— 那只是「受理」，不是「已更新到界面」。
 * 回执（note）同理：问题换了，旧卡上的那条回执就不再属于这张卡，一并作废。
 *
 * 纯逻辑在 [ApprovalGate] object 里，可 JVM 单测；Compose 侧用 [rememberApprovalGate] 持有。
 */
object ApprovalGate {

    /** 一次答复发射的结局。由调用方（CrewUi）按 HTTP 结果归类后回传。 */
    sealed interface Outcome {
        /** HTTP 200：后端已受理。 */
        data object Accepted : Outcome

        /**
         * 后端 409：这张卡在服务端已经变了 / 这句不被认作答复 / 票已结束。
         * 带服务端原话 —— 界面照实转述，绝不替它说成「已更新」。
         */
        data class Rejected(val reason: String) : Outcome

        /** 别的失败（网络、400）：可重试同一事件。 */
        data class Failed(val detail: String?) : Outcome
    }

    /** 一张票的一次答复所处的阶段。 */
    enum class Phase {
        /** 没有在途答复，可以点。 */
        Idle,
        /** 请求在途，HTTP 还没回来。不算答成，也不敢再点。 */
        Submitting,
        /** HTTP 成功：后端已受理。锁着，等时间线收敛。 */
        Accepted,
    }

    /** 某张票此刻的答复态。 [busy] 为真期间这张票上任何答复入口都不接受点击。 */
    data class State(
        val phase: Phase = Phase.Idle,
        val note: String? = null,
    ) {
        /** 在途/锁住：不能再点任何选项或自写框。 */
        val busy: Boolean get() = phase != Phase.Idle
        /** 真正「请求已发出、还没回来」的那一瞬才叫提交中（对应画板 pending 双禁用）。 */
        val submitting: Boolean get() = phase == Phase.Submitting
    }

    /**
     * 点某一个答复前的准入判定：这张票现在是 Idle 才放行，其余阶段（含 Accepted 锁）
     * 一律拦住 —— 同题互斥就落在这一个函数里。
     */
    fun canSubmit(state: State): Boolean = state.phase == Phase.Idle

    /** 准入通过、请求发出（HTTP 未回）→ Submitting。 */
    fun begin(): State = State(Phase.Submitting, null)

    /** HTTP 已受理（还没收敛到时间线）。不叫「提交中」也不叫「答完了」。 */
    const val ACCEPTED = "答复已受理，等待状态更新"

    /** HTTP 成功：后端已受理。文案不叫「提交中」，也不叫「答完了」，是「已受理，等状态更新」。 */
    fun accepted(): State = State(Phase.Accepted, ACCEPTED)

    /** 普通失败：退回 Idle，允许重试（草稿/输入框由 UI 保留，不在这里清）。 */
    fun failed(detail: String?): State = State(Phase.Idle, AnswerCopy.answerFailed(detail))

    /**
     * 后端 409：**解锁**并如实转述服务端原话。
     *
     * 这里不解锁会造成实机那个死局：409 的原因是「这句不是一个可执行的答复」时，时间线里
     * 什么都没变、签名永远不收敛，卡片于是永久锁死，提示还挂着「请按最新的那张」——
     * 而那张不存在。解锁让人能重新选一项；「是不是真换了卡」交给 [AttentionSupersede] 判。
     */
    fun rejected(reason: String?): State =
        State(Phase.Idle, AnswerCopy.answerFailed(reason ?: REJECTED_UNKNOWN))

    /** 409 但服务端没给原因时，只说确定的那点事。 */
    const val REJECTED_UNKNOWN = "这张卡在服务端已经变了"

    /**
     * 时间线是否已收敛到「可以解锁」：
     * - 这张票不见了（后端结掉 / 换掉）→ 收敛；
     * - 这一题的签名变了（换了问题或换了选项）→ 收敛；
     * - 都没有 → 还没收敛，继续锁。
     *
     * 只对 [Phase.Accepted] 有意义；Idle/Submitting 不受影响
     * （Submitting 等它自己的 HTTP 回来，Idle 本来就是可点的）。
     */
    fun converged(phase: Phase, oldSignature: String, newSignature: String?): Boolean {
        if (phase == Phase.Idle || phase == Phase.Submitting) return false
        return newSignature == null || newSignature != oldSignature
    }
}

/**
 * 一张票的审批闸门的 Compose 持有器。按**当前签名**判断收敛：签名变了（换题/票消失）才解锁。
 *
 * 持有器本身不认识 Compose 的重组细节；它只持有一份可变状态和一个"取当前签名"的函数。
 * 取签名用的是 [rememberApprovalGate] 传进来的**最新**引用（见那里的 rememberUpdatedState），
 * 切会话/换票时签名自然变化 → 收敛解锁，不会锁死在旧题上。
 *
 * 解锁不在每帧 recomposition 里做（那会 state 写→重组→再写，成环）。只由
 * [rememberApprovalGate] 用一个 LaunchedEffect(签名) 在签名真的变化时调用一次 [reconcile]。
 */
class ApprovalGateHolder(
    private val signatureOf: () -> String?,
) {
    var state by mutableStateOf(ApprovalGate.State())
        private set
    // begin 时这张票的签名（含 ticket.id / attention_id 范围，由调用方算进签名）。
    private var answeredSignature: String? = null

    /** 点答复前的准入 + 进入 Submitting（原子的：放行才置位，返回是否放行）。 */
    fun begin(): Boolean {
        if (!ApprovalGate.canSubmit(state)) return false
        answeredSignature = signatureOf()
        state = ApprovalGate.begin()
        return true
    }

    // HTTP 回来的三种结局。**立刻**自检当前签名：若在途期间这张票已经换了题/换了票/换了会话
    // （签名不再等于 begin 时那一个），这一发就是过期请求 —— 直接作废回 Idle，绝不把结果写到新票上。
    fun accepted() {
        if (stillSameTicket()) state = ApprovalGate.accepted()
        else { state = ApprovalGate.State(); answeredSignature = null }
    }
    /** 后端 409：同一张票上解锁并如实转述；已经换票了就直接回 Idle（结果不写到新票上）。 */
    fun rejected(reason: String?) {
        if (stillSameTicket()) state = ApprovalGate.rejected(reason)
        else { state = ApprovalGate.State(); answeredSignature = null }
    }
    fun failed(detail: String?) {
        // 失败不锁：若仍在同一张票上，退回 Idle 并带失败文案（允许重试）；已换票则直接回 Idle。
        if (stillSameTicket()) state = ApprovalGate.failed(detail)
        else { state = ApprovalGate.State(); answeredSignature = null }
    }

    /**
     * 收敛检查：读**当前**签名（而非 begin 时的旧闭包）。签名变/票没了 → 解锁回 Idle。
     * 由 [rememberApprovalGate] 在签名变化的 LaunchedEffect 里调用一次，不在每帧 recomposition 里调。
     */
    fun reconcile() {
        val current = signatureOf()
        if (state.phase == ApprovalGate.Phase.Idle) {
            // Idle 只可能带一条回执（失败/409 的原话）。问题换了这条回执就不再属于这张卡：
            // 旧卡上的「没答上：这句不是一个可执行的答复」不该挂在新问题上。
            if (state.note != null && (answeredSignature == null || answeredSignature != current)) {
                state = ApprovalGate.State()
                answeredSignature = null
            }
            return
        }
        if (ApprovalGate.converged(state.phase, answeredSignature ?: "", current)) {
            state = ApprovalGate.State()
            answeredSignature = null
        }
    }

    private fun stillSameTicket(): Boolean = answeredSignature == signatureOf()
}

/**
 * @param ticketKey 这张票的稳定身份（建议 `"${ticket.id}|${ticket.attentionId}"`）。
 *   换了票/换了 attention 就换一个 holder（旧 holder 连同其未返回的旧请求结果一起被丢弃，
 *   不会把旧票的 Accepted 锁带到新票上）。
 * @param currentSignature 这张票当前的问题签名（含 ticket.id / attention_id 范围）。
 *   每次重组传入；内部用 rememberUpdatedState 保证持有器读到最新值。
 */
@Composable
fun rememberApprovalGate(ticketKey: String, currentSignature: String?): ApprovalGateHolder {
    val latest by rememberUpdatedState(currentSignature)
    // key 绑定票据身份：切票/切会话 → 新 holder，旧请求回来只更新旧 holder（已不再被渲染）。
    val holder = remember(ticketKey) { ApprovalGateHolder { latest } }
    // 签名变化（换题/票消失）时检查一次收敛；不在每帧 recomposition 里写 state。
    LaunchedEffect(currentSignature) { holder.reconcile() }
    return holder
}
