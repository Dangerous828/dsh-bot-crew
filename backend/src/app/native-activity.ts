/** Incremental, content-free projection of actual Session lifecycle events. */
export interface NativeActivityEvent { readonly type: string; readonly seq?: number; readonly time?: number | string; readonly data?: unknown }
export interface NativeActivity {
  kind: 'evaluating' | 'model' | 'tool' | 'retrying' | 'waiting_for_person' | 'idle' | 'ended' | 'unknown'
  since?: string
  at?: string
  label?: string
}
export interface NativeActivityOptions { since?: string }
type Tool = { name: string; at?: number }
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const integer = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
const milliseconds = (value: unknown): number | undefined => {
  const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(time) && Math.abs(time) <= 8.64e15 ? time : undefined
}
const iso = (value: number | undefined): string | undefined => value === undefined ? undefined : new Date(value).toISOString()
/** Names are lookup keys only: an unknown or malformed tool name never becomes main-screen text. */
export function toolActivityLabel(name: string): string {
  const leaf = name.split(/__|\./).at(-1)?.toLowerCase() ?? ''
  const labels: Record<string, string> = {
    read: '读取文件', read_file: '读取文件', read_image: '查看图片', look_video: '查看视频',
    grep: '查找文件', glob: '查找文件', search_files: '查找文件',
    bash: '运行命令', exec: '运行命令', exec_command: '运行命令',
    edit: '修改文件', write: '写入文件', apply_patch: '修改文件',
    web_search: '查询资料', tavily_search: '查询资料', web_fetch: '读取网页', read_mcp_resource: '读取资料',
    wait_agent: '等待成员回报', job_output: '等待任务结果', subagent: '分配任务',
    send_message: '发送消息', h3_generate_video: '生成视频', h3_generate_project_video: '生成视频',
    h3_generate_image: '生成图片', h3_generate_project_image: '生成图片', h3_collect: '获取产物',
  }
  return Object.hasOwn(labels, leaf) ? labels[leaf]! : '执行工具'
}

/** Replays and incrementally tracks native lifecycle phases without retaining message bodies or tool arguments. */
export class NativeActivityTracker {
  private lastSeq = -1
  private lastTime?: number
  private observed = false
  private turn?: number
  private step?: number
  private closed = false
  private model = false
  private modelAt?: number
  private retry = false
  private retryAt?: number
  private idle = false
  private tools = new Map<string, Tool>()

  /** Replay once when attaching to an existing session; live observations are O(1). */
  replay(events: readonly NativeActivityEvent[]): void {
    const ordered = [...events].sort((a, b) => {
      const left = integer(a.seq), right = integer(b.seq)
      return left !== undefined && right !== undefined ? left - right : (milliseconds(a.time) ?? 0) - (milliseconds(b.time) ?? 0)
    })
    for (const event of ordered) this.observe(event)
  }

  observe(event: NativeActivityEvent): void {
    const seq = integer(event.seq), time = milliseconds(event.time)
    if (seq !== undefined ? seq <= this.lastSeq : time !== undefined && this.lastTime !== undefined && time < this.lastTime) return
    if (seq !== undefined) this.lastSeq = seq
    const data = record(event.data), turn = integer(data.turn), step = integer(data.step)
    // A delayed result/closer from another turn or step must not affect the current invocation, even if a call id was reused.
    const matches = () => (turn === undefined || this.turn === undefined || turn === this.turn)
      && (step === undefined || this.step === undefined || step === this.step)
    const reset = () => { this.tools.clear(); this.model = false; this.retry = false; this.idle = false; this.modelAt = undefined; this.retryAt = undefined }
    let changed = true
    switch (event.type) {
      case 'turn/start':
        if (turn !== undefined && this.turn !== undefined && (turn < this.turn || turn === this.turn && this.closed)) return
        reset(); this.turn = turn; this.step = undefined; this.closed = false
        break
      case 'step/start':
        if (turn !== undefined && this.turn !== undefined && turn < this.turn) return
        if (this.closed && (turn === undefined || turn === this.turn)) return
        if (turn !== undefined && turn !== this.turn) { reset(); this.turn = turn; this.closed = false }
        if (step !== undefined && this.step !== undefined && step < this.step) return
        reset(); this.step = step; this.model = true; this.modelAt = time
        break
      case 'assistant/message':
      case 'assistant/attempt':
        if (!matches() || this.closed) return
        this.model = false; this.retry = false
        break
      case 'tool/call': {
        if (!matches() || this.closed) return
        if (typeof data.callId !== 'string' || !data.callId || typeof data.name !== 'string') return
        this.model = false; this.retry = false; this.idle = false
        this.tools.set(`${turn ?? this.turn}:${step ?? this.step}:${data.callId}`, { name: data.name, at: time })
        break
      }
      case 'tool/result': {
        if (!matches() || this.closed) return
        const id = record(data.message).toolCallId
        if (typeof id !== 'string' || !id) return
        if (!this.tools.delete(`${turn ?? this.turn}:${step ?? this.step}:${id}`)) return
        break
      }
      case 'llm/retry':
      case 'llm/retry-started':
        if (!matches() || this.closed) return
        if (!this.retry) this.retryAt = time
        this.retry = true; this.model = false; this.idle = false
        break
      case 'step/end':
        if (!matches() || this.closed) return
        reset(); this.idle = true
        break
      case 'turn/end':
        if (turn !== undefined && this.turn !== undefined && turn < this.turn) return
        reset(); this.turn = turn ?? this.turn; this.step = undefined; this.closed = true; this.idle = true
        break
      default: changed = false
    }
    if (changed) { this.observed = true; this.lastTime = time }
  }

  /** A live Agent idle transition invalidates unfinished historical calls without fabricating Session log events. */
  settle(at?: number | string): void {
    this.tools.clear(); this.model = false; this.retry = false; this.closed = true; this.idle = true
    this.lastTime = milliseconds(at)
    if (this.lastTime !== undefined) this.observed = true
  }

  snapshot(options: NativeActivityOptions = {}): NativeActivity | undefined {
    if (!this.observed) return undefined
    const since = milliseconds(options.since)
    if (since !== undefined && (this.lastTime === undefined || this.lastTime < since)) return undefined
    const fresh = (time: number | undefined) => since === undefined || time !== undefined && time >= since
    const tools = [...this.tools.values()].filter(tool => fresh(tool.at)).sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
    const at = iso(this.lastTime)
    if (tools.length) return { kind: 'tool', at, since: iso(tools[0]!.at), label: tools.length > 1 ? '并行执行工具' : toolActivityLabel(tools[0]!.name) }
    if (this.retry && fresh(this.retryAt)) return { kind: 'retrying', at, since: iso(this.retryAt), label: '模型正在重试' }
    if (this.model && fresh(this.modelAt)) return { kind: 'model', at, since: iso(this.modelAt), label: '模型处理中' }
    if (this.idle) return { kind: 'idle', at, since: at, label: '暂未执行' }
    return { kind: 'unknown', at, label: '执行状态待同步' }
  }
}

export function nativeActivityOf(events: readonly NativeActivityEvent[], options: NativeActivityOptions = {}): NativeActivity | undefined {
  const tracker = new NativeActivityTracker()
  tracker.replay(events)
  return tracker.snapshot(options)
}
