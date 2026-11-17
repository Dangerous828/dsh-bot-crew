/**
 * 轻量活动投影的**接线层**：把原生事件投影（`native-activity.ts`）与持久阶段合成契约里的
 * `activity`，不重复实现原生解析。
 *
 * 契约（`docs/review/product-fixes-20261117/CONTRACT.md`「状态协议」）：
 *   activity?: { kind: "evaluating"|"model"|"tool"|"retrying"|"waiting_for_person"|"idle"|"ended"|"unknown",
 *                since?: ISO, at?: ISO, label?: "读取文件" }
 *
 * 分工：
 * - 原生事件（step/tool/retry/turn）由 `NativeActivityTracker` 投影，这里只调用。
 * - `evaluating` / `waiting_for_person` / `ended` 是**持久事实**（thread.evaluating、工单阶段），
 *   优先于易失事件：它们说「在等人 / 已结束」时，最后一条工具调用改变不了这件事。
 *   但阶段只决定 kind，**不丢**原生投影给出的 label 与时间：`Runtime.activity` 已按真实
 *   outcome 写明「已停止 / 已完成」，那是人话，不该被接线层抹掉。
 * - 一个都说不出就整块缺席；读取出错才给 `unknown`，且不编时间。
 */
import type { NativeActivity, NativeActivityEvent, NativeActivityOptions, NativeActivityTracker } from './native-activity.ts'

export type ActivityKind = NativeActivity['kind']
export type Activity = NativeActivity
export type { NativeActivityEvent, NativeActivityOptions }
export { NativeActivityTracker, nativeActivityOf, toolActivityLabel } from './native-activity.ts'

/** 持久事实里能确定活动的那几格；其余交给原生事件。 */
export interface DurableActivityFacts {
  /** 工单阶段：`person` 是等人（答复/交付/复核/受阻/失败），`ended` 是结束。 */
  stage?: string
  /** 线程正在评估（还没生成工单）：`thread.evaluating` 的起点/送达时间。 */
  evaluating?: { since?: string; at?: string }
}

export interface WireActivityInput extends DurableActivityFacts {
  /** 这张票/这条会话的原生活动投影；读不到就不给。 */
  native?: Activity
}

/**
 * 合成契约的 `activity`。顺序即优先级：结束 > 等人 > 评估 > 原生（重试/工具/模型/空闲）。
 *
 * 阶段改写 kind 时保留原生的 `label` / `since` / `at`：宿主已经按真实结果写好的人话与时间，
 * 换掉 kind 不等于要把它一起抹掉。
 */
export function wireActivity(input: WireActivityInput): Activity | undefined {
  const stage = input.stage?.trim()
  const native = input.native
  // 只有**同一种活动**才带原生的 label/时间：`person` 阶段的文案与 `model` 的
  // 「模型处理中」混在一起就是假状态（kind 说等人、label 说在算），比不写更糟。
  const carry = (kind: ActivityKind): Partial<Activity> => native?.kind === kind
    ? { ...(native.since ? { since: native.since } : {}), ...(native.at ? { at: native.at } : {}), ...(native.label ? { label: native.label } : {}) }
    : {}
  if (stage === 'ended') return { kind: 'ended', ...carry('ended') }
  if (stage === 'person') return { kind: 'waiting_for_person', ...carry('waiting_for_person') }
  if (input.evaluating) {
    // 评估阶段不携带 tool/model 的 label：那时还没有工具在跑。
    return { kind: 'evaluating',
      ...(input.evaluating.since ? { since: input.evaluating.since } : {}),
      ...(input.evaluating.at ?? input.evaluating.since ? { at: input.evaluating.at ?? input.evaluating.since! } : {}) }
  }
  return native
}

/**
 * 把 tracker 的一次读取也走同一优先级：宿主只给 tracker 与持久阶段。
 *
 * tracker 缺席（宿主没接原生事件）→ `undefined`：没有证据就不画状态，客户端自行隐藏。
 * 读取出错（tracker 自己抛）→ `unknown` + 「执行状态读取失败」，不造时间、不假装在跑。
 */
export function activityFrom(
  tracker: Pick<NativeActivityTracker, 'snapshot'> | undefined,
  facts: DurableActivityFacts = {},
  options: NativeActivityOptions = {},
): Activity | undefined {
  const stage = facts.stage?.trim()
  if (stage === 'ended' || stage === 'person' || facts.evaluating) return wireActivity({ ...facts })
  if (!tracker) return undefined
  let native: Activity | undefined
  try { native = tracker.snapshot(options) } catch { return { kind: 'unknown', label: '执行状态读取失败' } }
  return wireActivity({ ...facts, ...(native ? { native } : {}) })
}
