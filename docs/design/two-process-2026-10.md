# 第④步「两个进程」施工单(2026-10-06)

> 这份文档只写**怎么拆**,不改代码。方向是用户在 `architecture-direction-2026-10.md` §1 拍过的
> (只有一个后端、两个进程、凭证归后端、客户端的事不经后端、CLI 走 HTTP、插件与 gateway 挂后端);
> 这里把它翻成一批一批能单独做、单独回退、门能自证的活,并把方向文档没定的事列成决策点表。
> 摸底数字都是 10-06 在 HEAD `c8f119a3a` 上实测的,带 `file:line`。
>
> 读法:§0 是一页纸总览;§1 是摸底(为什么这么排);§2 逐批施工单;§3 决策点表(要用户拍的都在这里);
> §4 不做 / 以后做;§5 陌生能力演练;§6 一句话的汇报要点。

## 0. 一句话与总览

**一句话**:后端今天是 Electron 主进程里装配出来的一台机器(`apps/desktop-react/electron/main.ts:236-257`),
第④步把它搬成 Electron 拉起的**一个子进程**,Electron 从此只剩窗口、内置浏览器和几件「只在用户屏幕上发生」的事;
搬之前先把两件会被搬坏的东西治好 —— **凭证**(后端出了 Electron 就没有 `safeStorage`)和**宿主端口里那几格客户端的事**
(对话框、深浅色、打开链接)。

> 名词先解释一句。**宿主端口**(`OnethingHostPorts`,`packages/backend/backend-host-ports.ts:141-208`)是宿主把
> Electron 独有能力递给后端的那张 18 格的表,后端不 import electron,只读这张表;**发现文件**是
> `<store>/run/http.json`,谁在服务这个 store 谁写它,客户端靠它找到后端;**shell dispatch**是后端「请客户端执行」
> 的既有机制(`packages/backend/resource/resource-shell-dispatch.ts`):客户端登记一个命名空间,后端把命令经 SSE 发给它,
> 它跑完回执。

### 0.1 总览表

| 批 | 做什么 | 动哪些文件(file 级) | 依赖 | 单独回退 | 用户能感觉到什么 |
| --- | --- | --- | --- | --- | --- |
| **批 0 · 凭证归后端** | 后端自己持有加密主密钥(进系统钥匙串,带超时、不挡启动),`credentials.json` 改用它加密;口令导出 / 导入;从 `safeStorage` 密文迁移;「凭证已锁定」状态与 RPC;门测试的「不用钥匙串」模式 | `packages/backend/credentials/`(新 `credentials-master-key.ts`、`credentials-export.ts`、`credentials-locked-state.ts`,改 `credentials-pool.ts` / `credentials-default-space-migration.ts` / `credentials-token-store.ts`)、`packages/backend/auth/auth-token-store.ts`、`packages/backend/auth/auth-host-ports.ts`(`tokenCryptoAdapter` 退役)、`packages/backend/backend-host-ports.ts`(`auth.tokenCryptoAdapter` 一格删)、`packages/shared/ipc/spaces.ts`(导出 / 导入 / 锁定状态三条契约)、`apps/desktop-react/electron/host-ports.ts`(`getShellSafeStorage` 只剩迁移用)、`apps/desktop-react/src/content/settings/`(导出 / 导入 / 锁定横幅)、`scripts/gate-credentials.mjs`(新) | 无 | 能:主密钥文件 + `credentials.json` 新信封并存,读侧两种都认,回退只是写侧改回 `safeStorage` | **不该有**。首次升级时一次迁移;多出「导出 / 导入凭证」两个按钮;钥匙串弹一次授权框 |
| **批 1 · 客户端的事移出后端** | `dialog` / `shell` / `settings.shouldUseDarkColors` 三格宿主端口退役,`dialog` / `shell` 两个 RPC 域退役;`dir:` 的 `reveal` 改 `home: 'shell'`;agent 请求打开链接改成卡片按钮;内置浏览器的用户数据面改路;`terminal-reload` 与内存探针改走 RPC | `packages/backend/backend-host-ports.ts`、`packages/backend/dialog/`(删)、`packages/backend/shell/`(删或缩成纯类型)、`packages/backend/settings/settings-host-ports.ts`、`packages/backend/file/file-resource-spec.ts:148-227`、`packages/backend/resource/resource-dir-provider.ts:231-303`、`packages/backend/acp/acp-elicitation-bridge.ts:247-335`、`packages/backend/http-server/http-server-capabilities.ts:66`、`packages/backend/http-server/http-server-client-api-roster.ts`(两行删)、`packages/backend/file/file-client-api.ts:446`、`skill/skill-client-api.ts:120`、`theme/theme-client-api.ts:93`(三处改成只答路径)、`apps/desktop-react/electron/host-ports.ts`、`apps/desktop-react/src/platform/open-external.ts`、`src/data/dialog-port.ts`、`src/data/reveal-path.ts`、`src/resources/`(`dir:` 的壳侧落点)、`apps/desktop-react/electron/terminal-reload.ts`、`electron/browser/`(见决策 D4) | 批 0 无硬依赖,但排在批 2 之前 | 能:每格端口独立 | 对话框、打开链接、在访达中显示、深浅色**行为不变**(都改在客户端自己做);agent 要开链接时卡片上多一颗「打开」按钮,不再自动弹浏览器 |
| **批 2 · 两个进程** | Electron 不再装配后端,改为拉起 / 停止一个后端子进程(`ELECTRON_RUN_AS_NODE=1` 跑 `backend.cjs`);`window-all-closed` 不退出;「退出后后端继续运行」设置;后端崩溃的处理;后端进程入口补齐桌面今天多起的五件事;发现文件 owner 与让位规则 | `packages/backend/backend-standalone-main.ts`、`packages/backend/http-server/http-server-standalone-backend.ts`、`http-server-discovery.ts`、`http-server-host-trust.ts`、`packages/backend/mcp/mcp-client-api.ts:104-118`、`apps/desktop-react/electron/main.ts`(大改:删装配,加 `backend-process.ts`)、新 `apps/desktop-react/electron/backend-process.ts`、`apps/desktop-react/scripts/build-electron.mjs`(第三份 esbuild 产物 `backend.cjs`)、`apps/desktop-react/scripts/dev-app.mjs`、`electron-builder.yml`(`asarUnpack` 加 `backend.cjs`)、`scripts/gate-packaged.mjs`、`scripts/dev-unified.mjs`、`packages/shared/ipc/settings.ts`(一格设置)、`apps/desktop-react/src/content/settings/`(一行开关 + 后端状态) | 批 0、批 1 | 能:回退 = `main.ts` 改回装配;产物多一份不碍事 | 关窗不退出(macOS 惯例,Dock 图标还在);活动监视器里多一个进程;启动略慢(多一次进程起步,预计 +100–300ms,门量);可选「退出后继续运行」 |
| **批 3 · CLI 走 HTTP** | `daemon-server.ts` 的 unix socket + 38 个自有方法退役,CLI 命令全部改成 `@onething/backend-client` 的 RPC 调用;缺省依附发现文件里的后端,可配置为自己拉起;`onething mcp` 桥改走 HTTP;`HeadlessBackend` 退役 | `apps/cli/src/daemon-server.ts`(删)、`daemon-client.ts`(删)、`paths.ts`、`ndjson.ts`(删)、`index.ts`、`mcp-command.ts`、`resource-command.ts`、新 `apps/cli/src/backend-connect.ts`、`packages/shared/cli/protocol.ts`(删或缩)、`packages/backend/headless/`(删)、`packages/backend/package.json`(exports 一把键删)、`scripts/build-cli.mjs`、`docs/audit/feature-layers-2026-10.json`(一行删)、`scripts/headless-boundary-check.ts`(涉 headless 的断言退役) | 批 2(要有可拉起的后端产物) | 能:CLI 是独立壳,回退只是换回旧 CLI 包 | `onething daemon start/stop/status` 变成 `onething backend …`;Windows 上 CLI 从「不支持」变成能用(今天 `paths.ts:21` 直接抛) |
| **批 4 · 插件与 gateway 挂后端** | 后端进程启动时 `bootstrapPluginSystem`;`plugins` 宿主端口的 `pickFile` 走 shell dispatch、`exec` 由后端自己起子进程;`GatewayHostPorts` 由后端进程自己实现(用进程内引擎做对话 runtime) | `packages/backend/backend-standalone-main.ts`(或 `http-server-standalone-backend.ts`)、`packages/backend/plugin/plugin-host-ports.ts`、`packages/backend/gateway/gateway-lifecycle-port.ts`、`gateway-standalone.ts`、新 `packages/backend/gateway/gateway-host.ts`、`packages/backend/http-server/http-server-capabilities.ts:70`(`pluginsManage` 自动变真) | 批 2 | 能:两个子系统都是「不起就没有」 | 设置里插件 / 网关两页从「只在桌面宿主」变成真的能用 |
| 以后 | 手机配对(发现文件之外的配对流程)、`browser:` 给 AI 用那一半删除、`server:build` 与 `backend.cjs` 两份产物合一 | — | — | — | — |

### 0.2 为什么这个顺序(与方向文档 §5 的顺序差在哪)

方向文档 §5 写的顺序是「生命周期 → 凭证 → 客户端能力 → CLI → 插件与 gateway」。这里把**凭证和客户端能力提到生命周期前面**,理由是一条实测:

- 后端一出 Electron 进程就**没有 `safeStorage`**,而今天凭证池的写侧「按此刻能力产出」,没有加密器就如实写明文
  (`packages/backend/credentials/credentials-pool.ts:308-321`),迁移更是整个拒绝(`credentials-default-space-migration.ts:541-556`,
  日志原话 `provider config migration deferred on purpose`)。先拆进程 = 用户所有 provider 在新后端里一把钥匙都读不出来 —— 这正是
  `main.ts:4-9` 文件头记的 08-31 那次事故(「薄壳 + 子进程 core」被放弃的直接原因)。所以凭证必须先有一条不靠 Electron 的加密路。
- `dialog` / `shell` / `settings` 三格端口今天由 Electron 注入(`apps/desktop-react/electron/host-ports.ts:187,211-214,235-249`);
  后端进程的宿主表里这三格本来就是 `null`(`http-server-standalone-backend.ts:71-103`)。先拆进程 = 这三件事静默降级
  (打开链接没反应、对话框答 `unavailable`、「跟随系统」恒浅色)。先把它们搬回客户端,拆的那一天就没有这三条回归。

做完批 0 和批 1 之后有一个可以数的判据:**Electron 的宿主表与后端进程的宿主表只剩 `auth`、`terminal`、`localTrust`、
`speechOutput`、`storePath` 五格不同**,而这五格批 2 都有现成的答案(§2.3)。

## 1. 摸底(按施工单 7 条)

### 1.1 Electron 主进程今天装配后端与之后挂的一切

`apps/desktop-react/electron/main.ts`(833 行)。装配在 `assembleOwnCore()`(`:236-257`):`createOnethingBackend({ host: createShellHostPorts(), toolRegistry: 'full', collab: true, sessionSkills: true, pets: true, sender: ShellNoopSender, hooks.afterSettings: applyShellNetworkProxySettings })`。
装配之后 `startPostWindowServices()`(`:264-450`)挂了**九件**,逐件归类:

| 件 | 行 | 拆完归谁 | 备注 |
| --- | --- | --- | --- |
| 内嵌 HTTP/SSE 面 + 发现文件(owner `'shell'`,带 CDP 口) | `:273-325` | 后端进程(它自己 listen、写发现文件) | 批 2 后 Electron 只读发现文件;CDP 口不再进发现文件(AI 浏览器那一半不做) |
| `initializeUserSchedulerTasks()` | `:339` | 后端 | **后端进程入口今天没起它**(`backend-standalone-main.ts` 与 `http-server-standalone-backend.ts` 零引用) |
| `b.mcp.start()` | `:353` | 后端 | **后端进程入口今天没起它**:`mcp.start()` 只在 `backend.ts:1350-1353` 的 `mcpAcp: true`(CLI 守护)分支与这里被调 |
| `registerACPPermissionBridge()` + `b.acp.start()` | `:369-372` | 后端 | 后端进程入口已有(`http-server-standalone-backend.ts:118,127`) |
| `b.music.start()`(电台指挥) | `:383` | 后端 | **后端进程入口今天没起它** |
| `installBrowserHost(...)` | `:404-409` | Electron | 它要 `backend.resources.mount(provider)`(`electron/browser/index.ts:339`)与 `backend.memory.registry.registerHolder`(`:407`)—— 这两处是进程内的直接调用,拆后不存在,见决策 D4 |
| 内存探针 `registerProbe(createShellMemoryProbe(...))` | `:421-438` | Electron 报数、后端汇总 | 改成 `memory` 域一条 RPC 上报(或不做,见 §2.2) |
| `refreshModelsOnFirstStartup` | `:444-466` | 后端 | **后端进程入口今天没起它** |
| `hydrateProcessEnvFromLoginShell`(登录 shell 的 PATH) | `:725-738` | 后端 | **后端进程入口今天没做**;ACP / MCP stdio / bash 都在后端 spawn,PATH 必须在后端进程里补 |

另外三件在装配之外:`app.setName('onething')`(`:93-95`,safeStorage 的钥匙名,批 0 迁移期间仍要)、`applyChromiumFlags` / `applyCdpFlag`
(`:107-108`,内置浏览器,留在 Electron)、`window-all-closed → app.quit()`(`:790`,批 2 改)。

`createShellHostPorts()`(`apps/desktop-react/electron/host-ports.ts:154-251`)18 格逐格:

| 格 | 今天 | 性质 | 拆后 |
| --- | --- | --- | --- |
| `storePath` `{isPackaged, resourcesPath}` | `:156-159` | 后端要知道打包资源目录(skills / templates / models) | 批 2 经环境变量递给后端进程(`ONETHING_RESOURCES_PATH`),顺手治 `main.ts:822-824` 留账②(打包态内建 skills 找不到) |
| `sandbox.getPath` | `:160-162` | 下载目录 | 后端进程今天已自己算(`http-server-standalone-backend.ts:65-70`) |
| `auth.authFetch` / `auth.tokenCryptoAdapter` | `:167-170` | `net.fetch` 与 **safeStorage**(凭证解密唯一口) | 批 0:`tokenCryptoAdapter` 退役;`authFetch` 退回受管 fetch(后端进程今天就是这样) |
| `terminal.broadcaster` | `:180` | PTY 输出出网口 | 后端进程已有开关 `ONETHING_SERVER_TERMINAL=1`(`http-server-standalone-backend.ts:83-85`),批 2 由 Electron 拉起时置真 |
| `shell` `{openExternal, openPath, revealPath}` | `:187`(实现 `:80-101`) | **客户端的事** | 批 1 删;`shell` RPC 域退役;`dir:reveal` 走 shell dispatch |
| `logging` / `voice` / `skillsEnvironment` / `todoPlan` / `scratchpad` / `plugins` / `gateway` / `evals` / `mcp` | `:191-198, 215-216` | 九格 `null` | 批 4 填 `plugins` / `gateway`(由后端进程自己填,不再是宿主端口) |
| `settings.shouldUseDarkColors` / `settings.applyNetworkProxySettings` | `:211-214` | 前者**客户端的事**;后者是「设置改了把代理套到 Electron 的 session 上」 | 批 1:前者删(React 壳渲染层已经自己读 `matchMedia`,`src/platform/host.ts:25`、`src/theme/theme-port.ts:75`,后端这一格今天在 React 壳上是死码);后者改成 Electron 订 `settings:changed` 全局事件自己重套 |
| `localTrust: { origin: 'desktop-embedded' }` | `:224` | 本机信任声明 | 批 2:后端进程回环绑定即 `loopback-server`;`mcp` 域的「能不能起本地进程」只认 `desktop-embedded`(`packages/backend/mcp/mcp-client-api.ts:112-118`)要改,见决策 D9 |
| `speechOutput` | `:230` | 主进程起 `afplay` / `mpv` 子进程出声(`electron/speech-output.ts`) | 批 2 整只文件搬进后端(它不用窗口,只要子进程) |
| `dialog.showOpen` | `:235-249` | **客户端的事**(挂在聚焦窗上) | 批 1 删;`dialog` RPC 域退役,渲染层直接经 preload 一条 `invoke` 开对话框(见决策 D5 对 IPC 预算的交代) |

Electron 目录里 import `@onething/backend` 的文件有 15 只(`main.ts` 10 处、`host-ports.ts` 6 处、`browser/resource-provider.ts` 4 处……);
批 2 之后目标是**只剩类型 import 与 `@shared`**,这条由 `boundary:gate` 新增一条断言守(§2.3 验收)。

### 1.2 凭证:谁加密、谁解密、存在哪

- **存在哪**:每个空间一份 `workspaces/<id>/credentials.json`,**整份加密**,信封 `{ version: 2, encryption: 'safeStorage' | 'none', data | providers }`
  (`packages/backend/credentials/credentials-pool.ts:276-283`);旧的 `<store>/oauth-tokens.json` 只剩读(`packages/backend/auth/auth-token-store.ts:2`)。
- **谁加密 / 解密**:唯一的加密器注入口是 `configureAuthHost({ tokenCryptoAdapter })`(`packages/backend/auth/auth-host-ports.ts:19`);
  池经 `configureSpaceCredentialsCrypto(() => getAuthHostPorts().tokenCryptoAdapter?.())` 转接(`credentials-resolution.ts:656`),每次读写现问
  (`credentials-pool.ts:303-312`);接口只有三个方法 `isEncryptionAvailable / encryptString / decryptString`(`auth-token-store.ts:17-21`)—— 这意味着
  **换加密器只换一个三方法对象**,池与 token store 一行不改。
- **OAuth 刷新写回**:`auth-oauth-manager.ts:77-94` 的 `refreshToken / saveToken` 经同一个 token store 写回池,所以刷新也经同一个加密器。
- **headless / server 两个宿主今天怎么处理**:两张宿主表都是 `auth: null`(`http-server-standalone-backend.ts:71`、`headless-backend.ts:142`)。
  后果三条:①读密文 → `credentials encrypted but no crypto adapter available` → 当空池;②写 → 如实写 `encryption: 'none'`(明文);
  ③存量 `settings.ai` 的迁移整个拒绝,原因码 `no-credential-encryption`,日志教你「用环境变量配 key,或让桌面跑一次」
  (`credentials-default-space-migration.ts:541-556`,08-31 用户拍板「甲」)。
- **脱敏判据**:`payloadLeavesProcess(context)` 就是一句 `context.transport === 'http'`(`settings-client-api.ts:107-109`、`mcp-client-api.ts:104-106`)。
  React 桌面渲染层本来就只走 HTTP,所以**今天桌面拿到的 settings 就已经是脱敏过的**;「恒真」在 React 壳上已经成立,批 2 之后只是把
  `'ipc'` 这一档从类型里删掉(`packages/shared/ipc/rpc.ts:45`),让「按传输判」变成「永远脱」。

### 1.3 CLI:38 个方法逐个对应到 RPC 域

`apps/cli/src/daemon-server.ts`(511 行)+ `daemon-client.ts`(unix socket、NDJSON 帧,`ensureDaemon` 自己 spawn 守护进程)+
`@shared/cli/protocol.ts`(38 个方法名);守护进程用 `HeadlessBackend`(`packages/backend/headless/headless-backend.ts`,715 行),
它的生产调用者**只有** `daemon-server.ts:15,31`(另三处 `session-event-log.ts:1018`、`permission-enforcement.ts:145-155`、
`resource-wire-views.ts:5` 都是注释)。CLI 源码 12 只文件 2910 行。RPC 名册约 47 个域(`http-server-client-api-roster.ts:24-71`)。

| daemon 方法 | 对应 RPC(域.方法) | 判 |
| --- | --- | --- |
| `daemon.health` / `daemon.status` | `GET /api/capabilities` + 发现文件 | 不需要契约 |
| `daemon.shutdown` / `daemon.prepareRestart` | **无** | 要新契约:`backend.shutdown`(只给本机信任的来访者),给「CLI 自己拉起的后端」停机用;`prepareRestart` 退役(重启 = 停 + 拉起) |
| `chat.ask` | `sessionCommand.emit(command:send-message)` + `GET /api/events` 流 | 有 |
| `chat.retryLast` | `sessionCommand.emit(command:retry-message)` | 有 |
| `permission.respond` | `sessionCommand.emit(command:permission-respond)` | 有(`packages/shared/ipc/permissions.ts:71` 明写) |
| `active.list` / `active.abort` | `chat.getActiveStreams` / `chat.abortStream`(或 `POST /api/streams/abort`) | 有 |
| `session.list/new/use/show/rename/pin/archive/delete/cwd/model` | `sessions.list/create/switch/get+getMessages/rename/updatePin/updateArchived/delete/updateWorkingDirectory/updateModel` | 有,一一对应 |
| `permission.mode.set` | `sessions.updatePermissionMode` | 有 |
| `provider.list` / `provider.models` | `providers.list` / `providers.getWithCapabilities`、`models` 域 | 有 |
| `provider.use` / `provider.enable` | `settings.saveSettings`(改 `ai.providers[*].enabled` / 默认 provider) | 没有单条动词,CLI 侧用 saveSettings 组合;`headless-cli-projections.ts:138-186` 那三只投影函数搬到 CLI 侧 |
| `provider.configure` | `spaces.setCredential`(`packages/shared/ipc/spaces.ts:375`)+ `settings.saveSettings` | 有,两步 |
| `tools.list` / `tools.set` | `tools.getTools` / `settings.saveSettings` | 有 / 组合 |
| `collab.roomNew/roomList/send/board/setBudgets/roomUpdate/transcript` | `collab.dmRoomEnsure`(或 `sessions.create`)/ `sessions.list` 过滤 / `sessionCommand.emit` / `collab.boardGet` / `collab.roomSetBudgets` / `collab.roomUpdate` / `sessions.getMessages` | 有 |
| `resource.list/describe/read/do` | `resources.list/describe/read/do`(`packages/shared/ipc/resources.ts:242-248`) | 有,逐字 |

结论:**38 个里 34 个有现成 RPC(含「两步组合」),真缺的只有进程生命周期两条**(`shutdown`,以及批 2 本来就要的「健康 / 状态」读数),
另外 `onething mcp`(`apps/cli/src/mcp-command.ts`)今天经守护进程桥资源调用、60 秒自己计时,改走 HTTP 后判据不变。
`HeadlessBackend` 独有的两样 —— `markHostUnattended('cli-daemon')`(`headless-backend.ts:121`)和 `chat.ask` 流上的 60 秒自动拒 ——
在「CLI 依附 Electron 拉起的后端」这一档不再需要(有窗口答卡);在「CLI 自己拉起」那一档由后端进程按启动参数自己声明(决策 D7)。

### 1.4 「发现文件指向活后端时直接连它」那条路能复用多少

`main.ts:713-716`:`readDiscovery()` → `isAlive`(pid 活 ∧ 端口 500ms 内连得上,`:177-184`)→ `connection.resolve(connectionOf(existing))`。
这条路今天只做**一件事**:把 `{baseUrl, token}` 交给渲染层。它**跳过了整段 `startPostWindowServices()`**,所以复用程度是:

- **连接接线可以逐字复用**(`HostConnectionGate`、`host:connection` IPC、`readDiscovery` / `isAlive`、`connectionOf`)。批  2 的主路就是
  「拉起子进程 → 轮询发现文件直到 `isAlive` → 走这条路」,`isAlive` 的两段判据与子进程退出事件合起来就是启动成功 / 失败的判据。
- **后端侧不能复用**:今天「借活的 core」等于借一台**没有 MCP、没有调度任务、没有电台指挥、没有首启模型拉取、没有登录 shell PATH** 的
  后端(§1.1 表里五个「今天没起它」)。所以批 2 的一半工作量在后端进程入口把这五件补上,而不是在 Electron。
- `readDiscovery` 只认 `owner ∈ {desktop, server, shell}`(`:144`),`server:start` 只对 `owner !== 'server'` 让位(`backend-standalone-main.ts:83`):
  Electron 拉起的后端写哪个 owner、谁对谁让位,要重定(决策 D6)。

### 1.5 「后端请客户端执行」机制今天的形状

- 登记:客户端经 `resources.mountShell({ shellId, spec })` 登记一个 `home: 'shell'` 的命名空间(`packages/backend/resource/resource-client-api.ts:164`),
  `shellId` 是壳每次运行现铸的坐标、不跨重连复用(`apps/desktop-react/src/resources/shell-host.ts` 文件头)。心跳 30s,三拍没续命(90s)注销
  (`resource-shell-registry.ts:117,294`)。
- 投递:后端发全局事件 `resource:shell-command { shellId, callId, kind: 'op'|'read', ref, op, params }`(`packages/shared/events/global-events.ts:171-200`)
  走 `GET /api/events` **广播**,收到的壳自己对 `shellId`;壳跑完调 `resources.shellResult`。
- **没有客户端在线时**:某 scheme 没人认领 → 立刻 `ResourceHomeUnavailableError`(`resource-shell-dispatch.ts:250-253`);登记过但 10 秒没回执
  (`DEFAULT_SHELL_COMMAND_TIMEOUT_MS`,`:90`)或壳注销 → 同一个错(`:207-226`)。断线窗口里发出的命令就是丢了,不回放。
- 路由是 **scheme → 一个 shellId**(`:122-128` 的 `claim` / `release`,后登记者顶掉先登记者)。多客户端同时在线谁接,见决策 D8。
- 今天的消费者只有桌面的 `workbench:`(`apps/desktop-react/src/resources/workbench-spec.ts`,七条做法)。

### 1.6 插件管理器 / gateway 今天的宿主状态

- `bootstrapPluginSystem`(`packages/backend/plugin/plugin-manager.ts:438`)在 `packages` / `apps` / `scripts` 里**零生产调用者**(只有 `plugin-system.ts:6` 的注释示例)。
  `getPluginManager()` 为 `null` → `GET /api/capabilities` 的 `pluginsManage` 恒假(`http-server-capabilities.ts:70`),插件域写操作答「只在桌面宿主」。
  插件宿主端口 `PluginsHostPorts`(`plugin-host-ports.ts:45`)只有两格:`pickFile`(要原生对话框)和 `exec`(execa 起子进程;注释说
  「桌面在 `@main/ipc/plugins.ts` 注入三行转调」—— 那只文件随 Vue 宿主已删)。
- gateway:`GatewayHostPorts`(`gateway-lifecycle-port.ts:70-85`,`getStatus/start/stop/wechat*`)三张宿主表全是 `null`;独立网关进程
  `gateway-standalone-main.ts` 要 `ONETHING_GATEWAY_RUNTIME_MODULE` 指一个对话 runtime(`gateway-standalone.ts:131-134`),缺了就 fatal。
  引擎侧接网关会话的路由已在装配里(`backend-assemble-engine.ts:181-197` 认 `gateway:` 前缀的会话)。

### 1.7 依赖进程身份的东西

| 东西 | 今天 | 拆后 |
| --- | --- | --- |
| `StoreLock`(`packages/backend/storage/storage-store-lock.ts`) | 只有传了 `owner` 才真拿锁(`backend.ts:676-677` 经 `createStoreLease`,`storage-store-lock.ts:399-401` 无 owner 给 `UnlockedStoreLease`);今天只有 CLI 守护传 `'daemon'`(`headless-backend.ts:124`) | 批 3 之后**没有进程拿锁**(用户 08-24 拍「store 不要锁」);`StoreLock` 类留给 `onething store lock` 维护命令与备份(`store-command.ts`),`formatDesktopLockConflict` 那两句话变死码 |
| 本机信任声明 | 桌面 `desktop-embedded`(装配时 `host-ports.ts:224`,挂 HTTP 面时再声明一次 `http-server-embed.ts:146`);server 回环才 `loopback-server`(`backend-standalone-main.ts:141`) | 批 2 只剩 `loopback-server`;唯一按 origin 分档的判据是 `mcp` 域的 `canSpawnLocalProcesses`(`mcp-client-api.ts:112-118`),见 D9 |
| `GET /api/capabilities` | 从 `hasShellHost / hasTerminalHost / getPluginManager / isHostLocallyTrusted` 推导(`http-server-capabilities.ts:59-77`) | `shellTools` 一位退役(批 1,客户端自己知道);其余判据不变、值随批 2 / 批 4 自动变 |
| `transport:gate` | React 壳 `ipcMain` 通道 ≤ 2(`host:connection`、`host:native-view`;`scripts/transport-gate.mjs:22,73,204-207`) | 批 1 对话框若走 preload 多一条 → 决策 D5 |
| `gate:packaged` | ③ 等发现文件 ④ 打 capabilities + rpc ⑤ CDP ⑥ SIGTERM 后文件删、无残留(`scripts/gate-packaged.mjs:9-19`);另断言 `search.status.mode === 'owner'`、`vector === 'off'`、`vectorExtension === 'loadable'`(`:162-203`) | 批 2 加:发现文件里的 pid ≠ app pid、SIGTERM 后**两个**进程都退、「继续运行」档下后端留着且下次启动被接上 |
| `asarUnpack` | `search-worker.cjs`、`acp-mcp-bridge.cjs`、几组原生包(`electron-builder.yml`) | 加 `dist-electron/backend.cjs`(子进程入口要真路径;能不能从 asar 里起由 `gate:packaged` 跑出来,不写在注释里) |
| 检索 Worker 放在宿主入口旁边 | 三份产物各带一份 `search-worker.cjs`,按 `import.meta.url` 往旁边找(`packages/backend/search/search-worker.ts:5-24`、`build-electron.mjs:118-131`) | 规矩不变:`backend.cjs` 成为宿主入口,与 `search-worker.cjs` 同住 `dist-electron/`;Electron 主进程**不再**需要那份 Worker |
| 运行时与 ABI | Electron 41.1.1(Node 24 / ABI 145),`.nvmrc` 24;`gate:native` 已在 `ELECTRON_RUN_AS_NODE=1` 下逐个 `require` 原生模块(`scripts/gate-native-abi.mjs:16,342`) | 后端进程跑在同一只 Electron 二进制下 = 与今天同一套 ABI,门不用加新尺子;Node 24 开发机照常 |
| `safeStorage` 身份 | 绑 app 名 + 代码签名(`main.ts:77-95`;`gate-packaged.mjs:20-24` 记着首启授权框的坑) | 批 0 之后只在**迁移**时用一次;后端主密钥另有归属(D2) |

## 2. 逐批施工单

每批四段:目标、改动清单、行为变化(改前 / 改后 / 推荐 / 要不要拍)、风险与验收。验收只写**脚本能自证**的门;要真机的写明「用户择时」。

### 2.1 批 0 · 凭证归后端

**目标**:后端在任何进程里都能加密落盘并解开自己的凭证,不靠 Electron;用户能导出 / 导入;升级时存量 `safeStorage` 密文迁进新信封;
钥匙串解不开时后端说「已锁定」而不是当空池。

**改动清单**

1. `packages/backend/credentials/credentials-master-key.ts`(新):一把 32 字节主密钥,AES-256-GCM 包 `credentials.json` 的 `data`
   (Node 内建 `node:crypto`,零原生依赖)。密钥的**存放档位**由决策 D2 定,接口只有一个:`loadMasterKey({ timeoutMs }) → { key } | { locked: reason }`。
   三条硬规矩照方向文档:带超时(建议 3s)、**不挡装配**(装配时只起一次异步加载,池在第一次需要密钥时 `await` 它)、解不开时进入「锁定」状态。
2. `credentials-pool.ts`:信封新增一档 `encryption: 'master-key'`(`:289` 的联合类型加一项),读侧三档都认(`'safeStorage'` 只在有迁移用的临时适配器时才解得开),
   写侧永远按 `'master-key'` 产出;`activeCredentialsCrypto()`(`:303-312`)改成问主密钥而不是问宿主端口。`auth-token-store.ts` 同一把。
3. `credentials-default-space-migration.ts:541-556` 那道「没有加密能力就不迁」的闸**保留**,判据改成「主密钥可用」—— 它守的道理没变。
4. `credentials-locked-state.ts`(新):`credentials:locked` 全局事件(`packages/shared/events/global-events.ts` 的 `GLOBAL_EVENT_LEAVES_PROCESS` 表加一行,出进程 = `true`)
   + `spaces.credentialsStatus` 读法 + `spaces.unlockCredentials`(重试加载主密钥)。
5. `credentials-export.ts`(新):`spaces.exportCredentials({ passphrase }) → 文件字节`、`spaces.importCredentials` 扩一档 `{ passphrase, bytes }`(今天那条
   `importCredentials` 是 `packages/shared/ipc/spaces.ts:387`,形状是明文条目,保留)。口令派生用 scrypt(Node 内建),文件自带盐与版本。
   **任何接口不返回凭证原文**:导出文件是密文,`credentialsStatus` 只答档位与锁定原因。
6. 迁移(两条路,见 D3):①**自动**:Electron 主进程仍有 `safeStorage`(它还是那个签过名的 app),首次启动新版本时在 Electron 里解开旧密文、
   经 `spaces.importCredentials` 交给后端重新加密、逐条校验后删旧密文;②**口令**:设置页「导出凭证」用 Electron 的 safeStorage 解出并按口令加密成文件,
   「导入凭证」交给后端。顺序按用户拍的:停旧后端 → 导出 → 迁移并逐条校验 → 删旧密文。
7. `backend-host-ports.ts:145` 的 `auth` 格缩成 `{ authFetch }`;`auth-host-ports.ts:14` 的 `tokenCryptoAdapter` 删;`host-ports.ts:47-54` 的
   `getShellSafeStorage` 改名 `legacySafeStorageForMigration`,只有迁移那一步读它。
8. 门测试的「不用钥匙串」模式:`ONETHING_CREDENTIALS_KEYRING=file|none`(`file` = 主密钥落 `<store>/credentials-master.key` 0600,给临时 store 的门用;
   `none` = 不加密、如实写 `'none'`,给 vitest 用)。**缺省 = 系统钥匙串**。

**行为变化**

| 项 | 改前 | 改后 | 推荐 | 拍 |
| --- | --- | --- | --- | --- |
| 首次启动 | 无感 | 一次迁移 + 钥匙串授权框弹一次(macOS 对新建的钥匙串条目问一次「允许 / 始终允许」) | 自动迁移,日志与设置页各记一行「已迁移 N 条」 | D3 |
| 钥匙串解不开 / 超时 | 当空池,引擎静默不开 run(08-31 真机症状) | 顶部横幅「凭证已锁定」+「重试」;provider 列表显示锁图标;发消息被拒时错误带原因码 | 横幅 + 重试 | D10(呈现) |
| 导出 / 导入 | 无 | 设置 → 空间 → 两个按钮,口令对话框在客户端 | — | 不用拍(用户已定) |
| 无界面后端(`server:start` / 门) | 拒迁移、写明文 | 同一条加密路;临时 store 用 `file` 档 | — | 不用拍 |

**风险**

- 主密钥丢了(钥匙串条目被删、换电脑没导出)= 凭证全丢。对策:导出 / 导入是长期功能;「已锁定」横幅里给「重新登录 / 导入」出口。
- Windows / Linux 的钥匙串:macOS 有 `security` 命令行,别的平台要么 N-API 模块要么 `file` 档。D2 里写明分平台档位,不把 macOS 的做法当通用。
- 迁移半路 OAuth 刷新让导出过期:按用户定的顺序「停旧后端」就是为这个;自动迁移在后端起来**之前**由 Electron 读旧文件,同样避开。

**验收(脚本自证)**

- 新门 `scripts/gate-credentials.mjs`:临时 store 上 ①种一份 `encryption: 'safeStorage'` 密文(用一个假适配器)→ 跑迁移 → 断言新信封、条目逐条相等、旧文件删;
  ②导出(口令)→ 换 store 导入 → 断言相等;③`ONETHING_CREDENTIALS_KEYRING=none` 下 `credentialsStatus` 答 `'none'`;④模拟钥匙串超时 → 断言 `locked` 事件
  与 `unlockCredentials` 重试成功。只用 node 跑。
- `packages/backend/credentials/__tests__/credentials-master-key.test.ts` 等单测;`sessions:shadow-battery` 继续用环境变量种假 key(不变)。
- 真机(**用户择时**):真 `~/.onething` 上升级一次,看授权框只弹一次、provider 全在。这一步**我不碰**真 store。

### 2.2 批 1 · 客户端的事移出后端

**目标**:后端里不再有「只在用户屏幕上发生」的事;所有这类事要么客户端自己做,要么由后端经 shell dispatch 请客户端做。

**改动清单**

1. **`dialog`**:删 `packages/backend/dialog/`、名册一行、`backend-host-ports.ts:208` 一格、`host-ports.ts:235-249`。渲染层 `src/data/dialog-port.ts`
   改成经 preload 开对话框(D5)。谁在用:`FilesPanel` / `open-dir-hub` / `skills-port` / `TodoMenus` 等 19 只文件里的 `dialog-port` 消费者不改(端口形状不变)。
2. **`shell`**:删 `packages/backend/shell/`(只留 `hasShellHost` 的替身 → 恒假的那一支整条删)、名册一行、`host-ports.ts:80-101,187`、
   `http-server-capabilities.ts:66` 的 `shellTools`。渲染层 `src/platform/open-external.ts:15-27` 改成桌面走 preload、网页走 `window.open`(已有的那一支)。
   后端里**真调**这格端口的消费者有五处(`rg "getShellHost\("`):`file-client-api.ts:446`(`files.reveal`)、`skill-client-api.ts:120`(打开技能目录)、
   `theme-client-api.ts:93`(打开主题文件)、`acp-elicitation-bridge.ts:264`(下面第 4 条)、`resource-dir-provider.ts:299`(第 3 条)。前三处改成
   **只答路径**,由客户端自己 `openPath` / `revealPath`(渲染层 `skill-open.ts` / `skills-port.ts` / 主题页各改一行);OAuth 登录那条**不用改** ——
   `auth-client-api.ts:87` 今天就「不递 `openExternal`,后端不开浏览器」,链接交回客户端开。
3. **`dir:` 的 `reveal` 改 `home: 'shell'`**:`packages/backend/file/file-resource-spec.ts:139-148` 那条 `reveal` 的 `home` 改 `'shell'`,
   `resource-dir-provider.ts:231-303` 的两段 `reveal` 删;壳侧 `apps/desktop-react/src/resources/` 新增 `dir-shell-spec.ts`(一条做法 `reveal`,`home: 'shell'`)与
   落点(经 preload 调 `shell.showItemInFolder`),在 `shell-host.ts` 的 `mountShell` 里**多登记一个 scheme**。`reveal-path.ts` 不改(它调的还是 `resources.do(dir:…, 'reveal')`)。
   注意 `ResourceTool` 对 `home: 'shell'` 的做法在 plan 期就判「宿主口缺席」(`resource-dir-provider.ts:236` 注释),所以 AI 在无客户端时得到的是结构化拒绝,不是超时。
4. **agent 请求打开链接改卡片按钮**:`acp-elicitation-bridge.ts:247-264` 的 `openExternal` 依赖删;`createUrl`(`:310-335`)不再替人开,题面带 `url`,
   `InteractionQuestion` 加一格 `link?: { url, label }`(`packages/shared/interaction/types.ts`),渲染层的权限 / 交互卡画一颗「打开」按钮,点了走客户端自己的 `openExternal`。
   MCP OAuth 那条(`mcp-oauth-provider.ts:135`)同形。
5. **深浅色**:`settings-host-ports.ts:29-30,58` 的 `shouldUseDarkColors` 删,`settings.getSystemTheme` RPC 退役(React 壳 `theme-port.ts:75` 已不经后端;
   手机 / 网页壳各自读系统)。`applyNetworkProxySettings` 这一格端口也删:Electron 改订 `GET /api/events` 上**已有**的 `settings:changed`
   (它在 `GLOBAL_EVENT_LEAVES_PROCESS` 表里标 `false`(`global-events.ts:384`)不是「不出网」,是「这条 SSE 上它已经有另一种脱敏过的载荷形状」,
   `:370-374` 的判词;渲染层 `theme-port.ts:13`、`search-settings-source.ts:287` 今天就靠它热生效),收到后 `settings.getSettings` 再重套。
   **表不用改**。
6. **内置浏览器的用户数据面**(D4):今天 `BrowserLeaf` 的「开格 / 去地址 / 读正文 / 列 tab」走 `resources` RPC → 后端内核 → Electron 主进程里
   `backend.resources.mount(provider)` 的 `browser:`(`src/data/browser-port.ts` 文件头、`electron/browser/index.ts:339`)。后端出进程后这条路断。
7. **`terminal-reload.ts:1`** 直接 import 后端的 `markAllTerminalsDetached`(模块单例)—— 拆后在错的进程里是一句空话。改成 `terminal` 域一条
   `detachAll` RPC(本机信任才给)。
8. **内存探针**:`main.ts:421-438` 的 Electron 进程表改成 `memory` 域 `reportProcesses` 上报,或先不做(`memory:report` 少几行渲染 / GPU 进程)。推荐先不做,留账。
9. `speechOutput` 不动(批 2 搬进后端)。

**行为变化**

| 项 | 改前 | 改后 | 推荐 | 拍 |
| --- | --- | --- | --- | --- |
| 用户点外链 / 在访达中显示 / 打开目录 / 选文件 | 渲染层 → HTTP → 后端 → Electron 端口 | 渲染层 → preload → Electron | 行为不变 | 否 |
| agent(ACP / MCP OAuth)要你去开一个链接 | 桌面上自动弹浏览器,卡上写「已在浏览器里打开」 | 卡上一颗「打开 …」按钮,你点了才开 | 用户已定 | 否 |
| AI 的「在访达中显示」 | 后端直接做 | 后端请当前壳做;没有壳在线 → AI 得到结构化拒绝 | 用户已定「先保留」 | 否 |
| 跟随系统深浅色 | React 壳已经自己读系统 | 不变 | — | 否 |
| 设置页改代理 | 后端经端口让 Electron 重套 | Electron 听 `settings:changed` 自己重套 | 行为不变;时序上晚一次 SSE 往返(毫秒级) | 否 |
| 内置浏览器(用户用的那一半) | 走后端 RPC 绕一圈 | 见 D4 | D4 推荐 A | **是** |

**风险**

- `files.reveal` / 技能目录 / 主题文件三处从「后端做」改成「答路径、客户端做」,网页壳与手机拿到路径做不了任何事 —— 要照 `dialog` 的先例答一句结构化的
  「这台客户端做不了」,不是静默。
- `dir:reveal` 改 `home: 'shell'` 后,AI 调它要有一扇壳**登记了 `dir:`**;壳断线 10 秒内发出的调用会落 `ResourceHomeUnavailableError`(§1.5),工具面上要有一句人话。
- `client-api:gate` 的下限是 40 只 client-api;删两域后约 45,仍过,但别再顺手删别的。
- D5 若走 preload 新通道,`transport:gate` 的 `ipcMain` 基线要从 2 收成 3,这是一次**放宽**而不是收紧,理由必须写进基线文件头。

**验收**:`transport:gate`(`ipcMain` 预算见 D5)、`client-api:gate`(名册少两行,下限 40 仍满足:今天约 47)、`boundary:gate` 新断言「`packages/backend` 零出现 `dialog.showOpenDialog` / `shell.openExternal` 字样」、
`gate:resources`(`apps/desktop-react/scripts/gate-resources.mjs`,它今天就判 `home: 'shell'` 的做法走 shell dispatch,加 `dir:reveal` 一行)、
`gate:acp` 加一步「`createUrl` 不再调 openExternal、题面带 link」、`gate:a11y` 对交互卡那颗按钮扫一屏。真机:`gate:browser`(D4 定了再改)。

### 2.3 批 2 · 两个进程

**目标**:Electron 不装配后端;拉起、发现、监督、停止一个后端子进程;窗口生命周期与后端生命周期分家。

**改动清单(Electron 侧)**

1. `apps/desktop-react/electron/backend-process.ts`(新,≈150 行):
   - `spawn(process.execPath, [backendEntry], { env: {...process.env, ELECTRON_RUN_AS_NODE: '1', ONETHING_STORE_PATH, ONETHING_SERVER_HOST: '127.0.0.1',
     ONETHING_SERVER_TERMINAL: '1', ONETHING_RESOURCES_PATH: process.resourcesPath, ONETHING_BACKEND_LAUNCHER: 'desktop', ONETHING_LOG… }, detached: <按设置>, stdio: ['ignore','pipe','pipe'] })`;
     `backendEntry` = `path.join(__dirname, 'backend.cjs')`(打包态要是 `app.asar.unpacked` 下的真路径)。
   - 启动判据复用 `main.ts:136-184` 的 `readDiscovery` / `isAlive`:轮询直到发现文件活着(每 100ms,上限 15s),或子进程先退出(那就是启动失败,把 stderr 尾巴交给 `connection.resolve({ ok: false, error })`,渲染层照今天 `:731-736` 的路显示)。
   - 退出:缺省(随 Electron 同停)`will-quit` 里 SIGTERM 子进程、等它退出(上限 = 后端自己的 5s 刷盘期限 + 2s),没退就 SIGKILL 并记一行日志;
     「退出后继续运行」档:不发信号,子进程是 `detached` 的、`unref()`,Electron 直接退;下次启动走「发现文件活着就连它」那条路(`:713-716` 逐字复用)。
   - 崩溃:子进程非预期退出 → 发现文件由后端自己删不掉(它死了),Electron 删掉 pid 对得上的那份、按 D11 的策略重拉或亮横幅。
2. `main.ts`:删 `assembleOwnCore` / `startPostWindowServices` / `shutdownOwnCore` 整段(`:229-466, 769-808`),`whenReady` 里变成
   「开窗 → 发现文件活着就连 → 否则 `backendProcess.start()` → 连」;`window-all-closed`(`:790`)改成 macOS 不退、其它平台退;
   `activate`(`:756-758`)已有重开窗;`app.setName('onething')`(`:93-95`)**保留**(批 0 迁移还要它,而且 userData 目录绑着它)。
   `installTerminalReloadDetach`、`installBrowserHost`、内存探针按批 1 的结果改。
3. 设置:`packages/shared/ipc/settings.ts` 的 `AppSettings.general` 加 `backendKeepRunningAfterQuit?: boolean`(缺省 false);设置页「通用」加一行开关 + 一行后端状态(pid / 端口 / 运行时长 / 「重启后端」)。
4. 构建:`apps/desktop-react/scripts/build-electron.mjs:159-170` 加第三次 esbuild `{ backend: 'packages/backend/backend-standalone-main.ts' } → dist-electron/backend.cjs`
   (与 `search-worker.cjs` / `acp-mcp-bridge.cjs` 同配方同目录,`:118-153` 那条「落在宿主入口旁边」的纪律因此不用动);`dev-app.mjs` 同步;`electron-builder.yml` 的 `asarUnpack` 加一行。
5. `scripts/dev-unified.mjs`:桌面泳道照旧不起第二个 server(桌面会自己拉);注释里那句「桌面自己就是后端」改成「桌面拉起后端」。
6. `apps/desktop-react/electron/login-shell-env.ts`:**整只搬进后端**。按 R1 它是「进程环境」,建议新功能目录 `packages/backend/process-env/`(L0,入口 `process-env.ts`),
   按 CLAUDE.md §7 的加功能步骤:层次表 `docs/audit/feature-layers-2026-10.json` 加一行、`packages/backend/package.json` exports 加一把 `./process-env`、`bun run feature-map` 重生成,
   测试搬到 `process-env/__tests__/`。后端进程入口在装配前起它、在第一次 spawn 之前 `await`(今天 Electron 就是并行的,判词在那只文件头)。

**改动清单(后端进程入口)**

7. `packages/backend/backend-standalone-main.ts` 补齐 §1.1 的五件:`initializeUserSchedulerTasks()`、`backend.mcp.start()`、`backend.music.start()`、
   首启模型拉取、登录 shell PATH。建议按 `ONETHING_BACKEND_LAUNCHER=desktop|cli|none` 一个档位决定(桌面档全开;`gate:*` 继续用缺省档,行为不变)。
8. `http-server-standalone-backend.ts:63-104` 宿主表:`storePath` 读 `ONETHING_RESOURCES_PATH`;`speechOutput` 由后端自己填(`speech-output.ts` 搬进 `packages/backend/music/` 或 `voice/`);
   `terminal` 照旧看 `ONETHING_SERVER_TERMINAL`;`localTrust` 照旧在 listen 后按回环声明。`toolRegistry` 桌面档 `'full'`(今天就是)。
9. 发现文件(D6):`http-server-discovery.ts` 的 owner 联合加 `'backend'`;`backend-standalone-main.ts:83` 的让位判据改成「活着就让,不看 owner」;
   读发现文件的人都要认新值 —— `rg "run/http.json|readHttpDiscovery"` 今天命中 `main.ts:144`、`apps/desktop-react/vite/dev-api-proxy.ts`、`scripts/dev-unified.mjs`、
   `gate-acp` / `gate-packaged` / `gate-web-shell` / `gate-search-index` / `log-smoke` / `memory-report` / `migrate-sessions-events` 九只脚本与 `apps/cli/src/paths.ts`。
   `--force` 的告警原话保留。
10. `mcp-client-api.ts:112-118` 的 `canSpawnLocalProcesses` 改成 `isHostLocallyTrusted()`(D9)。
11. `packages/shared/ipc/rpc.ts:45` 的 `transport: 'ipc' | 'http'` 删 `'ipc'`;`DESKTOP_RPC_CONTEXT` 只剩测试与 CLI 直连用(批 3 删)。

**行为变化**

| 项 | 改前 | 改后 | 推荐 | 拍 |
| --- | --- | --- | --- | --- |
| 关掉最后一扇窗 | 整个 app 退出(`main.ts:790`) | macOS:app 留在 Dock,后端继续;点 Dock 重开窗。Windows / Linux:照旧退出 | 用户已定 | 否 |
| Quit(⌘Q) | 收尾后端再退 | 缺省同;设置开了「继续运行」则后端留着 | 缺省不变 | 否(用户已定) |
| 启动时长 | 窗先开,装配 ≈1.7s 并行 | 窗先开,子进程起步 + 装配并行;预计多 100–300ms(进程起步 + 发现文件轮询粒度) | 轮询 50ms 粒度;门量出真数 | 否 |
| 后端崩了 | 整个 app 一起崩 | 窗还在;见 D11 | 自动重拉一次 + 横幅 | **是** |
| 活动监视器 / 任务管理器 | 一个 onething | 两个(主进程 + 后端,后端进程名仍是 onething,因为是同一只二进制) | 后端加 `process.title = 'onething-backend'` | 否 |
| 日志文件 | `shell.jsonl`(`main.ts:240`) | 后端写 `app.jsonl`(或保留 `backend.jsonl`),Electron 自己一本 `shell.jsonl` 只记窗口的事 | 后端 `app.jsonl`(与 CLI 同名,因为它们现在是同一个进程种类);顺手结 `main.ts:819-821` 留账① | 否 |
| `run/http.json` 的 `cdp` 字段 | 桌面把 CDP 口写进去 | 不写(AI 浏览器那一半不做,chrome-devtools-mcp 连 CDP 那条路一起退役) | — | 否(用户已定) |

**风险**

- `ELECTRON_RUN_AS_NODE` 在打包态要**电子保险丝(fuse)`RunAsNode` 开着**(electron-builder 缺省不关;仓里没有任何 fuses 配置,grep 零命中)。这条由 `gate:packaged` 跑出来。
- 从 asar 里 `spawn` 一个 `.cjs`:Electron 的 node 对 asar 有读取补丁,但 `worker_threads` 与原生模块要真路径 —— 所以 `backend.cjs` 进 `asarUnpack`,同 `search-worker.cjs` 的先例。
- 两个写者:若用户同时开着 `server:start` 与桌面,今天就会写坏账本(`backend-standalone-main.ts:94-106` 的原话);D6 的让位规则把这个窗口收窄到「`--force`」一条路。
- 子进程的 `stdout` 管道:后端 `consoleEcho: 'pretty'`(`:117`)在子进程下没人读会把管道撑满 → 子进程阻塞。桌面档关掉 echo,或 Electron 持续读并丢弃。写进 `backend-process.ts` 的文件头。
- 钥匙串 ACL(批 0 的 D2)—— 后端与 Electron 是**同一只二进制**,`security` 命令行建的条目把这只可执行文件加进信任名单,两者都解得开;开发期 `sign:dev:mac` 换一次签名就要再点一次「始终允许」(与 CLAUDE.md §1 今天那条坑同一个机制,不是新坑)。

**验收**

- `gate:packaged` 扩:③ 断言发现文件 `owner === 'backend'` 且 `pid !== app pid`;⑥ 缺省档 SIGTERM 后两个进程都退、文件删;新增 ⑦「继续运行」档:
  写一份 `ONETHING_STORE_PATH` 下的设置开开关 → 退 app → 断言后端还活着、文件还在 → 再起 app → 断言它**没有**再拉一个(发现文件 pid 不变)→ 最后 SIGTERM 后端收尾。
- 新门 `scripts/gate-backend-process.mjs`(不打包,跑 `dist-electron`):起 Electron 离屏(`ONETHING_GATE_HEADLESS=1`,不抢前台)→ 杀后端子进程 → 断言 D11 的行为 → 断言 `GET /api/capabilities` 的 `terminal: true`、`localFileSystem: true`、MCP 名单非空(证明五件补齐)。
- `boundary:gate` 新断言:`apps/desktop-react/electron/**` 对 `@onething/backend` 只许 `import type`。
- 启动时长:`gate:chat-layout` 的冷载一栏加「从进程起到 `host:connection` 落定」一个数,基线用今天的数(门量,不手填)。
- `transport:gate` 不变;`gate:native` 不变(同一只二进制)。
- 真机(**用户择时**):真 `~/.onething` 上跑一天,看 MCP / 调度任务 / 电台都在。

### 2.4 批 3 · CLI 走 HTTP

**目标**:CLI 是一个纯客户端;缺省连 Electron 拉起的后端,可配置为自己拉起;守护进程与 unix socket 退役;Windows 顺带可用。

**改动清单**

1. `apps/cli/src/backend-connect.ts`(新):读发现文件 → `isAlive` → `createTransport({ baseUrl, token })`(`@onething/backend-client`);
   没有活后端时按配置:`attach`(缺省)→ 报「后端没在跑,打开 onething 或 `onething backend start`」;`spawn` → 用 §2.3 的同一套拉起逻辑(`ONETHING_BACKEND_LAUNCHER=cli`,
   `detached`,后端自己声明 `markHostUnattended('cli')`,见 D7)。拉起用哪份产物见 D12。
2. 每条命令改成 RPC(§1.3 的表):流式用 `GET /api/events` 的 `session:event`,`stdout()` 照旧是给人看的唯一出口。
3. 删 `daemon-server.ts`、`daemon-client.ts`、`ndjson.ts`、`packages/shared/cli/protocol.ts`(方法表退役;错误码保留的迁到 CLI 自己的文件)、`packages/backend/headless/`、
   `packages/backend/package.json` exports 的 `./headless`、层次表一行;`mcp-command.ts` 的桥改成 `resources.do` over HTTP(60 秒判据不变)。
4. `onething daemon start|stop|status|restart|logs` → `onething backend start|stop|status|logs`;`stop` 调新契约 `backend.shutdown`(只给本机信任的来访者,与 `memory.trim` 同一档)。
5. `scripts/build-cli.mjs`:CLI 产物不再拖整个后端(今天 `dist/cli/main.cjs` 里是整棵装配);`search-worker.cjs` / `acp-mcp-bridge.cjs` 两份副产物随 D12 决定要不要再出。
6. `scripts/headless-boundary-check.ts` 里与 `HeadlessBackend` / daemon 有关的断言退役;`docs/audit/feature-layers-2026-10.json` 删 `headless` 一行;`bun run feature-map`。

**行为变化**

| 项 | 改前 | 改后 | 推荐 | 拍 |
| --- | --- | --- | --- | --- |
| `onething ask` 时桌面没开 | 自己拉守护进程(8s 内连上) | 缺省报错并提示;配置 `spawn` 档才自己拉 | 用户已定 | 否 |
| 桌面开着时 `onething ask` | **起第二台后端写同一个 store**:`ensureDaemon`(`daemon-client.ts:103-111`)只试 socket、连不上就 spawn,守护进程 `start()`(`daemon-server.ts:42-75`)不读发现文件;它以 `'daemon'` 拿锁(`headless-backend.ts:124`)而桌面不拿锁(`main.ts:32-34`、`backend.ts:676-677` 的 `UnlockedStoreLease`),所以锁也拦不住 —— 正是 `backend-standalone-main.ts:94-106` 说的「两个写者铸同一个 seq」。`storage-store-lock.ts:405-407` 那句「桌面正在用」只在旧 Vue 桌面拿锁的年代成立 | 直接用桌面的后端,**同一份会话、一个写者** | 行为改善(今天是一条会写坏账本的路) | 否 |
| Windows | `paths.ts:21` 直接抛「不支持」 | 能用 | — | 否 |
| `onething daemon …` | 有 | 改名 `onething backend …`,旧名保留一版别名 | 保留别名一版 | 否 |

**风险**

- 后端重启的窗口里 CLI 与桌面读同一份发现文件:旧记录 pid 已死、新记录还没写 → CLI 缺省档报「没在跑」,`spawn` 档会抢在桌面之前再拉一台。对策:`spawn` 档拉起前
  等 2 秒再读一次,且拉起时照 D6 的让位规则,后端自己发现有活记录就退。
- `onething mcp` 桥经 HTTP 进来是「联网调用方」,资源 `do` 的授权判据从 `DESKTOP_RPC_CONTEXT` 变成本机信任(回环 + token),与今天守护进程里直连内核的权限面不完全同:
  今天它绕过了 `payloadLeavesProcess` 脱敏,改后会被脱敏 —— 这是**对的**,但 `mcp-command.test.ts` 的夹具要跟着换。
- CLI 产物瘦身后,`apps/cli/src/store-command.ts`(备份 / 校验)仍直接 import `@onething/backend/storage` 读盘 —— 它不经后端是有意的(`gate:store-backup` 守着),
  批 3 不动它;但 CLI 包因此仍带一部分后端代码,不能说「CLI 纯客户端」。

**验收**:`gate:client`(`@onething/backend-client` 两运行时)不变;新门 `scripts/gate-cli-http.mjs`:临时 store 起 `dist/server`(或 D12 的产物)→ 逐条跑
`onething session new / ask(假服务商) / resource list / mcp`(stdio 握手)→ 断言输出形状与今天 `apps/cli/src/__tests__/fixtures` 一致;再起 **没有**后端的空 store → 断言缺省档报错、`spawn` 档拉得起、`onething backend stop` 停得掉、发现文件删。

### 2.5 批 4 · 插件与 gateway 挂后端

**目标**:两个今天没有宿主的子系统在后端进程里起来。

**改动清单**

1. 插件:后端进程入口(桌面档与 CLI 档)在引擎之后 `await bootstrapPluginSystem(eventBus, engine)`,`own()` 它的拆除;`PluginsHostPorts.exec` 由后端自己实现
   (`execa` 是根依赖 `package.json:118`,后端进程 import 它不再有「塞进 server 包」的顾虑 —— 后端进程就是那个包);`pickFile` 改成 shell dispatch:
   插件声明树里的 `file-pick` 节点由客户端渲染,点了在客户端开对话框、把文件经 `resources.do(plugin:…, 'import', { bytes })` 交回后端。
   `http-server-capabilities.ts:70` 的 `pluginsManage` 自动变真;插件域里「只在桌面宿主」那几句结构化拒绝删。
2. gateway:新 `packages/backend/gateway/gateway-host.ts` 实现 `GatewayHostPorts`(`getStatus / start / stop / wechat*`),`start` 用 `startGateway`(`gateway-standalone.ts:64`)
   + 进程内引擎造对话 runtime(不再需要 `ONETHING_GATEWAY_RUNTIME_MODULE`);后端进程入口装配后 `configureGatewayHost(...)` 并按设置决定起不起。
   `gateway-standalone-main.ts` 保留给单独部署。网关的远程审批(网关消息里批权限)今天走 `gateway` 域,不动。

**行为变化**:设置里插件页、网关页从「只在桌面宿主」变成能用;插件的 UI 描述树照旧只在锚点上渲染。两页今天都是空的,所以「保持旧行为」没有可保的,直接做。

**风险**

- 插件的 `exec` 从前设计成在桌面主进程跑(`plugin-host-ports.ts:45-60` 的注释),现在在后端进程跑:它拿到的 PATH 是批 2 搬过去的登录 shell PATH,不再是 Electron 的 ——
  行为上更接近用户终端,但 `gate:plugin` 要真起一条带 Homebrew 路径的命令证明。
- `execa` 进后端产物:它本来就是根依赖,但 `dist/server/main.js` 那份 vite 包今天没有它;D12 的 (b) 档(服务器上用系统 Node 跑)要么把它带上,要么在那一档关掉插件 `exec`。
- gateway 起来之后后端进程常驻一条到微信 / Telegram 的长连接;「退出后后端继续运行」关着时,Quit 会把网关一起断 —— 设置页网关那一节要写明这句话,别让用户以为网关是独立的。
- 插件的凭证策略(`configureAppPluginCredentialStrategyHost`,`backend.ts:192`)已在装配里,不受影响;但插件能读到的凭证经批 0 之后全是后端主密钥解的,**插件 API 不得暴露原文**
  (`plugin-contract-policy.ts` 的 `PLUGIN_DEFERRED_REGISTRIES` 先读)。

**验收**:`gate:plugin`(新):临时 store 装一个夹具插件(仓里 `evals` / `__tests__` 已有的插件夹具)→ 断言 `pluginsManage: true`、插件命令经 `exec` 跑通、`file-pick` 走 shell dispatch
(用 `gate-resources` 同款假壳);`gateway`:`gate:gateway`(新)起后端 + 假渠道(`gateway/channels/__tests__` 里的替身)→ 一条消息进出。两道都只用 node。

## 3. 决策点表

每条:选项、我的推荐与理由、要不要用户拍。**用户可感知的**默认推荐「保持旧行为」或明确列出让用户选。

| # | 决策 | 选项 | 推荐与理由 | 拍 |
| --- | --- | --- | --- | --- |
| D1 | 后端进程跑在什么上 | (a) **Electron 二进制 + `ELECTRON_RUN_AS_NODE=1`**;(b) 打包一份 Node;(c) 系统 Node | **(a)**。零体积增量(Electron dist 281MB、其中 Framework 260MB 已经在包里;一份 Node 二进制 122MB);ABI 与今天逐字相同(Node 24 / 145),`gate:native` 已在这个运行时下逐个跑过;同一只二进制 = 同一个代码签名身份,钥匙串 ACL 一条就够。代价:没有 `safeStorage`(批 0 已不靠它)、打包态要 `RunAsNode` 保险丝开着(门跑出来)。(b) 多 122MB 且多一个要签名的二进制;(c) 不可控 | **用户 10-06 拍定(按推荐)** |
| D2 | 后端主密钥放哪、归谁的签名身份 | (a) macOS `security` 命令行写钥匙串条目,`-T` 信任本 app 可执行文件;(b) N-API 钥匙串模块(要过 `gate:native` + N-API 法);(c) 文件 0600 | **macOS 先走 (a)**(零依赖,条目归 app bundle 的签名身份;dev 的 ad-hoc 签名每换一次二进制再授权一次,与今天同机制);**Windows / Linux 走 (c) 作为第一版**,并在「凭证已锁定」里诚实报「这台上是文件档」;(b) 等有跨平台需求再评,仓里今天没有任何钥匙串依赖(grep `keytar|keyring|@napi-rs` 零命中)。**限制(10-06 向用户说明过)**:`security` 命令建的条目,同一用户下任何进程都能经同一命令读出,所以它防的是「store 文件被拷走 / 被备份带走」,不防本机恶意进程,强度与 0600 文件同档;要防本机进程得上 N-API 钥匙串模块 + 正式签名,第一版不做 | **用户 10-06 拍定(按推荐)** |
| D3 | 存量 `safeStorage` 密文怎么迁 | (a) Electron 首启自动迁(它仍握有 safeStorage,无需口令);(b) 只走用户拍的「导出(口令)→ 导入」 | **(a) 为缺省、(b) 为长期功能**。(a) 对用户无感,且顺序与用户拍的一致:Electron 在后端起来**之前**读并解开旧文件(此时没有写者,OAuth 刷新不会让它过期),后端就绪后、对外服务前经 `spaces.importCredentials` 导入并逐条校验,成功才删旧密文。但 (a) 让明文凭证经本机回环 socket 从 Electron 进到后端一次(token 鉴权、0600 发现文件)—— 这与用户「任何接口不得把凭证原文**返回**客户端」不冲突(方向是进不是出),但要用户点头 | **用户 10-06 拍定(按推荐)** |
| D4 | 内置浏览器的用户数据面(开格 / 导航 / 读正文 / 列 tab)拆后怎么走 | (A) Electron 主进程当一个 shell 客户端:`browser:` 改 `home: 'shell'`,主进程订 `/api/events`、`mountShell`,渲染层**一行不改**(仍走 `resources` RPC);(B) 渲染层直接走 preload 的 `host:native-view` 那条 IPC(不加通道,但把数据面塞进「窗口系统」通道,违反 `native-view-ipc.ts` 文件头那条分界);(C) 新开一条 IPC(`transport:gate` 的 ≤2 预算破) | **(A)**。`resource-provider.ts:8-10` 反对 `'shell'` 的理由是「主进程就是 core 进程、寿命不是一次连接」—— 拆完之后它的寿命**正是**一次连接,那条理由自己消失了。代价:每次操作多一次回环往返(毫秒级,`gate:browser` 的 `tabSwitchMs ≤ 50` 量得出);AI 那一半(`browser_navigate` 效果、`gate:browser` ①)按用户定的以后删,但 `browser:` 这个命名空间**留给用户的壳**。(B) 省一圈但把两类东西挤一条通道;(C) 破门。**顺带说清一个没选的省法**:Electron 主进程一旦是 shell 客户端,`dialog` / `shell` 也可以零新 IPC 地骑 shell dispatch(渲染层 → 后端 → SSE → 主进程)—— 我不选它,因为那正是用户「不需要经过后端的不再经过后端」要删的路;浏览器走 (A) 是因为它的数据面本来就要被 AI 与壳共用,对话框不是 | **用户 10-06 拍定(按推荐)** |
| D5 | `dialog` 退役后渲染层怎么开对话框 | (a) preload 加 `host:client-action` 一条 `invoke`(对话框、`openExternal` / `openPath` / `revealPath` 四个动词在载荷里;`ipcMain` 2→3,`transport:gate` 基线放宽一次);(b) 并进 `host:native-view` 通道;(c) 保留 `dialog` RPC 域、后端经 shell dispatch 转回 Electron(绕两圈) | **(a)**。这条通道与 `host:connection` 同性质(只有宿主答得出的事),不是数据通道,不违背「请求 / 应答永远不开新通道」的本意;但 CLAUDE.md §9「它只有两条 IPC 通道」是一句立过法的数,改它要用户点头 | **用户 10-06 拍定(按推荐)** |
| D6 | 发现文件的 owner 与让位 | (a) Electron 拉起的后端写 `owner: 'backend'`,`server:start` 对**任何**活记录让位(修掉今天「两个 server 不互拒」的缺口);(b) 沿用 `'server'` | **(a)**。Electron 需要区分「我拉的」和「别人起的 server:start」(前者退出时要不要收尾由设置定,后者不归它管);今天 `:83` 只对 `owner !== 'server'` 让位,在拆后会变成主路上的洞 | 按推荐(不需用户拍) |
| D7 | `HeadlessBackend` 退役还是变成后端进程的一个档位 | (a) 退役,`toolRegistry: 'headless'` + `markHostUnattended` + 60 秒自动拒三样变成 `ONETHING_BACKEND_LAUNCHER=cli` 档的参数;(b) 保留为一类进程 | **(a)**。它 715 行里只有 `daemon-server.ts` 一个调用者,其余是给 CLI 的投影函数(搬到 CLI 侧);「同一份代码两种档位」比「两种后端」合 R5 | 按推荐(不需用户拍) |
| D8 | 多个客户端在线时「后端请客户端执行」发给谁 | (a) 现状:后登记者顶掉先登记者(`claim` 覆盖);(b) 发给**发起这次调用的那个客户端**(要 `RpcDispatchContext.callerId`,HTTP 侧今天不填,`global-events.ts:158-161` 记着这个坑);(c) 广播、谁先回执算谁 | **分两类**:用户自己发起的(`workbench:`、`dir:reveal` 从壳里点)走 (b)—— 把 Bearer token 之外再带一格 `X-Onething-Shell-Id` 请求头,`callerId` 就有了;AI 发起的走 (a) 的「最近一次活动的壳」。(c) 会做两次 | **用户 10-06 拍定(按推荐)** |
| D9 | 本机信任的档位 | (a) `canSpawnLocalProcesses` 改认 `isHostLocallyTrusted()`(回环 + token 即可起本地进程);(b) 新 origin `desktop-launched` 专给 Electron 拉起的后端 | **(a)**。拆后桌面与 `server:start` 对后端来说是同一种来访者;「拿着 0600 文件里的 token 的本机进程」就是今天 `desktop-embedded` 想说的那个人。一条判据,不加第二个 origin | 按推荐(不需用户拍) |
| D10 | 「凭证已锁定」怎么呈现 | (a) 顶部横幅 + 「重试」;(b) 只在 provider 列表上锁图标;(c) 弹模态 | **(a)+(b)**,不用 (c)(锁定不该挡住读会话)。文案我定进派工单(用户 09-17 的规矩:当用户读) | **用户 10-06 拍定(按推荐)** |
| D11 | 后端崩了 Electron 怎么办 | (a) 自动重拉一次(60 秒内最多 3 次),再崩亮横幅「后端已停止 · 重启 / 查看日志」;(b) 只亮横幅;(c) 整个 app 一起退(今天的行为) | **(a)**。今天是 (c),但那是「同一个进程」的副作用不是设计;重拉期间渲染层照今天「连接失败」的路显示,会话账本在盘上不会丢(事件账本每条落盘) | **用户 10-06 拍定(按推荐)** |
| D12 | CLI 自己拉起后端时用哪份产物 | (a) 找本机安装的 onething.app,用它的 Electron + `backend.cjs`(与桌面同一份);(b) CLI 包自带 `dist/server/main.js` 用系统 Node 跑;(c) 两者都认,先 (a) 后 (b) | **(c)**。(a) 的后端与桌面一模一样(MCP / 终端 / 语音都在);没装 app 的机器(服务器)只能 (b),而 (b) 正是 `server:start` 今天的产物。两份产物以后合一,见 §4 | 按推荐(不需用户拍) |
| D13 | 开发模式 `bun run dev` 怎么起 | (a) `dev-app.mjs` 的 esbuild 多出一份 `backend.cjs`(≈0.4s),Electron 照生产路拉起;(b) 桌面泳道连 `dev:web` 那台 `server:start`;(c) 桌面继续进程内装配,只有打包态拆 | **(a)**。(c) 是两套启动路(dev 与 prod 不一样是 09-10 判例里被斥的那种);(b) 让桌面依赖 web 泳道。硬约束:后端**不能用 bun 跑**(`node:sqlite`,CLAUDE.md §5 `gate:search-index` 那句),所以 dev 下也是 Electron-as-Node 或 node,不是 bun | 按推荐(不需用户拍) |
| D14 | `pets` / `collab` / `sessionSkills` 这些装配开关在后端进程里取什么值 | 桌面档与今天 `assembleOwnCore` 逐字相同(`collab: true, sessionSkills: true, pets: true, toolRegistry: 'full'`);server 档不变 | 不变 | 按推荐(不需用户拍) |

## 4. 不做 / 以后做

- **不做**:`browser:` 给 AI 用的那一半(`browser_navigate` 效果、`gate:browser` ①、CDP 口进发现文件、chrome-devtools-mcp 连 CDP)—— 用户已定,批 1 之后另开一单删。
- **不做**:开机自启、托盘图标、多窗(`main.ts:209-210` 留账的 P4)。
- **不做**:店锁(StoreLock)复活;`UnlockedStoreLease` 仍是所有后端的缺省。
- **不做**:凭证级主体 / 作用域 token(09-03 用户搁置)。
- **以后**:手机配对流程(今天只有 `backend-standalone-main.ts:212-215` 打一行 `pairing` 日志);两份后端产物(`dist/server/main.js` vite 包与 `dist-electron/backend.cjs` esbuild 包)合一;
  内存探针上报;Windows / Linux 的钥匙串从文件档升级;gateway 按人分权限(方向文档 §1.1「以后再做」)。
- **以后**:`transport` 字段整个从 `RpcDispatchContext` 删掉(批 2 只删 `'ipc'` 一档,剩下的消费者 `settings` / `mcp` 两域改成无条件脱敏后再删字段)。

## 5. 陌生能力演练:手机端要一个原生分享面板

题目:手机 app 要「把这条消息 / 这个文件用系统分享面板发出去」,AI 也能说「把这个分享到微信」。设计时没想过。拆完之后要改哪些文件?

- **能力自己的模块**(手机侧,`apps/mobile/src/resources/share-spec.ts` + `share-ops.ts`):一份 `SerializedResourceSpec`,scheme `share:`,一条做法 `send { text?, path? }`,
  `effects: ['ui_change']`,`home: 'shell'`;落点调 React Native 的 `Share.share(...)`。
- **壳渲染 / 接线**(手机侧,`apps/mobile/src/resources/shell-host.ts`):与桌面 `apps/desktop-react/src/resources/shell-host.ts` 同一个体例的一只文件 —— 连上后
  `resources.mountShell({ shellId, spec })`、每 30s 续命、订 `resource:shell-command`、对 `shellId`、跑落点、`resources.shellResult`、断开时 `unmountShell`。
  这只文件是**每个客户端一份、写一次**,不是每个能力一份;手机今天还没有它,所以演练里算一只新文件,第二个能力就不用再写。
- **一行登记**:`mountShell` 的 spec 列表里加 `shareSpec` 这一项。

后端:**零文件、零行**。`ShellMountRegistry` 收的是运行期交来的 spec(`resource-client-api.ts:164`),AI 工具面、`describe`、授权(按 `effects`)、
命令面板自动认得 `share:send`;Electron、CLI、`http-server/` 名册、`backend.ts`:零改动。「能力自己的模块 + 壳渲染 + 一行登记」成立。

反向再演一个:**后端要请客户端做一件今天没有的事**(例:agent 要「震动一下」提醒)—— 同上,一条 `home: 'shell'` 的做法,没有客户端在线时 AI 得到 `ResourceHomeUnavailableError`,
后端里不出现任何客户端的名字。所以批 1 把 `dialog` / `shell` 端口删掉之后,后端不会再长出第二张「按客户端能力枚举」的表。

## 6. 汇报要点(摘给编排者)

- 摸底最出乎意料的三条:
  1. **「借活的 core」那条路今天借的是一台不完整的后端**:`backend-standalone-main.ts` 不起 MCP(`mcp.start()` 全仓只在 `backend.ts:1350-1353` 的 CLI 档与 `main.ts:353` 被调)、
     不起调度任务、不起电台指挥、不拉首启模型目录、不补登录 shell 的 PATH。第④步一半的活在后端进程入口,不在 Electron。
  2. **拆进程切断的不只是 AI 的浏览器,还有用户自己的**:`BrowserLeaf` 的开格 / 导航 / 读正文走 `resources` RPC 经后端内核回到 Electron 主进程里 `mount` 的 `browser:`
     (`src/data/browser-port.ts` 文件头、`electron/browser/index.ts:339`)。方向文档只说了「给 AI 用的那一半不做」,用户用的那一半要一个决定(D4)。
  3. **桌面开着时跑 `onething ask`,今天会起第二台后端写同一个 store**:`ensureDaemon`(`daemon-client.ts:103-111`)只试 socket、连不上就 spawn,守护进程不读发现文件;
     它以 `'daemon'` 拿锁而桌面不拿锁(`UnlockedStoreLease`,`backend.ts:676-677`),锁拦不住 —— 这就是 `backend-standalone-main.ts:94-106` 警告的「两个写者铸同一个 seq」。
     批 3 让 CLI 依附桌面的后端,顺手关掉这条路。(另两条小的:`payloadLeavesProcess` 在 React 桌面上**今天就恒真**,拆后不是新状态;真正按进程身份分档、拆后会断的是
     `mcp` 域的 `canSpawnLocalProcesses` 只认 `desktop-embedded`,`mcp-client-api.ts:118`,见 D9。)
- 拿不准的:①`ELECTRON_RUN_AS_NODE` 子进程能否直接从 `app.asar` 加载 `.cjs`(我按「进 `asarUnpack`」写,由 `gate:packaged` 证);②macOS `security` 命令行建的钥匙串条目在
  硬化运行时 + 公证之后的 ACL 行为(dev 的 ad-hoc 签名实测过的是 `safeStorage`,不是 `security`);③D3 自动迁移是否违背用户对「口令」那条的本意 —— 我读成「口令是导出文件的保护,
  不是迁移的前提」,但这是推论;④启动时长多出的 100–300ms 是估的,门量出来才算数。
