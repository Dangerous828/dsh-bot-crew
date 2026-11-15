/**
 * author md 生命周期镜像（起草 v3：裁定 C —— 显式 toHub 才分享 / canonical source_file 撤回）。
 *
 * 裁定 C（lead 2026-11-14）：settle 生成的新记忆 **默认 toHub=false**，origin/type 不构成分享授权；
 * 只有已认证操作者经产品 edit/update 入口**显式设 toHub:true** 才落 author md、才会上行。
 * 既有 28 条 toHub:false 不回改。
 *
 * 远端撤回正确性（wb-hub-retract 冻结协议 docs/review/...-retract-contract.md）：
 *  - 远端每行 dedupe_key = sha256(content)[:16] ≠ ledger 业务 dedupe_key；
 *  - canonical = namespace + source_file（md 文件名，跨版本稳定）；
 *  - 反查用原始 /v1/memories/search + metadata_filter{source_file}（只 live），逐条 DELETE /{id}；
 *  - edit 同名内容变：保留新 digest 行，只删旧 digest 的 live 行（keepDigest）。
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { maskSecrets } from '../app/screen.ts'
import { renderMarkdown, targetPathOf, type MemoryRecord } from './adapter.ts'
import type { MemoryEntry } from './recall.ts'

export interface RetractResult {
  ok: boolean
  deleted: number
  matched?: number
  alreadyDeleted?: number
  totalVersions?: number
  ids?: string[]
}

/** 中枢按 canonical 源（source_file）撤回 live 历史版本。路径口径见冻结协议 §4。 */
export interface HubRetraction {
  /** keepDigest：edit 场景保留该 dedupe_key（新版本）的行不删。 */
  bySourceFile(input: { namespace: string; sourceFile: string; keepDigest?: string }): Promise<RetractResult>
  /**
   * 原子占位（wb-hub-retract 冻结端点 POST /v1/memory/retract-tombstone）：
   * 传 canonical source + 已知 digest 集合（不传正文），服务端单事务为「无行」的 digest 插入
   * deleted 占位行（不产生 live 窗口）；已删幂等；live 归 existing_live 不擅删；source 不匹配→conflicts 整请求 409。
   * 使「从未入库的旧 pending / md 已删算不出的旧版本」首次上行时被 ON CONFLICT 吸收成 deleted，不复活。
   */
  tombstoneByDigests?(input: { namespace: string; sourceFile: string; knownDigests: string[]; reason?: string }):
    Promise<{ ok: boolean; placed: string[]; alreadyRetracted: string[]; softDeleted: string[]; conflicts: string[] }>
}

export interface AuthorMirrorOptions {
  root: string
  retract?: HubRetraction
  /** 读某记忆的远端 digest 历史（由宿主提供，KV 一族）。 */
  digestsOf?: (name: string) => string[]
  /** 记一条远端 digest 历史（由宿主提供，只存 16hex）。 */
  rememberDigest?: (name: string, digest: string) => void
  /** 敏感粗筛：默认用 maskSecrets 语义（命中即视为敏感，不落盘不上行）。粗筛非完备 DLP。 */
  looksSensitive?: (entry: MemoryEntry) => boolean
  now?: () => number
}

export interface PublishResult { written: boolean; path?: string; retracted?: RetractResult; retractError?: Error; sensitive?: boolean }
export interface ForgetResult { ok: boolean; disabled: boolean; retracted?: RetractResult; retractError?: Error }
export interface SimpleResult { ok: boolean; retracted?: RetractResult; retractError?: Error }

export type MutationEvent =
  | { kind: 'publish'; entry: MemoryEntry; keepDigest?: string }
  | { kind: 'forget'; name: string; botId: string; entry?: MemoryEntry }
  | { kind: 'supersede'; name: string; botId: string }
  | { kind: 'evict'; name: string; botId: string }

const AUTHOR_NAMESPACE = 'dsh-memory/bot'
const sourceFileOf = (name: string): string => `${name}.md`
/**
 * 复算管道上传的 content（与 local_dream `_iter_dsh_auto_memories` 逐字一致）：
 *   header = `[dsh-auto-memory:<type>] <stem>` + (description ? ` — <description>` : '')
 *   content = `# ${header}\n\n${body}`
 * 注意：不是 frontmatter md，是管道 POST 的纯文本；dedupe_key = sha256(content)[:16]。
 */
export function pipelineContent(entry: Pick<MemoryEntry, 'name' | 'type' | 'description' | 'body'>): string {
  const stem = entry.name.replace(/\.md$/, '')
  let header = `[dsh-auto-memory:${entry.type}] ${stem}`
  const desc = (entry.description ?? '').trim()
  if (desc) header += ` — ${desc}`
  return `# ${header}\n\n${entry.body.trim()}`
}
/** 管道远端 dedupe_key = sha256(utf8(content)).hexdigest()[:16]。 */
export function pipelineDigest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16)
}
/** 默认敏感粗筛：复用 maskSecrets 语义（KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL=value、Bearer xxx）。 */
const defaultLooksSensitive = (e: MemoryEntry): boolean => maskSecrets(`${e.description}\n${e.body}`) !== `${e.description}\n${e.body}`

/**
 * author md 生命周期镜像：把产品账本里的记忆落成 local_dream 能搬的 md，并把 forget/evict/
 * supersede/edit 同步到 author md 与中枢撤回。纯模块（不依赖 runtime/settings），宿主注入 root 与撤回流。
 */
export class AuthorMirror {
  private readonly now: () => number
  private readonly sensitive: (e: MemoryEntry) => boolean
  constructor(private readonly options: AuthorMirrorOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000))
    this.sensitive = options.looksSensitive ?? defaultLooksSensitive
  }
  private pathOf(botId: string, name: string): string { return targetPathOf(this.options.root, botId, name) }

  private write(record: MemoryRecord, entry: MemoryEntry): PublishResult {
    const path = this.pathOf(entry.bot_id, entry.name)
    const content = renderMarkdown(record)
    if (existsSync(path)) { try { if (readFileSync(path, 'utf8') === content) return { written: false, path } } catch { /* rewrite */ } }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, content, { mode: 0o600 })
    // 记该条会随管线上行的远端 digest（只 16hex，不存正文），供未来撤回占位旧版本。
    this.options.rememberDigest?.(entry.name, pipelineDigest(pipelineContent(entry)))
    return { written: true, path }
  }

  /** 落盘：仅 entry.toHub===true 且非敏感才写；true→false 时删 md 并撤远端。 */
  async publish(entry: MemoryEntry, opts: { keepDigest?: string } = {}): Promise<PublishResult> {
    const path = this.pathOf(entry.bot_id, entry.name)
    const sensitive = this.sensitive(entry)
    if (entry.toHub !== true || sensitive) {
      const existed = existsSync(path)
      if (existed) { try { unlinkSync(path) } catch { /* ignore */ } }
      const out: PublishResult = { written: false, sensitive }
      if (existed && this.options.retract) {
        try { out.retracted = await this.options.retract.bySourceFile({ namespace: AUTHOR_NAMESPACE, sourceFile: sourceFileOf(entry.name), ...opts.keepDigest ? { keepDigest: opts.keepDigest } : {} }) }
        catch (e) { out.retractError = e instanceof Error ? e : new Error(String(e)) }
      }
      return out
    }
    return this.write(entry as MemoryRecord, entry)
  }

  /** edit：重写 md（新内容），并在需要时按 keepDigest 撤旧版本 live 行（保留新版本）。 */
  async edit(entry: MemoryEntry, newDigest?: string): Promise<PublishResult> {
    // 先撤旧版本（保留新 digest 行），再由 md 新内容自然上行新行。
    const out = await this.publish(entry, { keepDigest: newDigest })
    return out
  }

  /**
   * forget：先写 tombstone（占住当前 content 的远端槽，防未入库旧 pending 首次上行复活）
   * → md 打 disabled:true（管道跳过）→ 撤远端该 source_file 全部 live 版本。
   * `entry` 可选：给出则可写 tombstone（需 content）；省略则只撤已入库 live 行（旧 pending 缺口如实留）。
   */
  async forget(name: string, botId: string, entry?: MemoryEntry): Promise<ForgetResult & { tombstoned?: boolean }> {
    const path = this.pathOf(botId, name)
    let disabled = false
    if (existsSync(path)) {
      try { const t = readFileSync(path, 'utf8'); const n = this.flag(t, 'disabled', 'true'); if (n !== t) writeFileSync(path, n, { mode: 0o600 }); disabled = true }
      catch { disabled = false }
    }
    const result: ForgetResult & { tombstoned?: boolean } = { ok: true, disabled }
    if (this.options.retract) {
      // 1) 原子占位：把该 source 的**全部已知 digest**（本地历史）交给 retract-tombstone，挡 pending/未来重扫。
      //    额外把当前 entry 的 digest 也纳入（即便历史漏记）。
      const known = new Set<string>(this.options.digestsOf?.(name) ?? [])
      if (entry) known.add(pipelineDigest(pipelineContent(entry)))
      if (this.options.retract.tombstoneByDigests && known.size) {
        try {
          const t = await this.options.retract.tombstoneByDigests({ namespace: AUTHOR_NAMESPACE, sourceFile: sourceFileOf(name), knownDigests: [...known], reason: 'forget' })
          // placed=新占槽 / alreadyRetracted=已删幂等 / softDeleted=canonical 匹配的 live 行被端点直接软删，都算撤回生效
          result.tombstoned = t.placed.length > 0 || t.alreadyRetracted.length > 0 || t.softDeleted.length > 0
          if (t.conflicts.length) result.retractError = new Error(`retract-tombstone conflicts: ${t.conflicts.join(',')}`)
        } catch (e) { result.retractError = e instanceof Error ? e : new Error(String(e)) }
      }
      // 2) 撤已入库 live 行
      try { result.retracted = await this.options.retract.bySourceFile({ namespace: AUTHOR_NAMESPACE, sourceFile: sourceFileOf(name) }) }
      catch (e) { result.retractError = e instanceof Error ? e : new Error(String(e)) }
    }
    return result
  }

  /** supersede：旧 md status:superseded + 撤旧源全部 live 版本（换名场景）。 */
  async supersede(name: string, botId: string): Promise<SimpleResult> {
    const path = this.pathOf(botId, name)
    const out: SimpleResult = { ok: true }
    if (existsSync(path)) { try { writeFileSync(path, this.flag(readFileSync(path, 'utf8'), 'status', 'superseded'), { mode: 0o600 }) } catch { out.ok = false } }
    if (this.options.retract) {
      try { out.retracted = await this.options.retract.bySourceFile({ namespace: AUTHOR_NAMESPACE, sourceFile: sourceFileOf(name) }) }
      catch (e) { out.retractError = e instanceof Error ? e : new Error(String(e)) }
    }
    return out
  }

  /** evict：真删 md + 撤远端该源全部 live 版本。 */
  async evict(name: string, botId: string): Promise<SimpleResult> {
    const path = this.pathOf(botId, name)
    const out: SimpleResult = { ok: true }
    if (existsSync(path)) { try { unlinkSync(path) } catch { out.ok = false } }
    if (this.options.retract) {
      try { out.retracted = await this.options.retract.bySourceFile({ namespace: AUTHOR_NAMESPACE, sourceFile: sourceFileOf(name) }) }
      catch (e) { out.retractError = e instanceof Error ? e : new Error(String(e)) }
    }
    return out
  }

  async apply(event: MutationEvent): Promise<unknown> {
    switch (event.kind) {
      case 'publish': return this.publish(event.entry, event.keepDigest ? { keepDigest: event.keepDigest } : {})
      case 'forget': return this.forget(event.name, event.botId, (event as any).entry)
      case 'supersede': return this.supersede(event.name, event.botId)
      case 'evict': return this.evict(event.name, event.botId)
    }
  }

  private flag(text: string, key: string, value: string): string {
    if (!text.startsWith('---\n')) return text
    const end = text.indexOf('\n---', 4)
    if (end < 0) return text
    const head = text.slice(0, end); const rest = text.slice(end)
    const re = new RegExp(`^${key}:.*$`, 'm'); const line = `${key}: ${value}`
    return (re.test(head) ? head.replace(re, line) : `${head}\n${line}`) + rest
  }
}

