/**
 * Tests for the OAuth presentation of WorkBuddy's published routes.
 *
 * Two behaviours are pinned here, and both are silent when wrong:
 *
 * 1. **The directory entry.** The Models page decides whether to render an
 *    endpoint/API-key form or a sign-in button from `nativeAuth`; an entry that
 *    omits it, or that carries `env: [...]`, silently falls back to the form and
 *    asks the user to type in a loopback endpoint and a per-process secret.
 * 2. **The sign-in flow.** The page's button runs whatever is registered under
 *    the route's credential key. A flow that returns without signing in reports
 *    a successful authorization that never happened.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { directoryEntryOf, registerDirectory } from '../src/provider-directory.ts'
import { flowKeyFor, registerSignInFlow, type AuthorizationSession } from '../src/authorization-flow.ts'

describe('directoryEntryOf', () => {
  const request = {
    region: 'global' as const,
    providerId: 'workbuddy-oauth-ai',
    displayName: 'WorkBuddy AI (国际版)',
    shimOrigin: 'http://127.0.0.1:39272',
    settingsNs: 'llm-pi-ai',
  }

  it('declares keyless OAuth, which is what hides the API-key form', () => {
    const entry = directoryEntryOf(request)
    // The Models page reads exactly this pair: `env.length === 0 && oauth` is
    // the `keylessNativeAuth` branch that suppresses the key field.
    expect(entry.nativeAuth).toEqual({ env: [], oauth: true })
  })

  it('points at the loopback endpoint and marks the route as declared', () => {
    const entry = directoryEntryOf(request)
    expect(entry.defaultBaseURL).toBe('http://127.0.0.1:39272/v1')
    expect(entry.declared).toBe(true)
  })

  it('addresses the same profile path the publisher writes', () => {
    const entry = directoryEntryOf(request)
    expect(entry.settingsPath).toEqual(['providers', 'workbuddy-oauth-ai'])
    expect(entry.settingsNs).toBe('llm-pi-ai')
  })

  it('carries the route key and label the page groups under', () => {
    const entry = directoryEntryOf(request)
    expect(entry.provider).toBe('workbuddy-oauth-ai')
    expect(entry.displayName).toBe('WorkBuddy AI (国际版)')
  })
})

/** A context whose `llm.registerConfigurableProviders` records what it was given. */
function directoryContext(options: { refuse?: boolean } = {}): {
  ctx: Context
  registered: unknown[][]
  replaced: unknown[][]
  warnings: unknown[]
} {
  const registered: unknown[][] = []
  const replaced: unknown[][] = []
  const warnings: unknown[] = []
  const ctx = {
    logger: { info: vi.fn(), warn: (...args: unknown[]) => { warnings.push(args) }, error: vi.fn() },
    llm: {
      registerConfigurableProviders(entries: unknown[]) {
        if (options.refuse === true) throw new Error('DUPLICATE_DIRECTORY')
        registered.push(entries)
        const handle = (() => {}) as (() => void) & { replace: (next: unknown[]) => void }
        handle.replace = (next: unknown[]) => { replaced.push(next) }
        return handle
      },
    },
  } as unknown as Context
  return { ctx, registered, replaced, warnings }
}

describe('registerDirectory', () => {
  const entry = directoryEntryOf({
    region: 'cn',
    providerId: 'workbuddy-oauth',
    displayName: 'WorkBuddy (国内版)',
    shimOrigin: 'http://127.0.0.1:39271',
    settingsNs: 'llm-pi-ai',
  })

  it('registers the whole set in one call', () => {
    const { ctx, registered } = directoryContext()
    registerDirectory(ctx, [entry])
    expect(registered).toHaveLength(1)
    expect(registered[0]).toEqual([entry])
  })

  it('refuses an empty set without touching the service', () => {
    const { ctx, registered } = directoryContext()
    expect(registerDirectory(ctx, [])).toBeUndefined()
    expect(registered).toHaveLength(0)
  })

  it('reports a refused registration instead of aborting the region', () => {
    // A duplicate declaration means something else claims this route's entry.
    // The route still publishes and still serves; only the presentation is lost,
    // so this must not throw into the caller's startup path.
    const { ctx, warnings } = directoryContext({ refuse: true })
    expect(registerDirectory(ctx, [entry])).toBeUndefined()
    expect(warnings).toHaveLength(1)
  })
})

describe('flowKeyFor', () => {
  it('registers under the scope the Models page reads', () => {
    // The page derives a route's methods from `llm-pi-ai/<provider>`; any other
    // scope leaves the sign-in button with no flow behind it.
    expect(flowKeyFor('workbuddy-oauth-ai')).toBe('llm-pi-ai/workbuddy-oauth-ai')
  })

  it('rejects a provider id outside the credential grammar', () => {
    expect(() => flowKeyFor('WorkBuddy.AI')).toThrow()
  })
})

/** A context carrying a recording authorization registry. */
function flowContext(): {
  ctx: Context
  flows: Array<{ key: string; label: string; methods: readonly { id: string }[]; run: (s: AuthorizationSession) => Promise<void> }>
  warnings: unknown[]
} {
  const flows: Array<{ key: string; label: string; methods: readonly { id: string }[]; run: (s: AuthorizationSession) => Promise<void> }> = []
  const warnings: unknown[] = []
  const ctx = {
    logger: { info: vi.fn(), warn: (...args: unknown[]) => { warnings.push(args) }, error: vi.fn() },
    get: (name: string) => name === 'authorization'
      ? {
          registerFlow(flow: typeof flows[number]) {
            flows.push(flow)
            return () => {}
          },
        }
      : undefined,
  } as unknown as Context
  return { ctx, flows, warnings }
}

/** A session that records what the flow reported and can be aborted. */
function session(overrides: Partial<AuthorizationSession> = {}): AuthorizationSession & { notices: unknown[] } {
  const notices: unknown[] = []
  return {
    method: 'oauth',
    signal: new AbortController().signal,
    notify: (notice) => { notices.push(notice) },
    prompt: async () => '',
    notices,
    ...overrides,
  }
}

describe('registerSignInFlow', () => {
  it('does nothing without an authorization service', () => {
    // Headless and ACP profiles have no sign-in surface; the commands remain.
    const ctx = { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, get: () => undefined } as unknown as Context
    expect(registerSignInFlow(ctx, 'workbuddy-oauth', 'cn', {
      begin: async () => ({ url: 'u', state: 's' }),
      complete: async () => ({ uid: 'u', label: 'l' }),
      isPending: () => false,
    })).toBeUndefined()
  })

  it('offers exactly one OAuth method', () => {
    const { ctx, flows } = flowContext()
    registerSignInFlow(ctx, 'workbuddy-oauth', 'cn', {
      begin: async () => ({ url: 'u', state: 's' }),
      complete: async () => ({ uid: 'u', label: 'l' }),
      isPending: () => false,
    })
    expect(flows).toHaveLength(1)
    expect(flows[0]!.methods.map(method => method.id)).toEqual(['oauth'])
    expect(flows[0]!.key).toBe('llm-pi-ai/workbuddy-oauth')
  })

  it('notifies the authorization URL before polling', async () => {
    const { ctx, flows } = flowContext()
    const begin = vi.fn(async () => ({ url: 'https://example.test/auth', state: 'state-1' }))
    registerSignInFlow(ctx, 'workbuddy-oauth', 'cn', {
      begin,
      complete: async () => ({ uid: 'u', label: '账号 A' }),
      isPending: () => false,
    })
    const current = session()
    await flows[0]!.run(current)
    const notice = current.notices[0] as { url?: string }
    expect(notice.url).toBe('https://example.test/auth')
  })

  it('polls through pending answers and reports the signed-in account', async () => {
    const { ctx, flows } = flowContext()
    let calls = 0
    registerSignInFlow(ctx, 'workbuddy-oauth', 'cn', {
      begin: async () => ({ url: 'u', state: 's' }),
      complete: async () => {
        calls += 1
        if (calls < 3) throw new Error('pending')
        return { uid: 'u', label: '账号 A' }
      },
      isPending: () => true,
      sleep: async () => {},
    })
    const current = session()
    await flows[0]!.run(current)
    expect(calls).toBe(3)
    expect(JSON.stringify(current.notices)).toContain('账号 A')
  })

  it('fails on a non-pending error instead of reporting success', async () => {
    const { ctx, flows } = flowContext()
    registerSignInFlow(ctx, 'workbuddy-oauth', 'cn', {
      begin: async () => ({ url: 'u', state: 's' }),
      complete: async () => { throw new Error('upstream refused') },
      isPending: () => false,
      sleep: async () => {},
    })
    await expect(flows[0]!.run(session())).rejects.toThrow('upstream refused')
  })

  it('gives up after the attempt budget instead of waiting forever', async () => {
    const { ctx, flows } = flowContext()
    registerSignInFlow(ctx, 'workbuddy-oauth', 'cn', {
      begin: async () => ({ url: 'u', state: 's' }),
      complete: async () => { throw new Error('pending') },
      isPending: () => true,
      sleep: async () => {},
      attempts: 3,
    })
    await expect(flows[0]!.run(session())).rejects.toThrow()
  })

  it('stops when the attempt is cancelled', async () => {
    const { ctx, flows } = flowContext()
    const controller = new AbortController()
    registerSignInFlow(ctx, 'workbuddy-oauth', 'cn', {
      begin: async () => ({ url: 'u', state: 's' }),
      complete: async () => { throw new Error('pending') },
      isPending: () => true,
      sleep: async () => { controller.abort() },
    })
    await expect(flows[0]!.run(session({ signal: controller.signal }))).rejects.toThrow()
  })

  it('reports a duplicate key instead of taking the region down', () => {
    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      get: () => ({ registerFlow: () => { throw new Error('DUPLICATE_FLOW') } }),
    } as unknown as Context
    expect(registerSignInFlow(ctx, 'workbuddy-oauth', 'cn', {
      begin: async () => ({ url: 'u', state: 's' }),
      complete: async () => ({ uid: 'u', label: 'l' }),
      isPending: () => false,
    })).toBeUndefined()
  })
})
