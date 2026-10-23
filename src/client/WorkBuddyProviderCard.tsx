import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type { WorkBuddyWebStatus } from '../status-paths.ts'
import { readStatus, sendControl, type ControlRequest } from './host.ts'
import { ModelSelection } from './ModelSelection.tsx'

type Props = PropsRuntime<'settings.models.provider-card'> & PropsLocale<'workbuddy'>

/** Native provider-picker companion; opening it never writes provider configuration. */
export function WorkBuddyProviderCard({ provider, t }: Props) {
  const [status, setStatus] = useState<WorkBuddyWebStatus>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)
  useEffect(() => {
    const abort = new AbortController()
    void readStatus(abort.signal).then(value => { if (!abort.signal.aborted) setStatus(value) })
    return () => abort.abort()
  }, [provider.provider])
  const region = status?.regions.find(value => value.providerId === provider.provider)
  const run = async (body?: ControlRequest) => {
    if (busy) return
    setBusy(true)
    setNotice('')
    try {
      if (body && status && region) {
        const result = await sendControl(region.controlPath, status.controlKey, body)
        if (result?.state !== 'ok') {
          setNotice(t('selectionFailed', { reason: result?.reason ?? t('statusUnavailable') }))
          return
        }
        setNotice(t('selectionSaved'))
      }
      const next = await readStatus()
      if (next) setStatus(next)
      else setNotice(t('statusUnavailable'))
    } finally { setBusy(false); setConfirmRemove(false) }
  }
  return <section className="wb-card" aria-label="WorkBuddy">
    <strong>{provider.displayName}</strong>
    {notice ? <p role="status" className="wb-note">{notice}</p> : null}
    <button type="button" className="wb-btn" disabled={busy} onClick={() => { void run() }}>{t('refresh')}</button>
    {region ? <>
      <ModelSelection region={region} busy={busy} t={t}
        onSave={modelIds => run({ action: 'sync-provider', modelIds })} />
      {region.route.configured ? <button type="button" className="wb-btn wb-btn-danger" disabled={busy}
        onClick={() => { if (confirmRemove) void run({ action: 'remove-provider' }); else setConfirmRemove(true) }}>
        {t(confirmRemove ? 'removeConfirm' : 'removeProvider')}
      </button> : null}
    </> : <p>{t('statusUnavailableHint')}</p>}
  </section>
}
