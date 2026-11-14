/** A `SubprocessRuntime` backed by `child_process.spawn`, so tests exercise real processes instead of a stand-in. */
import { spawn } from 'node:child_process'
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/**
 * Runs real programs with real exit codes and real stdio.
 *
 * Isolation tests must use this rather than a mock: the point of a sandbox level is what a real child process can
 * and cannot do, so a stand-in would pass while the sandbox was broken.
 */
export function realSubprocess(): SubprocessRuntime {
  return {
    spawn: ({ argv, cwd, env }: { argv: readonly string[]; cwd: string; env?: Record<string, string> }) => {
      const child = spawn(argv[0]!, argv.slice(1), { cwd, ...env ? { env } : {} })
      const output = { stdout: '', stderr: '' }
      child.stdout.on('data', chunk => { output.stdout += String(chunk) })
      child.stderr.on('data', chunk => { output.stderr += String(chunk) })
      const reader = (name: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: output[name], nextOffset: 0, lossy: false }) })
      const done = new Promise(resolve => child.on('close', code => resolve({ exitCode: code, signal: null })))
      return { done, collected: { stdout: reader('stdout') as SubprocessOutputReader, stderr: reader('stderr') as SubprocessOutputReader } }
    },
  } as unknown as SubprocessRuntime
}
