/**
 * A worker asking for a job to be put in front of a teammate.
 *
 * The worker has no way to open a ticket itself: routing belongs to the main Session, and handing a worker
 * that power would put two schedulers on one ledger. What a worker *can* do is say so in the reply it is
 * already sending, on a line of its own, and let the host read it there. The line never reaches the person:
 * it is stripped before the message goes out, and the remaining text is what they read.
 */

/** The marker a worker writes on its own line, naming the bot the work belongs to. */
const HANDOFF = /^[ \t]*@handoff[ \t]+([a-z0-9-]+)[ \t]*(?::[ \t]*(.*))?$/im

export interface Handoff {
  /** The bot the work should go to, as written. Callers check it against the roster. */
  bot_id: string
  /** What the worker said to pass along, or an empty string when it named only the bot. */
  note: string
}

/**
 * Split a worker reply into what the person reads and the handoffs it asked for.
 *
 * Only a whole line counts: a mention of `@handoff` inside a sentence is prose, and a person may well be
 * discussing this very feature. Every handoff line is removed from the text regardless of whether the bot
 * it names exists, because the person must never see the machinery; whether the target is real is the
 * caller's check.
 */
export function splitHandoff(text: string): { text: string; handoffs: Handoff[] } {
  const handoffs: Handoff[] = []
  // matchAll requires the global flag while the line filter must not share its state, so the two use
  // separate patterns: one scans, one decides.
  for (const match of text.matchAll(new RegExp(HANDOFF.source, 'gim'))) {
    const bot = match[1]
    if (bot) handoffs.push({ bot_id: bot.toLowerCase(), note: (match[2] ?? '').trim() })
  }
  const kept = text
    .split('\n')
    .filter(line => !HANDOFF.test(line))
    .join('\n')
    // A reply that was nothing but a handoff leaves blank lines behind; the person gets an empty message
    // rather than a stray gap, and the caller decides what to say instead.
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text: kept, handoffs }
}

/** The body of a handoff ticket, as the worker wrote it. Falls back to the original request so the bot knows what is wanted. */
export function handoffBody(handoff: Handoff, original: string): string {
  return handoff.note || original
}
