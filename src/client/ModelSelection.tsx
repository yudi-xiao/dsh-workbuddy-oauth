import { useEffect, useState } from 'react'
import type { WorkBuddyConfigPageProps } from './WorkBuddyConfigPage.tsx'
import type { WorkBuddyWebRegion } from '../status-paths.ts'
import { selectableModels, toggleSelected } from './model-selection.ts'

/** Draft state is always explicit: a new provider starts with nothing selected. */
export function ModelSelection({ region, busy, t, onSave }: {
  region: WorkBuddyWebRegion
  busy: boolean
  t: WorkBuddyConfigPageProps['t']
  onSave: (modelIds: string[]) => Promise<void>
}) {
  const saved = JSON.stringify(region.route.selectedModelIds ?? [])
  const [selected, setSelected] = useState<string[]>(() => JSON.parse(saved) as string[])
  useEffect(() => { setSelected(JSON.parse(saved) as string[]) }, [saved, region.providerId])
  return <div className="wb-panel">
    <p className="wb-hint">{t('manualIntro')}</p>
    {!region.signedIn ? <p className="wb-note">{t('manualLoginHint')}</p> : null}
    <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="wb-label">{t('selectionCount', { count: selected.length })}</legend>
      <div className="wb-grid" style={{ maxHeight: 280, overflowY: 'auto' }}>
        {selectableModels(region.models, selected).map(model => <label key={model.id} className="wb-mrow">
          <input type="checkbox" checked={selected.includes(model.id)}
            onChange={event => setSelected(value => toggleSelected(value, model.id, event.target.checked))} />
          <span className="wb-mname">{model.name} <small>{model.id}</small></span>
        </label>)}
      </div>
      <button type="button" className="wb-btn wb-btn-primary"
        disabled={busy || (!region.signedIn && !region.route.configured)}
        onClick={() => { void onSave(selected) }}>{t('saveSelection')}</button>
    </fieldset>
  </div>
}
