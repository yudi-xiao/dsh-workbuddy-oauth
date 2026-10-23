# dsh-workbuddy-oauth

把 WorkBuddy / CodeBuddy 的模型接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

国内版与国际版各一套端点，**自己走 OAuth 设备码流程**——不读桌面 App 的凭据文件，所以不用装桌面 App，也不受它的安装位置、凭据加密格式与版本号影响。密码不经过本插件：授权在浏览器完成，插件只拿令牌。

- **多账号**——同时登录多个，选号时自动跳过被限流的；某个账号额度耗尽**只停它一个**，其余照常服务。
- **尽力保持账号粘性**——有显式会话标识时优先使用，否则从首条用户输入派生。相同首条输入可能共享粘性键，裁剪历史可能改变键；这不是严格的会话隔离。失效或冷却账号会在后续请求中重新选择。

![license](https://img.shields.io/badge/license-MIT-blue.svg) ![node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-green.svg)

> **本仓库的定位。** 这是 [molly-ovo/dsh-workbuddy-oauth](https://github.com/molly-ovo/dsh-workbuddy-oauth) 的本地维护分支，面向 **DSH Desktop 0.2.1-rc.2** 与 pi-ai **1.1.0** 这一代宿主。它保留上游的 OAuth 设备码登录、多账号与会话粘性实现，只做宿主兼容与协议对齐的改动，改动明细见 [LOCAL_COMPATIBILITY.md](./LOCAL_COMPATIBILITY.md)。

> **版本边界：** 当前版本为 `0.0.5-dsh021.3`，提供插件自有命名空间下的手动区域服务商目录。已通过双端类型检查、374 项测试、构建和本机插件安装，并确认运行中第三方列表显示国内／国际入口及自定义卡片。未操作用户模型配置或重测真实上游请求，详见 [兼容记录](./LOCAL_COMPATIBILITY.md)。

---

## 安装

前置：`pnpm` 在 `PATH` 上、Node.js `^22.19.0 || >=24.0.0`，以及一个 WorkBuddy / CodeBuddy 账号（国内版或国际版均可）。**不需要安装桌面 App**——登录由本插件自己走 OAuth 设备码流程完成。

> **要求 DSH `0.2.1-rc.2`。** 本插件的 peer 依赖声明为 `^0.2.1-rc.2`，devDependency 固定为 `0.2.1-rc.2`，并与宿主同代使用 pi-ai **1.1.0**。DSH `0.2.0` 把设置服务换成了 Config 表单门面，`0.2.1` 又把 `dsh-llm-pi-ai` 的内部形状推进了一代；跨代混用会出现两套 `pi-ai` 并存（`Context` 类型不兼容、`TranscriptContext` 缺少 brand 属性），插件在加载期就会因类型对不上而注册失败。只跟最新一代，省掉这层兼容负担。

### 从 GitHub 安装（推荐）

只需要仓库地址，不需要本地源码、不需要构建：

```sh
dsh plugin --profile desktop add github:yudi-xiao/dsh-workbuddy-oauth
```

Desktop 版的 profile 叫 `desktop`；`web`、`headless` 等其它 profile 同理换成对应名字。也可以带分支或提交：`github:yudi-xiao/dsh-workbuddy-oauth#main`。

也可以在 **设置 → 插件** 里添加同一个 `github:` 地址，效果相同。

**本仓库随包分发已重新构建的 `lib/` 产物**，安装不需要本地编译；具体测试与运行验证范围见兼容记录。

### 这条命令做了什么（历史版本记录，不代表 .3 已验收）

- profile 不存在时自动从模板初始化。
- 通过 pnpm 从 GitHub 拉取 tarball 安装，lockfile 锁定到具体 **commit SHA**。
- **自动对账 `dsh.profile.bundles`**——本插件声明了 `dsh.bundle.patch`，用于挂载账号服务与 Client 卡片，不接管原生模型目录。

**装完重启 DSH**。插件行和模型 provider 目录都在进程启动时组成，刷新浏览器不足以加载 Host 半边。

> **升级**：重新执行一次 `add` 即可。GitHub 形式的依赖在 lockfile 中锁定 SHA，**不会自动跟随新提交**；重新 `add` 才会重新解析到最新提交。

> **注意**：包内 `pnpm add` 的告警如 `peer dependencies` 属正常（peer 由宿主提供）。若看到 `ERR_PNPM_IGNORED_BUILDS`，那是**安装方 profile** 的构建脚本策略问题，与本插件无关；Desktop 的 profile 模板已带 `allowBuilds`，正常不会出现。

### 从本地源码安装

```sh
git clone https://github.com/yudi-xiao/dsh-workbuddy-oauth.git
dsh plugin --profile desktop add ./dsh-workbuddy-oauth
```

**确认已生效**——重启后运行 `/wb-status` 应有输出。若没有：确认该 profile 的插件行 `enabled`、`llm-workbuddy-oauth` 已注册，并检查「插件」页是否能看到本条目。

**卸载**：

```sh
dsh plugin --profile desktop remove dsh-workbuddy-oauth
```

账号凭据与插件状态都在 `$DSH_HOME/workbuddy-oauth/` 下，**卸载不会删除**；要彻底清理请手动删该目录（见[隐私](#隐私)）。

---

## 用法

登录：卡片顶部「登录 · 国内版 / 国际版」→ 浏览器完成授权 → 回卡片点「我已完成授权」。也可以直接用命令，两条路径走的是同一套实现。

| 命令 | 作用 |
|---|---|
| `/wb-login [cn \| global]` | 登录（默认 `cn`），会弹出可直接点击的授权链接 |
| `/wb-status` | 查看已登录账号、区域、令牌有效期 |
| `/wb-account [enable\|disable] <uid 前缀>` | 启用 / 停用账号 |
| `/wb-logout [uid 前缀]` | 退出登录（只删本插件保存的凭据，不动上游账号） |

登录、状态、账号管理与积分查询也可在 **设置 → 插件 → DSH WorkBuddy OAuth** 卡片中完成。

### 手动添加区域服务商

在 **设置 → 模型 → 添加 → 第三方**（Settings → Models → Add → Third-party）选择 **WorkBuddy (国内版)** 或 **WorkBuddy AI (国际版)**。这是插件自有命名空间中的可配置目录项，不是把新路由自动写入 `llm-pi-ai.providers`。

进入 WorkBuddy 自定义服务商卡片后，显式选择需要的模型，再使用 **WorkBuddy 卡片自己的保存控件**保存。上游目录只是候选项，不等于已配置模型；不默认全选，也不通过启动、登录或刷新目录自动创建路由、补回删除的条目或恢复空模型选择。

现有 OAuth 账号界面保留：设备码登录、授权完成确认、账号管理和积分查询仍在 WorkBuddy 卡片中，命令入口也不变。登录只管理账号，不等于添加服务商或选择模型。

### 原生编辑器与旧路由的边界

- DSH `0.2.1-rc.2` 的通用编辑器可能把插件命名空间视为未知，显示提示或禁用它自己的「保存」。请使用 **WorkBuddy 卡片的保存控件**；不把目录项可见解释为通用编辑器已完全支持该命名空间。
- 旧的 `llm-pi-ai.providers` WorkBuddy 路由保持原样，不自动迁移、覆盖或删除。旧路由与新区域目录项冲突时，先抑制对应的新路由注册，避免争抢同一 provider。
- 如需切换，先记录旧路由中需要保留的模型及选项，再由你在原生模型设置中手动移除旧路由，然后手动添加对应的新区域服务商。插件不会替你删除旧配置，也不会自动复制旧模型选择。
- 删除服务商、删除模型和保存空选择都是有效用户决定。启动、登录和刷新不能撤销这些决定；要重新启用必须再次手动添加或选择并保存。

上下文窗口与推理选项以已保存配置和上游实际支持为准。最大窗口偏好仅影响后续新增模型，不改写已保存模型；旧 composer 探测数据不决定模型目录或推理选项。

---

## 工作原理

```
DSH 模型选择器
  └─ WorkBuddy 插件自有区域服务商（手动保存的模型配置）
       └─ 回环端点  127.0.0.1，进程内，带一次性共享密钥
            └─ 上游  copilot.tencent.com / www.workbuddy.ai 等
```

- **无常驻进程、无对外端口。** 回环端点在本插件进程内，只绑 `127.0.0.1`，并校验进程内生成的共享密钥。
- **凭据每账号一文件**，原子写入，权限 `0600`。
- **令牌刷新惰性触发**（过期前 5 分钟），进程内单飞 + 跨进程文件锁——上游会轮换 refresh token，并发刷新会让第二个请求送出已被消费的令牌。
- **设备指纹按 uid 稳定派生**，同账号恒定、跨账号隔离；登录流程**不带**指纹。

同类方案的凭据来源主要有三种，本插件选了第一种：

| 路线 | 凭据来源 | 需要桌面 App | 代表实现 |
|---|---|---|---|
| **本项目** | 自己的 OAuth 设备码流程 | 不需要 | — |
| 读桌面凭据 | 桌面 App 的本地文件 | 需要 | [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) |
| 外部代理进程 | 本地网关进程 | 视实现而定 | `workbuddy2api` 系（如 [tearslee/dsh-workbuddy2api](https://github.com/tearslee/dsh-workbuddy2api)） |

代价是要自己维护登录流程；换来的是不依赖桌面端的安装位置、凭据加密格式与版本号。

### 与上游的关系

本仓库**不是** [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) 的 fork：connect 复用桌面 App 的凭据文件，本插件改为自己走 OAuth 设备码流程。改动集中在凭据来源这一层，但会牵动登录、刷新、状态落盘等多处，**改到后来已经不太像同一个项目**，因此以上游 `molly-ovo/dsh-workbuddy-oauth` 为基线移植（vendor）并单独维护。

代价是**上游后续的修复不会自动进来**，需要自己留意。移植部分的出处与重合度都逐文件标注在[鸣谢](#鸣谢)中，`LICENSE` 也声明了本项目包含来自其他 MIT 项目的代码——如果其中有任何不妥，欢迎指出，我会调整。

### 跟进上游

本仓库没有配置 `upstream` remote。想对比上游改动时可以临时加两个**只读**远程：

```sh
git remote add upstream-oauth https://github.com/molly-ovo/dsh-workbuddy-oauth.git
git remote add upstream-connect https://github.com/corrinehu/dsh-workbuddy-connect.git
git fetch upstream-oauth upstream-connect
git diff upstream-oauth/main -- src/
git diff upstream-connect/main -- src/upstream.ts
```

只用来查看差异、手动挑拣，不推送。

### 二次开发

```sh
cd /path/to/dsh-workbuddy-oauth
pnpm install
pnpm typecheck                      # tsc --noEmit，宿主与客户端两个工程
pnpm test                           # vitest，不触网
pnpm build                          # 重新生成 lib/index.js 与 lib/client.js
```

pnpm 对本地目录默认以**链接**方式安装，所以构建完 profile 会**即时**拿到新产物，无需重装。改完客户端半边刷新浏览器即可；改动宿主半边（`lib/index.js`）需要重启 DSH。

> **提交产物就意味着要一起提交。** 改完 `src/` 请务必 `pnpm build` 并把 `lib/` 一并提交，否则仓库里的产物会落后于源码——而别人 clone 到的正是那份产物。

`pnpm typecheck` 与 `pnpm test` 都依赖本机安装的 DSH `0.2.1-rc.2` 类型包；若宿主代次变化，先更新 `package.json` 里的 peer/dev 版本再验证。

---

## 隐私

账号昵称在上游常常就是手机号或邮箱。所有会显示昵称的地方（`/wb-status`、`/wb-account`、设置页卡片、状态文档）都经过同一层脱敏：

| 类型 | 原始 | 显示 |
|---|---|---|
| 手机号 | `13800138000` | `13*******00` |
| 邮箱 | `alice1990@example.com` | `al*90@example` |

手机号只保留前 2 位与末 2 位（11 位中隐藏 7 位）；邮箱保留本地部分前 2 位与末 2 位、中间**固定一个星号**，并去掉域名末段（`.com`）。

邮箱之所以不做成 `a****@example.com` 那样「按实际长度打星」，是因为账号名要出现在列表里——**星号数随地址长度增长，会把整列撑宽**。固定成一个星号，标签宽度才有上界。

脱敏**只作用于显示**：凭据文件里保留原始值，功能不受影响。日志里只记录 uid 的前 8 位，从不记录昵称。

**登出会删掉什么**：`/wb-logout`（以及设置页的「登出」）清除该账号的**全部**痕迹，而不只是凭据文件：

| 位置 | 内容 |
|---|---|
| `accounts/workbuddy-<uid>.json` | 访问令牌、刷新令牌、昵称、企业 id |
| `cooldowns.json` | 该账号的失败冷却记录 |
| `disabled-accounts.json` | 该账号的启用 / 停用状态 |
| `probe-<region>.json` | 该账号的推理档位探测记录 |

这四类都以 uid 为键，只删凭据会让 uid 继续留在其余文件里——既是隐私问题（uid 是账号标识），也会在同一个账号再次登录时让旧的停用状态或探测结论悄悄生效。

所有状态都在 `$DSH_HOME/workbuddy-oauth/` 下，删除该目录即可完全重置。

> 注：`/wb-account disable` 是**可逆**的，只把账号移出选择，凭据与状态都保留；只有登出才会删除。

---

## 配置

插件行接受以下配置（在 profile 的 `cordis.patch.yml` 中设置）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `region` | `cn` | 默认区域，`cn` 或 `global` |
| `appVersion` | `""` | 出站身份中的客户端版本号，留空用内置兜底值 |
| `cliVersion` | `""` | 出站身份中的 CLI 版本号，留空用内置兜底值 |

---

## 已知限制

- **依赖上游非公开接口。** WorkBuddy / CodeBuddy 更新后，本插件可能需要随之调整。
- **推理能力以实际上游支持为准。** 在 DSH 原生模型配置中管理推理选项；插件不自动探测或把历史探测结论写回模型。
- **国际版与国内版是两套账号体系**，额度互不通用，需分别登录。
- **模型目录随上游变化**，本地缓存可能滞后。
- **失败换号要等到下一次请求。** 某账号被限流或额度耗尽时，**当前这次请求仍会返回错误**；该账号被冷却后，**下一次请求**才会自动落到另一个可用账号上。

  插件**不做请求内重试**：流式响应一旦开始就无法透明重发，且同一个请求体换账号重发会放大上游风控风险。DSH 自身的重试层在重试时会重新走一遍选号，所以实际体验通常是「偶发一次报错后自动恢复」。

  同一个对话也不例外——会话粘性**不会**把你钉在坏账号上，下一条消息就会换到健康账号，上下文不丢（消息由 DSH 持有，不在账号上）。

- **上下文窗口以已保存的模型配置为准。** 新服务商使用 WorkBuddy 卡片保存；旧 `llm-pi-ai` 路由仍由原生配置管理。最大窗口偏好仅影响后续新增模型。
- **验证边界。** 删除／空选择与所有权切换由隔离测试覆盖；真实用户配置的保存、删除及重启未作为诊断操作执行，OAuth 与真实上游请求本次未重测。

---

## 免责声明

- 本项目**仅供个人逆向学习与技术研究使用**，请勿用于商业用途或超出个人合理使用的场景。
- 使用者需遵守任一官方的服务条款，并自行承担因使用本项目产生的任何后果（包括但不限于账号被限制、额度被清空、服务中断）。
- 本插件只使用你自行登录后获得的令牌，不收集、不上传任何凭据到第三方服务器。
- 本项目与任一官方均无关联，未获其授权或认可；文中出现的名称仅用于描述兼容关系，商标权利归各自所有。
- 本项目作者不对因使用或滥用本项目产生的任何直接或间接损失负责。
- **本项目由 AI 参与移植与改写**，可能存在缺陷，请自行评估风险。若无意侵犯任意一方的权益，请联系我，我会**立即删除**相关内容。

---

## 鸣谢

本插件站在若干开源项目的肩膀上。以下项目或提供了被移植的代码，或提供了关键的对照实现与线路行为参考——**没有它们，这个插件不会存在**。

| 项目 | 作者 | 本插件使用了什么 |
|---|---|---|
| [molly-ovo/dsh-workbuddy-oauth](https://github.com/molly-ovo/dsh-workbuddy-oauth) | molly-ovo | **本仓库的直接上游。**OAuth 设备码登录、多账号与会话粘性实现均以此为基础。 |
| [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) | Corrine Hu | **最主要的上游。**核心模块直接移植自此上游。 |
| [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) | Sliverkiss | 设备指纹派生算法 `derive_id`；线路行为经 connect 间接源自此项目。 |
| [workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub) | ardeyouxipianyi | 指纹方案的实测依据；登录流程、刷新单飞、惰性刷新等防风控规则的对照实现 |
| [workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel) | linguo2625469（fork） | 登录状态落盘防混域、登录 TTL 与轮询限速等对照实现 |

> 关于 `Sliverkiss/workbuddy2api`：该上游项目已删除。

特别感谢 **Corrine Hu**——`dsh-workbuddy-connect` 是这一切的起点，本插件与它的差别只在于去掉桌面端凭据解密（`desktop-credential-protection.ts` 未被使用），其余绝大部分逻辑都源于它的实现与逆向工作；**Sliverkiss**——`workbuddy2api` 系列对上游接口的整理与指纹方案，是本插件能与 WorkBuddy 通信的前提；**ardeyouxipianyi**——`workbuddy2api-hub` 提供的指纹实测依据与防风控对照实现，让选号与刷新策略有据可循。

本插件运行在 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 之上，并依赖其客户端插件体系（`@deepseek-ai/dsh`）。设置卡片的按钮交互样式对齐了 DSH 自带的 `dsh-client-ui-primitives`，主题色全部使用其 `--dsw-alias-*` 令牌。

---

## 许可

MIT，见 [LICENSE](./LICENSE)。
