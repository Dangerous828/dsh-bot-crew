import { expect, it } from 'vitest'


it('sends a reply when the outbox hands the channel no deployment', async () => {
  // `SourceChannel.send` is defined to receive only `commands`, so `deployment` is undefined on the reply path
  // even though `sendTeam` declares it. Reading through it used to throw
  // `TypeError: Cannot read properties of undefined (reading 'stateDir')`, which parked every Bot reply in the
  // outbox and retried five times before giving up.
  const { sendTeam } = await import('../src/sources/team.ts')
  const runs: unknown[][] = []
  const host = { commands: { run: async (_tool: string, args: string[]) => { runs.push(args); return '' } } }
  const result = await sendTeam(host as never, {
    id: 'reply-1', text: '改好了',
    channel: { source: 'team', thread: 'team:main:6', address: { conversation: 'main', message: '6', bot_id: 'coder' } },
  } as never)
  expect(result).toBe('sent')
  const args = runs[0] as string[]
  expect(args.slice(0, 2)).toEqual(['reply', '--conversation'])
  expect(args).toContain('--text')
  // No deployment means no `--db`: the CLI falls back to its own default instead of the reply failing outright.
  expect(args).not.toContain('--db')
  expect(args).toContain('--bot')
})
