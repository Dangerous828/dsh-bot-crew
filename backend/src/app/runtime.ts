/** Application composition root and lifecycle manager for dsh-superagent. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Engine, key, liveTicket, reasonText, runningAssignment, ticketStage, type EngineForSettings, type OutboundMessage, type ReceiveResult,
  type Ticket, type Trigger } from '../core/index.ts'
import { allowedSender, settingsPolicy } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Commands } from '../infra/commands.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { environmentOf, executionRoot, ticketEnvironment, type Variable } from './execution-environment.ts'
import type { SetupProblem } from '../setup.ts'
import { DshExecutor, sourceTrigger, triggerMessage, workerSessionId } from '../executor/dsh.ts'
import { ticketCard } from './cards.ts'
import { screenOf, type ScreenEvent, type ScreenSnapshot } from './screen.ts'
import { outputsView, type OutputEvent, type OutputsTicket, type OutputsView } from './outputs.ts'
import { routinesView, type RoutinesView } from './routines.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { Store } from './store.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { Prompts } from './prompts.ts'
import { registerHttp, type HttpHost } from './http.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { handoffEndNotice } from './notices.ts'
import { HealthBoard } from '../infra/health.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Setup } from './setup.ts'
import { feishuSettings } from '../sources/feishu.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import { Sessions } from './sessions.ts'
import { Settings } from './settings.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'
import { MemoryLayer } from './memory-layer.ts'
import { memoryView, type MemoryView } from './views/memory.ts'

// Source plugins interact with dsh-superagent exclusively through the `SourceHost` service interface.
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
/**
 * Why a finished worker session is archived at once.
 *
 * Every worker session this plugin creates is machinery, not a conversation a person started: the crew is read
 * through the desktop window or the phone, never through the DSH chat list. Leaving them there fills the list
 * with one entry per errand ("回答仓库根目录 README…") and hides the person's own work. Archiving keeps the
 * transcript — the crew's screen and timeline read the session directly — and only removes it from the list.
 */
const now = (): string => new Date().toISOString()
/**
 * How many notes a chain of crew mates may pass before the next one is refused. Two bots left to answer each other never
 * stop on their own, since each answer is a fresh reason to write back; a person's request reaches depth 1, so this is room
 * for a few rounds of real conversation and no more.
 */
const CREW_HOP_LIMIT = 3
/**
 * The crew mate's ticket a note goes to: the newest one it is running. A crew mate can hold several tickets at once, having
 * been handed more while busy, and the newest is the one it is working now; an older one would put the note in front of a
 * worker whose attention has already moved on. Tickets arrive newest first, which makes the first match the current one.
 */
const teammateTicket = (tickets: readonly Ticket[], bot_id: string): Ticket | undefined =>
  tickets.find(candidate => liveTicket(candidate) && runningAssignment(candidate) !== undefined
    && String(candidate.channels[0]?.address.bot_id ?? '') === bot_id)
/** How many crew notes a ticket's chain has already carried; a ticket a person started at depth 0. */
const crewHop = (store: Pick<Store, 'get'>, ticketId: string): number => store.get(KV.crew.hop(ticketId)) ?? 0

/**
 * Where the gateway answers, as `scripts/dsh-superagent` configured it (tools/mobilegw reads the same two variables).
 * The panel needs it to link a crew conversation: the queue itself has no address of its own.
 */
const GATEWAY = { host: process.env.MOBILEGW_HOST ?? '127.0.0.1', port: process.env.MOBILEGW_PORT ?? '8788',
  secure: process.env.MOBILEGW_SECURE === '1' }

/**
 * Composition root of dsh-superagent that connects `Store`, `Setup`, `Engine`, `SourceRegistry`, `Effects`, `Outbox`, `Passes`, `Sessions`, `Settings`, `Prompts`, `DshExecutor`, and `MasterAssessor`.
 * Exposes the `SourceHost` service on the Cordis context for source plugins and coordinates startup, setup checks, HTTP route registration, and graceful shutdown.
 * Locks the state directory before opening SQLite so concurrent processes cannot corrupt or double-migrate state.
 */
export class Runtime extends Service implements SourceHost {
  readonly store: Store
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: Sessions
  readonly settings: Settings
  readonly executor: DshExecutor
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  /** 记忆层：谁写、谁读、什么时候写（见 `memory-layer.ts`）。 */
  readonly memory: MemoryLayer
  readonly ready: Promise<void>
  /**
   * DSH 的会话表，手机端的「子代理」卡片靠它从 worker 会话往下展开。
   *
   * 这是 `ctx.agents` 的引用而不是我们自己的一份：会话的创建与销毁都由 DSH 掌管，
   * 抄一份就会在会话重启后指向已经作废的对象。手机那条路按 `runtime.agents` 读它，
   * 少了这个字段只会得到一句「读不到会话树」，看不出是插件根本没有把它摆出来。
   */
  readonly agents: Context['agents']
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  readonly masterId: string
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly disposers: (() => void)[] = []
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  /** 待命期间重跑 setup 的定时器；关掉 runtime 时必须清掉，否则会对着已释放的锁再跑一次。 */
  private setupRetry?: ReturnType<typeof setTimeout>
  private stopping?: Promise<void>
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  constructor(ctx: Context, readonly machine: Machine, restart: () => void) {
    super(ctx, 'orchestrator')
    const runtime = this
    // `ctx` 不是参数属性，字段初始化时还看不到它，所以在构造器里接一次。
    this.agents = ctx.agents
    // Lock the state directory before opening the database so another process cannot migrate or write concurrently.
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    const release = lockSync(machine.stateDir, { stale: 30_000, onCompromised: compromised })
    this.releaseLock = async () => { release() }
    let opened: Store | undefined
    try {
      const report = (error: unknown) => { ctx.logger.warn('dsh-superagent: %s', String(error)) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      const setup = this.setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart })
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const feishu = () => setup.configured() && !!setup.deployment.feishu
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu)
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.masterId, masterId)
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      const board = this.board
      const effects = this.effects = new Effects(store, board)
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // Sync source member lists once startup completes when a source plugin loads dynamically.
        if (kind.policy?.sync) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() records its failure in health. */ })
        return () => {}
      })
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands, masterId, context: ctx,
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'), masterId,
        lifetime: this.lifetime,
        closing: () => this.closing(), environment,
        tools: (agent, ticket) => ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, agent) })
      // 记忆层要在执行器之前建：执行器的 launch 会问它要一小片召回。
      this.memory = new MemoryLayer({ store, bots: () => (store.settings().sources?.team?.config as { bots?: { bot_id?: string }[] } | undefined)?.bots
        ?.flatMap(bot => bot.bot_id ? [bot.bot_id] : []) ?? [] })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      this.executor = new DshExecutor({ context: ctx, get engine() { return runtime.engine }, store, effects, health: board.claim('worker'), machine,
        lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.paused(), environment, sourceLink: link,
        repliedTo: trigger => repliedTo({ store, sources }, trigger),
        recall: (ticket, query) => this.memory.recall(ticket, query) })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, paused: () => this.paused(),
        // A worker cannot open a ticket, so when it names a teammate in its reply the host opens one here, on the
        // same request, addressed to that bot. Reading the roster at call time keeps a settings change immediate.
        handoff: (request) => this.handOff(request.from, request.bot_id, request.text, request.ticket) })
      const { assessor, executor } = this
      const policy = () => settingsPolicy(store.settings(), sources)
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor,
        outbox, prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome), emit: event => {
          // 评估结果一律记一行。它平时是静默的：决策只在内存里广播一次，没人在听的时候就消失了。
          // 于是「队伍为什么不接这活」在运行时看不见 —— 事后只能翻数据库，而那时上下文已经没了。
          // 用 console 而不是 ctx.logger：宿主的 logger 收进了它自己的频道，不在这个进程的日志文件里。
          if (event.type === 'decision.recorded') {
            const decision = store.decisions.get(event.data.decisionId)
            console.log('[eval] kind=%s reason=%s thread=%s ticket=%s',
              String(decision?.kind ?? event.data.kind),
              JSON.stringify(decision?.reason ?? '-'),
              String(event.data.threadKey),
              String(decision?.ticketId ?? '-'))
          }
          // 主人说的「定下来的规矩」当场记一条。放在同一个 emit 里：这里是所有 Trigger 的唯一入口，
          // 记忆层将来要加别的来源（比如某个 Source 自己的结论）也只挂在这一处。
          if (event.type === 'trigger.received') {
            const received = store.triggers.get(event.data.triggerId)
            if (received?.human) { try { this.memory.hear(received) } catch (error) { console.log('[memory] settle failed: %s', String(error)) } }
          }
          // 一票收尾：把结论记一条（只记 ready / dropped，过程不进账本）。
          if (event.type === 'ticket.ended') {
            const done = store.tickets.get(event.data.ticketId)
            if (done) { try { this.memory.close(done) } catch (error) { console.log('[memory] settle failed: %s', String(error)) } }
          }
          // Notify the main Session only about domain events it did not initiate itself.
          const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction,
          // and of one for an ended ticket once it resumes, unless it routed the message there itself.
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
          const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
          if (followup) sessions.relay(followup.id, followup.text)
          // Notify the ticket's conversations whenever it ends via a pull request.
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          if (ended && setup.configured()) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            for (const message of pullEndNotices(ended, request, setup.deployment.repository)) outbox.send(message)
          }
          // A handoff opened a ticket in another bot's name, so its work would otherwise finish where the person who
          // asked cannot see it: they were told "handed to the writer" and nothing else arrives. Send the report to
          // the conversation the handoff came from, under the bot that did the work.
          const handoffReply = ended ? handoffEndNotice(ended, store.triggers.get(ended.origin.triggerId)) : undefined
          if (handoffReply) outbox.send(handoffReply)
          // 桥接产生的 worker 会话不是人开的对话：它是这台机器替主人干活的过程记录。留在 DSH 的会话列表里
          // 就变成「每跑一个活多一条」，把主人自己开的会话顶下去。工单结束就归档 —— 归档不删记录，
          // 桌面端「看它的屏幕」和手机时间线都是直接读会话，不受影响；DSH 列表里只留人自己开的会话。
          const archiving = ctx.workspaceRegistry.archiveSession
          if (event.type === 'ticket.ended' && typeof archiving === 'function') {
            void archiving.call(ctx.workspaceRegistry, workerSessionId(event.data.ticketId) as SessionId, { stopActivity: true })
              .catch(() => undefined)
          }
        } })
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing() })
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, receive: trigger => passes.receive(trigger) }
      this.toolHost = { context: ctx, engine, store, prompts, sessions, settings: this.settings, assessor, resources,
        // The tool hands off on behalf of the ticket it belongs to, taking that ticket's own channel: no reply exists
        // yet at the moment it decides to pass the work on.
        handOffFor: (ticket: Ticket, bot_id: string, text: string) => ticket.channels[0] === undefined ? false
          : this.handOff({ id: ticket.id, channel: ticket.channels[0] }, bot_id, text, ticket),
        // A note to a crew mate carries no reply of its own: the tool is the worker saying one thing to another worker.
        messageTeammate: (ticket: Ticket, bot_id: string, text: string) => this.messageTeammate(ticket, bot_id, text),
        // The crew the tool offers, read per call so a settings change applies without a restart.
        get crew() {
          const config = store.settings().sources?.team?.config as { bots?: { bot_id?: string; name?: string }[] } | undefined
          return (config?.bots ?? []).flatMap(bot => bot.bot_id && bot.name ? [{ bot_id: bot.bot_id, name: bot.name }] : [])
        },
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      this.ready = this.initialize()
    } catch (error) {
      // Release the database and state lock if initialization fails so an in-process restart can reacquire them.
      try { opened?.close() } finally { release() }
      throw error
    }
  }
  /**
   * Open a ticket for the bot a worker named, either in a handoff line of its reply or through the handoff tool.
   *
   * A worker cannot route: routing belongs to the main Session, and a second scheduler on one ledger would be a
   * different program. So the host reads the bot's name out of what the worker produced and opens the ticket here,
   * on the same request. An id the roster does not hold is dropped rather than guessed at, so work is never filed
   * under a bot that does not exist.
   */
  /**
   * 插队：把一句排队中的话直接交给正在跑的 worker，它在下一步边界先读到。
   * 不中断当前命令；工单已经结束/不存在时返回 false，调用方据此回 409。
   */
  async steer(ticketId: string, requestId: string, text: string): Promise<boolean> {
    const ticket = this.store.tickets.get(ticketId)
    if (!ticket || ticket.ended || !liveTicket(ticket)) return false
    const note = `主人插话（请优先处理，当前步骤做完后立刻回应）：${text}`
    await this.sessions.prompt(workerSessionId(ticketId), key('crew-steer', ticketId, requestId), note, 'steer')
    return true
  }

  /**
   * 「看它的屏幕」：把这张工单的 worker 会话整理成活动快照；读不到就说读不到。
   *
   * 三样一起给，手机才画得出实景而不是一串日志：
   * - 会话活动（`events`）：先从活的会话读（`inspect`），读不到再读会话持久化的存档 ——
   *   进程重启过、或者这张票的 worker 已经归档，屏幕上仍然有东西可看；
   * - 阶段与开工时间（`stage` / `since`）：从工单记录里读，不猜；
   * - 工作目录：票上的执行目录。
   *
   * 三样都读不到时，`screenOf` 会给出那句真实的 reason；这里不编。
   */
  async screen(ticketId: string): Promise<ScreenSnapshot> {
    const id = ticketId.trim()
    if (!id) return screenOf({})
    const ticket = this.store.tickets.get(id)
    if (!ticket) return screenOf({ ticketId: id, known: false })
    // 阶段机读不懂的票不该让整个读屏失败：阶段缺着，行照样给。
    let stage: string | undefined
    try { stage = ticketStage(ticket).stage } catch { stage = undefined }
    const since = runningAssignment(ticket)?.startedAt
    let events: ScreenEvent[]
    try { events = await this.screenEvents(id) }
    catch { return { state: 'unavailable', ticket_id: id, ...(stage ? { stage } : {}), reason: '这张工单的 worker 会话读不出来' } }
    return screenOf({ ticketId: id, events, cwd: ticket.execution?.directory, stage, since })
  }
  /**
   * 一张工单的 worker 会话事件：先问活着的会话，再退回磁盘上的存档。
   *
   * 两道都读不到时抛错，让调用方回一句「读不出来」——不能把「读不到」说成「没有记录」。
   */
  private async screenEvents(ticketId: string): Promise<ScreenEvent[]> {
    const sessionId = workerSessionId(ticketId) as SessionId
    try {
      const { events } = await this.ctx.sessionController.inspect(sessionId)
      if (events.length > 0) return events as unknown as ScreenEvent[]
    } catch { /* 会话已经不在了：下面读存档。 */ }
    await this.ctx.sessionPersistence.flush().catch(() => undefined)
    await using handle = await this.ctx.sessionPersistence.open(sessionId, 'read')
    const events: ScreenEvent[] = []
    // 存档是分页读的：一直读到空页为止，不假定一页能装完。
    for (let offset = 0; ; ) {
      const page = await handle.read(offset, 512)
      if (page.events.length === 0) break
      events.push(...page.events as unknown as ScreenEvent[])
      offset += page.events.length
    }
    return events
  }

  /**
   * 「产出」：把若干张工单交出来的文件合成一栏。
   *
   * 数据源只有一个 —— 每张票 worker 会话的事件流里 write / edit 写过哪些文件。
   * 一张票的会话读不出来（结束了、被回收了）就是那一条读不出来，不让整栏报错；
   * 全读不出来时 `outputsView` 会说 `unavailable`，而不是「没有产出」。
   */
  async outputs(tickets: readonly OutputsTicket[]): Promise<OutputsView> {
    return outputsView(tickets, async ticketId => {
      const { events } = await this.ctx.sessionController.inspect(workerSessionId(ticketId) as SessionId)
      return events as unknown as OutputEvent[]
    })
  }

  /**
   * 「常规任务」：把账本合成一栏。
   *
   * 数据源是 KV 里 `routines` 那一族（前缀见 `kv.ts`），不是会话事件、也不新开一张表：
   * 这是主人自己写下的账，跟工单不一样，工单没了账还在。
   * 账本读不出来（数据库打不开）就是 `unavailable`，不是「没有常规任务」。
   */
  /**
   * 「记忆」：主人的长期账本，可以看、改、忘。
   *
   * 与 `routines` 同一套三态：读不到说读不到，不说「没有记忆」。
   */
  async memories(options: { bot?: string } = {}): Promise<MemoryView> {
    return memoryView(() => this.memory.ledger.all(), options)
  }
  /** 忘掉一条：翻状态，不删行。 */
  forgetMemory(name: string): boolean { return this.memory.ledger.forget(name) }
  /** 改一条的正文 / 描述 / 重要性。 */
  editMemory(name: string, patch: { description?: string; body?: string; importance?: number }): boolean {
    return this.memory.ledger.edit(name, patch)
  }
  async routines(): Promise<RoutinesView> {
    return routinesView(() => this.store.keys(KV.routines.task).flatMap(name => {
      const record = this.store.get(name)
      return record === undefined ? [] : [record]
    }))
  }

  handOff(from: Pick<OutboundMessage, 'id' | 'channel'>, bot_id: string, text: string, origin?: Ticket): boolean {
    const { store } = this
    // Whose request this really is: the actor whose trigger opened the ticket being handed off.
    const actor = origin?.mandate.actor ?? { source: 'team', id: 'handoff' }
    const config = store.settings().sources?.team?.config as { bots?: { bot_id?: string }[] } | undefined
    const known = (config?.bots ?? []).some(bot => bot.bot_id === bot_id)
    if (!known) return false
    const address = from.channel.source === 'team' ? from.channel.address as { conversation?: unknown } : undefined
    const conversation = typeof address?.conversation === 'string' ? address.conversation : 'main'
    // A fresh message id and thread: reusing the source message's would let intake find the ticket it already made
    // and attach this handoff to that one, where the reply signs as the bot that answered first. A handoff is its
    // own turn with its own recipient.
    // The message the person actually sent, taken from the ticket's own origin, so the answer lands under it.
    const originTriggerId = origin?.origin?.triggerId
    const personMessage = originTriggerId === undefined ? undefined
      : String(store.triggers.get(originTriggerId)?.meta?.messageId ?? '') || undefined
    // 同名（同一 ticket、同一 bot）的第二次 handoff 不能撞上第一次的 message id：engine 会把
    // 它当成重复消息丢掉，工具却回 handed_off:false。文本变了就是新的一次交接；同一段文本
    // 重发仍然幂等，摘要相同。
    const digest = createHash('sha256').update(text).digest('hex').slice(0, 8)
    const messageId = `handoff-${from.id}-${bot_id}-${digest}`
    const thread = `team:handoff:${conversation}:${messageId}`
    const trigger: Trigger = {
      id: key('team', messageId),
      source: 'team',
      threads: [{ source: 'team', id: thread }],
      // A handoff carries a person's own request to the bot that should do it, so it is human work from that
      // person: marking it machine-made made the engine ignore it as `not_human`, and an invented actor id made
      // Policy refuse it as `not_a_member`. `meta.handoff_from` still records which bot passed it along.
      // The person the work came from, taken from the ticket's mandate: the reply carries no actor, and an invented
      // id is refused by Policy as `not_a_member`.
      actor,
      human: true,
      addressed: 'mention',
      at: new Date().toISOString(),
      text,
      channel: { source: 'team', thread, address: { conversation, message: messageId, bot_id } },
      meta: { conversation, messageId, root: messageId, bot_id,
        handoff_from: from.channel.address.bot_id, handoff_of: from.id,
        // The person's own message, which the answer belongs under: `handoff_of` is the bot reply that named the
        // crew mate, and the conversation is keyed by the message the person sent.
        ...(personMessage === undefined ? {} : { handoff_for: personMessage }) },
    }
    try {
      // `true` only when the engine actually took it: a trigger the source is not listening to is stored as
      // `filtered`, and reporting that as a handover would tell the worker the work is moving when it is not.
      // A duplicate that was not filtered is the same handover sent again: the first one was taken, so
      // answering false here told the worker its handover failed when it had already gone through.
      const result = this.engine.receive(trigger)
      return result === 'stored' || (result === 'duplicate' && !this.store.triggers.disposition(trigger.id)?.filtered)
    } catch { return false }
  }
  /**
   * Pass one note from a worker to a crew mate already running a ticket of its own, without opening anything.
   *
   * The note is a message, not work: the mate's ticket, mandate and reply stay as they are, so the only thing this can do is
   * inform what that bot is already doing. Nothing here routes, so the engine and its ledger stay untouched. Delivery goes
   * through the worker Session's own inbox (`steer`): a busy worker reads it at its next step boundary, an idle one starts a
   * turn for it, which is what "tell them this" means either way.
   */
  async messageTeammate(ticket: Ticket, bot_id: string, text: string): Promise<{ delivered: boolean; reason?: string }> {
    const target = teammateTicket(this.store.tickets.list(), bot_id)
    if (!target) return { delivered: false, reason: 'no_live_ticket' }
    const hop = crewHop(this.store, ticket.id) + 1
    // A chain of bots writing to each other has no natural end: every note is a reason for a reply. Refuse once the
    // receiving ticket is already this deep, so a pair that has nothing left to say cannot say it forever.
    if (crewHop(this.store, target.id) >= CREW_HOP_LIMIT) return { delivered: false, reason: 'hop_limit' }
    this.store.set(KV.crew.hop(target.id), Math.max(hop, crewHop(this.store, target.id)))
    // The marker is a suffix on its own line: a worker skimming the note reads the request first, and the line still names
    // who wrote it and how far the thread has travelled, which is the part it needs to answer rather than relay onward.
    const from = String(ticket.channels[0]?.address.bot_id ?? 'a crew mate')
    const note = `${text}\n\n[crew note from ${from}, hop ${hop}${hop >= CREW_HOP_LIMIT ? ' of ' + CREW_HOP_LIMIT : ''}]`
    // Deterministic on the sender, the recipient and the words: a retried call delivers once, and the same note worded again
    // is the same note, while any change of content is a new message.
    await this.sessions.prompt(workerSessionId(target.id), key('crew-msg', ticket.id, bot_id, text), note, 'steer')
    return { delivered: true }
  }
  get health(): Readonly<Record<string, Health>> { return this.board.all }
  /** Aborted when dsh-superagent stops or loses its state directory lock, cancelling running reads and subprocesses. */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  /** Resolved deployment; throws while waiting for setup (`!configured()`). */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem }
  /** Why the Feishu bot is unavailable even though the Feishu Source configures a CLI. */
  get feishuProblem(): SetupProblem | undefined { return this.setup.feishuProblem }
  links(): LinkTarget {
    const resolved = this.setup.configured() ? this.setup.deployment : undefined
    const links = { ...resolved ? { repository: resolved.repository, ...(resolved.feishu ? { feishu: resolved.feishu } : {}) } : {},
      gateway: GATEWAY }
    return channel => this.sources.link(channel, links)
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    const { setup: { deployment }, sources } = this
    return ticketEnvironment({ deployment, sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  checkSetup(): void { this.setup.check() }
  /** What the crew could switch to. The phone and the desktop both need this before they can offer a choice. */
  models(): ReturnType<HttpHost['models']> { return this.ctx.sessionController.modelCatalog() }
  /** 一条 provider/model 路由支持哪些推理档位，按适配器现查；没有就是没有，不编一列。 */
  async efforts(provider: string, model: string): Promise<{ efforts: { id: string; name: string; description?: string }[]; default?: string }> {
    const info = await this.ctx.llm.resolveModelInfo(provider, model)
    const efforts = (info.reasoning?.efforts ?? []).map(effort => ({
      id: String(effort.id), name: effort.name,
      ...(effort.description ? { description: effort.description } : {}),
    }))
    return { efforts, ...(info.reasoning?.defaultEffort ? { default: String(info.reasoning.defaultEffort) } : {}) }
  }
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> { return this.passes.pump() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  private paused(): boolean { return !this.setup.configured() || this.store.settings().paused }
  private async initialize(): Promise<void> {
    // Register management HTTP routes before setup completes so operators can fix setup problems in the UI.
    // Only once: a retry re-runs setup, not the routes (a second registration would collide).
    this.disposers.push(registerHttp(this.ctx, this.httpHost()))
    await this.finishSetup()
  }
  /**
   * Run setup and, once it holds, start the loops.
   *
   * Setup fails for reasons that repair themselves: a proxy that is down, a CLI being re-authenticated, a repository
   * that just became readable. Until this could be retried, the crew stayed paused until someone restarted it by hand,
   * so a short outage looked like a stopped product. The retry only recovers a pending crew — it never takes a working
   * one down — and stops on its own once setup holds or the runtime closes.
   */
  private async finishSetup(): Promise<void> {
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      this.retrySetup()
      return
    }
    this.sessions.install()
    this.executor.install()
    await this.sessions.ensure(this.masterId, this.machine.stateDir, 'dsh-superagent orchestrator', 'orchestrator')
    await this.archiveFinishedWorkers()
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    // If stop() was called while awaiting setup, session creation, or policy sync, do not start background loops.
    if (this.closing()) return
    this.executor.resume()
    this.passes.start()
    this.effects.start()
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
  }
  /**
   * Archives worker Sessions this crew left behind, so the DSH chat list holds only the person's own sessions.
   *
   * 工单结束时那条归档调用只覆盖「边跑边结束」的情况。进程重启、崩溃、或同一份 `workspace.json`
   * 被别的宿主整文件覆写过之后，收尾那一下会丢：会话还在磁盘上，归档集合里却没有它，于是它
   * 又冒回列表。这里在每次启动收尾时补一遍，分两类：
   * - 有工单记录、且已结束：直接按票号推会话号；
   * - 没有工单记录的孤儿（工单表被清过、或换了 stateDir 的老队伍）：扫自己执行目录下的
   *   `worker-*` 会话。只认本队执行根目录，别处的一概不碰。
   * 已经归档过的 id 会被 registry 直接跳过，重复调用是安全的。
   */
  private async archiveFinishedWorkers(): Promise<void> {
    const archiving = this.ctx.workspaceRegistry.archiveSession
    if (typeof archiving !== 'function') return
    // 归档失败不能挡住启动（少隐藏一条会话，队伍照常干活），但也不能像从前那样静默吞掉：
    // 这条 .catch 曾经把「归档从来没成功过」藏了一个月，没人看得出来。
    const archive = (sessionId: string): Promise<void> =>
      archiving.call(this.ctx.workspaceRegistry, sessionId as SessionId, { stopActivity: true })
        .catch((error: unknown) => { this.ctx.logger.warn('dsh-superagent could not archive worker Session %s: %s', sessionId, String(error)) })
    for (const ticket of this.store.tickets.list()) {
      if (ticket.ended !== undefined) await archive(workerSessionId(ticket.id))
    }
    // 孤儿：本队执行根目录（默认 <stateDir>/work）下、没有工单记录的 worker 会话。
    const root = executionRoot(this.store.settings(), this.machine.stateDir)
    const listed = new Set(this.store.tickets.list().map(ticket => workerSessionId(ticket.id)))
    for (const workspace of this.ctx.workspaceRegistry.list()) {
      if (workspace.path !== root) continue
      for (const sessionId of workspace.sessionIds) {
        if (!sessionId.startsWith('worker-') || listed.has(sessionId)) continue
        await archive(sessionId)
      }
    }
  }
  /** Retry a pending setup on a short timer; each failure schedules the next. */
  private retrySetup(delay = 5_000): void {
    if (this.closing()) return
    this.setupRetry = setTimeout(() => {
      this.setupRetry = undefined
      if (this.closing()) return
      void this.finishSetup().catch(error => {
        this.runtimeHealth.set({ state: 'error', detail: String(error), at: now() })
      })
    }, delay)
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks, setup, passes } = this
    return { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks,
      get deployment() { return setup.deployment },
      get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, models: () => runtime.models() }
  }
  /** Idempotent stop; concurrent or repeated calls share the same shutdown promise. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true
    if (this.setupRetry !== undefined) { clearTimeout(this.setupRetry); this.setupRetry = undefined }
    const passes = this.passes.stop(); this.stopped.abort()
    try {
      this.assessor.stop()
      const ids = [this.masterId, ...this.store.tickets.list().map(ticket => workerSessionId(ticket.id))]
      const agents = ids.map(id => this.ctx.agents.get(id as SessionId)).filter((agent): agent is Agent => agent !== undefined)
      for (const agent of agents) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled([passes, this.effects.drain(), ...agents.map(agent => agent.whenIdle())])
      // The workers' jobs and subagents stop too: their ends would start worker turns without the tool limits released below.
      await this.executor.shutdown()
      this.executor.dispose()
      this.sessions.dispose()
      for (const dispose of this.disposers.reverse()) dispose()
      await this.ctx.sessionPersistence.flush()
    } finally {
      // Close the database before releasing the directory lock so another process cannot open the database mid-write; a compromised lock may already be released.
      this.setup.restore()
      try { this.store.close() } finally {
        const unreleased = (error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release its state directory lock: %s',
          String(error)) }
        await this.releaseLock?.().catch(unreleased)
      }
    }
  }
}
