import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type { WorkBuddyModelInfo } from './catalog.ts'
import { storedRoute, type PublishOutcome } from './route-publisher.ts'

export interface ManualProfile { models: WorkBuddyModelInfo[] }
export const manualProfilesSchema: z = z.dict(z.object({
  models: z.array(z.object({
    id: z.string().pattern(/\S/).required(), name: z.string().pattern(/\S/).required(),
    contextWindow: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
    maxTokens: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
    supportsImages: z.boolean(),
    reasoning: z.object({
      supports: z.boolean(), onlyReasoning: z.boolean(),
      supportedEfforts: z.array(z.union(['low', 'medium', 'high', 'xhigh', 'max'] as const)), defaultEffort: z.union(['low', 'medium', 'high', 'xhigh', 'max'] as const),
      canDisableThinking: z.boolean(),
    }),
  })).default([]),
})).default({}).volatile()

/** Resolve the actual loader entry, never assume a profile-specific namespace. */
export function manualDescriptor(ctx: Context) {
  const settings = ctx.get('settings')
  const editor = ctx.get('configEditor') as { entries(): Array<{ options: { name: string; id: string } }> } | undefined
  if (!settings || !editor) return undefined
  const ids = new Set(editor.entries().filter(entry => entry.options.name === 'dsh-workbuddy-oauth').map(entry => entry.options.id))
  const matches = settings.describe({ redactSecrets: true }).filter(entry => ids.has(entry.ns))
  return matches.length === 1 ? matches[0] : undefined
}
export function manualProfile(ctx: Context, provider: string): ManualProfile | undefined {
  const value = manualDescriptor(ctx)?.value as { providers?: Record<string, ManualProfile> } | undefined
  return value?.providers?.[provider]
}
const queues = new WeakMap<object, Promise<unknown>>()
/** The only provider-write operation. Both UI and agent transports must supply IDs. */
export function saveManualProvider(ctx: Context, provider: string, roster: readonly WorkBuddyModelInfo[], ids: readonly string[] | null, active: () => boolean = () => true): Promise<PublishOutcome> {
  const owner = ctx.get('settings') ?? ctx
  const task = (queues.get(owner) ?? Promise.resolve()).catch(() => {}).then(async (): Promise<PublishOutcome> => {
    const modelCount = ids?.length ?? 0
    const reject = (reason: string): PublishOutcome => ({ published: false, action: 'rejected', reason, modelCount })
    try {
      if (!active()) return reject('Plugin disposed')
      if (storedRoute(ctx, provider) !== undefined) return reject('Legacy llm-pi-ai route is preserved; edit it in Models settings.')
      const descriptor = manualDescriptor(ctx)
      const settings = ctx.get('settings')
      if (!descriptor || !settings) return reject('No unique WorkBuddy settings namespace')
      if (ids === null) {
        await settings.mutate(descriptor.ns, [{ op: 'unset', path: ['providers', provider] }], descriptor.revision)
      } else {
        if (ids.length > 256 || new Set(ids).size !== ids.length) return reject('Invalid model selection')
        const previous = manualProfile(ctx, provider)?.models ?? []
        const models = ids.map(id => previous.find(m => m.id === id) ?? roster.find(m => m.id === id))
        if (models.some(m => !m)) return reject('Unknown model in selection; refresh catalog and retry')
        const snapshots = models.map(model => {
          const m = model!
          return { id: m.id, name: m.name, contextWindow: m.contextWindow, maxTokens: m.maxTokens,
            ...(m.supportsImages === undefined ? {} : { supportsImages: m.supportsImages }),
            ...(m.reasoning === undefined ? {} : { reasoning: m.reasoning }) }
        })
        await settings.mutate(descriptor.ns, [{ op: 'set', path: ['providers', provider], value: { models: snapshots } }], descriptor.revision)
      }
      return { published: true, action: 'written', modelCount }
    } catch (error) { return reject(error instanceof Error ? error.message : String(error)) }
  })
  queues.set(owner, task)
  return task
}

declare module '@deepseek-ai/cordis' {
  interface Events { 'loader/volatile-update'(): void }
}
