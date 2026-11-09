import { describe, expect, it } from 'vitest'
import { gatewayOrigin, teamLink } from '../src/sources/team.ts'

describe('the link a crew conversation offers', () => {
  it('opens the gateway when the queue message carries no URL of its own', () => {
    const link = teamLink({ conversation: 'main' }, { gateway: { host: '127.0.0.1', port: '8788' } })
    expect(link.url).toBe('http://127.0.0.1:8788/?conversation=main')
    expect(link.label.zh).toBe('Bot 队伍对话 main')
  })

  it('keeps the URL a phone or web note arrived with', () => {
    const link = teamLink({ conversation: 'main', url: 'https://example.test/note/1' }, {})
    expect(link.url).toBe('https://example.test/note/1')
  })

  it('dials the loopback address for a wildcard bind, which a browser cannot reach', () => {
    expect(gatewayOrigin({ host: '0.0.0.0', port: '8788' })).toBe('http://127.0.0.1:8788')
    expect(gatewayOrigin({ host: '::', port: '9000' })).toBe('http://127.0.0.1:9000')
  })

  it('falls back to the gateway default port and counts the scheme in the origin', () => {
    expect(gatewayOrigin({})).toBe('http://127.0.0.1:8788')
    expect(gatewayOrigin({ secure: true, port: '443' })).toBe('https://127.0.0.1')
  })
})
