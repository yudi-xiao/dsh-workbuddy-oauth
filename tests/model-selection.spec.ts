import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { WorkBuddyWebRegion } from '../src/status-paths.ts'
import { selectableModels, toggleSelected } from '../src/client/model-selection.ts'

const hooks = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0 }))
vi.mock('react', async importOriginal => ({
  ...await importOriginal<object>(),
  useEffect: vi.fn(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++
    if (!(index in hooks.states)) hooks.states[index] = typeof initial === 'function' ? initial() : initial
    return [hooks.states[index], (next: unknown) => { hooks.states[index] = typeof next === 'function' ? next(hooks.states[index]) : next }]
  },
}))
import { ModelSelection } from '../src/client/ModelSelection.tsx'

type Element = { type: unknown; props: Record<string, any> }
function all(node: unknown, type: string): Element[] {
  if (Array.isArray(node)) return node.flatMap(child => all(child, type))
  if (!node || typeof node !== 'object' || !('props' in node)) return []
  const element = node as Element
  return [...(element.type === type ? [element] : []), ...all(element.props.children, type)]
}
const region = {
  providerId: 'workbuddy-oauth-ai', signedIn: true,
  route: { configured: false, selectedModelIds: [] },
  models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
} as unknown as WorkBuddyWebRegion
const t = ((key: string) => key) as Parameters<typeof ModelSelection>[0]['t']
const save = vi.fn(async (_ids: string[]) => {})
function render(value = region) {
  hooks.cursor = 0
  return ModelSelection({ region: value, busy: false, t, onSave: save })
}
beforeEach(() => { hooks.states = []; hooks.cursor = 0; save.mockClear() })

describe('manual model selection', () => {
  it('opening a catalog selects nothing and never saves automatically', () => {
    expect(all(render(), 'input').map(input => input.props.checked)).toEqual([false, false])
    expect(save).not.toHaveBeenCalled()
  })
  it('saves exactly the checked subset only after the explicit button', () => {
    all(render(), 'input')[1]!.props.onChange({ target: { checked: true } })
    expect(save).not.toHaveBeenCalled()
    all(render(), 'button')[0]!.props.onClick()
    expect(save).toHaveBeenCalledWith(['b'])
  })
  it('allows removal of the last model without restoring catalog models', () => {
    const configured = { ...region, route: { ...region.route, configured: true, selectedModelIds: ['a'] } }
    all(render(configured), 'input')[0]!.props.onChange({ target: { checked: false } })
    all(render(configured), 'button')[0]!.props.onClick()
    expect(save).toHaveBeenCalledWith([])
  })
  it('retains saved missing ids visibly rather than silently dropping them', () => {
    expect(selectableModels(region.models, ['gone'])).toEqual([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'gone', name: 'gone' }])
  })
  it('does not duplicate selected IDs and does not mutate input', () => {
    const selection = ['a']
    expect(toggleSelected(selection, 'a', true)).toEqual(['a'])
    expect(toggleSelected(selection, 'a', false)).toEqual([])
    expect(selection).toEqual(['a'])
  })
})
