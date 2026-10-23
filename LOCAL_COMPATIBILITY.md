# Local DSH 0.2.1 compatibility build

Upstream: https://github.com/molly-ovo/dsh-workbuddy-oauth
Base commit: 3fcb35d6a0d147b5e97bfc076c8d2a9a2ddcce29
Base version: 0.0.4
Local version: 0.0.5-dsh021.1
Reviewed protocol patch: PR #1, exact head c0aef77b13a5eb5d97e293fa9ba8a869b377675b.

This repository is a maintained branch of that upstream, tracking **DSH
Desktop 0.2.1-rc.2** and pi-ai **1.1.0**. It is not an upstream release.

## Changes

- Retain pi-ai ^1.1.0 peer / 1.1.0 development dependency and matching source/bundle version guard. Do not downgrade the host.
- Target host packages `0.2.1-rc.2`: peer ranges are `^0.2.1-rc.2` and devDependencies pin `0.2.1-rc.2` (`@deepseek-ai/cordis` 4.0.5, `@deepseek-ai/schemastery` 3.18.5). The 0.2.0 peer set cannot resolve against the 0.2.1 `dsh-llm-pi-ai`, whose `PiAiAdapter` is typed against a later pi-ai; the install then carries two pi-ai copies and `tsc` fails on `TranscriptContext`'s brand property.
- Adapt PR #1's chat/probe headers: intent=craft and purpose=conversation on both regions; type=main only on Global. Existing OAuth, region selection, credentials, network destinations and account identity headers remain unchanged.
- Derive salted 32-hex conversation/turn IDs using the local session key and latest genuine user input. Retries, tool continuations and account/model changes retain a turn; every outbound message has a fresh message/request ID pair unless supplied by a caller. Raw local session IDs are not forwarded.
- Correct PR turn detection: genuine user text immediately after a tool result or assistant tool call starts a new turn. Skip only explicit tool-result-only user content, not all user messages following tools.
- Preserve caller IDs case-insensitively, without adding duplicate HTTP field names. Honor a carried conversation ID as the turn namespace.
- This is a local build, not an upstream release or a guarantee of gateway acceptance.

## Build and verification

All of the following ran in this repository's own checkout with
`pnpm install --frozen-lockfile` and the lockfile committed here.

- `pnpm typecheck` — both projects (`tsconfig.json` for the Host half,
  `tsconfig.client.json` for the browser half) exit 0 against DSH
  `0.2.1-rc.2` and pi-ai `1.1.0`.
- `pnpm test` — Vitest, 26 files / 325 tests, all passing. The suite never
  touches the network: upstream chat, probe, catalog refresh and OAuth calls
  are mocked, and the loopback shim is exercised over real local HTTP.
- `pnpm build` — tsdown emits `lib/index.js` + `lib/index.d.ts` (ESM, Host) and
  `lib/client.js` (CJS, browser). `__DSH_WORKBUDDY_OAUTH_VERSION__` is injected
  from `package.json` as `0.0.4-dsh021.2`.
- Both emitted bundles pass `node --check`; importing `lib/index.js` yields the
  expected `name`/`inject`/`Config` exports and both provider ids
  (`workbuddy-oauth`, `workbuddy-oauth-ai`).
- Packaging reviewer independently ran .2 inside installed Desktop DSH
  0.2.1-rc.2 / Electron 44.7.0 / Node 24.21.0 with the actual host pi-ai 1.1.0:
  full bundle import, adapter construction, listModels/resolveModel/catalog
  invalidation, mocked text/tool SSE, usage and finish events all passed. A
  separate in-memory test-only upstream export verified four intercepted dummy
  Global/CN requests: agent headers, conversation/request IDs, stable
  tool-continuation turn and changed next-user turn passed. No plugin apply(),
  real credentials, live network calls, profile mutation or restart in either
  smoke.

## Limitations

- IDs are process-salted, not persistent across restarts. Turn derivation assumes retained message position/content; compacted or edited histories can change IDs, while an identical replacement send at the same position is indistinguishable without a caller-provided turn ID.
- Without a local session key, conversation identity falls back to the first signable user content; distinct histories with identical first input can share a derived conversation ID. Empty/unreadable user content gets a fresh per-request turn ID.
- PR live 400/11128 claims are upstream-reported, not locally reproduced. Offline passes do not establish authentication, actual upstream completion, billing semantics, or resolution of every intercepted request. No authentication/region changes or risk-control bypasses included.
- `pnpm typecheck` and `pnpm test` depend on the DSH `0.2.1-rc.2` type packages
  being installable; a host generation change means updating the peer/dev ranges
  before these checks mean anything again.

## Model configuration ownership (0.0.5-dsh021.1)

Public commit boundary: `c6af050`. Everything below is local work after it.

The plugin no longer registers a pi-ai adapter of its own. WorkBuddy's routes
are ordinary `llm-pi-ai` provider entries, so DSH's Models page owns the model
list and there is one place that decides what a route serves.

- `provider-config.ts` turns a region's catalog into a route entry: endpoint,
  protocol, a per-region credential reference, `compat.maxTokensField`, and
  models carrying context window, output cap, modalities and effort levels.
- `route-publisher.ts` writes that entry through the settings seam, serialized
  across both regions because they share one settings revision. It seeds a
  **missing** route once. An existing route is never rewritten: its models and
  every other field the user configured are preserved. Only an explicit
  `sync-provider` replaces `models`, and even then the endpoint, credential
  reference and custom keys stay as the user left them. A route whose endpoint
  or credential reference was customised is refused rather than overwritten.
- The endpoint's bearer goes to the credential seam under a per-region
  reference, so no secret enters the configuration file. The legacy shared
  `WORKBUDDY_OAUTH_TOKEN` is migrated on the next publish.
- `provider-directory.ts` advertises each route with
  `nativeAuth: { env: [], oauth: true }`. That pair is what makes the Models
  page render a **sign-in button instead of an endpoint/API-key form** — the
  presentation `openai-codex` gets from being a pi-ai catalog provider. A
  third-party plugin cannot join pi-ai's build-time catalog, so this directory
  entry is the closest equivalent the host exposes.
- `authorization-flow.ts` registers the sign-in behind that button under the
  `llm-pi-ai/<provider>` credential key, driving the same `begin`/`complete`
  pair as `/wb-login`. It deliberately commits **no** pi-ai credential record:
  accounts stay in this plugin's own per-file store, which is what keeps the
  rotating pool, per-account cooldown and session affinity working.
- The settings card shows the upstream catalog read-only and reports the
  published route's state. It offers an explicitly confirmed import that
  replaces the route's model list, and says so before doing it. Model
  visibility, the maximum-window switch and the composer reasoning probe are
  gone: those decisions belong to the Models page now.

### Session affinity

The published route cannot send `x-session-id` — pi-ai withholds
`sendSessionAffinityHeaders` from configuration — so the shim derives the
affinity key from the request body: a digest of the conversation's first user
message. Same conversation, same account; a different conversation may rotate.

Limits of that derivation, stated because they are not obvious:

- Two distinct conversations whose first user message is byte-identical share
  one affinity key, and therefore one account.
- Compacting or editing history so the first user message changes produces a
  new key, which may move that conversation to another account. Messages stay
  in DSH, so the context is not lost — only the account binding is.

This is weaker than a true session id and is not claimed to be isolation.

## Build and verification

All of the following ran in this repository's own checkout with
`pnpm install --frozen-lockfile` and the lockfile committed here.

- `pnpm typecheck` — both projects (`tsconfig.json` for the Host half,
  `tsconfig.client.json` for the browser half) exit 0 against DSH
  `0.2.1-rc.2` and pi-ai `1.1.0`.
- `pnpm test` — Vitest, 28 files / 374 tests, all passing. The suite never
  touches the network: upstream chat, probe, catalog refresh and OAuth calls
  are mocked, and the loopback shim is exercised over real local HTTP.
- `pnpm build` — tsdown emits `lib/index.js` + `lib/index.d.ts` (ESM, Host) and
  `lib/client.js` (CJS, browser).
- Both emitted bundles pass `node --check`; importing `lib/index.js` yields the
  expected `name`/`inject`/`Config` exports and both provider ids
  (`workbuddy-oauth`, `workbuddy-oauth-ai`).

### GitHub install

Verified end to end, twice, against throwaway profiles:

```
dsh plugin --profile <name> add github:yudi-xiao/dsh-workbuddy-oauth
```

- A missing profile is initialized from the template first.
- pnpm fetches the repository tarball; the lockfile pins the exact commit SHA
  (`dsh-workbuddy-oauth@https://codeload.github.com/.../tar.gz/<sha>`).
- `dsh.profile.bundles` is reconciled automatically, so the plugin row mounts
  without a hand edit.
- `dsh --profile <name> --dump-config` then shows the `llm-workbuddy-oauth` row.
- `github:...#main` resolves the same way.
- No build step runs: `lib/` is committed and shipped as-is.

Two claims that turned out to be **false** during this work, recorded so they are
not repeated:

- A bare directory without the profile's `allowBuilds` reports
  `ERR_PNPM_IGNORED_BUILDS` for `@google/genai` and `protobufjs` (pulled in by
  pi-ai). That is a property of the *consuming* profile, not of this package.
- Adding `pnpm.onlyBuiltDependencies` to this package's manifest does **not**
  silence it: pnpm reads that field from the workspace root, not from a
  dependency. Two commits built on that assumption were reverted.

### Live status

An earlier 0.0.5 build was installed into the desktop profile and confirmed to
start: both listeners bind 39271/39272, the status route reports the new
`route` field per region, and the international route was written into the
profile's `llm-pi-ai.providers` with two models.

The desktop profile has since been switched from the local tarball to
`github:yudi-xiao/dsh-workbuddy-oauth` through the plugin manager
(`application: applied`), and the installed package carries the directory-entry
code.

**The OAuth presentation has not been observed in a running DSH yet.** The
directory registration and sign-in flow were added after the running instance
started, so these still need a restart to confirm:

1. Settings → Models lists WorkBuddy with a sign-in button and no endpoint or
   API-key fields.
2. Pressing it reaches the plugin's device-code login.
3. An existing route's `apiKeyEnv` migrates from the legacy shared
   `WORKBUDDY_OAUTH_TOKEN` to the per-region reference without touching its
   models.

## Limitations

- IDs are process-salted, not persistent across restarts. Turn derivation
  assumes retained message position/content; compacted or edited histories can
  change IDs.
- Without a usable user message, conversation identity falls back to the first
  signable user content, as described under session affinity.
- PR live 400/11128 claims are upstream-reported, not locally reproduced.
  Offline passes do not establish authentication, actual upstream completion,
  billing semantics, or resolution of every intercepted request. No
  authentication/region changes or risk-control bypasses included.
- `pnpm typecheck` and `pnpm test` depend on the DSH `0.2.1-rc.2` type packages
  being installable; a host generation change means updating the peer/dev
  ranges before these checks mean anything again.
