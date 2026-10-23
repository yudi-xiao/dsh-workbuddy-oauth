/**
 * The Models page sign-in for WorkBuddy's published routes.
 *
 * ## What a flow has to do here
 *
 * `ctx.authorization` is the seam every credential-obtaining UI goes through:
 * the Models page lists a route's methods from the flow registered under that
 * route's credential key, and pressing the button runs the flow's `run`.
 *
 * The flow contract ends with `session.commit(record)` — a pi-ai credential
 * record. **This plugin deliberately does not write one.** Its credentials live
 * in its own store, one file per account, because the whole point of the plugin
 * is a rotating multi-account pool; collapsing that into pi-ai's single
 * `{ type: 'oauth', refresh, access, expires }` record per provider would throw
 * away per-account cooldown and session affinity.
 *
 * The seam tolerates that: `begin()` reports `NOT_COMMITTED` when a flow
 * resolves without committing *during the attempt*, and the flow is allowed to
 * commit nothing at all — what the surface needs is the outcome. So `run` drives
 * the plugin's own device-code login to completion, stores the account in the
 * plugin's store, and returns. The Models page sees a completed attempt; the
 * next status read reports the account, and the route — already published with
 * its bearer — starts serving.
 *
 * ## Why the flow is registered even when nobody can sign in yet
 *
 * Registration is unconditional on configuration, exactly as `llm-pi-ai` does
 * for its catalog providers: a route has to be signed into *before* it is worth
 * showing models, so the method must exist from the moment the plugin mounts.
 *
 * @module dsh-workbuddy-oauth/authorization-flow
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { WorkBuddyRegion } from './region.ts'
import { regionEndpoints } from './region.ts'

/**
 * The slice of `ctx.authorization` this module uses.
 *
 * Declared locally rather than imported: the service is optional in a headless
 * composition, and a hard type dependency would make the plugin refuse to load
 * where the models still work.
 */
export interface AuthorizationRegistry {
  registerFlow: (flow: {
    key: string
    label: string
    methods: readonly { id: string; label: string }[]
    run: (session: AuthorizationSession) => Promise<void>
  }) => () => void
}

/** The session a flow is run with; only the members this module needs. */
export interface AuthorizationSession {
  readonly method: string
  readonly signal: AbortSignal
  notify: (notice: { message: string; url?: string; code?: string }) => void
  prompt: (prompt: {
    kind: 'text' | 'secret' | 'select'
    message: string
    placeholder?: string
    options?: readonly { id: string; label: string; description?: string }[]
  }) => Promise<string>
}

/** What the flow needs from the plugin to run a sign-in. */
export interface FlowDeps {
  /** Start an attempt: returns the URL the human must open. */
  begin: (region: WorkBuddyRegion) => Promise<{ url: string; state: string }>
  /**
   * Redeem an attempt.
   *
   * Resolves with the signed-in account once the human has approved, and throws
   * a pending error while they have not. The flow polls this itself: the seam
   * has no notion of "not yet", so waiting is the flow's job.
   */
  complete: (state: string) => Promise<{ uid: string; label: string }>
  /** Poll pacing, injectable so tests do not sleep. */
  sleep?: (ms: number) => Promise<void>
  /** How many times to poll before giving up. */
  attempts?: number
  /** Gap between polls. */
  intervalMs?: number
  /** Whether an attempt is retryable rather than failed. */
  isPending: (error: unknown) => boolean
}

/** Default poll pacing, matching the `/wb-login` command. */
const DEFAULT_ATTEMPTS = 20
const DEFAULT_INTERVAL_MS = 3_000

/**
 * The credential key the flow registers under.
 *
 * `llm-pi-ai`'s record scope, because that is the scope the Models page reads a
 * route's methods from — the page derives it from the route it is rendering, not
 * from which plugin owns the route.
 *
 * @param providerId - the route key, e.g. `workbuddy-oauth-ai`.
 */
export function flowKeyFor(providerId: string): string {
  return credentialKey('llm-pi-ai', providerId)
}

/**
 * Register one region's sign-in flow.
 *
 * @param ctx - the plugin context carrying the optional `authorization` service.
 * @param providerId - the published route this flow signs into.
 * @param region - which upstream the flow authenticates against.
 * @param deps - the plugin's own login implementation and poll pacing.
 * @returns a disposer, or `undefined` when this composition has no authorization
 *   service (headless and ACP profiles, where the commands remain the surface).
 */
export function registerSignInFlow(
  ctx: Context,
  providerId: string,
  region: WorkBuddyRegion,
  deps: FlowDeps,
): (() => void) | undefined {
  const registry = ctx.get('authorization') as AuthorizationRegistry | undefined
  if (registry === undefined) return undefined
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) }))
  const attempts = deps.attempts ?? DEFAULT_ATTEMPTS
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  try {
    return registry.registerFlow({
      key: flowKeyFor(providerId),
      label: regionEndpoints(region).label,
      methods: [{ id: 'oauth', label: '登录 WorkBuddy' }],
      async run(session: AuthorizationSession): Promise<void> {
        if (session.method !== 'oauth') {
          throw new Error(`unsupported sign-in method: ${session.method}`)
        }
        const request = await deps.begin(region)
        // The URL is what the human needs first; `notify` carries it to the page
        // so the flow does not have to prompt for something it already knows.
        session.notify({
          message: `请在浏览器中打开以下链接完成${regionEndpoints(region).label}授权：`,
          url: request.url,
        })
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          if (session.signal.aborted) throw new Error('sign-in cancelled')
          try {
            const account = await deps.complete(request.state)
            session.notify({ message: `已登录：${account.label}` })
            return
          } catch (error: unknown) {
            if (!deps.isPending(error)) throw error
          }
          if (attempt < attempts - 1) await sleep(intervalMs)
        }
        throw new Error('授权超时，请重新发起登录')
      },
    })
  } catch (error: unknown) {
    // A duplicate key means something else already claims this route's sign-in.
    // The route still serves requests, so this is reported rather than fatal.
    ctx.logger.warn(
      `dsh-workbuddy-oauth: 无法为 ${providerId} 注册登录流程，模型页将不显示登录按钮`,
      error,
    )
    return undefined
  }
}
