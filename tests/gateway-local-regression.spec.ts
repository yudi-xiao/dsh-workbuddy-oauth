/** Offline-only regressions for the local pi-ai 1.1 adaptation of PR #1. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyUpstreamClient, withGatewayChatHeaders } from '../src/upstream.ts'
import { createWorkBuddyShim, type WorkBuddyShim } from '../src/shim.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import type { CredentialStore } from '../src/store.ts'
import type { WorkBuddyCredential } from '../src/credentials.ts'

const credential: WorkBuddyCredential = {
  accessToken: 'offline-at', refreshToken: 'offline-rt', expiresAtMs: Date.now() + 3_600_000,
  domain: 'copilot.tencent.com', uid: 'offline-uid', region: 'cn',
}
const user = { role: 'user', content: 'same words' }
const toolCall = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'test' } }] }
const toolResult = { role: 'tool', tool_call_id: 'c1', content: 'result' }
const body = (messages: unknown[]): string => JSON.stringify({ model: 'hy3', messages })
const ids = (messages: unknown[], session = 'offline-session'): Record<string, string> =>
  withGatewayChatHeaders({}, body(messages), session)
let shim: WorkBuddyShim | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  await shim?.close()
  shim = undefined
})

describe('local ID invariants', () => {
  it('preserves all mixed-case caller IDs without duplicate HTTP fields', () => {
    const carried = {
      'x-conversation-id': 'conversation', 'X-CONVERSATION-REQUEST-ID': 'turn',
      'x-conversation-message-id': 'message', 'x-request-id': 'request',
    }
    const result = withGatewayChatHeaders({ ...carried }, body([user]), 'different-session')
    expect(result).toEqual(carried)
    expect(new Headers(result).get('x-conversation-id')).toBe('conversation')
  })

  it('uses a carried request ID for the missing message ID', () => {
    const result = withGatewayChatHeaders({ 'x-request-id': 'carried' }, body([user]))
    expect(result['X-Conversation-Message-ID']).toBe('carried')
    expect(new Headers(result).get('x-request-id')).toBe('carried')
  })

  it('distinguishes identical user words in a later turn, including after tools', () => {
    const initial = ids([user])
    for (const messages of [[user, toolCall, user], [user, toolCall, toolResult, user], [user, { role: 'assistant', content: 'done' }, user]]) {
      expect(ids(messages)['X-Conversation-Request-ID']).not.toBe(initial['X-Conversation-Request-ID'])
      expect(ids(messages)['X-Conversation-ID']).toBe(initial['X-Conversation-ID'])
    }
  })

  it('keeps retries, tool-result variants and model/account changes on one turn', async () => {
    const first = ids([user])
    const continued = [user, toolCall, toolResult, { role: 'user', content: [{ type: 'tool-result', content: 'other result' }] }]
    expect(ids(continued)['X-Conversation-Request-ID']).toBe(first['X-Conversation-Request-ID'])
    expect(ids(continued)['X-Conversation-Message-ID']).not.toBe(first['X-Conversation-Message-ID'])
    const requests: Array<Record<string, string>> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      requests.push(init.headers as Record<string, string>)
      return new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
    }))
    const client = new WorkBuddyUpstreamClient({ resolveChatIdentity: async () => ({ clientVersion: '5.5.6' }) })
    await client.chatStream(credential, body([user]), undefined, 's')
    await client.chatStream({ ...credential, uid: 'other-account' }, JSON.stringify({ model: 'other-model', messages: continued }), undefined, 's')
    expect(requests[0]?.['X-Conversation-Request-ID']).toBe(requests[1]?.['X-Conversation-Request-ID'])
  })

  it('separates sessions and caller-carried conversation namespaces', () => {
    expect(ids([user], 'a')['X-Conversation-Request-ID']).not.toBe(ids([user], 'b')['X-Conversation-Request-ID'])
    const a = withGatewayChatHeaders({ 'x-conversation-id': 'a' }, body([user]))
    const b = withGatewayChatHeaders({ 'x-conversation-id': 'b' }, body([user]))
    expect(a['X-Conversation-Request-ID']).not.toBe(b['X-Conversation-Request-ID'])
  })

  it('supports image-only input and distinguishes changed image content', () => {
    const image = (url: string) => ({ role: 'user', content: [{ type: 'image_url', image_url: { url } }] })
    const a = ids([image('data:image/png;base64,a')])
    expect(a['X-Conversation-Request-ID']).toBe(ids([image('data:image/png;base64,a')])['X-Conversation-Request-ID'])
    expect(a['X-Conversation-Request-ID']).not.toBe(ids([image('data:image/png;base64,b')])['X-Conversation-Request-ID'])
  })

  it('treats mixed tool results plus user text as a new send', () => {
    const mixed = { role: 'user', content: [{ type: 'tool_result', content: 'result' }, { type: 'text', text: 'new instruction' }] }
    expect(ids([user, toolCall, mixed])['X-Conversation-Request-ID']).not.toBe(ids([user])['X-Conversation-Request-ID'])
  })

  it('does not sign an empty latest user message as the preceding turn', () => {
    const messages = [user, { role: 'user', content: '' }]
    expect(ids(messages)['X-Conversation-Request-ID']).not.toBe(ids(messages)['X-Conversation-Request-ID'])
    for (const malformed of ['not JSON', 'null', '[]']) {
      const result = withGatewayChatHeaders({}, malformed)
      expect(result['X-Conversation-ID']).toBeUndefined()
      expect(result['X-Request-ID']).toMatch(/^[0-9a-f]{32}$/)
    }
  })
})

describe('both probe regions', () => {
  it.each(['cn', 'global'] as const)('uses the same header split and token boundary for %s', async region => {
    let observed: Headers | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      observed = new Headers(init.headers)
      return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
    }))
    const client = new WorkBuddyUpstreamClient({ resolveChatIdentity: async () => ({ clientVersion: '5.5.6' }) })
    await client.probeEffort({ ...credential, region, domain: region === 'cn' ? 'copilot.tencent.com' : 'workbuddy.ai' }, 'hy3', undefined, AbortSignal.timeout(1000))
    expect(observed?.get('x-agent-intent')).toBe('craft')
    expect(observed?.get('x-agent-purpose')).toBe('conversation')
    expect(observed?.get('x-agent-type')).toBe(region === 'global' ? 'main' : null)
    expect(observed?.get('x-conversation-request-id')).toMatch(/^[0-9a-f]{32}$/)
    expect(observed?.get('x-refresh-token')).toBeNull()
  })
})

describe('real loopback shim wiring', () => {
  it('passes one opaque session key to both account resolution and upstream tracking', async () => {
    const resolved: Array<string | undefined> = []
    const captured: Array<{ session: string | undefined; headers: Record<string, string>; body: string }> = []
    const store = {
      async resolve(key?: string) { resolved.push(key); return credential },
      async current() { return credential }, noteFailure: vi.fn(),
    } as unknown as CredentialStore
    shim = createWorkBuddyShim({
      store, catalog: new WorkBuddyCatalog(), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      client: { async chatStream(_credential: unknown, prepared: string, _signal: unknown, session?: string) {
        captured.push({ session, body: prepared, headers: withGatewayChatHeaders({}, prepared, session) })
        return { ok: false, status: 429, kind: 'soft_rate', message: 'offline rate limit' }
      } } as never,
    })
    await shim.ready
    for (const messages of [[user], [user, toolCall, toolResult]]) {
      const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json', 'x-session-id': 'opaque-session-42' },
        body: body(messages),
      })
      expect(response.status).toBe(429)
      await response.text()
    }
    expect(resolved).toEqual(['opaque-session-42', 'opaque-session-42'])
    expect(captured.map(call => call.session)).toEqual(resolved)
    expect(JSON.parse(captured[0]!.body).stream).toBe(true)
    expect(captured[0]?.headers['X-Conversation-ID']).toBe(captured[1]?.headers['X-Conversation-ID'])
    expect(captured[0]?.headers['X-Conversation-Request-ID']).toBe(captured[1]?.headers['X-Conversation-Request-ID'])
    expect(JSON.stringify(captured.map(call => call.headers))).not.toContain('opaque-session-42')
  })
})
