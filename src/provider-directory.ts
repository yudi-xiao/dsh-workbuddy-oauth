/**
 * Advertising the WorkBuddy routes as OAuth providers in the Models page.
 *
 * ## The problem this solves
 *
 * A route written into `llm-pi-ai.providers` is, by default, presented as a
 * hand-declared gateway: the Models page renders a provider-id field, an
 * endpoint field, an API-key field and a model list. That is the right form for
 * a relay someone typed in by hand, and the wrong one here — WorkBuddy's
 * endpoint is this plugin's own loopback listener and its credential is a
 * per-process secret. Asking a human to fill either in is asking them to break
 * it.
 *
 * `openai-codex` looks different because pi-ai *ships* it: its endpoint, models
 * and OAuth flow are part of the package, so the page only offers a sign-in
 * button. A third-party plugin cannot join that catalog — `builtinProviders()`
 * is generated at build time — but the same page reads one more piece of
 * information from the configurable-provider directory, and that part *is*
 * writable by a plugin:
 *
 * ```js
 * const keylessNativeAuth = nativeAuth?.env.length === 0 && nativeAuth.oauth
 * // true → the API-key field is not rendered at all
 * ```
 *
 * So registering the route in the directory with `nativeAuth: { env: [], oauth:
 * true }` is what turns "fill in an endpoint and a key" into "sign in". The
 * route itself is still published into `providers`, because that is what makes
 * the models resolve; the directory entry only changes how the page presents it.
 *
 * ## Why this keeps the multi-account pool
 *
 * The plugin does **not** hand its credentials to pi-ai's OAuth store. Its own
 * store keeps one file per account, the shim picks between them per request, and
 * the published route authenticates to the shim with a per-process bearer. The
 * sign-in flow registered alongside this directory entry therefore does not
 * write a pi-ai `grant` record; it runs the plugin's own login and reports
 * success through the flow contract. See `authorization-flow.ts`.
 *
 * That is the deliberate trade: the Models page shows the same "sign in" shape
 * as `openai-codex`, while account rotation, per-account cooldown and session
 * affinity keep working behind the loopback endpoint.
 *
 * @module dsh-workbuddy-oauth/provider-directory
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import { ROUTE_API_KEY_ENV } from './provider-config.ts'
import type { WorkBuddyRegion } from './region.ts'

/**
 * What the Models page needs in order to render a route as an OAuth provider.
 *
 * Restated structurally rather than imported: this module is reachable from the
 * browser bundle, and the host package would drag its Node-side dependencies in
 * with it.
 */
export interface DirectoryEntry {
  provider: string
  displayName: string
  settingsNs: string
  settingsPath: readonly string[]
  /**
   * `true` marks a route pi-ai does not ship — which is exactly what WorkBuddy
   * is, and what tells the page this row's models came from configuration
   * rather than from an installed catalog.
   */
  declared: boolean
  /** Endpoint the page shows before the profile sets one. */
  defaultBaseURL: string
  /**
   * Authentication the route performs without a credential reference.
   *
   * `env: []` with `oauth: true` is the pair that suppresses the API-key field:
   * the page reads it as "this route authenticates by signing in, and it reads
   * no environment variable to do it".
   */
  nativeAuth: { env: readonly string[]; oauth: boolean }
}

/** Everything one region's directory entry needs. */
export interface DirectoryRequest {
  region: WorkBuddyRegion
  providerId: string
  displayName: string
  /** The loopback origin this region is listening on. */
  shimOrigin: string
  /** Settings namespace the published route lives under, discovered at runtime. */
  settingsNs: string
}

/**
 * Build one region's directory entry.
 *
 * `settingsPath` addresses the profile inside the `llm-pi-ai` section, so the
 * page's editor and the route this plugin publishes agree on where the entry
 * lives. The path shape is the one `llm-pi-ai` itself uses for its own routes
 * (`['providers', <provider>]`); a different shape would make the page edit a
 * section nothing reads.
 *
 * @param request - the region's ids, label, endpoint and settings namespace.
 * @returns the entry to hand `registerConfigurableProviders`.
 */
export function directoryEntryOf(request: DirectoryRequest): DirectoryEntry {
  return {
    provider: request.providerId,
    displayName: request.displayName,
    settingsNs: request.settingsNs,
    settingsPath: ['providers', request.providerId],
    declared: true,
    defaultBaseURL: `${request.shimOrigin}/v1`,
    nativeAuth: { env: [], oauth: true },
  }
}

/**
 * Register (or refresh) this plugin's directory entries.
 *
 * Registration is all-or-nothing in the LLM service, and a provider already
 * declared by another registration is a hard error. That is why this is called
 * once per start with the full set for both regions rather than per region: a
 * second call would collide with the first call's own entries, and a partial set
 * would leave one region's row unrenderable.
 *
 * `replace` is used on subsequent calls, which is what lets a restart or a port
 * change refresh `defaultBaseURL` without a dispose/re-register window in which
 * the page would briefly lose the row.
 *
 * @param ctx - the plugin context carrying `ctx.llm`.
 * @param entries - every region's entry, as {@link directoryEntryOf} built them.
 * @returns a disposer that withdraws the registration, and a `replace` for later
 *   updates; `undefined` when the service refuses the set.
 */
export function registerDirectory(
  ctx: Context,
  entries: readonly DirectoryEntry[],
): { dispose: () => void; replace: (next: readonly DirectoryEntry[]) => void } | undefined {
  if (entries.length === 0) return undefined
  try {
    const handle = ctx.llm.registerConfigurableProviders([...entries])
    return {
      dispose: () => handle(),
      replace: (next) => handle.replace([...next]),
    }
  } catch (error: unknown) {
    // A refused registration is not fatal: the routes are still published and
    // still serve requests, and the page simply presents them as hand-declared
    // rows. Losing the OAuth presentation is a cosmetic regression, so it is
    // logged rather than allowed to abort the region.
    ctx.logger.warn(
      'dsh-workbuddy-oauth: 无法注册模型页的 OAuth 目录项，模型页将以手写路由的形式显示',
      error,
    )
    return undefined
  }
}

/**
 * The credential reference the published route names.
 *
 * Re-exported here so callers that only need the directory shape do not have to
 * reach into `provider-config.ts`.
 */
export { ROUTE_API_KEY_ENV }
