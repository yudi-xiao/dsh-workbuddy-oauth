/**
 * WorkBuddy models for DeepSeek Harness, signed in through this plugin's own
 * OAuth flow.
 *
 * ## What this is, relative to `dsh-workbuddy-connect`
 *
 * The provider, adapter, shim and upstream client are ported from connect (MIT)
 * and keep its wire behavior, which has been exercised against the live
 * endpoint. What differs is confined to the credential and identity seams:
 *
 * | Concern | connect | here |
 * |---|---|---|
 * | Credential | read + decrypt the desktop app's file | this plugin's OAuth flow |
 * | Outbound identity | read the installed app's version | configuration value |
 * | Accounts | one (whichever the app is signed into) | one per stored file |
 *
 * Consequently there is no desktop-credential decryption, no Electron
 * discovery, no process heartbeat, and no app-bundle parsing in this plugin.
 *
 * ## Structure
 *
 * One provider id (`workbuddy`), parameterized by region at request time rather
 * than duplicated per region. Connect registers two providers because each
 * variant is tied to a different installed app; this plugin has no such tie, so
 * a single provider keeps the settings surface and the model picker smaller.
 * The region still travels with each credential, so a domestic and an
 * international account can coexist.
 *
 * @module dsh-workbuddy-oauth
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { randomBytes } from 'node:crypto'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  piAiSettingsNs,
  publishProviderRoute,
  storedRoute,
  type PublishOutcome,
} from './route-publisher.ts'
import { directoryEntryOf, registerDirectory, type DirectoryEntry } from './provider-directory.ts'
import { registerSignInFlow } from './authorization-flow.ts'
import { routeApiKeyEnv } from './provider-config.ts'
import { FALLBACK_WORKBUDDY_AI_MODELS, FALLBACK_WORKBUDDY_MODELS, WorkBuddyCatalog } from './catalog.ts'
import { createWorkBuddyShim, type WorkBuddyShim } from './shim.ts'
import { createCredentialStore } from './store.ts'
import { WorkBuddyUpstreamClient } from './upstream.ts'
import { credentialFromLogin, displayNameOf, listCredentials, probePathFor, type WorkBuddyCredential } from './credentials.ts'
import { setAccountDisabled, forgetAccount } from './account-state.ts'
import { purgeAccount } from './account-purge.ts'
import { readHiddenModels, setRegionHiddenModels } from './hidden-models.ts'
import { readUseMaximumContextWindow, writeUseMaximumContextWindow } from './preferences.ts'
import { LoginClient, LoginPendingError } from './oauth.ts'
import { regionEndpoints, type WorkBuddyRegion } from './region.ts'
import { saveAccount } from './store.ts'
import { registerCommands, type UserQuestionsService } from './commands.ts'
import { PLUGIN_VERSION } from './version.ts'
import type { WorkBuddyModelInfo } from './catalog.ts'
import { WorkBuddyProbeStore } from './probe-store.ts'
import { WorkBuddyProbeService } from './probe-service.ts'
import { createControlKey, registerWorkBuddyControlRoute } from './control-route.ts'
import { registerWorkBuddyStatusRoute } from './web-status.ts'
import { controlPathFor, type WorkBuddyWebRoute } from './status-paths.ts'
import { piAiVersionWarning } from './pi-ai-guard.ts'

export { PLUGIN_VERSION } from './version.ts'
export { deriveId, deviceHeaders, requestId } from './fingerprint.ts'
export {
  credentialFromLogin,
  displayNameOf,
  listCredentials,
  maskPhoneNumbers,
  type WorkBuddyCredential,
} from './credentials.ts'
export { LoginClient, LoginPendingError, LoginExpiredError, parseRegionInput } from './oauth.ts'
export { ALL_REGIONS, regionEndpoints, regionOfDomain, type WorkBuddyRegion } from './region.ts'
export { createCredentialStore, chooseRotating, NotSignedInError } from './store.ts'
export { COOLDOWN_STATE_FILENAME, readCooldowns, writeCooldown } from './cooldown-state.ts'
export { createWorkBuddyShim } from './shim.ts'
export { FALLBACK_WORKBUDDY_MODELS, FALLBACK_WORKBUDDY_AI_MODELS, WorkBuddyCatalog } from './catalog.ts'
export type { WorkBuddyModelInfo } from './catalog.ts'
export { WorkBuddyProbeStore, workbuddyProbePath, fingerprintModel } from './probe-store.ts'
export { WorkBuddyProbeService, type WorkBuddyProbeStatus } from './probe-service.ts'
export { probeModel, PROBE_EFFORT_CANDIDATES } from './probe.ts'
export { createControlKey, workBuddyControlHandler } from './control-route.ts'
export { workBuddyWebStatus, workBuddyStatusHandler } from './web-status.ts'
export {
  WORKBUDDY_STATUS_PATH,
  WORKBUDDY_CONTROL_PATH,
  WORKBUDDY_AI_CONTROL_PATH,
  WORKBUDDY_CONTROL_KEY_HEADER,
  controlPathFor,
  type WorkBuddyWebStatus,
  type WorkBuddyWebRegion,
  type WorkBuddyWebProbeModel,
  type WorkBuddyWebAccount,
  type WorkBuddyWebModel,
  type WorkBuddyWebRoute,
  type WorkBuddyControlResult,
} from './status-paths.ts'

/** Stable Cordis plugin name. */
export const name = 'llm-workbuddy-oauth'

/** The model registry required before the provider can register. */
export const inject = ['llm', 'commands']

/**
 * Provider ids.
 *
 * **Namespaced deliberately, and not `workbuddy` / `workbuddy-ai`.** An adapter
 * is registered per provider id and a duplicate is a hard error
 * (`an adapter for provider "workbuddy" is already registered`), so a plain
 * `workbuddy` collides with `dsh-workbuddy-connect` — which claims exactly those
 * two ids — and makes this plugin's models silently unavailable whenever both
 * are installed. That is the expected setup for migration, so the collision is
 * not hypothetical: it happened on the first install.
 *
 * The prefix also keeps the two plugins' model groups distinguishable in the
 * picker, which is what a user comparing them needs.
 */
export const WORKBUDDY_PROVIDER = 'workbuddy-oauth'

/** Provider id for the international region. */
export const WORKBUDDY_AI_PROVIDER = 'workbuddy-oauth-ai'

/**
 * Provider id for one region.
 *
 * Two ids, not one: the upstreams advertise overlapping model ids, and a single
 * provider id would make the descriptor for a model depend on which region
 * happened to register last.
 */
export function providerIdFor(region: WorkBuddyRegion): string {
  return region === 'global' ? WORKBUDDY_AI_PROVIDER : WORKBUDDY_PROVIDER
}

/** Stream idle timeout, matching the ported client's expectations. */
export const WORKBUDDY_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * Loopback port each region's endpoint asks for.
 *
 * Fixed rather than ephemeral because the port is now part of a *published
 * configuration value*: `providers[<route>].baseURL` names `http://127.0.0.1:<port>/v1`,
 * and that value outlives the process that wrote it. An ephemeral port would
 * make every restart leave the route pointing at a dead listener until something
 * happened to republish it.
 *
 * Two distinct ports, because two listeners run in one process. The values are
 * arbitrary but must stay stable across releases: changing one silently breaks
 * every existing installation's configuration until the next publish, so a
 * change here is a migration, not a tweak.
 *
 * A bind failure is reported without falling back or changing the saved endpoint.
 */
export const SHIM_PORT_FOR: Readonly<Record<WorkBuddyRegion, number>> = {
  cn: 39271,
  global: 39272,
}

/**
 * Whether *automatic* reasoning-effort probing is authorized.
 *
 * **Permanently `false`, and that is a deliberate policy rather than an
 * unfinished setting.** A probe spends the user's credit, so the upstream
 * project's own design rule is that a sweep runs only when the user asks for it.
 * The control route therefore calls `probe(modelId, true)` — per-click manual
 * consent — and this gate exists so that any *future* automatic trigger has to
 * come through a deliberate decision instead of inheriting permission by
 * default.
 *
 * Do not wire a settings toggle to this without revisiting that rule.
 */
export const AUTOMATIC_PROBING_AUTHORIZED = false

/** How often to re-read credentials to notice a sign-in that happened while running, in ms. */
const CREDENTIAL_POLL_MS = 15_000

/** Configuration schema. */
export interface Config {
  /** Desktop-app version to claim in the User-Agent; empty uses the built-in default. */
  appVersion?: string
  /** CLI version to claim; empty omits the `CLI/…` User-Agent token. */
  cliVersion?: string
  /** Region to sign in to when no argument is given. */
  region?: string
}

export const Config: z<Config> = z.object({
  appVersion: z.string().default(''),
  cliVersion: z.string().default(''),
  region: z.string().default('cn'),
})

/** One region's live runtime. */
interface RegionRuntime {
  region: WorkBuddyRegion
  client: WorkBuddyUpstreamClient
  catalog: WorkBuddyCatalog
  store: ReturnType<typeof createCredentialStore>
  probeStore: WorkBuddyProbeStore
  probeService: WorkBuddyProbeService
  /**
   * The account in effect for this region, as `uid:enterpriseId`, or `undefined`
   * while signed out.
   *
   * **Why a cached synchronous value rather than a store read.** The probe
   * service judges records synchronously on every adapter read
   * (`observe: modelId => service.recordFor(modelId)`), but the credential store
   * is asynchronous — it lists and parses files. Awaiting inside that path would
   * turn a synchronous model-descriptor read into a promise the adapter cannot
   * wait on. So the identity is refreshed whenever the credential is actually
   * read (the startup fetch, the poll, a sign-in, a manual refresh), and the
   * probe service re-checks it before writing a result back.
   */
  account: () => string | undefined
  /**
   * Refresh the cached identity from a credential just read, or clear it when
   * signed out.
   *
   * Called by every path that reads the credential (the startup fetch, the poll,
   * a sign-in, a manual refresh), which is what keeps {@link RegionRuntime.account}
   * truthful without an async read on the adapter's synchronous path.
   */
  setAccount: (credential: WorkBuddyCredential | undefined) => void
  /**
   * The bearer this region's loopback endpoint requires.
   *
   * Minted once per region at construction rather than per listener start, so
   * the value stored in the credential seam and the value the endpoint checks
   * are the same one across a restart of the listener within this process. It
   * is regenerated on every plugin load, and republished with the route then.
   */
  shimToken: string
  /**
   * The loopback origin this region's listener is answering on, once it is up.
   *
   * `undefined` before the listener starts; the published route's `baseURL` is
   * derived from it, and the status document falls back to it when the stored
   * configuration does not name one.
   */
  origin?: string
  /**
   * Publish this region's route into `llm-pi-ai`, or re-publish it after the
   * catalog changed.
   *
   * A no-op until {@link startRegion} has an origin to publish, so a route that
   * fires before the listener is up cannot write a `baseURL` naming no port.
   */
  publish: (mode?: 'seed' | 'sync') => Promise<PublishOutcome>
}

/**
 * The stable identity key for a credential, or `undefined` when it has no uid.
 *
 * `enterpriseId` joins the uid because the same user id can exist in two
 * enterprises, and a probe observation (an entitlement fact) must not cross
 * between them. A uid-less credential yields `undefined` rather than a
 * `":enterpriseId"` key that every uid-less account would silently share.
 */
export function accountIdentityOf(
  credential: Pick<WorkBuddyCredential, 'uid' | 'enterpriseId'> | undefined,
): string | undefined {
  if (credential === undefined || credential.uid === '') return undefined
  return `${credential.uid}:${credential.enterpriseId ?? ''}`
}

/**
 * Pick the fallback roster for a region.
 *
 * Used only until the first successful fetch; the live catalog replaces it.
 */
function fallbackFor(region: WorkBuddyRegion): readonly WorkBuddyModelInfo[] {
  return region === 'global' ? FALLBACK_WORKBUDDY_AI_MODELS : FALLBACK_WORKBUDDY_MODELS
}

/** Build one region's runtime. */
function createRegionRuntime(
  region: WorkBuddyRegion,
  identity: { appVersion?: string; cliVersion?: string },
  consent: () => boolean,
): RegionRuntime {
  const client = new WorkBuddyUpstreamClient({ identity })
  const catalog = new WorkBuddyCatalog(fallbackFor(region))
  // Region-scoped: a credential is only valid against its own upstream host, so
  // a store must never hand the international service a domestic token.
  const store = createCredentialStore({ region })
  const probeStore = new WorkBuddyProbeStore({
    pluginVersion: PLUGIN_VERSION,
    // This plugin's own file, not the ported default: see `probePathFor`.
    path: probePathFor(region),
  })
  let account: string | undefined
  const probeService = new WorkBuddyProbeService({
    store: probeStore,
    catalog,
    credentials: store,
    client,
    // The two endpoints answer a rejected effort with different codes, so each
    // runtime reads only the vocabulary measured on its own endpoint.
    region,
    consent,
    account: () => account,
  })
  return {
    region,
    client,
    catalog,
    store,
    probeStore,
    probeService,
    account: () => account,
    // Records are read and written against the identity refreshed by
    // `refreshCatalog`; see {@link RegionRuntime.account}.
    setAccount: (credential) => {
      account = accountIdentityOf(credential)
    },
    shimToken: randomBytes(32).toString('base64url'),
    publish: async () => ({
      published: false,
      action: 'no-settings',
      reason: 'the loopback endpoint is not listening yet',
      modelCount: 0,
    }),
  }
}

/**
 * Describe one region's published route for the status document.
 *
 * Reads the *stored* configuration rather than what this plugin last wrote: the
 * route belongs to `llm-pi-ai`, and the user can edit or delete it on the Models
 * page without this plugin being told. Reporting the stored entry is therefore
 * the only answer that stays true.
 *
 * @param ctx - the plugin context.
 * @param runtime - the region being described.
 * @returns the route facts the card renders; `configured` is false when the
 *   route is absent or this composition has no settings service.
 */
function routeViewOf(ctx: Context, runtime: RegionRuntime): WorkBuddyWebRoute {
  const providerId = providerIdFor(runtime.region)
  const stored = storedRoute(ctx, providerId)
  const entry = typeof stored === 'object' && stored !== null && !Array.isArray(stored)
    ? stored as Record<string, unknown>
    : undefined
  const models = entry?.['models']
  return {
    providerId,
    baseURL: typeof entry?.['baseURL'] === 'string'
      ? entry['baseURL']
      : runtime.origin === undefined ? '' : `${runtime.origin}/v1`,
    apiKeyEnv: typeof entry?.['apiKeyEnv'] === 'string' ? entry['apiKeyEnv'] : routeApiKeyEnv(runtime.region),
    configured: entry !== undefined,
    modelCount: Array.isArray(models) ? models.length : 0,
  }
}

/**
 * Advertise one region's route as an OAuth provider in the Models page.
 *
 * Registration is all-or-nothing in the LLM service, and a provider already
 * declared by another registration is a hard error — so both regions are
 * registered together from one place, not one call per region. This function
 * therefore only records the region's entry; the single registration happens in
 * `apply` once both listeners hold their ports, because an entry's
 * `defaultBaseURL` names the region's own endpoint.
 *
 * @param ctx - the plugin context carrying `ctx.llm`.
 * @param runtime - the region to advertise.
 * @param origin - the loopback origin this region is listening on.
 */
function directoryEntryFor(ctx: Context, runtime: RegionRuntime, origin: string): DirectoryEntry {
  return directoryEntryOf({
    region: runtime.region,
    providerId: providerIdFor(runtime.region),
    displayName: regionEndpoints(runtime.region).label,
    shimOrigin: origin,
    // The page's editor and this plugin's publish must address the same profile.
    // Discovered from the live `llm-pi-ai` entry rather than guessed: a profile
    // may mount that plugin under any id.
    settingsNs: piAiSettingsNs(ctx) ?? 'llm-pi-ai',
  })
}

/**
 * Seed once at startup, or replace models after an explicit sync. Ordinary
 * catalog, preference and account changes never rewrite the Models-page route.
 *
 * A rejected publish is logged rather than thrown: the caller is either a
 * background refresh or a card action that reports its own failure, and neither
 * benefits from an exception escaping into the poll interval.
 *
 * @param ctx - the plugin context.
 * @param runtime - the region whose route should be refreshed.
 * @param log - the plugin's log sink.
 */
async function republish(
  ctx: Context,
  runtime: RegionRuntime,
  log: (message: string) => void,
  mode: 'seed' | 'sync' = 'seed',
): Promise<PublishOutcome> {
  const outcome = await runtime.publish(mode)
  const label = regionEndpoints(runtime.region).label
  if (outcome.action === 'rejected') {
    ctx.logger.warn(`dsh-workbuddy-oauth: ${label} 模型配置写入被拒绝（${outcome.reason ?? 'no reason'}）`)
  } else if (outcome.action === 'written') {
    log(`${label}：已写入 ${outcome.modelCount} 个模型到 DSH 模型配置。`)
  }
  return outcome
}

/**
 * Publish one region's route from its current catalog.
 *
 * Reads the catalog *at publish time* rather than capturing a list: the roster
 * is refreshed from the upstream on sign-in, on a manual refresh and on the
 * first start, and a publish that carried a stale copy would silently undo the
 * refresh it was meant to record.
 *
 * @param ctx - the plugin context.
 * @param runtime - the region being published.
 * @param origin - the shim origin the route's `baseURL` must name.
 */
async function publishRegion(
  ctx: Context,
  runtime: RegionRuntime,
  origin: string,
  mode: 'seed' | 'sync',
  active: () => boolean,
): Promise<PublishOutcome> {
  const models = mode === 'seed' ? runtime.catalog.current() : runtime.catalog.roster().map(model => ({
    ...model,
    contextWindow: model.defaultContextWindow ?? model.contextWindow,
  }))
  return publishProviderRoute(ctx, {
    providerId: providerIdFor(runtime.region),
    region: runtime.region,
    displayName: regionEndpoints(runtime.region).label,
    shimOrigin: origin,
    // Legacy selections apply only to the initial seed. Explicit sync means
    // the complete upstream roster, with its default context windows.
    models,
    observe: (modelId) => runtime.probeService.recordFor(modelId),
    token: runtime.shimToken,
    mode,
    active,
  })
}

/**
 * Refresh one region's catalog from the upstream, if an account exists.
 *
 * Failures are swallowed into a log line: a network problem must not stop the
 * provider from registering, and the fallback roster keeps working meanwhile.
 *
 * @param reason - Why the refresh is happening. A periodic poll passes
 *   `'poll'` and stays quiet when nothing changed, so the log does not fill
 *   with one identical line every interval; a user-triggered refresh (after a
 *   sign-in) passes `'login'` and always reports, because the user is waiting
 *   for exactly that confirmation.
 * @returns whether the catalog changed (callers emit an adapter update then).
 */
async function refreshCatalog(
  ctx: Context,
  runtime: RegionRuntime,
  log: (message: string) => void,
  reason: 'startup' | 'login' | 'poll' = 'poll',
): Promise<boolean> {
  const label = regionEndpoints(runtime.region).label
  // Ask the store rather than picking a credential here: the store owns the
  // region filter and the selection rule, and duplicating either would let the
  // catalog be fetched with one account while requests are served by another.
  const credential = await runtime.store.current()
  // Keep the cached identity in step with the credential this read settled on.
  // Every path that reads a credential goes through here (or the poll below), so
  // this one assignment is what makes the probe service's synchronous
  // `account()` truthful.
  runtime.setAccount(credential)
  if (credential === undefined) {
    // No account for this region: hide the group rather than offering models
    // that can only fail on the first message.
    const changed = runtime.catalog.setVisible(false)
    if (changed && reason !== 'poll') log(`${label}：无可用账号，模型分组已隐藏。`)
    return changed
  }
  const becameVisible = runtime.catalog.setVisible(true)

  try {
    const models = await runtime.client.fetchModels(credential)
    if (models.length === 0) {
      if (reason !== 'poll') log(`${label}：上游返回空模型列表，保留内置回落表。`)
      return becameVisible
    }
    // `catalog.set` returns void, so the change check happens here rather than
    // by modifying the ported catalog. Comparing the ids is enough: the poll
    // exists to notice models appearing or disappearing, not to notice
    // reordered metadata.
    const before = runtime.catalog.current().map((model) => model.id).join(',')
    runtime.catalog.set(models)
    const after = runtime.catalog.current().map((model) => model.id).join(',')
    const changed = before !== after
    // A poll that changed nothing is not worth a line, but a startup or a
    // sign-in always is: those are the moments a user checks the log to see
    // whether the plugin worked.
    if (changed || reason !== 'poll') log(`${label}：已同步 ${models.length} 个模型。`)
    return changed || becameVisible
  } catch (error: unknown) {
    // Failures are logged at every reason: a repeated failure is the signal
    // that something is actually broken, unlike a repeated success.
    log(
      `${label}：模型列表拉取失败，保留内置回落表（${error instanceof Error ? error.message : String(error)}）。`,
    )
    return becameVisible
  }
}

/**
 * Plugin entry point.
 *
 * Wires one provider, its loopback shim, and the credential-driven catalog
 * lifecycle. Nothing here reads the WorkBuddy desktop app.
 */
export function apply(ctx: Context, config: Config): void {
  const log = (message: string): void => {
    ctx.logger.info(`dsh-workbuddy-oauth: ${message}`)
  }

  // Report a shadowed pi-ai copy once, at load. See pi-ai-guard.ts: the plugin
  // still runs, but a mismatched generation otherwise surfaces only as an
  // opaque PI_AI_ERROR on the first request (issue #92).
  const piAiWarning = piAiVersionWarning()
  if (piAiWarning !== undefined) ctx.logger.warn(`dsh-workbuddy-oauth: ${piAiWarning}`)

  const identity = {
    ...(config.appVersion !== undefined && config.appVersion !== '' ? { appVersion: config.appVersion } : {}),
    ...(config.cliVersion !== undefined && config.cliVersion !== '' ? { cliVersion: config.cliVersion } : {}),
  }

  const runtimes = [
    createRegionRuntime('cn', identity, () => AUTOMATIC_PROBING_AUTHORIZED),
    createRegionRuntime('global', identity, () => AUTOMATIC_PROBING_AUTHORIZED),
  ]

  /**
   * Apply the persisted hidden-model rule to each catalog.
   *
   * Loaded once at startup; the catalog's `setHiddenModels` is separate from the
   * roster (`set`), so a later catalog refresh cannot resurrect a hidden model.
   * Initial publication awaits both preferences, so the one-time migration
   * cannot seed models that the user previously hid.
   */
  const preferencesReady = Promise.all([readHiddenModels(), readUseMaximumContextWindow()]).then(([hidden, maximum]) => {
    for (const runtime of runtimes) {
      runtime.catalog.setHiddenModels(new Set(hidden[runtime.region]))
      runtime.catalog.setUseMaximumContextWindow(maximum)
    }
  })

  /**
   * Live login attempts, keyed by state.
   *
   * Held here rather than in a module global so a profile reload cannot leave a
   * stale pending login behind.
   */
  const logins = new LoginClient()

  /** Schedules outstanding, cleared on disposal. */
  const timers: NodeJS.Timeout[] = []
  let stopped = false

  const shims: Array<() => Promise<void>> = []

  /**
   * Start one region's loopback endpoint, then register its provider.
   *
   * **Order matters**: the adapter reads the shim's origin while it is being
   * constructed, so the listener must already hold a port. Constructing first
   * throws `workbuddy shim has no listening address` and the whole entry fails
   * to activate. (Connect documents this at its own call site, which is why it
   * awaits `shim.ready` before building the adapter.)
   */
  const startRegion = async (runtime: RegionRuntime): Promise<void> => {
    const { region } = runtime
    const label = regionEndpoints(region).label

    // A busy stable port is an error, never permission to rewrite the endpoint.
    const startShim = async (port: number): Promise<WorkBuddyShim | undefined> => {
      const candidate = createWorkBuddyShim({
        store: runtime.store,
        client: runtime.client,
        catalog: runtime.catalog,
        logger: ctx.logger,
        port,
        token: runtime.shimToken,
      })
      try {
        await candidate.ready
      } catch (error: unknown) {
        void candidate.close()
        ctx.logger.error(`dsh-workbuddy-oauth: ${label} 回环端点启动失败`, error)
        return undefined
      }
      return candidate
    }

    const preferred = SHIM_PORT_FOR[region]
    const shim = await startShim(preferred)
    if (shim === undefined) return
    if (stopped) { await shim.close(); return }
    shims.push(() => shim.close())

    try {
      const origin = shim.baseUrl()
      runtime.origin = origin
      runtime.publish = (mode = 'seed') => publishRegion(ctx, runtime, origin, mode, () => !stopped)
      // The directory entry that makes the Models page render a sign-in button
      // instead of an endpoint/API-key form is registered once for both regions
      // after every listener is up (see `apply`): an entry's `defaultBaseURL`
      // names the port this call has just obtained.
      // The route is published rather than served by an adapter this plugin
      // registers: from here on `llm-pi-ai` owns it, the Models page edits it,
      // and the plugin's only remaining job is to answer on the endpoint.
      //
      // Published unconditionally, not only when the catalog changed: the bearer
      // is regenerated on every plugin load, so a restart that skipped this
      // would leave the stored credential naming the previous process's secret
      // and every request failing `401` until something else triggered a write.
      await preferencesReady
      if (stopped) return
      await refreshCatalog(ctx, runtime, log, 'startup')
      if (stopped) return
      await republish(ctx, runtime, log)
    } catch (error: unknown) {
      // Contained per region: one region failing must not take the other down.
      ctx.logger.error(`dsh-workbuddy-oauth: ${label} provider 注册失败`, error)
      void shim.close()
    }
  }

  const startups = runtimes.map(runtime => startRegion(runtime))

  /**
   * Advertise both regions in the configurable-provider directory, once.
   *
   * After `startups`, not before: an entry's `defaultBaseURL` names the region's
   * own loopback port, which only exists once its listener is up. One call for
   * the whole set, because the LLM service registers all-or-nothing and treats a
   * provider already declared by another registration as a hard error.
   *
   * The failure mode is contained inside `registerDirectory`: a refused set costs
   * the OAuth presentation (the page falls back to the hand-declared form), not
   * the routes themselves.
   */
  void Promise.all(startups).then(() => {
    if (stopped) return
    const entries = runtimes.flatMap(runtime => {
      const origin = runtime.origin
      return origin === undefined ? [] : [directoryEntryFor(ctx, runtime, origin)]
    })
    if (entries.length > 0) registerDirectory(ctx, entries)
  })

  /**
   * Notice sign-ins that happen while DSH keeps running.
   *
   * Without this the model group would only appear after a restart, because the
   * initial fetch happens once at startup.
   *
   * The catalog is re-fetched only when there is something new to fetch: while a
   * region has no account, polling the upstream would be a wasted request every
   * interval (and the upstream is the last place to spend gratuitous traffic).
   * A region that already has a catalog is left alone — model rosters change on
   * the order of days, and `refreshCatalog` re-fetches on the next sign-in
   * anyway. This keeps the interval cheap and the log quiet.
   */
  const poll = setInterval(() => {
    if (stopped) return
    for (const runtime of runtimes) {
      void runtime.store
        .current()
        .then(async (credential) => {
          if (credential === undefined) {
            // Signed out: drop the route if it is published, so the picker stops
            // offering models that can only answer `401`, and do not call out.
            runtime.catalog.setVisible(false)
            return
          }
          // A credential appeared for a region that was hidden: this is the
          // sign-in case the interval exists for.
          if (!runtime.catalog.isVisible()) {
            await refreshCatalog(ctx, runtime, log, 'login')
          }
        })
        .catch((error: unknown) => {
          ctx.logger.warn('dsh-workbuddy-oauth: 账号轮询失败', error)
        })
    }
  }, CREDENTIAL_POLL_MS)
  timers.push(poll)

  /**
   * Complete a sign-in: redeem the authorization, persist the credential, and
   * refresh every region's catalog.
   *
   * **One implementation, two surfaces.** Both `/wb-login` and the settings
   * card's sign-in button reach the upstream through this, so the two entry
   * points cannot drift into two different login flows — the failure that would
   * produce is a card that signs in "successfully" while the command path (which
   * the rest of the plugin trusts) never ran.
   */
  const completeLogin = async (state: string): Promise<{ uid: string; label: string }> => {
    const result = await logins.complete(state)
    const credential = credentialFromLogin(result)
    await saveAccount(credential)
    // A fresh sign-in is an explicit "I want to use this account", so any
    // disable flag left over from an earlier session is cleared. Without this,
    // signing back into an account that was disabled before it was signed out
    // returns it *still* disabled: the credential is stored, nothing selects it,
    // and every surface reports it as disabled with no way to tell why.
    await forgetAccount(credential.uid)
    // Refresh immediately so the models are selectable without waiting for the
    // periodic poll, then write the routes: a fresh sign-in usually changes the
    // roster, and the picker reads the published route rather than this catalog.
    await Promise.all(runtimes.map((runtime) => refreshCatalog(ctx, runtime, log, 'login')))
    return { uid: credential.uid, label: displayNameOf(credential) }
  }

  /**
   * Register the Models page sign-in for each region.
   *
   * The directory entry (see `provider-directory.ts`) is what makes the page
   * show a sign-in button; this is the flow that button runs. It drives the same
   * `begin`/`completeLogin` pair as `/wb-login` and the settings card, so all
   * three surfaces sign in through one implementation — the failure this avoids
   * is a Models page that reports success while the plugin's own store was never
   * written.
   *
   * The flow deliberately commits no pi-ai credential record: accounts stay in
   * this plugin's own per-file store so the rotating pool, per-account cooldown
   * and session affinity keep working. `registerSignInFlow` documents why that
   * is allowed by the seam.
   */
  const flowDisposers: Array<() => void> = []
  for (const runtime of runtimes) {
    const dispose = registerSignInFlow(
      ctx,
      providerIdFor(runtime.region),
      runtime.region,
      {
        begin: async (region) => {
          const request = await logins.begin(region)
          return { url: request.url, state: request.state }
        },
        complete: completeLogin,
        isPending: (error: unknown) => error instanceof LoginPendingError,
      },
    )
    if (dispose !== undefined) flowDisposers.push(dispose)
  }

  /**
   * Remove an account and every trace of it, then refresh the catalogs.
   *
   * **One implementation, two surfaces.** Both `/wb-logout` and the settings
   * card's sign-out reach this, so neither can leave behind state the other
   * erases. The credential file is the secret and goes first (see
   * `account-purge.ts`); the uid-keyed stores follow.
   *
   * `enterpriseId` is needed to build the probe key but is not known to the
   * caller once the credential file is gone, so it is read here first.
   */
  const removeAccountCompletely = async (uid: string): Promise<void> => {
    const target = (await listCredentials()).find(credential => credential.uid === uid)
    const accountKey = accountIdentityOf(target)
    await purgeAccount(uid, {
      ...accountKey === undefined ? {} : { accountKey },
      // Every region's store is offered the key: the account's own region is not
      // known here, and a store that held nothing simply reports zero.
      forgetProbeRecords: (key) =>
        runtimes.reduce((count, runtime) => count + (runtime.probeStore.forget(key) ? 1 : 0), 0),
    })
    await Promise.all(runtimes.map((runtime) => refreshCatalog(ctx, runtime, log, 'login')))
    // A removed account can leave a region with no credential at all, in which
    // case its catalog is now empty and the route must stop advertising it.
  }

  /**
   * Register the sign-in commands.
   *
   * `userQuestions` is read through `ctx.get` rather than declared as a
   * dependency: it is absent in headless and ACP profiles, and injecting it
   * would make the whole plugin refuse to load there. The command layer
   * degrades to a text prompt when it is missing.
   */
  const commandDisposers = registerCommands(ctx, logins, {
    complete: completeLogin,
    remove: removeAccountCompletely,
    userQuestions: ctx.get('userQuestions') as UserQuestionsService | undefined,
    warn: (message, error) => {
      ctx.logger.warn(`dsh-workbuddy-oauth: ${message}`, error)
    },
  })

  /**
   * Same-origin routes backing the settings card and the probe control.
   *
   * `webServer` is optional — a headless or ACP profile serves no browser — so
   * it is reached through `ctx.inject` rather than declared in `inject`. Naming
   * it as a hard dependency would make the whole plugin refuse to load exactly
   * where the commands still work.
   */
  const controlKey = createControlKey()
  ctx.inject(['webServer'], (webCtx) => {
    registerWorkBuddyStatusRoute(webCtx, {
      regions: runtimes.map(runtime => ({
        region: runtime.region,
        providerId: providerIdFor(runtime.region),
        // The full roster, not `current()`: the card's visibility list must
        // still show a hidden model so its checkbox can be re-ticked. `current()`
        // already drops hidden ids, which is exactly what makes hiding
        // irreversible from the card — the row vanishes the moment it is hidden.
        models: () => runtime.catalog.roster(),
        probeRunning: () => runtime.probeService.isRunning(),
        probeCandidates: () =>
          runtime.catalog.current().filter(info => runtime.probeService.isCandidate(info.id)).map(info => info.id),
        probeResults: () =>
          runtime.catalog.current().flatMap(info => {
            const record = runtime.probeService.recordFor(info.id)
            return record === undefined ? [] : [{ id: info.id, record }]
          }),
        hiddenModels: () => runtime.catalog.hiddenModelIds(),
        useMaximumContextWindow: () => runtime.catalog.isUsingMaximumContextWindow(),
        route: () => routeViewOf(ctx, runtime),
      })),
      controlKey,
    })

    for (const runtime of runtimes) {
      registerWorkBuddyControlRoute(webCtx, {
        // One path per region: `webServer.register` throws on a duplicate, so a
        // shared path would abort the second region's control surface.
        path: controlPathFor(runtime.region),
        probe: async (modelId) => {
          // The authenticated manual endpoint is reached only after per-model
          // confirmation, so it carries one-request consent. This never changes
          // the automatic-probing policy.
          const result = await runtime.probeService.probe(modelId, true)
          return result
        },
        clear: () => {
          runtime.probeStore.clear()
        },
        refresh: async () => {
          if (stopped) return { state: 'failed', reason: 'plugin is stopping' }
          await refreshCatalog(ctx, runtime, log, 'login')
          return runtime.catalog.isVisible()
            ? { state: 'refreshed', reason: `${runtime.catalog.current().length} models` }
            : { state: 'signed-out' }
        },
        /**
         * Write this region's models into the `llm-pi-ai` route.
         *
         * This is the card's counterpart to "the model list is configuration
         * now": the plugin cannot make a model appear in the picker by itself,
         * because the route belongs to `llm-pi-ai`. The button exists so a user
         * who just ticked a model does not have to restart DSH to see it.
         */
        syncProvider: async () => {
          if (stopped) return { state: 'failed', reason: 'plugin is stopping' }
          const outcome = await republish(ctx, runtime, log, 'sync')
          return outcome.published
            ? { state: 'ok', reason: `${outcome.action} · ${outcome.modelCount} models` }
            : { state: 'failed', reason: outcome.reason ?? outcome.action }
        },
        /**
         * The card's sign-in flow.
         *
         * `begin` is region-specific because the authorization URL is issued by
         * one upstream, but `complete` is not: the state carries its own region
         * (see `LoginClient`), so the card cannot redeem a state against the
         * wrong host. Both regions therefore share one `complete`.
         */
        loginBegin: async (region) => {
          const target = region === 'global' ? 'global' : 'cn'
          const request = await logins.begin(target)
          return { state: 'pending', url: request.url, loginState: request.state }
        },
        loginComplete: async (state) => {
          try {
            const result = await completeLogin(state)
            return { state: 'ok', reason: result.label }
          } catch (error: unknown) {
            // A not-yet-approved authorization is the normal case while the user
            // is still in the browser, so it is reported as `pending` rather
            // than as a failure; anything else is a real error.
            if (error instanceof LoginPendingError) return { state: 'pending' }
            return {
              state: 'failed',
              reason: error instanceof Error ? error.message : String(error),
            }
          }
        },
        /**
         * The card's counterpart to `/wb-logout`.
         *
         * Erases every trace of the account — the credential file, its persisted
         * cooldown, its enable/disable state, and its probe records — via the
         * same path the command uses, so the two surfaces cannot drift. The
         * upstream account is untouched. The catalog is refreshed so a group that
         * is now empty disappears instead of offering models that can only fail.
         */
        logout: async (uid) => {
          const credentials = await listCredentials()
          const target = credentials.find(credential => credential.uid === uid)
          if (target === undefined) return { state: 'failed', reason: 'no such account' }
          const label = displayNameOf(target)
          await removeAccountCompletely(uid)
          return { state: 'ok', reason: label }
        },
        /**
         * The card's counterpart to `/wb-account enable|disable`.
         *
         * Reversible, unlike {@link logout}: the credential file stays, so the
         * account keeps its tokens and only leaves selection. The catalog is
         * refreshed because disabling the account in use must drop the group
         * rather than leave it serving requests that will now fail.
         */
        setAccountEnabled: async (uid, enabled) => {
          const credentials = await listCredentials()
          if (!credentials.some(credential => credential.uid === uid)) {
            return { state: 'failed', reason: 'no such account' }
          }
          await setAccountDisabled(uid, !enabled)
          await Promise.all(runtimes.map((runtime) => refreshCatalog(ctx, runtime, log, 'login')))
                return { state: 'ok', reason: enabled ? 'enabled' : 'disabled' }
        },
        /**
         * The card's counterpart to hiding a model.
         *
         * The host owns both the catalog filter and the persisted rule, so the
         * picker and the checkbox cannot disagree. The loop's `runtime` is the
         * region this route serves; the body's region is checked rather than
         * trusted, since a route posting to the wrong region would hide the wrong
         * roster.
         */
        setModelVisible: async (region, modelId, visible) => {
          if (region !== runtime.region) {
            return { state: 'failed', reason: `region mismatch: ${region}` }
          }
          const next = new Set(runtime.catalog.hiddenModelIds())
          if (visible) next.delete(modelId)
          else next.add(modelId)
          runtime.catalog.setHiddenModels(next)
          await setRegionHiddenModels(runtime.region, [...next])
          // Republished rather than merely invalidated: the tick now decides
          // what the route advertises, so a change that is not written leaves
          // the card and the picker disagreeing until the next restart.
          return { state: 'ok', reason: visible ? 'visible' : 'hidden' }
        },
        /**
         * The card's counterpart to the maximum-context-window preference.
         *
         * One flag shared across regions; the host owns the catalog flag and the
         * persistence, so the picker and the checkbox cannot disagree. Invalidates
         * the adapter only when the flag actually changed.
         */
        setMaximumContextWindow: async (enabled) => {
          await writeUseMaximumContextWindow(enabled)
          // The flag changes each model's published `contextWindow`, so every
          // region's route is rewritten — a region whose flag did not move still
          // carries the old window in its configuration.
          for (const region of runtimes) {
            region.catalog.setUseMaximumContextWindow(enabled)
          }
          return { state: 'ok', reason: enabled ? 'maximum' : 'default' }
        },
        /**
         * The card's counterpart to P5.1: fetch one account's balance.
         *
         * Reads the stored credential by uid and asks the upstream for its
         * balance, returning it in `credits` for immediate display.
         */
        refreshCredits: async (uid) => {
          const credential = (await listCredentials()).find(item => item.uid === uid)
          if (credential === undefined) return { state: 'failed', reason: 'no such account' }
          try {
            const credits = await runtime.client.fetchCredits(credential)
            return { state: 'ok', reason: 'credits', credits }
          } catch (error: unknown) {
            return { state: 'failed', reason: error instanceof Error ? error.message : String(error) }
          }
        },
      }, controlKey)
    }
  })

  ctx.effect(() => async () => {
    stopped = true
    for (const timer of timers) clearInterval(timer)
    for (const dispose of commandDisposers) dispose()
    for (const dispose of flowDisposers) dispose()
    await Promise.all(startups)
    await Promise.all(shims.map(close => close()))
  })

  log(`已加载 v${PLUGIN_VERSION}（自有 OAuth 登录，不读取桌面端）`)
}
