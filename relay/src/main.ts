/**
 * 中转进程的入口：读环境、起服务、接到信号就体面退出。
 *
 * 全部配置走环境变量，没有配置文件也没有命令行参数 —— 它要跑在 Docker 里，
 * 环境变量是容器时代唯一不需要再包一层的东西。缺省值都是「能起来但最保守」：
 * 不设密钥就不验宿主密钥（局域网/自用场景），不设 admin token 就不给详细健康视图。
 */
import { createRelay, type RelayOptions } from './server.ts'

/** 把 "1"/"true"/"yes" 当成真，别的都是假。 */
const flag = (value: string | undefined): boolean => !!value && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())

/** 读一个正整数环境变量。读不出就用缺省值 —— 一个打错的环境变量不该让服务起不来。 */
function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

/** 进程行的结构化日志（一行一个 JSON）。Docker 的日志驱动按行收集。 */
function logger(sink = process.stdout): NonNullable<RelayOptions['log']> {
  return line => {
    sink.write(`${JSON.stringify({ at: new Date().toISOString(), level: line.level, message: line.message, ...line.detail })}\n`)
  }
}

export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): RelayOptions {
  return {
    ...(env.RELAY_REGISTER_SECRET ? { registerSecret: env.RELAY_REGISTER_SECRET } : {}),
    ...(env.RELAY_ADMIN_TOKEN ? { adminToken: env.RELAY_ADMIN_TOKEN } : {}),
    heartbeatIntervalMs: positive(env.RELAY_HEARTBEAT_MS, 15_000),
    // 60s：宿主那边是 45s 判死（三拍 ping 没回），中转比它晚一步，免得两边同时抖。
    pongTimeoutMs: positive(env.RELAY_PONG_TIMEOUT_MS, 60_000),
    responseTimeoutMs: positive(env.RELAY_RESPONSE_TIMEOUT_MS, 120_000),
    maxRequestBodyBytes: positive(env.RELAY_MAX_BODY_BYTES, 256 * 1024),
    maxInflightPerInstance: positive(env.RELAY_MAX_INFLIGHT, 64),
    authFailureLimit: positive(env.RELAY_AUTH_FAILURE_LIMIT, 20),
    log: logger(),
  }
}

async function main(): Promise<void> {
  const options = optionsFromEnv()
  const relay = createRelay(options)
  const port = positive(process.env.RELAY_PORT, 8787)
  const host = process.env.RELAY_HOST?.trim() || '0.0.0.0'
  await relay.listen(port, host)
  if (!options.registerSecret) {
    // 不设密钥意味着任何人都能抢注一个 instanceId。局域网自用可以，公网不行。
    process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), level: 'warn', message: 'RELAY_REGISTER_SECRET is not set; any host may claim any instanceId' })}\n`)
  }
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), level: 'info', message: 'relay listening', host, port, detail: `/health and /i/<instanceId>/...` })}\n`)

  // 收到 TERM/INT 就体面退出：先告诉每条隧道「中转要走了」，再关监听。
  // 直接 process.exit 会让宿主那边看到 1006，然后按退避重连 —— 而它本该立刻重连（中转只是重启）。
  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), level: 'info', message: 'shutting down', signal })}\n`)
    await relay.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
  process.on('SIGINT', () => { void shutdown('SIGINT') })
  // 未处理的异常不该让一个公网服务悄悄死掉又没人知道：打出来再退，交给 Docker 的重启策略。
  process.on('uncaughtException', error => {
    process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), level: 'error', message: 'uncaught exception', error: String(error) })}\n`)
    process.exit(1)
  })
  process.on('unhandledRejection', reason => {
    process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), level: 'error', message: 'unhandled rejection', error: String(reason) })}\n`)
  })
}

// 只在被直接执行时跑。被 import（测试、将来被别的进程包起来）时什么都不做。
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main()
}
