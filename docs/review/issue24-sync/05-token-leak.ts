// token 不泄漏：错凭据走真实中枢，看错误文本/日志里是否出现 token 值。
import { HubHttp, isHubAuthError } from '/Users/cpuser/Code/dsh-bot-crew/backend/src/memory/hub-client.ts'
import { readHubToken } from '/Users/cpuser/Code/dsh-bot-crew/backend/src/memory/auth.ts'
const tok = readHubToken({ env: 'HUB_TOKEN', file: '/Users/cpuser/.config/hub-memory-mcp/env' })
const bad = `${tok.token}WRONG`
const hub = new HubHttp({ base: 'https://jarvis.kentonnie.top/v1', timeoutMs: 10000, token: () => bad })
const err = await hub.search({ query: 'x', limit: 1 }).catch(e => e)
const text = String(err?.message ?? err)
console.log('isHubAuthError =', isHubAuthError(err), '| status =', (err as {status?:number}).status)
console.log('错误文本 =', text)
console.log('错误文本含 token 值 =', text.includes(tok.token) ? 'YES(泄漏!)' : 'NO')
console.log('错误文本含整条错 token =', text.includes(bad) ? 'YES(泄漏!)' : 'NO')
