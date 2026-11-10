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
import { Engine, key, liveTicket, reasonText, runningAssignment, type EngineForSettings, type OutboundMessage, type ReceiveResult, type Ticket,
  type Trigger } from '../core/index.ts'
import { allowedSender, settingsPolicy } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Commands } from '../infra/commands.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.ts'
import type { SetupProblem } from '../setup.ts'
import { DshExecutor, sourceTrigger, triggerMessage, workerSessionId } from '../executor/dsh.ts'
import { ticketCard } from './cards.ts'
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

// Source plugins interact with dsh-superagent exclusively through the `SourceHost` service interface.
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
/** How many of the crew's finished tickets the chat list keeps visible, so its entry opens on recent work. */
const RECENT_CREW_TICKETS = 2
/**
 * Whether a finishing ticket is old enough to archive its worker.
 *
 * The crew's entry must not open empty: the two most recent tickets stay in the list, and everything older is
 * archived. Ids are compared as a set, so a ticket that ends twice (a resume that ends again) still counts once.
 */
const pastTheRecent = (store: Pick<Store, 'tickets'>, ticketId: string): boolean => {
  const ended = store.tickets.list().filter(ticket => ticket.ended !== undefined)
    .sort((a, b) => (b.ended?.at ?? '').localeCompare(a.ended?.at ?? ''))
  return ended.findIndex(ticket => ticket.id === ticketId) >= RECENT_CREW_TICKETS
}
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
  readonly ready: Promise<void>
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  readonly masterId: string
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly disposers: (() => void)[] = []
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  private stopping?: Promise<void>
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  constructor(ctx: Context, readonly machine: Machine, restart: () => void) {
    super(ctx, 'orchestrator')
    const runtime = this
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
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      this.executor = new DshExecutor({ context: ctx, get engine() { return runtime.engine }, store, effects, health: board.claim('worker'), machine,
        lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.paused(), environment, sourceLink: link,
        repliedTo: trigger => repliedTo({ store, sources }, trigger) })
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
          // A finished ticket's worker is done, and leaving its Session in the list means the crew slowly fills
          // the chat list with one entry per errand. Archive it: the transcript is kept and can be reopened, but
          // the crew reads as the one place it is instead of as everything it has ever done.
          // A finished ticket's worker is done, and keeping it in the list means the crew slowly fills the chat list
          // with one entry per errand. Archive it, but keep the two most recent: the entry is where a person looks to
          // see what the crew just did, and an archive that starts empty has nothing to show. The transcript is kept
          // either way, so this only decides what the list opens on.
          const archiving = ctx.workspaceRegistry.archiveSession
          if (event.type === 'ticket.ended' && typeof archiving === 'function' && pastTheRecent(store, event.data.ticketId)) {
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
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> { return this.passes.pump() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  private paused(): boolean { return !this.setup.configured() || this.store.settings().paused }
  private async initialize(): Promise<void> {
    // Register management HTTP routes before setup completes so operators can fix setup problems in the UI.
    this.disposers.push(registerHttp(this.ctx, this.httpHost()))
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      return
    }
    this.sessions.install()
    this.executor.install()
    await this.sessions.ensure(this.masterId, this.machine.stateDir, 'dsh-superagent orchestrator', 'orchestrator')
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    // If stop() was called while awaiting setup, session creation, or policy sync, do not start background loops.
    if (this.closing()) return
    this.executor.resume()
    this.passes.start()
    this.effects.start()
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
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
    this.closingFlag = true; const passes = this.passes.stop(); this.stopped.abort()
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
