import { expect, it } from 'vitest'
import { optionsFromEnv } from '../src/main.ts'

it('reads every knob from the environment', () => {
  const options = optionsFromEnv({
    RELAY_REGISTER_SECRET: 's', RELAY_ADMIN_TOKEN: 'a', RELAY_HEARTBEAT_MS: '20000',
    RELAY_PONG_TIMEOUT_MS: '90000', RELAY_RESPONSE_TIMEOUT_MS: '5000', RELAY_MAX_BODY_BYTES: '1024',
    RELAY_MAX_INFLIGHT: '4', RELAY_AUTH_FAILURE_LIMIT: '7',
  })
  expect(options).toMatchObject({
    registerSecret: 's', adminToken: 'a', heartbeatIntervalMs: 20_000, pongTimeoutMs: 90_000,
    responseTimeoutMs: 5_000, maxRequestBodyBytes: 1024, maxInflightPerInstance: 4, authFailureLimit: 7,
  })
})

it('falls back to safe defaults for anything missing or unparsable', () => {
  // 一个打错的环境变量不该让服务起不来；宁可跑缺省值。
  const options = optionsFromEnv({ RELAY_HEARTBEAT_MS: 'soon', RELAY_MAX_BODY_BYTES: '-5' })
  expect(options.registerSecret).toBeUndefined()
  expect(options.adminToken).toBeUndefined()
  expect(options.heartbeatIntervalMs).toBe(15_000)
  expect(options.maxRequestBodyBytes).toBe(256 * 1024)
})
