/**
 * The standard `llm-pi-ai` provider routes this plugin publishes.
 *
 * ## Why this module exists
 *
 * WorkBuddy used to be served by an adapter this plugin registered itself, with
 * its model roster baked into `catalog.ts` and filtered by a hidden-models file.
 * That made the plugin the owner of the model list, which put it outside DSH's
 * normal third-party provider story: a route such as `openai-codex` is a
 * `providers:` entry under `llm-pi-ai`, editable in the built-in Models page,
 * and there is exactly one place that decides what a route serves.
 *
 * This module closes that gap. The plugin now only:
 *
 * 1. signs in through its own OAuth flow,
 * 2. serves the upstream through the loopback shim, and
 * 3. writes one `llm-pi-ai` provider route per region into the profile's
 *    configuration, describing the shim's endpoint and the region's models.
 *
 * From then on the route is indistinguishable from any other third-party
 * provider: DSH owns the catalog, the Models page edits it, and the composer
 * picks it up from the ordinary directory.
 *
 * ## What a published route looks like
 *
 * ```yaml
 * - id: llm-pi-ai
 *   config:
 *     providers:
 *       workbuddy-oauth-ai:
 *         displayName: WorkBuddy AI (国际版)
 *         api: openai-completions
 *         baseURL: http://127.0.0.1:39272/v1
 *         apiKeyEnv: WORKBUDDY_OAUTH_GLOBAL_TOKEN
 *         models:
 *           - id: gpt-6-astra
 *             name: GPT-6 Astra
 *             contextWindow: 400000
 *             maxTokens: 128000
 *             input: [text, image]
 *             reasoningEfforts: { low: low, medium: medium, ... }
 * ```
 *
 * The credential reference is satisfied by the plugin itself: it stores the
 * shim's shared secret under that reference through `ctx.credentials`, which is
 * the same seam the Models page writes API keys through. Nothing secret enters
 * the configuration file.
 *
 * @module dsh-workbuddy-oauth/provider-config
 */

import type { WorkBuddyModelInfo } from './catalog.ts'
import type { WorkBuddyRegion } from './region.ts'
import type { WorkBuddyProbeRecord } from './probe-store.ts'

/** Legacy shared reference, recognized only for one-time migration. */
export const ROUTE_API_KEY_ENV = 'WORKBUDDY_OAUTH_TOKEN'

/** Independent bearer references: each region has a different listener secret. */
export function routeApiKeyEnv(region: WorkBuddyRegion): string {
  return region === 'global' ? 'WORKBUDDY_OAUTH_GLOBAL_TOKEN' : 'WORKBUDDY_OAUTH_CN_TOKEN'
}

/** Wire protocol every published model speaks; the shim is OpenAI-compatible. */
export const ROUTE_API = 'openai-completions'

/**
 * One published model entry, shaped for `llm-pi-ai`'s `models` list.
 *
 * Field names and defaults are `PiAiModelProfile`'s, restated structurally here
 * rather than imported: this module is reachable from the browser bundle, and
 * importing the host package would pull its Node-side dependencies into it.
 */
export interface PublishedModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  input?: readonly ('text' | 'image')[]
  /**
   * Selectable reasoning levels and their wire spellings, or `false` for a
   * model that does not reason.
   *
   * `llm-pi-ai` refuses an entry that offers no level beyond `off`, so the
   * mapping below never emits one: a row with nothing honest to offer becomes
   * `false` instead.
   */
  reasoningEfforts?: false | Readonly<Record<string, string | null>>
}

/**
 * One published provider route, shaped for `llm-pi-ai`'s `providers` dict.
 *
 * `models` is always present and always complete: a published route describes
 * its catalog explicitly rather than inheriting one, because the shim is not a
 * provider pi-ai ships and so has no installed catalog to inherit from.
 */
export interface PublishedRoute {
  displayName: string
  api: typeof ROUTE_API
  baseURL: string
  apiKeyEnv: string
  compat: { maxTokensField: 'max_tokens' }
  models: readonly PublishedModel[]
}

/** Everything {@link publishRoute} needs about one region. */
export interface PublishInput {
  region: WorkBuddyRegion
  /** Human label for the picker group, e.g. `WorkBuddy AI (国际版)`. */
  displayName: string
  /** The shim origin, e.g. `http://127.0.0.1:39271`. */
  shimOrigin: string
  /** Models to publish, already resolved for visibility and context-window preference. */
  models: readonly WorkBuddyModelInfo[]
  /** Recorded effort observations, consulted for rows the upstream leaves undeclared. */
  observe?: (modelId: string) => WorkBuddyProbeRecord | undefined
}

/**
 * Map one WorkBuddy model's reasoning capability onto `reasoningEfforts`.
 *
 * The precedence is the one the adapter used to apply, restated here because it
 * is a property of the *upstream data* rather than of any adapter:
 *
 * 1. A declared non-empty `supportedEfforts` wins outright.
 * 2. Otherwise a `validating` probe observation supplies the verified set.
 * 3. Otherwise the upstream's own default effort is the one level that is
 *    certainly accepted.
 * 4. Otherwise the model does not reason as far as anyone can tell, which is
 *    published as `false`.
 *
 * `off` is offered only when the upstream declares `canDisableThinking`, and on
 * the CN endpoint a row that also declares `onlyReasoning` never gets it: that
 * endpoint rejects the literal spelling (HTTP 400 / `11150`), so offering the
 * level could only ever produce a failed request.
 *
 * `minimal` is never offered: it is not in the upstream's effort vocabulary, so
 * no declared set — and no probe candidate — can contain it.
 *
 * @returns `false` for a non-reasoning model, otherwise the level→spelling map.
 */
export function reasoningEffortsOf(
  info: WorkBuddyModelInfo,
  observed: WorkBuddyProbeRecord | undefined,
  region: WorkBuddyRegion,
): false | Record<string, string> {
  const reasoning = info.reasoning
  if (reasoning === undefined || reasoning.supports !== true) return false

  const declared = reasoning.supportedEfforts
  let efforts: readonly string[]
  let declaredSet: boolean
  if (declared !== undefined && declared.length > 0) {
    efforts = declared
    declaredSet = true
  } else if (observed?.validation === 'validating' && observed.efforts.length > 0) {
    efforts = observed.efforts
    declaredSet = false
  } else if (reasoning.defaultEffort !== undefined) {
    efforts = [reasoning.defaultEffort]
    declaredSet = false
  } else {
    return false
  }

  const map: Record<string, string> = {}
  const offAllowed =
    declaredSet &&
    reasoning.canDisableThinking === true &&
    (region !== 'cn' || reasoning.onlyReasoning !== true)
  if (offAllowed) map['off'] = 'off'
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
    if (efforts.includes(level)) map[level] = level
  }
  // `llm-pi-ai` refuses a map whose only level is `off`; a row that reached here
  // with nothing selectable is published as non-reasoning rather than as an
  // entry the route resolution would reject wholesale.
  return Object.keys(map).some(level => level !== 'off') ? map : false
}

/**
 * Build one published model entry from a catalog row.
 *
 * @param info - the upstream catalog row, after visibility and window selection.
 * @param observed - a recorded effort observation for this model, when one exists.
 * @param region - which upstream the row came from; only the CN `off` veto reads it.
 */
export function publishedModelOf(
  info: WorkBuddyModelInfo,
  observed: WorkBuddyProbeRecord | undefined,
  region: WorkBuddyRegion,
): PublishedModel {
  return {
    id: info.id,
    name: info.name,
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
    input: info.supportsImages ? ['text', 'image'] : ['text'],
    reasoningEfforts: reasoningEffortsOf(info, observed, region),
  }
}

/**
 * Build one region's published provider route.
 *
 * The route key is the region's provider id, which is also what the model
 * picker groups under and what every settings path addresses. Keeping the two
 * ids distinct is load-bearing: the upstreams advertise overlapping model ids
 * (`deepseek-v4.1-flash` exists on both), and a shared route key would make a
 * request's descriptor depend on which region registered last.
 *
 * @param input - the region's display label, shim origin, and resolved models.
 * @returns the route entry to write under `providers[<providerId>]`.
 */
export function publishRoute(input: PublishInput): PublishedRoute {
  const { region, displayName, shimOrigin, models, observe } = input
  return {
    displayName,
    api: ROUTE_API,
    baseURL: `${shimOrigin}/v1`,
    apiKeyEnv: routeApiKeyEnv(region),
    compat: { maxTokensField: 'max_tokens' },
    models: models.map(info => publishedModelOf(info, observe?.(info.id), region)),
  }
}

/**
 * Whether an already-stored route entry matches what would be published now.
 *
 * Used to skip a configuration write that would change nothing — a profile
 * patch write restarts the affected entry, so publishing an identical route on
 * every sign-in would restart the model directory for no reason.
 *
 * Compared structurally rather than by `JSON.stringify` alone so a reordered
 * model list is *not* treated as equal: order is what the picker shows.
 *
 * @param stored - the entry currently under `providers[<providerId>]`, if any.
 * @param next - the entry {@link publishRoute} just built.
 */
export function routeMatches(stored: unknown, next: PublishedRoute): boolean {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return false
  const entry = stored as Record<string, unknown>
  if (entry['displayName'] !== next.displayName) return false
  if (entry['api'] !== next.api) return false
  if (entry['baseURL'] !== next.baseURL) return false
  if (entry['apiKeyEnv'] !== next.apiKeyEnv) return false
  const models = entry['models']
  if (!Array.isArray(models) || models.length !== next.models.length) return false
  return next.models.every((model, index) => modelMatches(models[index], model))
}

/** Whether one stored model entry matches a freshly published one, field by field. */
function modelMatches(stored: unknown, next: PublishedModel): boolean {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return false
  const entry = stored as Record<string, unknown>
  if (entry['id'] !== next.id) return false
  if (entry['name'] !== next.name) return false
  if (entry['contextWindow'] !== next.contextWindow) return false
  if (entry['maxTokens'] !== next.maxTokens) return false
  const input = entry['input']
  if (!Array.isArray(input) || !Array.isArray(next.input)) return input === next.input
  if (input.length !== next.input.length) return false
  if (!next.input.every((modality, index) => input[index] === modality)) return false
  return JSON.stringify(entry['reasoningEfforts']) === JSON.stringify(next.reasoningEfforts)
}
