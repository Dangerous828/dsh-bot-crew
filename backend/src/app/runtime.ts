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
import { Engine, key, liveTicket, reasonText, runningAssignment, threadKey, ticketStage, type EngineForSettings, type OutboundMessage, type ReceiveResult,
  type Ticket, type Trigger, type AssessmentOutcome } from '../core/index.ts'
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
import { buildRoutine, editRoutine, routinesView, routineItemOf, newRoutineId, type RoutineRecord, type RoutinesView } from './routines.ts'
import { advance, dueOf, routineMessage, TICK_MS } from './routine-runner.ts'
import { followupsOf, followupText } from './followup.ts'
import { spendOf, spendSteps, type Spend, type SpendEvent } from './spend.ts'
import { auditOf, type AuditRow } from './audit.ts'
import { transcribe as transcribeAudio, type SpeechHost, type Transcript } from './voice.ts'
import { summaryFact, worthRemembering, type CompactionSummaryEvent } from './compact-memory.ts'
import { deliver, PushOutbox, type PushMessage, type PushOutcome } from './push.ts'
import { dailyDue, dailyNotice, pushFor, type Notice, type PushRecipient } from './notices-out.ts'
import { approvalOf, approvalPrompt, readAnswer, type ApprovalDecision } from './approval.ts'
import { quotaOf, quotaWarning, replySpendOf, type Quota, type ReplySpend } from './quota.ts'
import { allowedTools, connectionsOf, judgeCall, KIND_NAME, type ConnectionVerdict } from './connections.ts'
import { speak as speakText, systemSpeakHost, DEFAULT_VOICE, type SpeakOutcome, type SpeakHost } from './speech.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { Store } from './store.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { Prompts } from './prompts.ts'
import { registerHttp, type HttpHost } from './http.ts'
import { threadTitle, type LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { handoffEndNotice } from './notices.ts'
import { HealthBoard, type HealthEntry } from '../infra/health.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Setup } from './setup.ts'
import { feishuSettings } from '../sources/feishu.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import { Sessions } from './sessions.ts'
import { checkRoleRoutes, type RoutedModel } from './role-models.ts'
import { Settings } from './settings.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'
import { MemoryLayer } from './memory-layer.ts'
import { HubProbe, LocalMemory, pickMemoryPort } from '../memory/detect.ts'
import { RuleDistiller, type Distiller } from '../memory/distill.ts'
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

/** 一条看门狗告警：何时、什么事、给谁看的一句话，以及对应的 decision id（去重/追查用）。 */
export interface WatchdogAlert { at: string; kind: string; title: string; body: string; decisionId: string }
/** 看门狗对外快照：最近几条告警 + 上次真重排过的自愈时刻（证明它是活的）。 */
export interface WatchdogStatus { alerts: WatchdogAlert[]; lastSelfHealAt?: string }

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
  /** 记忆中枢可达性探测（供记忆层分叉与设置保存后刷新）。 */
  memoryProbe?: HubProbe
  /** 睡眠期提炼器（默认规则版；中枢或装了便宜模型时可替换为 LLM 版）。 */
  private readonly distiller: Distiller = new RuleDistiller()
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
  /** 待发件箱：手机离线时留件，连上来的第一时间补发。 */
  private readonly pushOutbox = new PushOutbox()
  /**
   * 经隧道送一条推送的那只手，由 `index.ts` 在隧道建好后注入。
   *
   * 为什么是回调而不是直接持有 tunnel：隧道是 index 层的接线（它要读环境变量、要管降级链），
   * Runtime 不该知道中转地址长什么样。而且 `runtime` 先于隧道构造，晚一步注入才不会绕成环。
   */
  private pusher?: (message: PushMessage) => boolean
  /** 今天报过日报没有（`YYYY-MM-DD`），同一天只说一次。 */
  private dailySaid = ''
  /** 今天派出去的常规任务次数（日报用）。 */
  private routinesToday = 0
  /** 会话压缩的监听只挂一次；挂不上（老宿主）时也不会每轮重试。 */
  private compactionWatch = false
  /** 常规任务的调度器；`start` 之后才有，`stop` 时清掉（`routines()` 据此说 runner 是 live 还是 none）。 */
  // 看门狗告警账本：超时未决定这类「卡住」事件各记一条，桌面/管理面读它显示横幅。
  // 与 pushNotice 无关——即使 App 的独立系统推送停了，这条账本也一定写在 /state 上（#8-2）。
  private readonly watchdogAlerts: { at: string; kind: string; title: string; body: string; decisionId: string }[] = []
  private routineTimer?: ReturnType<typeof setInterval>
  // 上次 tick 的时刻。Mac 睡眠时 setInterval 也停摆，醒来后第一次 tick 会明显晚于 TICK_MS；
  // 用它判断「是不是睡过头了」，睡过就先补扫一次自愈，别让停机窗口里的卡死没人管（#8-4）。
  private lastTickAt?: number
  // 上次真正重排过一条决策的自愈时刻，供 watchdogStatus 展示「看门狗是活的」。
  private lastSelfHealAt?: string
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
        guardConnection: (ticketId, name, args) => this.guardConnection(ticketId, name, args),
        tools: (agent, ticket) => ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, agent) })
      // 记忆层要在执行器之前建：执行器的 launch 会问它要一小片召回。
      // 记忆中枢：按设置里的 memory.hub 探测决定走中枢版还是本机版；两版共用同一个本机账本。
      // 允许环境变量 DSH_SUPERAGENT_MEMORY_HUB 兜底：设置里没填时用它，省去先开面板。
      const memorySettings = store.settings().memory
      const envHub = (process.env.DSH_SUPERAGENT_MEMORY_HUB ?? '').trim()
      const memoryHub = memorySettings.hub || (/^https?:\/\//.test(envHub) ? envHub : '')
      const memoryProbe = new HubProbe({ hub: memoryHub, timeoutMs: memorySettings.timeoutMs,
        log: line => console.log(line) })
      const localMemory = new LocalMemory({ store, bots: () => (store.settings().sources?.team?.config as { bots?: { bot_id?: string }[] } | undefined)?.bots
        ?.flatMap(bot => bot.bot_id ? [bot.bot_id] : []) ?? [],
        // 睡眠期提炼：默认规则版（零模型、可回查）；接中枢或便宜模型时换成 LLM 版。
        distill: (text, at) => this.distiller.distill(text, at),
        // 原始料：窗口内人写的 Trigger，按时间正序。
        episodic: range => store.read.episodicRange(range) })
      this.memoryProbe = memoryProbe
      void memoryProbe.refresh().catch(() => undefined)
      this.memory = new MemoryLayer({
        store,
        bots: () => (store.settings().sources?.team?.config as { bots?: { bot_id?: string }[] } | undefined)?.bots
          ?.flatMap(bot => bot.bot_id ? [bot.bot_id] : []) ?? [],
        port: pickMemoryPort(localMemory, memoryProbe) })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => {
        for (const ticket of store.tickets.open()) {
          if (ticket.pendingApproval?.kind !== 'connection' || ticket.pendingApproval.status !== 'approved') continue
          delete ticket.pendingApproval
          store.tickets.save(ticket)
        }
        this.engine.policyChanged(from, to, effects)
      }
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
        outbox, prepareTicket: (ticket, outcome) => this.prepareWithApproval(executor.prepare(ticket, outcome), outcome), emit: event => {
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
            // 评估静默失败要出声。`unavailable` 里有两种不同的事：
            // 判官说「现在别接」是一种正常裁决（不出声）；超时三次、判官没给出意见是
            // 「这活没人判」（#4 那类静默卡死），必须让人知道 —— 否则请求就这么消失，
            // 界面上看不到任何痕迹。这里给主 Session 递一条、推一条手机通知，
            // 与 followup / routine 同一条出口；按 decision id 去重，同一件事只说一次。
            const timedOut = decision?.kind === 'unavailable' && event.data.kind === 'unavailable'
              && (decision.reason ?? []).some(reason => reason.code === 'timeout')
            if (timedOut) {
              const thread = store.threads.get(event.data.threadKey)
              const title = thread ? threadTitle(store, thread) : event.data.threadKey
              const text = `评估超时未决定：「${title}」这条请求连续超时仍未得到判断，队伍没有接下它。可以重发，或到面板看这一条。`
              sessions.relay(key('eval-timeout', decision.id), JSON.stringify({ kind: 'eval_timeout', thread: event.data.threadKey, text }))
              // 账本先写：这是「一定送达」的那条链——桌面右栏与管理面 /state 都读它，
              // 不依赖 App 的独立系统推送（那条用户已停）。pushNotice 只作手机在线时的加送。
              this.watchdogAlerts.unshift({ at: now(), kind: 'eval_timeout', title: '有一件事没判下来',
                body: `「${title}」评估超时，队伍没有接。`, decisionId: decision.id })
              if (this.watchdogAlerts.length > 50) this.watchdogAlerts.length = 50
              this.pushNotice({ title: '有一件事没判下来', body: `「${title}」评估超时，队伍没有接。`, kind: 'followup' })
            }
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
            if (done) { try { this.memory.close(done) } catch (error) { console.log('[memory] settle failed: %s', String(error)) }
              // 睡眠期巩固的触发点：一票结束时顺手整理最近一天的原始对话（异步、不阻塞关闭）。
              void this.memory.consolidate({ since: Math.floor(Date.now() / 1000) - 24 * 60 * 60 })
                .catch(error => console.log('[memory] consolidate failed: %s', String(error))) }
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
      const passes = this.passes = new Passes({ engine: { receive: trigger => this.approvalReply(trigger) ?? engine.receive(trigger), evaluateDue }, effects,
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
  /**
   * 新建 / 修改 / 删除一条常规任务（手机端可写，契约 §5.5）。
   *
   * 只写 `routines` 前缀下的 KV，与读侧同一本账。id 由服务端生成，客户端不能自造 id
   * （否则能覆写别的键）。返回 `{ok, record}` 或 `{ok:false, reason}` —— 原因给一句人话，
   * 不把 zod/内部错误漏上屏。
   */
  writeRoutine(action: 'create' | 'edit' | 'remove', input: { id?: string; title?: string; cycle?: string; bot_id?: string; enabled?: boolean }): { ok: boolean; record?: RoutineRecord; reason?: string } {
    if (action === 'remove') {
      const id = typeof input.id === 'string' ? input.id.trim() : ''
      if (!id) return { ok: false, reason: 'id is required' }
      if (!this.store.get(KV.routines.task(id))) return { ok: false, reason: 'no such routine' }
      this.store.delete(KV.routines.task(id))
      return { ok: true }
    }
    if (action === 'create') {
      const built = buildRoutine(input, newRoutineId())
      if (!built.ok) return { ok: false, reason: built.reason }
      this.store.set(KV.routines.task(built.record.id), built.record)
      return { ok: true, record: built.record }
    }
    // edit
    const id = typeof input.id === 'string' ? input.id.trim() : ''
    if (!id) return { ok: false, reason: 'id is required' }
    const current = this.store.get(KV.routines.task(id))
    if (!current) return { ok: false, reason: 'no such routine' }
    const edited = editRoutine(current, input)
    if (!edited.ok) return { ok: false, reason: edited.reason }
    this.store.set(KV.routines.task(id), edited.record)
    return { ok: true, record: edited.record }
  }

  async routines(): Promise<RoutinesView> {
    return routinesView(() => this.store.keys(KV.routines.task).flatMap(name => {
      const record = this.store.get(name)
      return record === undefined ? [] : [record]
    }), Date.now(), this.routineTimer ? 'live' : 'none')
  }

  /**
   * 走一遍「常规任务」的账本：到点的派出去，逾期的只记一次提醒。
   *
   * 派单不另开派单器：`Engine.receive` 就是手机发消息走的那一条路，
   * 所以到点派出来的活和主人亲手发的活在同一本账上（票、裁决、回复都在）。
   *
   * 不派的情况两种，都不改 `last_run` —— 没跑成就不能记成跑过：
   * - 队伍暂停（`paused()`）：原因 `paused`；
   * - 这条没指定 Bot，且队伍一个人都没有：原因 `no_recipient`。
   */
  /**
   * 看门狗的自愈那一半：把「因评估超时而静默停在账上」的决策捡回来重跑一轮。
   *
   * 只看最近一小时、kind 为 unavailable、原因是 timeout、且还没被自愈过的决策；每条给一次机会
   * （由 `healed` 标记保证有界）。判官说「现在别接」的 unavailable 不在此列 —— 那是正常裁决。
   *
   * 进程若在「已经重排队、还没醒来跑」之间重启，下一次 tick 会看到这些 Trigger 已标 healed、遂跳过，
   * 由那一轮 Eval 自己跑完，不会重复重排。
   *
   * @returns 真正被捡回来重跑的决策 id。
   */
  async runSelfHeal(now = Date.now(), options: { catchUpMs?: number } = {}): Promise<string[]> {
    if (this.paused()) return []
    // 默认扫最近一小时；醒来补扫时按实际停机时长扩大窗口，把睡过头那段时间里超时的也捞回来。
    const windowMs = Math.max(3_600_000, options.catchUpMs ?? 0)
    const since = new Date(now - windowMs).toISOString()
    const healed: string[] = []
    for (const decision of this.store.read.decisionsOfKinds(['unavailable'], 200)) {
      if (decision.at < since) continue
      if (!(decision.reason ?? []).some(reason => reason.code === 'timeout')) continue
      try {
        if (this.engine.recoverExpiredDecision(decision.id)) {
          healed.push(decision.id)
          this.lastSelfHealAt = new Date(now).toISOString()
          console.log('[selfheal] requeued decision=%s thread=%s', decision.id, decision.threadKey)
        }
      } catch (error) { console.log('[selfheal] failed decision=%s error=%s', decision.id, String(error)) }
    }
    return healed
  }

  async runRoutines(now = Date.now()): Promise<{ dispatched: string[]; held: string[] }> {
    const tasks = this.store.keys(KV.routines.task).flatMap(name => {
      const item = routineItemOf(this.store.get(name), now)
      return item ? [item] : []
    })
    const due = dueOf(tasks, now)
    if (!due.length) return { dispatched: [], held: [] }
    const crew = this.crewBots()
    const dispatched: string[] = [], held: string[] = []
    for (const task of due) {
      const recipient = task.bot_id ?? crew[0]
      if (this.paused() || !recipient) {
        // 只记一次提醒：`[routine]` 一行，与 [eval] / [memory] 同一个频道。
        console.log('[routine] held id=%s reason=%s', task.id, this.paused() ? 'paused' : 'no_recipient')
        held.push(task.id)
        continue
      }
      const at = new Date(now)
      const messageId = `routine-${task.id}-${at.toISOString()}`
      const thread = `team:routine:${task.id}:${messageId}`
      const trigger: Trigger = {
        id: key('team', messageId), source: 'team', threads: [{ source: 'team', id: thread }],
        // 到点派单算「人定的常规任务」，不是机器自说自话：主人写下这条账时就是要它这么做。
        actor: { source: 'team', id: 'routine' }, human: true, addressed: 'mention', at: at.toISOString(),
        text: routineMessage(task, at), channel: { source: 'team', thread, address: { conversation: 'main', message: messageId, bot_id: recipient } },
        meta: { conversation: 'main', messageId, root: messageId, bot_id: recipient, routine: task.id },
      }
      let taken = false
      try { taken = this.engine.receive(trigger) === 'stored' }
      catch (error) { console.log('[routine] dispatch failed id=%s error=%s', task.id, String(error)) }
      if (!taken) { held.push(task.id); continue }
      const record = this.store.get(KV.routines.task(task.id))
      if (record) {
        // 记上「真跑过」：这是 `last_run` 唯一的写入点。
        const next = advance({ cycle: record.cycle, created_at: record.created_at, last_run: record.last_run }, now)
        this.store.set(KV.routines.task(task.id), { ...record, ...next })
      }
      console.log('[routine] dispatched id=%s bot=%s ticket_of=%s', task.id, recipient, trigger.id)
      this.routinesToday += 1
      // 到点派了单要说一声：不然主人只会在下次开电脑时才发现队伍早上干过活。
      this.pushNotice({ title: '到点派了一件事', body: `「${task.title}」已经交给 ${recipient}。`, kind: 'routine' })
      dispatched.push(task.id)
    }
    if (dispatched.length) this.passes.request()
    return { dispatched, held }
  }

  /**
   * 接了的活要不要先问一声。
   *
   * 挂在这里而不是挂进 worker：`prepareTicket` 在 `executor.start` 之前跑，
   * 所以「停下等点头」不需要让一个 worker 先起来再干等 —— 那会白占一个并发位。
   *
   * 要问的时候做三件事：把问题写成 `attention`（手机与桌面上的 A/B 按钮据此画出来）、
   * 把指令强度降成 `inferred`（worker 不会自己开工）、把这条推送出去。
   */
  private prepareWithApproval(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    let decision: ApprovalDecision
    try {
      const settings = this.store.settings()
      const config = (settings as { approval?: { mode?: 'auto' | 'ask' | 'off'; askWhenBudgetUsed?: number } }).approval
      decision = approvalOf({
        mode: config?.mode ?? 'ask',
        rules: outcome.rules ?? [],
        sensitive: (settings.policy?.rules ?? []).filter(rule => rule.sensitive).map(rule => rule.id),
      })
    } catch (error) {
      // 判定读不出来时保守：先问一句。宁可多问一次，也不要替主人做主。
      decision = { ask: true, because: 'mode', reason: `读不出审批设置（${String(error)}），先问你一声` }
    }
    if (!decision.ask) return ticket
    const prompt = approvalPrompt(ticket.title, decision)
    console.log('[approval] asking ticket=%s because=%s', ticket.id, decision.because)
    this.pushNotice({ title: '等你点头', body: prompt.question, kind: 'approval' })
    return {
      ...ticket,
      pendingApproval: { kind: 'task', status: 'waiting' },
      attention: {
        id: `attention-approval-${ticket.id}`,
        question: prompt.question,
        ...(ticket.origin?.triggerId ? { triggerId: ticket.origin.triggerId } : {}),
        options: prompt.options,
      },
    }
  }

  /**
   * 把一条话送到主人的每台设备上。
   *
   * 三档由近到远，与 `push.ts` 的设计一致：
   *
   * 1. **隧道**：队伍自己连中继的那条（`index.ts` 建的），设备此刻挂在中转上就直送，
   *    中转自己判在线、自己留件 —— 这一档交给它，比宿主猜准。
   * 2. **本地留件**：隧道没连上（或这台机器根本没配中继）时留在本进程里，
   *    手机下次连上来时由这一层补发。
   * 3. **系统推送**：要 APNs / FCM 凭据，这一层不内置；没配就如实说 `no_provider`。
   *
   * 顺序不能反：先落本地留件会让中转那一档永远用不上（本地先认了「已排队」），
   * 于是同一句话在两边各存一份，设备重连时补发两次。
   */
  private pushNotice(notice: Notice): PushOutcome[] {
    const recipients: PushRecipient[] = this.devices().map(device => ({ deviceId: device.deviceId }))
    if (!recipients.length) return []
    const messages: PushMessage[] = pushFor(notice, recipients)
    const outcomes = messages.map((message): PushOutcome => {
      // 隧道那一档：发出去就由中转接管（在线直送、离线留件都在它那边）。
      // 返回 false 只表示「这条隧道现在发不了」，不是「这台设备不存在」。
      if (this.pusher?.(message)) return { status: 'queued', deviceId: message.deviceId, depth: 0 }
      return deliver(message, { online: false, outbox: this.pushOutbox })
    })
    for (const outcome of outcomes) {
      console.log('[push] %s kind=%s device=%s', outcome.status, notice.kind, outcome.deviceId)
    }
    return outcomes
  }

  /**
   * 一次对外连接的工具调用放不放行。
   *
   * 读直接放；写返回 `ask`，由调用方把它变成一句「等你点头」。
   * 光靠 worker 白名单拦不住写 —— 白名单只决定「能拿到哪个工具」，
   * 发邮件这个动作本身要在这里判。
   */
  judgeConnection(server: string, tool: string): ConnectionVerdict {
    try {
      const raw = (this.store.settings() as { connections?: unknown }).connections
      return judgeCall(connectionsOf(raw), server, tool)
    } catch (error) {
      // 读不出配置时保守：一律要点头。宁可多问一句，也不要静默发出去。
      return { action: 'ask', reason: `读不出对外连接设置（${String(error)}），先问你一声` }
    }
  }

  /** The grant is one exact MCP call, invalidated by any connection configuration change. */
  private guardConnection(ticketId: string, name: string, args: unknown): string | undefined {
    return this.store.atomic(() => {
      const ticket = this.store.tickets.get(ticketId)
      if (!ticket || !liveTicket(ticket)) return '工单已经结束'
      const config = connectionsOf(this.store.settings().connections)
      const connection = config.connections.find(item => name.startsWith(`mcp__${item.server}__`))
      if (!connection || !allowedTools(config).includes(name)) {
        if (ticket.pendingApproval?.kind === 'connection' && ticket.pendingApproval.status === 'approved') {
          delete ticket.pendingApproval
          this.store.tickets.save(ticket)
        }
        return '这个外部工具已不在当前连接配置中'
      }
      const tool = name.slice(`mcp__${connection.server}__`.length)
      const verdict = judgeCall(config, connection.server, tool)
      if (verdict.action === 'deny') return verdict.reason
      if (verdict.action === 'allow') return undefined
      const signature = key(name, JSON.stringify(args ?? null), JSON.stringify(config))
      if (ticket.pendingApproval?.kind === 'connection' && ticket.pendingApproval.status === 'approved'
        && ticket.pendingApproval.signature === signature) {
        delete ticket.pendingApproval
        this.store.tickets.save(ticket)
        return undefined
      }
      ticket.pendingApproval = { kind: 'connection', status: 'waiting', signature }
      const summary = JSON.stringify(args ?? null, (field, value) =>
        /token|password|credential|authorization|secret|api_?key/i.test(field) ? '[redacted]' : value).slice(0, 500)
      const prompt = approvalPrompt(`${name}（${summary}）`,
        { ask: true, because: 'rule', reason: verdict.reason })
      ticket.attention = { id: `attention-connection-${ticketId}-${signature}`, ...prompt, triggerId: ticket.origin.triggerId }
      ticket.updatedAt = new Date().toISOString()
      this.store.tickets.save(ticket)
      return `${prompt.question} 请结束本轮等待，批准后只重试同一参数的一次调用。`
    })
  }

  /** 写操作被拦下时的那一句话，直接给人看。 */
  connectionAskText(verdict: ConnectionVerdict): string {
    return verdict.reason || `要用${verdict.kind ? KIND_NAME[verdict.kind] : '外部服务'}做改动，先问你一声`
  }

  /**
   * 播报：把一句话念成 WAV。
   *
   * 用系统 `say`：与语音识别同一套前提 —— 不出本机、不传凭据、不按字计费。
   * 宿主没有这个能力（非 macOS、或没装那个声音）时如实说，不假装念了。
   */
  speak(text: string): Promise<SpeakOutcome> {
    return speakText(this.speechHost(), text, DEFAULT_VOICE)
  }

  /** 播报用的宿主。第一次用到时才建：不起子进程，只是个对象。 */
  private speech?: SpeakHost
  private speechHost(): SpeakHost {
    this.speech ??= systemSpeakHost()
    return this.speech
  }

  /** 已配对的设备。读不到就当没有：推送不该把整个队伍拖垮。 */
  private devices(): readonly { deviceId: string }[] {
    const host = this as { remote?: { list?: () => readonly { deviceId: string }[] } }
    try { return host.remote?.list?.() ?? [] } catch { return [] }
  }

  /** 一条设备连上来时取走它的待发件。 */
  takePending(deviceId: string): PushMessage[] { return this.pushOutbox.take(deviceId) }

  /**
   * 大哥的日报：晚上九点之后说一次，说的是今天真发生过的数。
   *
   * 与跟进分开：跟进说的是「有一件事卡住了」，日报说的是「今天一共怎么样」。
   * 两件都塞进一条里，人会分不清哪句要他现在动手。
   */
  async runDaily(now = new Date()): Promise<Notice | undefined> {
    if (!dailyDue(now)) return undefined
    const day = now.toISOString().slice(0, 10)
    if (this.dailySaid === day) return undefined
    const tickets = this.store.tickets.open()
    const finished = tickets.filter(ticket => ticket.ended && ticket.ended.at.startsWith(day)).length
    // 结局里没有 `failed`：失败是一个中间状态（还能重试）。日报里数的是「今天结束但没办成」的，
    // 也就是 `dropped` / `stopped` 这两种 —— 别把「还在跑」误报成失败。
    const failed = tickets.filter(ticket => ticket.ended && ticket.ended.at.startsWith(day)
      && (ticket.ended.outcome === 'dropped' || ticket.ended.outcome === 'stopped')).length
    const waiting = tickets.filter(ticket => ticketCard(ticket).state.startsWith('person/')).length
    const notice = dailyNotice({
      day: `${now.getMonth() + 1} 月 ${now.getDate()} 日`, finished, failed, waiting, routines: this.routinesToday,
    })
    // 什么也没发生的日子不发：一条「今天什么也没发生」只是在占人时间。
    if (!notice) { this.dailySaid = day; return undefined }
    this.pushNotice(notice)
    this.dailySaid = day
    return notice
  }

  /**
   * 走一遍跟进：卡在等人的票、以及跑着很久没回报的票，各提醒一次。
   *
   * 只提醒一次：提醒过的票号记在 KV（`followup.reminded`），票有新动静才清掉。
   * 隔五分钟问一次「你还在吗」的助手不是助手，是骚扰 —— 这条规矩比「别漏提醒」更重要。
   */
  async runFollowups(now = Date.now()): Promise<string[]> {
    if (this.paused()) return []
    const tickets = this.store.tickets.open().map(ticket => ({ ticket, state: ticketCard(ticket).state }))
    const candidates = followupsOf(tickets, now)
    const sent: string[] = []
    for (const candidate of candidates) {
      const seen = this.store.get(KV.followup.reminded(candidate.ticket_id))
      // 同一种「没下文」只提醒一次：换了一种（从在跑变成等你答）才算新情况。
      if (seen === `${candidate.kind}:${candidate.action ?? ''}`) continue
      const ticket = this.store.tickets.get(candidate.ticket_id)
      const channel = ticket?.channels[0]
      if (!ticket || !channel) continue
      const text = followupText(candidate)
      this.outbox.send({ id: key('followup', candidate.ticket_id, seen ?? 'first', String(now)), channel, text, kind: 'notice', ticketId: ticket.id })
      this.store.set(KV.followup.reminded(candidate.ticket_id), `${candidate.kind}:${candidate.action ?? ''}`)
      // 同时告诉主 Session 一声：它在等的那件事没下文了，不用等主人自己发现。
      this.sessions.relay(key('followup-relay', candidate.ticket_id, String(now)),
        JSON.stringify({ ...candidate, kind: 'follow_up_due', candidate: candidate.kind, text }))
      console.log('[followup] reminded ticket=%s kind=%s stalled_ms=%d', candidate.ticket_id, candidate.kind, candidate.stalled_ms)
      // 跟进光落在工单上不够：人不在电脑前时，这条等于没发生。
      this.pushNotice({ title: '有事等你', body: text, kind: 'followup' })
      sent.push(candidate.ticket_id)
    }
    return sent
  }

  /**
   * 「这张票花了多少」：从 worker 会话的 `assistant/message.usage` 算。
   *
   * 会话读不出来（票已归档、进程重启过）时返回 `undefined`，让界面说「读不到」——
   * 不返回一本 0 token 的空账，那会被读成「它没花」。
   */
  async spend(ticketId: string): Promise<Spend | undefined> {
    const id = ticketId.trim()
    if (!id || !this.store.tickets.get(id)) return undefined
    let events: SpendEvent[]
    try { events = await this.screenEvents(id) as unknown as SpendEvent[] }
    catch { return undefined }
    return spendOf(events, this.routeOf(id))
  }

  /**
   * 逐条用量：这张票每一步用的哪个模型、花了多少、上下文还剩多少。
   *
   * 与 `spend()` 的区别是粒度：那个给一张票一个合计，这个给每一步一条 ——
   * 「它刚才那一下用的谁」问的是后者。
   *
   * `contextWindow` 从模型目录里读；provider 没公布就不写余量，不猜。
   */
  async replySpends(ticketId: string): Promise<{ replies: ReplySpend[]; quota: Quota; warning?: string } | undefined> {
    const id = ticketId.trim()
    if (!id || !this.store.tickets.get(id)) return undefined
    let events: SpendEvent[]
    try { events = await this.screenEvents(id) as unknown as SpendEvent[] }
    catch { return undefined }
    // 这张票 worker 的默认路由：事件里没带 provider/model 时用它兜底。
    const fallback = this.routeOf(id)
    const windows = new Map<string, number | undefined>()
    const replies: ReplySpend[] = []
    for (const step of spendSteps(events, fallback)) {
      const route = `${step.provider}/${step.model}`
      if (!windows.has(route)) windows.set(route, await this.contextWindowOf(step.provider, step.model))
      const window = windows.get(route)
      replies.push(replySpendOf({
        provider: step.provider, model: step.model, usage: step.usage,
        ...(window === undefined ? {} : { contextWindow: window }),
      }))
    }
    if (replies.length === 0) return undefined
    const quota = quotaOf(replies)
    const warning = quotaWarning(quota)
    return { replies, quota, ...(warning ? { warning } : {}) }
  }

  /** 这条路由公布的上下文窗口。目录里没有就说没有 —— 不拿常见的 128k 当默认值。 */
  private async contextWindowOf(provider?: string, model?: string): Promise<number | undefined> {
    if (!provider || !model) return undefined
    try {
      const info = await this.ctx.llm.resolveModelInfo(provider, model) as { contextWindow?: number } | undefined
      const window = info?.contextWindow
      return typeof window === 'number' && window > 0 ? window : undefined
    } catch { return undefined }
  }

  /**
   * 「这件事的来龙去脉」：谁派的、谁判的、谁干的、花了多少。
   *
   * 四样都在盘上，这里只是编成一张表；缺的格子写「没有记录」，不替它编。
   */
  async audit(ticketId: string): Promise<AuditRow | undefined> {
    const id = ticketId.trim()
    const ticket = id ? this.store.tickets.get(id) : undefined
    if (!ticket) return undefined
    // 裁决按 thread 存：用这条 trigger 的 thread 去读，再挑出提到它的那一条。
    const trigger = ticket.origin?.triggerId ? this.store.triggers.get(ticket.origin.triggerId) : undefined
    const thread = trigger?.threads[0]
    const decision = thread
      ? this.store.decisions.byThread(`${thread.source}:${thread.id}`).filter(item => item.triggerIds.includes(trigger!.id)).at(-1)
      : undefined
    const report = ticket.assignments.at(-1)?.report
    let spent: Spend | undefined
    try { spent = await this.spend(id) } catch { spent = undefined }
    return auditOf({ ticket, trigger, decision, report, spent })
  }

  /** 这张票的 worker 用哪条路由：审计账在事件没带 provider/model 时的兜底。 */
  private routeOf(ticketId: string): { provider?: string; model?: string } {
    const executor = this.store.settings().executor
    const bot = this.store.tickets.get(ticketId)?.channels[0]?.address.bot_id
    const route = (typeof bot === 'string' ? executor?.botModels?.[bot] : undefined) ?? executor?.model
    if (route?.provider && route?.model) return { provider: route.provider, model: route.model }
    return {}
  }

  /**
   * 语音输入：把一段录音转成文字。
   *
   * 认字交给宿主（`speechToText`，本地识别，不出本机）；这里只负责认得出能力有没有、
   * 录音合不合规。宿主没装语音插件时如实回「没有」—— 按钮按了没反应比说「没有」难查得多。
   */
  async transcribe(audio: Uint8Array, signal: AbortSignal): Promise<Transcript> {
    // 每次现取：宿主装上/卸下语音插件都不需要重启队伍。
    const host = this.ctx.get('speechToText') as SpeechHost | undefined
    return transcribeAudio(host, audio, signal)
  }

  /** 花名册里的 Bot id，按主人写的顺序。 */
  private crewBots(): string[] {
    const config = this.store.settings().sources?.team?.config as { bots?: { bot_id?: string }[] } | undefined
    return (config?.bots ?? []).flatMap(bot => bot.bot_id ? [bot.bot_id] : [])
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

  /**
   * Let a component outside Runtime report its own health (the phone's P2P channel does:
   * whether a direct tunnel is up is not Runtime's business, but the operator needs it on
   * the same panel). Throws when the name is already taken, so one component cannot silently
   * overwrite another's line.
   */
  claimHealth(name: string, initial?: Health): HealthEntry { return this.board.claim(name, initial) }

  /**
   * 接上「经中继送推送」那只手。隧道建好后由 `index.ts` 调一次。
   *
   * 传 `undefined` 表示这条路现在不可用（没配中继、或隧道要关了），通知就回落到本地留件。
   * 这里不校验回调是否成功 —— 它返回 false 只说明这一条没发出去，留件的责任在中转与本地两层。
   */
  attachPusher(pusher: ((message: PushMessage) => boolean) | undefined): void { this.pusher = pusher }
  /** Aborted when dsh-superagent stops or loses its state directory lock, cancelling running reads and subprocesses. */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  /** Resolved deployment; throws while waiting for setup (`!configured()`). */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.setup.configured() }
  /** 看门狗最近告警（超时未决定等「卡住」事件），桌面右栏与管理面 /state 读它。最新的在前。 */
  watchdogStatus(): WatchdogStatus {
    return { alerts: this.watchdogAlerts.slice(0, 10), lastSelfHealAt: this.lastSelfHealAt }
  }
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
  /** A unique pending question can only be answered by its requester in the same conversation and Bot. */
  private approvalReply(trigger: Trigger): ReceiveResult | undefined {
    if (!trigger.human || this.store.triggers.get(trigger.id) || !this.sources.scope(trigger).listened) return undefined
    const conversation = (channel: Trigger['channel']) => channel
      ? `${channel.source}:${channel.address.conversation ?? channel.address.chatId ?? channel.thread}` : undefined
    const text = trigger.text.replace(/^@\S+\s+/, '').trim()
    const candidates = this.store.tickets.open().filter(ticket => ticket.pendingApproval
      && ticket.pendingApproval.status !== 'approved'
      && ticket.mandate.actor.source === trigger.actor.source && ticket.mandate.actor.id === trigger.actor.id
      && ticket.channels.some(channel => conversation(channel) === conversation(trigger.channel)
        && channel.address.bot_id === trigger.channel?.address.bot_id))
    const sameThread = candidates.filter(ticket => trigger.threads.some(ref =>
      this.store.threads.get(threadKey(ref))?.subscriptions.includes(ticket.id)))
    const matches = sameThread.length ? sameThread : candidates
    // A bare label must never approve two tickets or guess which one the person meant.
    if (matches.length !== 1) return undefined
    const ticket = matches[0]!
    const pending = ticket.pendingApproval!
    const option = ticket.attention?.options?.find(item => item.label === text || item.id === text)
    if (!option && pending.status !== 'revise') return undefined
    return this.store.atomic(() => {
      const at = new Date().toISOString()
      this.store.triggers.save(trigger)
      this.store.triggers.saveDisposition(trigger.id, { fanout: [ticket.id], acked: [ticket.id], at })
      ticket.inputs.push({ id: key('approval-input', trigger.id), kind: 'trigger', triggerId: trigger.id, human: true, at })
      ticket.updatedAt = at
      const answer = option ? readAnswer(option.label) : 'revise'
      if (option && answer === 'stop') {
        this.store.tickets.save(ticket)
        this.engine.stopTicket(ticket.id, '主人选择先别做')
      } else if (option && answer === 'revise') {
        pending.status = 'revise'
        ticket.attention = { id: `attention-approval-${ticket.id}`, question: '请写下新的做法；确认后才会继续。', triggerId: trigger.id }
        this.store.tickets.save(ticket)
      } else if (pending.status === 'revise') {
        if (ticket.execution) ticket.execution.assignment += `\n\n主人修订：${trigger.text}`
        ticket.pendingApproval = { kind: 'task', status: 'waiting' }
        const prompt = approvalPrompt(ticket.title, { ask: true, because: 'mode', reason: `已记录新要求：${text}` })
        ticket.attention = { id: `attention-approval-${ticket.id}`, ...prompt, triggerId: trigger.id }
        this.store.tickets.save(ticket)
      } else {
        if (pending.kind === 'connection') pending.status = 'approved'
        else delete ticket.pendingApproval
        delete ticket.attention
        const input = { id: key('approval-go', trigger.id), kind: 'text' as const, at,
          text: '主人已批准这次请求。外部写操作仅批准之前展示的同一工具和同一参数的一次调用；不要扩大范围。' }
        ticket.inputs.push(input); ticket.undelivered.push(input.id)
        this.store.tickets.save(ticket)
        const latest = ticket.assignments.at(-1)
        if (latest?.state === 'pending') this.executor.start(ticket, latest)
        else if (latest?.state === 'running') this.executor.deliver(ticket, latest)
      }
      return 'stored' as const
    })
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
  /**
   * 收集 settings 里所有会被当角色模型用的路由：eval 主、executor 主、每位 bot 的 route。
   * 只收「配了值」的；null/空 = 走宿主默认，不算错配。启动一致性检查用它。
   */
  private configuredRoutes(): (RoutedModel | null | undefined)[] {
    const settings = this.store.settings()
    const routes: (RoutedModel | null | undefined)[] = [settings.eval.model, settings.executor.model]
    for (const route of Object.values(settings.executor.botModels ?? {})) routes.push(route)
    return routes
  }

  private async finishSetup(): Promise<void> {
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      this.retrySetup()
      return
    }
    // 启动一致性检查（#8-1）：settings 里任何一条会被拿来用的路由（eval / executor / 每个 bot）
    // 若主备都解析不通，就在启动阶段拦下 —— 报错写进 health 与日志，而不是让 Eval 进了 evaluating 之后
    // 死等 judgement 到超时。轮询/重试 setup 时也会再走这里，所以改好配置后能自愈。
    const routeFailures = await checkRoleRoutes(this.ctx, this.configuredRoutes())
    if (routeFailures.length > 0) {
      const detail = `模型路由解析不通：${routeFailures.map(f => f.detail).join('；')}`
      this.runtimeHealth.set({ state: 'error', detail, at: now() })
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
    this.startRoutines()
    this.watchCompaction()
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
  /**
   * 盯住宿主折会话：折出来的摘要记进记忆账本。
   *
   * 这一条是「会话可以短、记忆要长」的接缝：压缩器由宿主决定什么时候折、怎么折，
   * 这里只管折完之后那一段落进账本 —— 于是会话归档、重开新 Session 之后，
   * 它仍然带着「之前聊过什么」。
   *
   * 只记 worker 会话的摘要：主人自己那几条 DSH 会话不归这支队伍管，
   * 把它们的摘要写进队伍账本，等于偷看别人的工作。
   */
  private watchCompaction(): void {
    if (this.compactionWatch) return
    this.compactionWatch = true
    try {
      this.ctx.on('session/event', (session: unknown, event: unknown) => {
        const candidate = event as CompactionSummaryEvent | undefined
        if (!candidate || !worthRemembering(candidate)) return
        const id = (session as { id?: unknown } | undefined)?.id
        if (typeof id !== 'string') return
        // 只认自己派出去的 worker 会话（`worker-<ticket>`）。
        const match = /^worker-(.+)$/.exec(id)
        const ticketId = match?.[1]
        const ticket = ticketId ? this.store.tickets.get(ticketId) : undefined
        if (!ticket) return
        const bot = (ticket.channels[0]?.address as { bot_id?: unknown } | undefined)?.bot_id
        if (typeof bot !== 'string' || !bot) return
        try {
          const fact = summaryFact(candidate)
          this.memory.ledger.settle({
            bot_id: bot,
            fact: { dedupe_key: fact.dedupe_key, description: fact.description, body: fact.body, type: 'project', importance: 3 },
            origin: `ticket:${ticket.id}`,
            source: { ticket_id: ticket.id },
          })
          console.log('[memory] compact settled ticket=%s chars=%d', ticket.id, fact.body.length)
        } catch (error) {
          console.log('[memory] compact settle failed ticket=%s error=%s', ticket.id, String(error))
        }
      })
    } catch (error) {
      // 宿主没有这个事件（老版本）时安静跳过：压缩还在跑，只是不落账本。
      console.log('[memory] compaction watch unavailable: %s', String(error))
    }
  }

  /**
   * 起调度器：一分钟看一次账本。
   *
   * 第一次检查故意晚一个 tick：启动时正忙着建会话、同步花名册，
   * 这时候派单会撞上还没就绪的队伍。晚一分钟不会让谁错过什么 ——
   * 逾期只提醒，跑的是「该跑的下一轮」。
   */
  private startRoutines(): void {
    if (this.routineTimer || this.closing()) return
    this.routineTimer = setInterval(() => {
      if (this.closing()) return
      const now = Date.now()
      // 睡过头的判定：距上次 tick 超过 3 个周期（>= 3 分钟），基本只可能是机器睡眠/断网挂起，
      // 不是正常节拍。醒来第一拍先补一次自愈扫描（把停机期间超时的 Eval 捡回来），扫描窗口按
      // 实际停机时长扩大，别漏掉窗口外的；然后照常跑这一拍。
      const gap = this.lastTickAt === undefined ? 0 : now - this.lastTickAt
      this.lastTickAt = now
      if (gap >= TICK_MS * 3) {
        console.log('[selfheal] 检测到长时间停机（%dms），醒来补扫一次', gap)
        void this.runSelfHeal(now, { catchUpMs: gap })
          .catch(error => { console.log('[selfheal] catch-up failed: %s', String(error)) })
      }
      void this.runRoutines().catch(error => { console.log('[routine] tick failed: %s', String(error)) })
      void this.runSelfHeal(now).catch(error => { console.log('[selfheal] tick failed: %s', String(error)) })
      void this.runFollowups().catch(error => { console.log('[followup] tick failed: %s', String(error)) })
      void this.runDaily().catch(error => { console.log('[daily] tick failed: %s', String(error)) })
    }, TICK_MS)
    this.lastTickAt = Date.now()
    // 定时器不该一个人把进程钉住（测试、以及脚本里的一次性启动）。
    this.routineTimer.unref?.()
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
    if (this.routineTimer !== undefined) { clearInterval(this.routineTimer); this.routineTimer = undefined }
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
