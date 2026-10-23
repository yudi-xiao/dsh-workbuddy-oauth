import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { FALLBACK_WORKBUDDY_MODELS, FALLBACK_WORKBUDDY_AI_MODELS } from '../src/catalog.ts'
import { manualDescriptor, manualProfile, saveManualProvider, manualProfilesSchema } from '../src/manual-providers.ts'

const model = { id: 'chosen', name: 'Chosen', contextWindow: 12345, maxTokens: 1000, supportsImages: false }
function fixture(legacy = false) {
  const own: Record<string, unknown> = {}
  let revision = 1
  const writes: unknown[] = []
  const settings = {
    describe: () => [
      { ns: 'profile-specific-id', value: { providers: own }, revision },
      { ns: 'pi-ai', value: { providers: legacy ? { 'workbuddy-oauth': { models: [model] } } : {} }, revision: 1 },
    ],
    mutate: async (ns: string, ops: Array<{ op: string; path: string[]; value?: unknown }>, expected: number) => {
      expect(ns).toBe('profile-specific-id')
      expect(expected).toBe(revision)
      writes.push(ops)
      for (const op of ops) {
        if (op.op === 'unset') delete own[op.path[1]!]
        else own[op.path[1]!] = op.value
      }
      revision++
    },
  }
  const ctx = { get: (key: string) => key === 'settings' ? settings : key === 'configEditor' ? {
    entries: () => [
      { options: { name: 'dsh-workbuddy-oauth', id: 'profile-specific-id' } },
      { options: { name: '@deepseek-ai/dsh-llm-pi-ai', id: 'pi-ai' } },
    ],
  } : undefined } as unknown as Context
  return { ctx, own, writes }
}

describe('manual provider snapshots', () => {
  it('resolves the actual namespace without writing anything', () => {
    const { ctx, writes } = fixture()
    expect(manualDescriptor(ctx)?.ns).toBe('profile-specific-id')
    expect(manualProfile(ctx, 'workbuddy-oauth')).toBeUndefined()
    expect(writes).toEqual([])
  })
  it('saves only explicitly selected IDs and retains metadata without a fresh roster', async () => {
    const { ctx } = fixture()
    expect((await saveManualProvider(ctx, 'workbuddy-oauth', [model, { ...model, id: 'not-selected' }], ['chosen'])).published).toBe(true)
    expect(manualProfile(ctx, 'workbuddy-oauth')?.models).toEqual([model])
    expect((await saveManualProvider(ctx, 'workbuddy-oauth', [], ['chosen'])).published).toBe(true)
    expect(manualProfile(ctx, 'workbuddy-oauth')?.models).toEqual([model])
  })
  it('preserves explicit empty selection and removes only on explicit deletion', async () => {
    const { ctx, own } = fixture()
    await saveManualProvider(ctx, 'workbuddy-oauth', [model], [])
    expect(own).toEqual({ 'workbuddy-oauth': { models: [] } })
    await saveManualProvider(ctx, 'workbuddy-oauth', [model], null)
    expect(own).toEqual({})
    expect(manualProfile(ctx, 'workbuddy-oauth')).toBeUndefined()
  })
  it('rejects unknown and duplicate IDs without mutations', async () => {
    const { ctx, writes } = fixture()
    expect((await saveManualProvider(ctx, 'workbuddy-oauth', [model], ['missing'])).action).toBe('rejected')
    expect((await saveManualProvider(ctx, 'workbuddy-oauth', [model], ['chosen', 'chosen'])).action).toBe('rejected')
    expect(writes).toEqual([])
  })
  it('never changes or replaces legacy pi-ai routes', async () => {
    const { ctx, writes } = fixture(true)
    expect((await saveManualProvider(ctx, 'workbuddy-oauth', [model], ['chosen'])).action).toBe('rejected')
    expect((await saveManualProvider(ctx, 'workbuddy-oauth', [], null)).action).toBe('rejected')
    expect(writes).toEqual([])
  })
  it('rejects queued mutations after disposal', async () => {
    const { ctx, writes } = fixture()
    let active = true
    const queued = saveManualProvider(ctx, 'workbuddy-oauth', [model], ['chosen'], () => active)
    active = false
    expect(await queued).toMatchObject({ published: false, reason: 'Plugin disposed' })
    expect(writes).toEqual([])
  })
  it('rejects malformed core snapshot fields', () => {
    for (const invalid of [{}, { ...model, id: '' }, { ...model, name: ' ' },
      ...[0, -1, 1.5, Infinity, NaN].flatMap(value => [
        { ...model, contextWindow: value }, { ...model, maxTokens: value },
      ])]) {
      expect(() => manualProfilesSchema({ test: { models: [invalid] } })).toThrow()
    }
  })
  it('roundtrips both fallback rosters through the snapshot schema', () => {
    for (const models of [FALLBACK_WORKBUDDY_MODELS, FALLBACK_WORKBUDDY_AI_MODELS]) {
      const parsed = manualProfilesSchema({ test: { models: JSON.parse(JSON.stringify(models)) } }).get()
      expect(parsed.test.models).toMatchObject(models)
      expect(manualProfilesSchema(JSON.parse(JSON.stringify(parsed))).get()).toEqual(parsed)
    }
  })
  it('schema accepts saved model snapshots and empty profiles', () => {
    expect(() => manualProfilesSchema({ 'workbuddy-oauth': { models: [model] } })).not.toThrow()
    expect(() => manualProfilesSchema({ 'workbuddy-oauth': { models: [] } })).not.toThrow()
  })
})
