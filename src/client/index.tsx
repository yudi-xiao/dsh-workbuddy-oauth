/**
 * Browser half: WorkBuddy accounts and explicit native provider registration.
 *
 * Settings registration is guarded; client failures do not take down the Host.
 *
 * Uses the Plugins page (`plugins.bundle.config`, keyed by bundle name) and
 * native provider cards (`settings.models.provider-card`, keyed by the live
 * settings namespace). It never restores removed provider selections.
 *
 * @module dsh-workbuddy-oauth/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the slot declaration this bundle registers into. The Plugins page
// declares `plugins.bundle.config`. Cross-plugin collaboration goes through cordis
// services, so value imports would fail the client bundle-purity gate.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { WorkBuddyConfigPage } from './WorkBuddyConfigPage.tsx'
import { WorkBuddyProviderCard } from './WorkBuddyProviderCard.tsx'
import { readStatus } from './host.ts'
import { installStyles } from './styles.ts'
import { en, zh, type WorkBuddyLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** WorkBuddy card and control copy. */
    'workbuddy': WorkBuddyLocaleKey
  }
}

/** Stable browser-plugin name. */
export const name = 'dsh-workbuddy-oauth-client'

/** The bundle's package name, which is also this half's configuration key. */
export const BUNDLE_NAME = 'dsh-workbuddy-oauth'

/** Required client services. */
export const inject = ['slots', 'locale']

/** Prefix every guarded client contribution's degradation logs with this. */
const CLIENT_CONTRIBUTION_FAILED = '[dsh-workbuddy-oauth] client contribution failed to load (host provider unaffected):'

/** Disposer handed back when a deferred registration degraded: nothing to undo. */
const NOOP_DISPOSER = (): void => {}

/**
 * Run ONE browser-side contribution, degrading its failure to a `console.error`
 * instead of throwing into the DSH loader. Returns the contribution's own value
 * on success, or `undefined` when it degraded.
 *
 * Guarded at both boundaries where it can throw: the eager
 * `ctx.slots.inject(...)` call (a slot-API shape break) and the deferred slot
 * callback (which the slot runtime invokes long after `apply` has returned).
 */
function guardClientContribution<T>(label: string, fn: () => T): T | undefined {
  try {
    return fn()
  } catch (error: unknown) {
    console.error(`${CLIENT_CONTRIBUTION_FAILED} ${label}`, error)
    return undefined
  }
}

/** Register the bundle's browser-side contributions. */
export function apply(ctx: ClientContext): void {
  const namespace = 'workbuddy'
  // Install the card's stylesheet once per document, before anything renders:
  // the interaction states the card depends on (`:hover`, `:active`,
  // `:focus-visible`, `:disabled`) cannot be expressed by inline styles. Its own
  // failure is not fatal — an unstyled card still works, so this is guarded like
  // every other contribution.
  guardClientContribution('stylesheet', () => { installStyles() })
  guardClientContribution('settings copy', () => {
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-workbuddy-oauth: settings copy')
  })

  guardClientContribution('settings.models.provider-card', () => {
    ctx.slots.inject('settings.models.provider-card', () => {
      const abort = new AbortController()
      const disposers: (() => void)[] = []
      let timer: ReturnType<typeof setTimeout> | undefined
      let attempts = 0
      const register = async () => {
        const status = await readStatus(abort.signal)
        if (abort.signal.aborted) return
        const namespaces = new Set(status?.regions.flatMap(region => region.route.settingsNs ? [region.route.settingsNs] : []) ?? [])
        if (namespaces.size) {
          for (const key of namespaces) {
            const dispose = guardClientContribution('manual provider card', () => ctx.slots.register({
              name: 'settings.models.provider-card', key, locale: namespace,
            }, WorkBuddyProviderCard))
            if (dispose) disposers.push(dispose)
          }
        } else if (++attempts < 12) timer = setTimeout(() => { void register() }, 5000)
      }
      void register()
      return () => { abort.abort(); clearTimeout(timer); for (const dispose of disposers) dispose() }
    })
  })

  // The Plugins-page configuration entry, keyed by the bundle's package name as
  // the page dispatches it. This is the settings card (P2.4).
  guardClientContribution('plugins.bundle.config page', () => {
    ctx.slots.inject('plugins.bundle.config', () => (
      guardClientContribution('plugins.bundle.config page', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: BUNDLE_NAME,
        locale: namespace,
      }, WorkBuddyConfigPage)) ?? NOOP_DISPOSER
    ))
  })

}
