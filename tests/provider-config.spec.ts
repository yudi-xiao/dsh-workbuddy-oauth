/**
 * Route-publishing tests.
 *
 * These pin the contract that replaced the plugin's own adapter: WorkBuddy's
 * models reach the picker as an ordinary `llm-pi-ai` provider route, written
 * through the settings seam, with the endpoint's bearer stored through the
 * credential seam rather than in configuration.
 *
 * Every assertion here is about a failure that is silent in production: a route
 * whose `api` or `baseURL` is wrong answers nothing and looks merely unconfigured;
 * a route whose credential reference resolves to nothing fails every request with
 * `MISSING_CREDENTIAL`; and a route that is rewritten when nothing changed
 * restarts the model directory on every startup.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  publishRoute,
  publishedModelOf,
  reasoningEffortsOf,
  routeMatches,
  ROUTE_API,
  ROUTE_API_KEY_ENV,
  routeApiKeyEnv,
  type PublishedRoute,
} from '../src/provider-config.ts'
import { publishProviderRoute, storedRoute } from '../src/route-publisher.ts'
import { FALLBACK_WORKBUDDY_AI_MODELS, FALLBACK_WORKBUDDY_MODELS } from '../src/catalog.ts'
import type { WorkBuddyModelInfo } from '../src/catalog.ts'
import type { WorkBuddyProbeRecord } from '../src/probe-store.ts'

/** A model row with nothing declared, so each test states only what it means. */
function model(overrides: Partial<WorkBuddyModelInfo> = {}): WorkBuddyModelInfo {
  return {
    id: 'm', name: 'M', contextWindow: 100_000, maxTokens: 16_000, supportsImages: false,
    ...overrides,
  }
}

/** A `validating` observation, which is the only kind that supplies a level set. */
function observed(efforts: readonly ('low' | 'medium' | 'high' | 'xhigh' | 'max')[]): WorkBuddyProbeRecord {
  return {
    fingerprint: 'f', validation: 'validating', efforts,
    probedAtMs: 1, pluginVersion: 'v', account: 'a',
  }
}

describe('reasoningEffortsOf', () => {
  it('publishes a non-reasoning model as false', () => {
    expect(reasoningEffortsOf(model(), undefined, 'cn')).toBe(false)
    expect(reasoningEffortsOf(
      model({ reasoning: { supports: false, onlyReasoning: false, canDisableThinking: true } }),
      undefined,
      'cn',
    )).toBe(false)
  })

  it('takes a declared set verbatim', () => {
    const efforts = reasoningEffortsOf(
      model({
        reasoning: {
          supports: true, onlyReasoning: true, canDisableThinking: false,
          supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high',
        },
      }),
      undefined,
      'global',
    )
    expect(efforts).toEqual({ low: 'low', high: 'high', max: 'max' })
  })

  it('never offers minimal, which the upstream vocabulary does not contain', () => {
    const efforts = reasoningEffortsOf(
      model({
        reasoning: {
          supports: true, onlyReasoning: true, canDisableThinking: true,
          supportedEfforts: ['low', 'max'],
        },
      }),
      undefined,
      'global',
    )
    expect(efforts).not.toBe(false)
    expect(efforts).not.toHaveProperty('minimal')
  })

  it('offers off only when the model declares it can disable thinking', () => {
    const withoutOff = reasoningEffortsOf(
      model({
        reasoning: {
          supports: true, onlyReasoning: true, canDisableThinking: false,
          supportedEfforts: ['high'],
        },
      }),
      undefined,
      'global',
    )
    expect(withoutOff).toEqual({ high: 'high' })

    const withOff = reasoningEffortsOf(
      model({
        reasoning: {
          supports: true, onlyReasoning: true, canDisableThinking: true,
          supportedEfforts: ['high'],
        },
      }),
      undefined,
      'global',
    )
    expect(withOff).toEqual({ off: 'off', high: 'high' })
  })

  it('vetoes off on the CN endpoint for a row that also declares onlyReasoning', () => {
    // Measured: the CN endpoint rejects the literal spelling with 400/11150 on
    // these rows, so offering the level could only produce a failed request.
    const row = model({
      reasoning: {
        supports: true, onlyReasoning: true, canDisableThinking: true,
        supportedEfforts: ['high'],
      },
    })
    expect(reasoningEffortsOf(row, undefined, 'cn')).toEqual({ high: 'high' })
    // The international roster carries the same contradictory pair on rows that
    // do accept it, hence the region guard rather than a blanket rule.
    expect(reasoningEffortsOf(row, undefined, 'global')).toEqual({ off: 'off', high: 'high' })
  })

  it('falls back to a validating observation for an undeclared row', () => {
    const row = model({
      reasoning: { supports: true, onlyReasoning: true, canDisableThinking: false, defaultEffort: 'medium' },
    })
    expect(reasoningEffortsOf(row, observed(['low', 'high']), 'global')).toEqual({ low: 'low', high: 'high' })
  })

  it('ignores a non-validating observation, which accepts spellings that cannot exist', () => {
    const row = model({
      reasoning: { supports: true, onlyReasoning: true, canDisableThinking: false, defaultEffort: 'medium' },
    })
    const nonValidating: WorkBuddyProbeRecord = { ...observed(['low', 'high']), validation: 'non-validating' }
    expect(reasoningEffortsOf(row, nonValidating, 'global')).toEqual({ medium: 'medium' })
  })

  it('offers the declared default when nothing else is known', () => {
    const row = model({
      reasoning: { supports: true, onlyReasoning: true, canDisableThinking: false, defaultEffort: 'high' },
    })
    expect(reasoningEffortsOf(row, undefined, 'global')).toEqual({ high: 'high' })
  })

  it('never emits a map whose only level is off', () => {
    // `llm-pi-ai` refuses such an entry, and the refusal is about the whole
    // route, so one bad row would make every model unserviceable.
    const row = model({
      reasoning: { supports: true, onlyReasoning: true, canDisableThinking: true, defaultEffort: 'low' },
    })
    const efforts = reasoningEffortsOf(row, observed([]), 'global')
    expect(efforts).not.toBe(false)
    expect(Object.keys(efforts as Record<string, string>).some(level => level !== 'off')).toBe(true)
  })
})

describe('publishedModelOf', () => {
  it('carries the capacities the picker shows', () => {
    const entry = publishedModelOf(model({ contextWindow: 400_000, maxTokens: 128_000 }), undefined, 'global')
    expect(entry.contextWindow).toBe(400_000)
    expect(entry.maxTokens).toBe(128_000)
  })

  it('declares image input only for a model that supports it', () => {
    expect(publishedModelOf(model({ supportsImages: true }), undefined, 'global').input).toEqual(['text', 'image'])
    expect(publishedModelOf(model({ supportsImages: false }), undefined, 'global').input).toEqual(['text'])
  })
})

describe('publishRoute', () => {
  it('points at the shim origin and names the credential reference', () => {
    const route = publishRoute({
      region: 'global',
      displayName: 'WorkBuddy AI (国际版)',
      shimOrigin: 'http://127.0.0.1:39272',
      models: [model()],
    })
    expect(route.baseURL).toBe('http://127.0.0.1:39272/v1')
    expect(route.apiKeyEnv).toBe(routeApiKeyEnv('global'))
    expect(route.api).toBe(ROUTE_API)
    expect(route.displayName).toBe('WorkBuddy AI (国际版)')
  })

  it('publishes one entry per catalog row, in catalog order', () => {
    const models = FALLBACK_WORKBUDDY_AI_MODELS.slice(0, 5)
    const route = publishRoute({
      region: 'global', displayName: 'AI', shimOrigin: 'http://127.0.0.1:1', models,
    })
    expect(route.models.map(entry => entry.id)).toEqual(models.map(entry => entry.id))
  })

  it('produces an entry llm-pi-ai can materialize for every shipped catalog row', () => {
    // The published list replaces the route's catalog wholesale, so one row
    // `llm-pi-ai` refuses takes the whole route down. These are the rules its
    // resolver enforces, checked here without booting a host.
    for (const [region, models] of [
      ['cn', FALLBACK_WORKBUDDY_MODELS],
      ['global', FALLBACK_WORKBUDDY_AI_MODELS],
    ] as const) {
      const route = publishRoute({
        region, displayName: 'x', shimOrigin: 'http://127.0.0.1:1', models,
      })
      for (const entry of route.models) {
        expect(entry.id).toBeTypeOf('string')
        expect(entry.id.length).toBeGreaterThan(0)
        expect(Number.isInteger(entry.contextWindow)).toBe(true)
        expect(entry.maxTokens).toBeGreaterThan(0)
        if (entry.reasoningEfforts !== false) {
          const levels = Object.keys(entry.reasoningEfforts ?? {})
          // At least one level beyond `off`, and every non-off level carries a
          // non-empty wire spelling.
          expect(levels.some(level => level !== 'off')).toBe(true)
          for (const level of levels) {
            if (level === 'off') continue
            expect((entry.reasoningEfforts as Record<string, string>)[level]).toBeTruthy()
          }
        }
      }
    }
  })
})

describe('routeMatches', () => {
  const base: PublishedRoute = {
    displayName: 'AI',
    api: ROUTE_API,
    baseURL: 'http://127.0.0.1:39272/v1',
    apiKeyEnv: ROUTE_API_KEY_ENV,
    compat: { maxTokensField: 'max_tokens' },
    models: [{ id: 'a', name: 'A', contextWindow: 1, maxTokens: 1, input: ['text'], reasoningEfforts: false }],
  }

  it('matches an identical route, so no write is made', () => {
    expect(routeMatches(structuredClone(base), base)).toBe(true)
  })

  it('rejects a changed endpoint', () => {
    expect(routeMatches({ ...structuredClone(base), baseURL: 'http://127.0.0.1:1/v1' }, base)).toBe(false)
  })

  it('rejects a reordered model list, because order is what the picker shows', () => {
    const two = { ...base, models: [...base.models, { id: 'b', name: 'B' }] }
    const reversed = { ...two, models: [...two.models].reverse() }
    expect(routeMatches(reversed, two)).toBe(false)
  })

  it('rejects a missing route', () => {
    expect(routeMatches(undefined, base)).toBe(false)
    expect(routeMatches(null, base)).toBe(false)
  })
})

/** A context whose settings section is a live `providers` dict. */
function settingsContext(): {
  ctx: Context
  providers: Record<string, unknown>
  mutations: Array<{ ns: string; ops: unknown[] }>
  secrets: Map<string, string>
} {
  const providers: Record<string, unknown> = {}
  const mutations: Array<{ ns: string; ops: unknown[] }> = []
  const secrets = new Map<string, string>()
  const settings = {
    describe: () => [{
      ns: 'custom-pi-entry', autoGenerate: true, schema: {}, revision: 1,
      value: { providers }, applies: 'live' as const,
    }],
    mutate: async (ns: string, ops: unknown[]) => {
      mutations.push({ ns, ops })
      for (const raw of ops as Array<{ op: string; path: string[]; value?: unknown }>) {
        const key = raw.path[1]
        if (key === undefined) continue
        if (raw.op === 'set') {
          if (raw.path[2]) (providers[key] as Record<string, unknown>)[raw.path[2]] = raw.value
          else providers[key] = raw.value
        }
        else delete providers[key]
      }
    },
  }
  const credentials = { set: async (ref: string, value: string) => { secrets.set(ref, value) } }
  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    get: (name: string) => (name === 'configEditor' ? { entries: () => [{ options: { name: '@deepseek-ai/dsh-llm-pi-ai', id: 'custom-pi-entry' } }] } : name === 'settings' ? settings : name === 'credentials' ? credentials : undefined),
  } as unknown as Context
  return { ctx, providers, mutations, secrets }
}

describe('publishProviderRoute', () => {
  const request = {
    providerId: 'workbuddy-oauth-ai',
    region: 'global' as const,
    displayName: 'WorkBuddy AI (国际版)',
    shimOrigin: 'http://127.0.0.1:39272',
    models: [model({ id: 'gpt-6-astra', name: 'GPT-6 Astra' })],
    token: 'shim-secret',
  }

  it('writes the route under llm-pi-ai and stores the bearer separately', async () => {
    const { ctx, providers, secrets } = settingsContext()
    const outcome = await publishProviderRoute(ctx, request)

    expect(outcome.action).toBe('written')
    expect(outcome.modelCount).toBe(1)
    const entry = providers['workbuddy-oauth-ai'] as Record<string, unknown>
    expect(entry['baseURL']).toBe('http://127.0.0.1:39272/v1')
    expect(entry['apiKeyEnv']).toBe(routeApiKeyEnv('global'))
    // The secret is in the credential seam, never in the configuration.
    expect(JSON.stringify(entry)).not.toContain('shim-secret')
    expect(secrets.get(routeApiKeyEnv('global'))).toBe('shim-secret')
  })

  it('skips the write when the stored route already matches', async () => {
    const { ctx, mutations } = settingsContext()
    await publishProviderRoute(ctx, request)
    const afterFirst = mutations.length
    const outcome = await publishProviderRoute(ctx, request)

    expect(outcome.action).toBe('unchanged')
    expect(mutations).toHaveLength(afterFirst)
  })

  it('refreshes the stored bearer even when the route is unchanged', async () => {
    // The bearer is per-process: after a restart the stored value names the
    // previous shim, so a skipped credential write would fail every request.
    const { ctx, secrets } = settingsContext()
    await publishProviderRoute(ctx, request)
    await publishProviderRoute(ctx, { ...request, token: 'next-process-secret' })
    expect(secrets.get(routeApiKeyEnv('global'))).toBe('next-process-secret')
  })

  it('preserves user models and custom fields on startup and signed-out refresh', async () => {
    const { ctx, providers, mutations } = settingsContext()
    await publishProviderRoute(ctx, request)
    const route = providers[request.providerId] as Record<string, unknown>
    route['models'] = [{ id: 'user-edited', maxTokens: 7 }]
    route['headers'] = { 'X-Custom': 'value' }
    const before = structuredClone(route)
    expect((await publishProviderRoute(ctx, { ...request, models: [] })).published).toBe(true)
    expect(route).toEqual(before)
    expect(mutations).toHaveLength(1)
  })

  it('explicit sync replaces only models and rejects an empty list', async () => {
    const { ctx, providers } = settingsContext()
    await publishProviderRoute(ctx, request)
    const route = providers[request.providerId] as Record<string, unknown>
    route['displayName'] = 'User label'
    route['headers'] = { Test: 'kept' }
    route['models'] = [{ id: 'custom' }]
    expect((await publishProviderRoute(ctx, { ...request, mode: 'sync', models: [] })).action).toBe('rejected')
    expect(route['models']).toEqual([{ id: 'custom' }])
    expect((await publishProviderRoute(ctx, { ...request, mode: 'sync' })).published).toBe(true)
    expect(route['models']).toEqual(publishRoute(request).models)
    expect(route['displayName']).toBe('User label')
    expect(route['headers']).toEqual({ Test: 'kept' })
  })

  it('migrates a shared credential without changing user models', async () => {
    const { ctx, providers } = settingsContext()
    providers[request.providerId] = { ...publishRoute(request), apiKeyEnv: ROUTE_API_KEY_ENV, models: [] }
    await publishProviderRoute(ctx, request)
    expect(storedRoute(ctx, request.providerId)).toMatchObject({ apiKeyEnv: routeApiKeyEnv('global'), models: [] })
  })

  it('keeps simultaneous regional credential writes independent', async () => {
    const { ctx, secrets, providers } = settingsContext()
    const outcomes = await Promise.all([
      publishProviderRoute(ctx, request),
      publishProviderRoute(ctx, { ...request, region: 'cn', providerId: 'workbuddy-oauth', token: 'cn-secret' }),
    ])
    expect(outcomes.every(outcome => outcome.published)).toBe(true)
    expect(Object.keys(providers)).toHaveLength(2)
    expect(secrets.get(routeApiKeyEnv('cn'))).toBe('cn-secret')
    expect(secrets.get(routeApiKeyEnv('global'))).toBe('shim-secret')
  })

  it('does not mutate routes when stopped during credential storage', async () => {
    const { ctx, mutations } = settingsContext()
    let active = true
    ctx.get('credentials')!.set = async () => { active = false }
    const outcome = await publishProviderRoute(ctx, { ...request, active: () => active })
    expect(outcome.action).toBe('rejected')
    expect(mutations).toEqual([])
  })

  it('rejects a missing credentials service and preserves a changed endpoint', async () => {
    const { ctx, providers, secrets } = settingsContext()
    providers[request.providerId] = { ...publishRoute(request), baseURL: 'http://localhost:9999/v1' }
    expect((await publishProviderRoute(ctx, request)).action).toBe('rejected')
    expect(secrets.size).toBe(0)
    const get = ctx.get.bind(ctx)
    ctx.get = ((name: string) => name === 'credentials' ? undefined : get(name)) as typeof ctx.get
    expect((await publishProviderRoute(ctx, request)).reason).toContain('credentials')
  })

  it('reports no-settings rather than throwing in a headless composition', async () => {
    const ctx = { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, get: () => undefined } as unknown as Context
    const outcome = await publishProviderRoute(ctx, request)
    expect(outcome.action).toBe('no-settings')
    expect(outcome.published).toBe(false)
  })

  it('reports a refused write instead of claiming success', async () => {
    const { ctx } = settingsContext()
    ctx.get('settings')!.mutate = async () => { throw new Error('settings/conflict') }
    const outcome = await publishProviderRoute(ctx, request)
    expect(outcome.action).toBe('rejected')
    expect(outcome.reason).toContain('conflict')
  })
})

