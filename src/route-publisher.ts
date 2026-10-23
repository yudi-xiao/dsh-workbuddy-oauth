/** Seed standard routes once; explicit sync alone replaces their models. */
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-settings'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { publishRoute, ROUTE_API_KEY_ENV, type PublishInput } from './provider-config.ts'

export interface PublishOutcome {
  published: boolean
  action: 'unchanged' | 'written' | 'no-settings' | 'rejected'
  reason?: string
  modelCount: number
}
export interface PublishRequest extends PublishInput {
  providerId: string
  token: string
  mode?: 'seed' | 'sync'
  active?: () => boolean
}

function descriptorOf(ctx: Context) {
  const settings = ctx.get('settings')
  const editor = ctx.get('configEditor') as { entries(): Array<{ options: { name: string; id: string } }> } | undefined
  if (!settings || !editor) return undefined
  const ids = new Set(editor.entries()
    .filter(entry => entry.options.name === '@deepseek-ai/dsh-llm-pi-ai')
    .map(entry => entry.options.id))
  const matches = settings.describe({ redactSecrets: true }).filter(entry => ids.has(entry.ns))
  return matches.length === 1 ? matches[0] : undefined
}
function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

/**
 * The settings namespace `llm-pi-ai` is mounted under in this composition.
 *
 * Discovered rather than assumed: a profile may mount the plugin under any
 * entry id, and the configurable-provider directory must name the namespace the
 * page will actually read. Matched on the module specifier, because that is the
 * only stable identity — the id is the profile's own choice.
 *
 * @param ctx - the plugin context carrying the optional `configEditor`.
 * @returns the entry id, or `undefined` when the service is absent or the
 *   module is mounted more than once (an ambiguous answer is worse than none).
 */
export function piAiSettingsNs(ctx: Context): string | undefined {
  const editor = ctx.get('configEditor') as { entries(): Array<{ options: { name: string; id: string } }> } | undefined
  if (editor === undefined) return undefined
  const ids = editor.entries()
    .filter(entry => entry.options.name === '@deepseek-ai/dsh-llm-pi-ai')
    .map(entry => entry.options.id)
  return ids.length === 1 ? ids[0] : undefined
}

export function storedRoute(ctx: Context, providerId: string): unknown {
  return object(object(descriptorOf(ctx)?.value)?.['providers'])?.[providerId]
}

// Serialize across both regions because they share one settings revision.
const queues = new WeakMap<object, Promise<unknown>>()
export function publishProviderRoute(ctx: Context, request: PublishRequest): Promise<PublishOutcome> {
  const owner = ctx.get('settings') ?? ctx
  const previous = queues.get(owner) ?? Promise.resolve()
  const task = previous.catch(() => {}).then(() => publish(ctx, request))
  queues.set(owner, task)
  return task
}
async function publish(ctx: Context, request: PublishRequest): Promise<PublishOutcome> {
  const modelCount = request.models.length
  const reject = (reason: string): PublishOutcome => ({ published: false, action: 'rejected', reason, modelCount })
  try {
    if (request.active?.() === false) return reject('plugin is stopping')
    const settings = ctx.get('settings')
    const descriptor = descriptorOf(ctx)
    if (!settings || !descriptor) return { published: false, action: 'no-settings', reason: 'no unique active llm-pi-ai settings entry', modelCount }
    const credentials = ctx.get('credentials')
    if (!credentials) return reject('credentials service is unavailable')
    if (!request.token.trim()) return reject('shim credential is empty')
    const next = publishRoute(request)
    const stored = object(object(descriptor.value)?.['providers'])?.[request.providerId]
    const existing = object(stored)
    if (stored !== undefined && !existing) return reject('existing provider is not an object')
    if ((!existing || request.mode === 'sync') && modelCount === 0) return reject('no serviceable models')
    if (existing && existing['baseURL'] !== next.baseURL) return reject('existing provider endpoint differs; update it explicitly on the Models page')
    if (existing && existing['apiKeyEnv'] !== next.apiKeyEnv && existing['apiKeyEnv'] !== ROUTE_API_KEY_ENV) {
      return reject('existing provider uses a custom credential reference')
    }
    await credentials.set(credentialRef(next.apiKeyEnv), request.token)
    if (request.active?.() === false) return reject('plugin is stopping')
    const ops: Array<{ op: 'set'; path: string[]; value: unknown }> = []
    const path = ['providers', request.providerId]
    if (!existing) ops.push({ op: 'set', path, value: next })
    else {
      // Migrate wire compatibility without replacing custom flags.
      const compat = object(existing['compat'])
      if (existing['compat'] === undefined) ops.push({ op: 'set', path: [...path, 'compat'], value: next.compat })
      else if (compat && compat['maxTokensField'] === undefined) ops.push({ op: 'set', path: [...path, 'compat', 'maxTokensField'], value: 'max_tokens' })
      // Migrate only the old shared secret reference, never the user's models.
      if (existing['apiKeyEnv'] === ROUTE_API_KEY_ENV) ops.push({ op: 'set', path: [...path, 'apiKeyEnv'], value: next.apiKeyEnv })
      if (request.mode === 'sync' && JSON.stringify(existing['models']) !== JSON.stringify(next.models)) {
        ops.push({ op: 'set', path: [...path, 'models'], value: next.models })
      }
    }
    if (ops.length) await settings.mutate(descriptor.ns, ops, descriptor.revision)
    return { published: true, action: ops.length ? 'written' : 'unchanged', modelCount: existing && request.mode !== 'sync' && Array.isArray(existing['models']) ? existing['models'].length : modelCount }
  } catch (error) {
    return reject(error instanceof Error ? error.message : String(error))
  }
}
