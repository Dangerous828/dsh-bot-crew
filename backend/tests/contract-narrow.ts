/**
 * A file tsc reads and vitest never runs. Widening `TimelineRole` past what `tools/mobilegw` writes breaks
 * `@ts-expect-error` below (it stops being an error), and `npm run build` fails. This is the half of
 * `contract-timeline.spec.ts` that a runtime test cannot do.
 */
import type { TimelineRole } from '../src/contract/types.ts'

// Roles the gateway never writes. Each line must stay a type error.
// @ts-expect-error the gateway writes only 'user' and 'agent'
const asBot: TimelineRole = 'bot'
// @ts-expect-error the gateway writes only 'user' and 'agent'
const asSystem: TimelineRole = 'system'
// @ts-expect-error the gateway writes only 'user' and 'agent'
const asAssistant: TimelineRole = 'assistant'

export const neverWritten = [asBot, asSystem, asAssistant]
