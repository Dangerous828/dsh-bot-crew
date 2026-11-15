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
 *
 * 补丁（#23 接收闭环）：离线留件的「领取」不能一次 GET 就删。设备一次 GET 只**看**到还有
 * 哪些件（peek，带稳定 id），真把条目落进设备本地存储之后，再发一条显式 ACK 才把这几条从
 * 留件里移除。否则 200 一发出、App 崩溃，这条就永久丢了 —— 那是根因没堵，只是把丢件挪到了
 * 应答之后。稳定 id 在**入队那一刻生成并保存**，之后每次 peek 拿到的都是同一个，设备靠它去重。
 */

import { createHash } from 'node:crypto'
import { KV } from '../kv.ts'

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

/**
 * 一条留言、它的到期时刻，以及**入队时定下的稳定 id**。
 *
 * id 只在这里生成一次，之后所有 peek 都读它 —— 不在每次 GET 重造，否则设备拿到的 id
 * 每次都变，去重和 ACK 都对不上同一条。
 */
/** 一条排队中的待发件：载荷 + 到期时刻 + 稳定 id。落盘形状，`NoticeStore` 也用它。 */
export interface Queued {
  message: PushMessage
  expiresAt: number
  id: string
}

/**
 * 待发件的持久化接口 —— 由调用方注入（Runtime 接 `Store`，单测接内存替身）。
 *
 * 这是「排队的件不因进程重建而丢」的唯一落点：`PushOutbox` 自己没有盘，全靠这个口子把整桶
 * 写下去。**先写盘成功，再动内存**：写失败时抛出来，`keep`/`ack` 如实把失败交给上层，绝不
 * 先改内存、再假装留住了 —— 那正是「HMR 一重建，未 ACK 的件全没了」的根因。
 */
export interface NoticeStore {
  /** 读这台设备整桶待发件；没有就是空。 */
  get(deviceId: string): Queued[] | undefined
  /** 覆盖写这台设备整桶待发件（空桶等价于清掉）。失败即抛。 */
  set(deviceId: string, box: Queued[]): void
  /** 清掉这台设备整桶待发件。 */
  delete(deviceId: string): void
  /**
   * 列出所有设备 id（对应 KV `notice.pending:` 这一族）。只有它在，新进程才能把上次
   * 写成孤键、却已不记得 deviceId 的桶读回来 —— 否则重建后 `boxes` 是空的，件就丢了。
   */
  devices(): string[]
}

/** 取件条目的线上形状：设备拉到的东西。`id` 是稳定去重键。 */
export interface NoticeDelivery {
  id: string
  title: string
  body: string
  kind?: string
  at?: string
  sessionId?: string
}

/** 入队那一刻定下的稳定 id：同一条留言（同设备 + 同 kind/title/body/at）永远同一个。 */
export function noticeId(message: PushMessage): string {
  const material = [message.deviceId, message.kind ?? '', message.title, message.body, message.at ?? ''].join('\u0000')
  return createHash('sha256').update(material).digest('hex').slice(0, 16)
}

/**
 * 待发件箱。按设备分桶、按到期限长，满了就丢最旧的 ——
 * 手机上收到十条一样的「有未读」，不如收到最新那一条。
 *
 * 桶可以落在内存（`store` 缺省，给纯单测跑语义），也可以落在 `NoticeStore` 后面（Runtime
 * 接 `Store`/KV）。落盘时**内存只当 Cache，盘才是真相**：每次改动都是「读盘 → 改 → 原子写回 →
 * 写成功后才更新内存」。早先只有 `boxes` 这个 Map，backend HMR/实例重建就把尚未 ACK 的件全丢掉
 * —— 那正是本类要堵的持久缺口。
 */
export class PushOutbox {
  /** 内存镜像。有 `store` 时只当 Cache：每次先读盘算，写盘成功才更新它。 */
  private readonly boxes = new Map<string, Queued[]>()
  private readonly now: () => number
  private readonly ttl: number
  private readonly cap: number
  constructor(
    options: { now?: () => number; ttl?: number; cap?: number } = {},
    /** 持久化后端。缺省纯内存（只给单测）；Runtime 传接 `Store`/KV 的 adapter。 */
    private readonly store?: NoticeStore,
  ) {
    this.now = options.now ?? (() => Date.now())
    this.ttl = options.ttl ?? QUEUE_TTL_MS
    this.cap = options.cap ?? MAX_QUEUE_PER_DEVICE
  }

  /**
   * 读这台设备当前**未过期**的桶。有 `store` 时盘是真相：先读盘、滤掉过期、写回（顺手把过期件
   * 从盘里真删掉，免得越积越多）。内存只在这一步之后对齐 —— 每次读都不信任进程里的旧 Map，
   * 这样另一个 Runtime 实例已经写过的件不会被这一实例的陈旧 Cache 盖掉。
   */
  private load(deviceId: string): Queued[] {
    const at = this.now()
    if (!this.store) {
      const box = (this.boxes.get(deviceId) ?? []).filter(item => item.expiresAt > at)
      if (box.length === 0) this.boxes.delete(deviceId)
      else this.boxes.set(deviceId, box)
      return box
    }
    const stored = this.store.get(deviceId) ?? []
    const live = stored.filter(item => item.expiresAt > at)
    // 有东西过期了：把它从盘里真删（TTL 清理要同步持久，不能只活在内存里）。
    if (live.length !== stored.length) {
      if (live.length === 0) this.store.delete(deviceId)
      else this.store.set(deviceId, live)
    }
    if (live.length === 0) this.boxes.delete(deviceId)
    else this.boxes.set(deviceId, live)
    return live
  }

  /**
   * 留一条。返回留完之后这个桶里有几条。写盘失败会抛出 —— 上层据此如实说「没留住」，
   * 不会先回 `queued` 再说。
   *
   * id 在这里生成并**随条目一起存下来**：之后 peek 拿到的都是同一个，设备靠它去重。
   */
  keep(message: PushMessage): number {
    const at = this.now()
    const box = [...this.load(message.deviceId)]
    // 稳定 id 按内容取（同设备+kind/title/body/at 同一条）；同 id 的重复件在 peek/ack 阶段按 id 去重，
    // 与旧内存语义一致（同一句话不会因为重投在设备那儿变成两条）。
    box.push({ message, expiresAt: at + this.ttl, id: noticeId(message) })
    // 超了从最旧的开始丢：新的那条是「现在」。同一 kind 只留最新一条。
    const deduped = message.kind ? box.filter(item => item.message.kind !== message.kind || item === box.at(-1)) : box
    const kept = deduped.slice(-this.cap)
    if (this.store) this.store.set(message.deviceId, kept)
    this.boxes.set(message.deviceId, kept)
    return kept.length
  }

  /**
   * 看一眼这台设备还有哪些没 ACK 的（**不删**）。按 id 去重、跳过过期的。
   *
   * 这是取件这条路读的唯一来源：GET 只 peek，不把任何东西移除 —— 只有 device 明确 ACK 才删。
   */
  peek(deviceId: string): NoticeDelivery[] {
    const box = this.load(deviceId)
    const seen = new Set<string>()
    const out: NoticeDelivery[] = []
    for (const item of box) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      out.push({ id: item.id, title: item.message.title, body: item.message.body,
        ...(item.message.kind ? { kind: item.message.kind } : {}),
        ...(item.message.at ? { at: item.message.at } : {}),
        ...(item.message.sessionId ? { sessionId: item.message.sessionId } : {}) })
    }
    return out
  }

  /**
   * 设备确认这几条已经落进它的本地存储：只删被点名的那些，别的原封不动。
   *
   * 返回真正删掉几条。ACK 一个不存在的 id 是幂等的空操作（重试安全）。**先持久化再回 2xx**：
   * 写盘失败就抛，上层不会先答「删掉了」而盘上其实还在。
   */
  ack(deviceId: string, ids: readonly string[]): number {
    const box = this.load(deviceId)
    if (box.length === 0) return 0
    const wanted = new Set(ids)
    const kept = box.filter(item => !wanted.has(item.id))
    const removed = box.length - kept.length
    if (kept.length !== box.length) {
      if (this.store) { if (kept.length === 0) this.store.delete(deviceId); else this.store.set(deviceId, kept) }
    }
    if (kept.length === 0) this.boxes.delete(deviceId)
    else this.boxes.set(deviceId, kept)
    return removed
  }

  /** 取走一台设备所有还没过期的，取完清空（保留给不 ACK 的老路径；新接收链走 peek+ack）。 */
  take(deviceId: string): PushMessage[] {
    const box = this.load(deviceId)
    if (this.store) this.store.delete(deviceId)
    this.boxes.delete(deviceId)
    return box.map(item => item.message)
  }

  /** 这个桶现在有几条（过期的算没有）。 */
  depth(deviceId: string): number {
    return this.load(deviceId).length
  }
}

/**
 * 把一台设备的待发件映射成线上取件形状（peek 的薄封装，保留一个显式入口给路由层）。
 *
 * 不删任何东西 —— 见 `PushOutbox.peek`。设备持久化后自己发 ACK 才走 `PushOutbox.ack`。
 */
export function pendingFor(deviceId: string, outbox: PushOutbox): { items: NoticeDelivery[] } {
  return { items: outbox.peek(deviceId) }
}

/**
 * 已读账本的幂等合并：把新报上来的 id 并进旧账，去重、保序、留最新一段。
 *
 * 「seen」在这里的口径是**device-persisted**（设备已经把它落进本地存储），不是「人眼读过」。
 * 真实人眼阅读要另证，不靠这个字段冒充。上限用 `cap` 防止一台设备把账本无限撑大。
 */
export function seenLedgerPatch(ledger: readonly string[] | undefined, seen: readonly string[], cap = MAX_QUEUE_PER_DEVICE * 2): string[] {
  const merged = [...(ledger ?? [])]
  const have = new Set(merged)
  for (const id of seen) {
    if (typeof id !== 'string' || !id) continue
    if (have.has(id)) continue
    have.add(id)
    merged.push(id)
  }
  return merged.slice(-cap)
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
  // 落件。写盘失败会抛 —— 不能把「没留住」说成 queued，那等于给了个假承诺：
  // 进程一重建它就没影了。让失败大声抛出去，由上层按错误如实处置。
  const depth = options.outbox.keep(message)
  // 有系统推送就走它；它说没成，也仍算「留在件里」，如实标 queued。
  if (options.push && options.push(message)) return { status: 'delivered', deviceId: message.deviceId }
  return { status: 'queued', deviceId: message.deviceId, depth }
}


/**
 * 把 `PushOutbox` 的持久化后端接到项目既有的 `Store`/KV 上：每台设备一整桶，一桶一键
 * （`KV.notice.pending(deviceId)`）。**纯 adapter，不改语义** —— TTL/CAP/同 kind 合并仍归
 * `PushOutbox`，这里只负责把整桶读出来、写回去、列设备、删空桶。`Store.set` 失败会抛出，一路
 * 传到 `keep`/`ack`，绝不吞成假成功。
 *
 * `devices()` 走 `Store.keys`：新进程靠它把上次写成孤键的桶找回来。没有它，重建后 `boxes` 是
 * 空的 —— 件就跟着没了，正是这一族键要堵的持久缺口。
 */
export function storeNoticeStore(store: Pick<import('./store.ts').Store, 'get' | 'set' | 'delete' | 'keys'>): NoticeStore {
  const prefix = KV.notice.pending.prefix
  return {
    get: deviceId => store.get(KV.notice.pending(deviceId)),
    set: (deviceId, box) => { store.set(KV.notice.pending(deviceId), box) },
    delete: deviceId => store.delete(KV.notice.pending(deviceId) as string),
    devices: () => store.keys(prefix).map(key => key.slice(prefix.length)),
  }
}
