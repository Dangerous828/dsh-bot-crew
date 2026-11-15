// 起草：HubRetraction HTTP 实现（按 source_file 撤全部 live 历史版本）。
// 严格按 wb-hub-retract 冻结协议 docs/review/2026-11-14-issue24-retract-contract.md §4。
//
// 关键点（协议 §4.1 / §4.4）：
//  - 反查用原始 POST /v1/memories/search {namespace, query:"", limit:100, metadata_filter:{source_file}}
//    默认只回 live 行（include_deleted=false），已软删版本无需再动。
//  - 逐条 DELETE /v1/memories/{id}?hard=false&reason=...；404=已消失=ok；5xx/超时抛出供持久重试；
//    同 id 重试 already_deleted 幂等。
//  - edit（同名文件内容变）：传 keepDigest（新版本 dedupe_key），反查 live 行里 != keepDigest 的删，保留新版。
//  - bounded：live 行可能 >limit(100)，循环「search(limit 100 live) → 删本批 → 再 search」直至 live=0 或达上限，
//    防死循环；每轮仅 live，避免 include_deleted=true 反复命已删行。
import type { HubRetraction, RetractResult } from './author.ts'

export interface RetractHttpOptions {
  base: () => string
  token: () => string
  timeoutMs: () => number
  fetchImpl?: typeof fetch
}

interface RawRow { id?: unknown; dedupe_key?: unknown; deleted_at?: unknown; metadata?: { dedupe_key?: unknown; source_file?: unknown } }
const PAGE = 100
const MAX_ROUNDS = 20 // bounded：最多撤 2000 个版本，远超单条记忆历史

export function makeHubRetraction(options: RetractHttpOptions): HubRetraction {
  const doFetch = options.fetchImpl ?? fetch
  const headers = (): Record<string, string> => {
    const token = options.token()
    return { 'content-type': 'application/json', ...token ? { 'x-hub-token': token } : {} }
  }
  const digestOf = (row: RawRow): string | undefined => {
    const v = row.dedupe_key ?? row.metadata?.dedupe_key
    return typeof v === 'string' ? v : undefined
  }

  async function searchLive(namespace: string, sourceFile: string, timeout: number): Promise<RawRow[]> {
    const base = options.base().replace(/\/+$/, '')
    const resp = await doFetch(`${base}/memories/search`, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ namespace, query: '', limit: PAGE, include_deleted: false, metadata_filter: { source_file: sourceFile } }),
      signal: AbortSignal.timeout(timeout),
    })
    if (!resp.ok) throw new Error(`hub retract search answered ${resp.status}`)
    const body = (await resp.json()) as unknown
    return Array.isArray(body) ? body as RawRow[] : []
  }

  async function deleteId(id: string, sourceFile: string, timeout: number): Promise<boolean> {
    const base = options.base().replace(/\/+$/, '')
    const reason = encodeURIComponent(`retract:${sourceFile.replace(/\.md$/, '')}`)
    const resp = await doFetch(`${base}/memories/${encodeURIComponent(id)}?hard=false&reason=${reason}`, {
      method: 'DELETE', headers: headers(), signal: AbortSignal.timeout(timeout),
    })
    if (resp.status === 404) return false // 已消失，幂等成功（不计 deleted）
    if (!resp.ok) throw new Error(`hub retract delete ${id} answered ${resp.status}`)
    return true
  }

  return {
    async bySourceFile({ namespace, sourceFile, keepDigest }): Promise<RetractResult> {
      const timeout = options.timeoutMs()
      let deleted = 0, matched = 0, alreadyDeleted = 0, totalVersions = 0
      const ids: string[] = []
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const live = await searchLive(namespace, sourceFile, timeout)
        if (live.length === 0) break
        totalVersions += live.length
        matched += live.length
        let actedThisRound = 0
        for (const row of live) {
          const id = typeof row.id === 'string' ? row.id : undefined
          if (!id) continue
          // edit 场景：保留新版本（keepDigest 匹配的行不删）。
          if (keepDigest && digestOf(row) === keepDigest) continue
          if (typeof row.deleted_at === 'string' && row.deleted_at) { alreadyDeleted += 1; continue }
          const did = await deleteId(id, sourceFile, timeout)
          if (did) { deleted += 1; ids.push(id); actedThisRound += 1 }
        }
        // 没有可删的（只剩 keepDigest 保留行 / 全是已删）→ 停，避免死循环。
        if (actedThisRound === 0) break
        // live 行 < PAGE 说明已取尽本批；但为稳妥再查一轮确认无剩余 live。
        if (live.length < PAGE) break
      }
      return { ok: true, deleted, matched, ids, alreadyDeleted, totalVersions }
    },

    /**
     * 原子占位（wb-hub-retract 冻结端点 POST /v1/memory/retract-tombstone）：
     * 传 canonical source + 已知 digest 集合（不传正文），服务端单事务为「无行」的 digest 插 deleted 占位，
     * 不产生 live 窗口。conflicts 非空 → 服务端整请求 409，这里抛错（可观察、不误删）。
     */
    async tombstoneByDigests({ namespace, sourceFile, knownDigests, reason }) {
      const base = options.base().replace(/\/+$/, '')
      const timeout = options.timeoutMs()
      const resp = await doFetch(`${base}/memory/retract-tombstone`, {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ namespace, source_file: sourceFile, known_digests: knownDigests, ...reason ? { reason } : {} }),
        signal: AbortSignal.timeout(timeout),
      })
      if (resp.status === 409) {
        const body = await resp.json().catch(() => ({})) as { conflicts?: unknown }
        const conflicts = Array.isArray(body.conflicts) ? body.conflicts.map(String) : []
        throw new Error(`retract-tombstone conflicts (409): ${conflicts.join(',') || 'unknown'}`)
      }
      if (!resp.ok) throw new Error(`hub retract-tombstone answered ${resp.status}`)
      const body = await resp.json().catch(() => ({})) as Record<string, unknown>
      const arr = (v: unknown): string[] => Array.isArray(v) ? v.map(String) : []
      return { ok: true, placed: arr(body.placed), alreadyRetracted: arr(body.already_retracted), softDeleted: arr(body.soft_deleted), conflicts: arr(body.conflicts) }
    },
  }
}
