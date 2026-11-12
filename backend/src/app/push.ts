/**
 * 推送：把「有事需要你知道」送到手机上。
 *
 * 这一份做的是**投递层**，不是推送服务商。三档由近到远：
 *
 * 1. **在线**：这台设备此刻有一条隧道挂着，直接把帧写下去，手机在前台/后台收到就弹。
 * 2. **离线留件**：隧道断了就把这条留在中转内存里（有上限、有时效），
 *    设备下次连上来时补发。**不假装送达** —— 离线留件的那条回执写的是 `queued`。
 * 3. **系统推送**（FCM / APNs）：要账号与凭据，这一层不内置。没配时如实说 `no_provider`，
 *    绝不把「没配」说成「已送达」。
 *
 * 为什么值得单独写一层：手机在后台时隧道往往是断的（系统会掐长连接）。
 * 只做「在线才送达」的推送，等于在最需要它的那一刻恰好不工作。
 */

/** 一条待推送。字段与 `T.pushSend` 的载荷一致。 */
export interface PushMessage {
  deviceId: string
  title: string
  body: string
  /** 点开之后跳到哪个会话 / 哪张票。可选。 */
  sessionId?: string
  /** 用来分组与去重：`followup` / `routine` / `report` / `daily`。 */
  kind?: string
  at?: string
}

/** 投递结果。四档分开，因为它们的处置完全不同。 */
export type PushOutcome =
  | { status: 'delivered'; deviceId: string }
  | { status: 'queued'; deviceId: string; depth: number }
  | { status: 'no_provider'; deviceId: string; reason: string }
  | { status: 'rejected'; deviceId: string; reason: string }

/** 一台设备能挂几条待发：够覆盖一夜，又不会把中转内存吃光。 */
export const MAX_QUEUE_PER_DEVICE = 50

/** 留件多久后作废：一天前的「你有一条未读」再看也没有意义。 */
export const QUEUE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 设备 id 的形状：与宿主那边的设备表一致。
 *
 * 真实取值来自手机自己报的 `ANDROID_ID`（16 位小写十六进制，如 `d021988751fdd554`），
 * 桌面那条是手写的名字（`crew-desktop`）。所以这里**不能要求 `dev_` 前缀** ——
 * 早先这条正则写成 `/^dev_[a-z0-9]{6,40}$/`，而设备表里一个都不带前缀，
 * 结果是每一条通知都被判 `rejected`、推送永远发不出去。
 *
 * 只挡「空、带空白、长得离谱」这三种：真正的身份校验在 `phone-gate` 那一层
 * （设备表 + 凭据摘要），这里再按形状卡一遍只会卡掉合法设备。
 */
export const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/

/** 一条留言与它的到期时刻。 */
interface Queued {
  message: PushMessage
  expiresAt: number
}

/**
 * 待发件箱。按设备分桶、按到期限长，满了就丢最旧的 ——
 * 手机上收到十条一样的「有未读」，不如收到最新那一条。
 */
export class PushOutbox {
  private readonly boxes = new Map<string, Queued[]>()
  private readonly now: () => number
  private readonly ttl: number
  private readonly cap: number

  constructor(options: { now?: () => number; ttl?: number; cap?: number } = {}) {
    this.now = options.now ?? (() => Date.now())
    this.ttl = options.ttl ?? QUEUE_TTL_MS
    this.cap = options.cap ?? MAX_QUEUE_PER_DEVICE
  }

  /** 留一条。返回留完之后这个桶里有几条。 */
  keep(message: PushMessage): number {
    const at = this.now()
    const box = (this.boxes.get(message.deviceId) ?? []).filter(item => item.expiresAt > at)
    box.push({ message, expiresAt: at + this.ttl })
    // 超了从最旧的开始丢：新的那条是「现在」。同一 kind 只留最新一条。
    const deduped = message.kind ? box.filter(item => item.message.kind !== message.kind || item === box.at(-1)) : box
    const kept = deduped.slice(-this.cap)
    this.boxes.set(message.deviceId, kept)
    return kept.length
  }

  /** 取走一台设备所有还没过期的，取完清空。 */
  take(deviceId: string): PushMessage[] {
    const at = this.now()
    const box = (this.boxes.get(deviceId) ?? []).filter(item => item.expiresAt > at)
    this.boxes.delete(deviceId)
    return box.map(item => item.message)
  }

  /** 这个桶现在有几条（过期的算没有）。 */
  depth(deviceId: string): number {
    const at = this.now()
    const box = (this.boxes.get(deviceId) ?? []).filter(item => item.expiresAt > at)
    if (box.length === 0) this.boxes.delete(deviceId)
    return box.length
  }
}

/**
 * 投递一条。
 *
 * `online` 是「这台设备此刻有没有挂着隧道」的判定，由调用方给 ——
 * 中转知道这件事，这一层不该再去猜。`provider` 没有时走离线留件，并如实标 `queued`。
 *
 * 顺序是刻意的：**先在线，再留件，最后才谈系统推送**。反过来的话，
 * 一条本来能即时送达的消息要绕一圈推送服务商，慢几秒还可能被系统限流。
 */
export function deliver(message: PushMessage, options: {
  online: boolean
  outbox: PushOutbox
  push?: (message: PushMessage) => boolean
}): PushOutcome {
  if (!DEVICE_ID.test(message.deviceId)) {
    return { status: 'rejected', deviceId: message.deviceId, reason: '设备号形状不对' }
  }
  if (!message.body.trim()) {
    return { status: 'rejected', deviceId: message.deviceId, reason: '空的推送没有意义' }
  }
  if (options.online) return { status: 'delivered', deviceId: message.deviceId }
  const depth = options.outbox.keep(message)
  // 有系统推送就走它；它说没成，也仍算「留在件里」，如实标 queued。
  if (options.push && options.push(message)) return { status: 'delivered', deviceId: message.deviceId }
  return { status: 'queued', deviceId: message.deviceId, depth }
}
