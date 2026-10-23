# Local DSH 0.2.1 compatibility build

Upstream: https://github.com/molly-ovo/dsh-workbuddy-oauth
Base commit: 3fcb35d6a0d147b5e97bfc076c8d2a9a2ddcce29
Base version: 0.0.4
Local version: 0.0.4-dsh021.2
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


## 本地原生模型所有权重构（0.0.5-dsh021.1）

公开提交边界为 `c6af050`；本节描述其后的本地工作，不表示已发布或已安装验证。

- DSH 原生 `llm-pi-ai.providers` 管理模型。插件只负责账号、回环连接和只读上游目录，不提供第二套模型编辑器。
- 已有路由的模型列表不会因启动、登录或刷新目录自动替换；缺失路由可初始化模型。
- 卡片保留显式 `sync-provider` 导入，并在发送前提示确认：它会替换对应 provider 的模型列表，覆盖用户的原生模型编辑。普通刷新不执行导入。
- 移除隐藏模型复选框、最大上下文开关和 composer 探测注册。旧探测结果不再控制原生模型目录或推理档位。账号、积分和登录保留。
- 请在 **DSH 设置 → 模型** 编辑模型、上下文窗口与推理选项。

### 验证边界

本次未安装插件、未登录、未发起真实聊天或导入请求；Client Slot 运行时读取超时，因此不声称在线 UI 验证。上面的 325 测试与离线加载结果仅属于历史版本，不能作为此次重构的验证结果。

本次 Client 独立 TypeScript 检查通过。并行重构期间全套测试快照为 346 通过 / 3 失败：固定回环端口占用、登出后目录应为空的旧断言，以及国际版凭据引用的旧断言；尚不能宣称全套通过。完整 Host 类型检查也受并行接口改动影响，需集成后重新验证。
