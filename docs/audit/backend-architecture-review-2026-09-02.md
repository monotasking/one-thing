# 后端架构审查(2026-09-02,HEAD `b56198f0`)

只读调查,不含任何改动。范围是 `packages/core` / `packages/onething-runtime` / `packages/backend` /
`packages/shared` 与四个宿主的装配代码。**Vue 那份 renderer(`packages/renderer`)按用户口径已退役,
本文不评它本身**,但它的宿主(`apps/electron`)仍然是今天很多后端能力唯一的装配点,这一点是本文第一条。

四路各自的原始报告与可复现脚本在本节末尾。所有数字都是脚本跑出来的,file:line 均已抽查。

---

## 0. 结论速览(按严重度排序)

| # | 问题 | 一句话 |
| --- | --- | --- |
| 1 | **一半产品能力只挂在已退役的 Vue 宿主上** | React 壳装配 10 件,Vue 壳装配 37 件;插件 / 语音 / 音乐 / 网关 / evals 宿主口 / deeplink / todo 与草稿纸 watcher / skills 初始化在 React 壳里根本没起,而所有宿主端口未注入都是**静默降级**,所以壳看起来正常只是功能少了一半 |
| 2 | **`createOnethingBackend` 是 35 步全局脚本,不是对象** | 0 步把上一步产物当参数传下去;26 个只能置一次的布尔闩;第二次调用静默返回第一份的引擎;全仓没有一个测试真正调用它 |
| 3 | **关机与启动不对称** | 四宿主三套关机清单;janitor 定时器 / 用户调度器 / todo watcher 在 backend 关机里一个不关,`stopTodoPlanWatcher` 全仓零调用点 |
| 4 | **会话账本的两条写队列没有共同的失败处理,双写者只在事后检出** | `events.jsonl` 与 `meta.json` 各一条队列;两个 `server:start` 互不拒绝;会话容器持久化的写面不唯一,`server/runtime.ts` 里有第二套 `saveSession` |
| 5 | **`server/runtime.ts` 4135 行是第二份装配配方** | 扇出 67,per-owner 会话 / 插件 / 搜索三套镜像与两个单槽端口全在一个闭包里;桌面内嵌 HTTP 面上 plugins 域读镜像树、写真树,链上/恢复那 80 行零测试 |
| 6 | **RPC 域把"这台机器有没有外设"写成了 `transport` 分叉** | 13/42 域分叉,其中 voice 11/11、terminal 7/7、plugins 18/19 是整域二分;前端能力位与后端护栏判据不一致,music 是反向缺口(浏览器端能驱动服务器的 mpv);网络宿主工具默认 `full` 档带 bash/write/edit |
| 7 | **依赖方向有三处真洞** | `packages/shared` 反向吃 core/runtime 34 处(含一条跨包相对路径);backend 内 49 文件真环靠 6 处动态 import 撑着;`stores/sessions.ts ↔ session/commands.ts` 两跳硬环 |
| 8 | **"薄接线"名不副实,logging 住错了槽** | `wiring/collab` 9325 行、`wiring/engine` 6712 行;`wiring/logging/index.ts` 扇入 142 是全包最被依赖的模块;core/engine 与 wiring/engine 有 7 个同名孪生文件,I2 不变量不管这一对 |
| 9 | **CLAUDE.md 与代码分叉四处** | 会话章节整段过期且方向危险(说 messages.jsonl 是唯一真相,实际已停写);wiring 28 vs 实有 33;宿主表缺 desktop-react;三进程模型还是 Vue 的 |

健康的部分见 §3,不少。

---

## 1. 前提:宿主现状

先把"谁在装配 backend"说清楚,因为后面一半问题都从这里长出来。

| 宿主 | 装配点 | 状态 | 宿主注入与初始化调用数 |
| --- | --- | --- | --- |
| Vue 桌面 | `apps/electron/src/app/main-process.ts:216` | **已退役**(用户口径) | 37 |
| React 壳 | `apps/desktop-react/electron/main.ts:190` | 现役,渲染层走 HTTP/SSE | 10 |
| headless server | `packages/backend/server/runtime.ts:818` | 现役 | — |
| CLI daemon | `packages/backend/wiring/headless/backend.ts:104` | 现役,入口仍在 `apps/electron/src/main/cli/` | — |

React 壳装配的全部内容(`main.ts:198-202` + `startPostWindowServices`):configureLogging、auth / sandbox / storePath
三个宿主端口、`createOnethingBackend({toolRegistry:'full', collab:true, sessionSkills:true})`、内嵌 HTTP/SSE 面、
用户调度器、MCP、首启模型刷新。就这些。

只有 Vue 宿主才起的东西,按代码量:

| 子系统 | wiring | runtime | core | 电子宿主 | React 壳里的状态 |
| --- | --- | --- | --- | --- | --- |
| plugins | 3722 | 4518 | 15341 | 410 | 无 PluginManager → 19 条 RPC 全部回"desktop host only" |
| collab(runtime 20933 行) | 9325 | 20933 | 0 | 0 | ✅ 在 backend 本体里(`collab:true`) |
| evals(宿主口) | 537 | 7086 | 0 | 0 | `configureEvalsHost` 未注入,静默 |
| external-agents | 713 | 3589 | 0 | 0 | 只在 backend 关机里被 import,无初始化 |
| voice | 883 | 2581 | 0 | 383 | `configureVoiceHost` 未注入,RPC 回假态 |
| music | 1982 | 2902 | 0 | 0 | 未起 radio conductor |
| gateway(`packages/gateway` 3410) | 204 | 0 | 0 | 596 | 未起 |
| skills | 232 | 2472 | 0 | 48 | `initializeSkills()` 未调(sessionSkills 那半在 backend 里) |
| deeplink | 344 | 0 | 0 | 310 | 未起 |
| todo-plan / scratchpad | 136 | 646+361 | 0 | 31 | watcher 未起 |

这不是 React 壳的 bug,是 backend 的结构问题:**backend 本体没有一份"产品能力清单",装配哪些子系统由宿主决定**,
而 20 个 `configure*Host` 端口未注入时 **0 个抛错**、全部静默或结构化降级(`configureMCPClientHost` 例外:未注入
等于"真连",见 §2.2)。宿主漏接一根线,得到的是一个能跑但少一半功能的进程,而不是启动失败。

---

## 2. 问题清单

每条给现象、证据、为什么算架构问题、候选治法。**治法只列候选,不替你拍板**。

### 2.1 一半产品能力只挂在已退役的宿主上(§1 已述)

候选治法:
- (a) 把"宿主无关但今天塞在 Vue 宿主 post-window 里"的初始化收回 `createOnethingBackend`,用 options 开关而不是宿主自己调——`initializeSkills` / `startTodoPlanWatcher` / `startScratchpadWatcher` / 插件管理器 / 网关都符合。证据是它们已经有第二三个启动点(scratchpad watcher 在 `server/runtime.ts:1377`,todo-plan watcher 在 `rpc/domains/settings.ts:143`)。
- (b) 让端口未注入时按能力声明**抛错或至少 warn 一次**,而不是静默。今天只有 `configureShellHost` / `configurePluginsHost` / `configureGatewayHost` 三个是结构化降级,其余静默 noop。
- (c) 把 `apps/electron/src/main/cli/` 的 daemon 入口从 Vue 宿主搬走,否则 Vue 宿主没法真正退役。

### 2.2 `createOnethingBackend` 是全局脚本,不是对象

`packages/backend/backend.ts:145-297`,35 步:

- **0 步**把前一步的产物当参数传给下一步;6 步吃 option 值;其余 29 步全靠 `getSettings()` / `getEventBus()` / `getStreamEngine()` 这类进程级访问器读全局。`getSettings` 有 79 个调用文件,`getEventBus` 46 个。
- **26 个单向布尔闩**(`providerRegistryInitialized`、`bootstrapped`、`skillsLoaderConfigured`、`builtinTriggersRegistered`…)只在 `*ForTests` 口子里重置(35 个这样的口子,全是测试用)。`configureAppRuntimeAdapters()` 的"幂等"就是靠这 11 个闩,所以 shutdown 之后再 assemble 会**静默跳过**所有接线。
- **二次调用静默**:`initializeEventSystem`(`events/index.ts:58-62`)、`initializeStreamEngine`(`engine/index.ts:82-85`)、`initializeSessionLayer`(`session/index.ts:44-47`)存在就 warn 并 return。第二份 backend 拿到的 `engine/eventBus` 是第一份的对象,而它的 `shutdown()` 会把两份一起关掉。
- **无测试**:`packages/backend/__tests__/` 只有 `import-side-effect-free.test.ts`;全仓提到 `createOnethingBackend` 的 3 个测试文件只断言 `typeof === 'function'`。
- 附带一个死单例:`packages/core/events/index.ts:8-9` 声明了第二对 `eventBus/streamChannel` 和同名 `getEventBus()`,从 `packages/core/index.ts:472` 导出,**没有任何宿主初始化它**——从 `@onething/core` import 到的是一个永远抛错的总线。
- `configureMCPClientHost` 未注入时不是"没有 MCP",是 `new MCPClient(config)` 真连(`runtime/src/mcp/manager.ts:27-29`)。20 个端口里唯一一个"未注入 = 做危险的事"。

从面向对象的角度说:backend 里 23 个 class 对 971 个导出函数,装配层是一堆带全局状态的自由函数,不是一个持有子系统、有生命周期的对象。这正是 §2.1 与 §2.3 的共同病根:没有一个 `Backend` 实例"拥有"这些子系统,就没有地方写"我起了什么、我该关什么"。

候选治法:
- (a) 把 `createOnethingBackend` 改成构造一个 `OnethingBackend` 对象,每一步的产物作为字段持有并显式传给下一步;26 个闩变成对象字段,随对象生灭。
- (b) 先不动结构,只补一个真调用它的测试(assemble → shutdown → assemble 一次),把"二次装配静默"从未知变成已知红。
- (c) 删掉 `packages/core/events/index.ts` 里那份死单例。

### 2.3 关机与启动不对称

`backend.ts:303-374` 关 18 件事。启动里开了、关机里没关的:

| 开的 | 在哪 | 关了吗 |
| --- | --- | --- |
| 日志文件 sink + `LogDirJanitor` 5 分钟定时器 + `process.on('exit')` | `wiring/logging/index.ts:234-243` | 否,`shutdownAppLogging` 从不被 `backend.shutdown()` 调 |
| todo-plan watcher | 三处启动(`main-process.ts:233` / `rpc/domains/settings.ts:143` / store) | **否,`stopTodoPlanWatcher` 全仓零非测试调用** |
| 用户调度器(`setTimeout` 链,`scheduler.ts:612`) | 两个 GUI 宿主都起 | 否,不存在 `stopScheduler` |
| 内嵌 HTTP server + SSE 连接 | `server/embed.ts:75` 模块单槽 | 否,靠宿主自己调 `stopEmbeddedOnethingHttpServer` |
| 26 个闩 | 全程 | 否 |

四宿主的关机路:server 走 `backend.shutdown()` ✅,React 壳走 `b.shutdown()` ✅,daemon 手写清单(`headless/backend.ts:123-152`),Vue 桌面手写清单(已退役,略)。daemon 的手写清单比 `backend.shutdown()` 少 8 件,包括 `shutdownCollabV3Runtime`——而它自己传了 `collab:true`。`Interaction.shutdown()` / `uninstallSessionLedgerEventBroadcaster()` / `disposeRpcDomains` 全仓只有 `backend.ts` 一个调用者,所以 daemon 上从不跑。

候选治法:与 §2.2(a) 同一件事——子系统归对象持有,关机就是对象的 dispose,宿主不再各写一份清单。daemon 短期可先改成直接调 `backend.shutdown()`。

### 2.4 会话账本:两条写队列、事后检出的双写者、不唯一的容器写面

先纠正一个前提:**`messages.jsonl` 已停写,`events.jsonl` 是唯一账本,影子对比门已退役**(`storage-driver.ts:10-30`,
`core/engine/tool-step.ts:47`)。CLAUDE.md 第 246-277 行说的相反,见 §4。

- **两条独立写队列**:消息事件走 `event-log.ts` 每会话自己的队列(2s 时限),会话外壳 `meta.json` 走 `AsyncSaveQueue` 300ms 节流(`session-repository.ts:190`)。没有两阶段提交、没有共同失败处理;`backend.ts:369` 与 `headless/backend.ts:149` 的注释自己写着"事件有自己的每会话写队列"。异步写失败先记数、**下一次**同步 append 才上抛(`event-log.ts:466-470`),中间那一拍不可见。
- **`event-log.ts:298-312` 的文件头注释说"拒写只记账不上抛、messages.jsonl 还在写",与同文件 475-479 行的代码和 `read-mode.ts:43-45` 矛盾**——过期注释还在指路。
- **双写者**:桌面 ↔ daemon 有 StoreLock 互挡;server 对桌面/daemon 靠发现文件拒启(`apps/server/src/main.ts:72`);但 **server ↔ server 互相放行**(只挡 `owner !== 'server'`),`--force` 只 warn。兜底 `guardForeignWriter`(`event-log.ts:315-338`)是**事后**比字节数,检出时对方已经把 seq 写脏了;`event-log.ts:313` 自己承认这个残余窗口。
- **会话容器持久化写面不唯一**:`session:gate` 0 违例是真的,但它只守 `session.messages` 的类型。绕过 `sessionCommands` 直接持久化会话容器的点:`server/runtime.ts:1069` 与 `:3402` 是**第二套 `saveSession` 实现**(注释还按"重写整份 messages.jsonl"的旧模型描述风险);`core/session/store-helpers.ts` 4 处、`media/image-generation.ts:488,518`、`sessions/stream-abort.ts:204`、`core/engine/stream-processor.ts:595` 各自 `flushSessionSave`。这些全在闸外。
- 桌面 IPC 侧零 replay(`ipc-bridge.ts:180` 裸转发,SSE 侧有 `?after=` / `Last-Event-ID`)。**对 React 壳是 moot**,它走 SSE。记一笔是因为 daemon 之外没人再用 IPCBridge,这份代码可以随 Vue 宿主一起退。

候选治法:
- (a) 两个 `server:start` 的互挡补在 `main.ts:72`(owner 相同也拒,除非 `--force`);这是最小改动。
- (b) 会话容器的 `saveSession` 收成一个口,`session-check.mjs` 加一条规则守它(今天只守消息数组)。
- (c) 改 `event-log.ts:298-312` 那段注释。

### 2.5 `server/runtime.ts` 是第二份装配配方

`packages/backend/server/runtime.ts` 4135 行(非空 3903),19 个导出,**扇出 67**,是全仓最大的文件。`http.ts` 反而不是问题:786 行、19 条路由,其中 8 条 SSE、1 条字节流、1 条泛型 RPC、1 条能力位,结构上不能走 RPC 的就有 11 条,该退役的只有 4 条(全部注明为 apps/mobile 保留)。

`runtime.ts` 里装的东西:per-owner 会话 / 插件 / 搜索三套镜像、`ownerUid` 26 处消费里的 15 处、两个单槽端口的注入、内嵌面的"链上 / 跳过 / 覆盖"逻辑。

内嵌面(`embed.ts:95` 传 `{ownsBackend:false, processPorts:'host'}`)对端口的处理有三种,**没有测试**(`server/__tests__/test-helpers.ts:5` 明说交给宿主 smoke):

| 处理 | 端口 |
| --- | --- |
| 链上(捕获旧槽、先调它、关机恢复) | OAuth 广播、settings 广播、todo-plan host、scratchpad host(4) |
| 跳过(`ownsProcessPorts` 守卫) | 权限授权存储、MCP identity / host / capabilities、scratchpad watcher(5) |
| **无守卫直接覆盖** | `configureServerPluginCatalogPort`(`:1810`)、`configureServerSearchPort`(`:1928`)、`configureFilesLocalTrust`(`embed.ts:110`)(3) |

后果:桌面内嵌 HTTP 面上,plugins 域 7 条读面走 server 镜像树(`owners/<uid>/<wid>/plugin-store/plugins`),11 条写面走桌面真管理器(`<store>/plugins`)——同一扇窗口里"列出来的"和"装卸的"是两棵树。CLAUDE.md 说"桌面内嵌面有管理器、与 IPC 同一条路"只对写面成立。在 React 壳上这条脑裂被更大的问题盖住了:它没装 PluginManager,19 条全部回"desktop host only"(§2.1)。

`embed.ts:75 let current` + `:85 if (current) return current`:第二次以不同 options 调用,静默返回第一个 server,options 丢在地上。

候选治法:
- (a) 单槽端口模式(`configureServer*Port`)本身就是"组不出第二份 runtime"逼出来的;§2.2(a) 落地后,server runtime 应当只是对 `OnethingBackend` 对象的一层 per-owner 包装,镜像树的三套代码搬出这个文件。
- (b) 短期:给三个无守卫端口补 `ownsProcessPorts` 判断,并补一个"内嵌面装上再拆掉,旧槽恢复原值"的测试。

### 2.6 RPC 域按 `transport` 分叉,分的其实是"这台机器有没有外设"

42 域 318 方法,13 域分叉。真正的债不在广度在深度:

| 域 | 分叉 | 两支实际在说什么 |
| --- | --- | --- |
| voice | 11/11 | 有没有语音硬件与 tray;http 支恒返回假态 |
| terminal | 7/7 | 有没有 PTY;http 支 7 条全拒 |
| plugins | 18/19 | 有没有 PluginManager |
| tools | 4/6 | 后台任务表在 http 上恒空 |
| 其余 9 域 | 1-3 处 | 脱敏 / 夹沙箱 / 认领 targetChannel,是同一实现上的护栏差异,合理 |

前三个域的 `transport` 判据说的是"宿主有没有这个外设",本该像 `configureShellHost` 那样是宿主注入端口(未注入 → 结构化降级),而不是域处理器里的 if。今天 React 壳走 http,voice 与 terminal 域对它永远是假态——不是因为壳没有终端,是因为域把"http"当成了"没终端"。

前端能力位(`packages/renderer/platform/types.ts` 14 个,Vue 侧已退役,但 React 壳有同构问题)与后端护栏判据不一致:
- `pluginsManage` 前端按"是不是 web"、后端按"有没有 manager",桌面内嵌面上永远对不齐。
- **`music` 是反向缺口**:`web.ts:56` 缺省 `music:true`,后端 music 域**没有任何 transport 护栏**——浏览器点播放会驱动服务器那台机器的 mpv。

网络宿主工具档:`ONETHING_SERVER_TOOLS` 唯一读点 `runtime.ts:812`,默认 `full`(17 只,含 bash / write / edit),显式设 `readonly` 才降到 4 只。降级不是默认。

传输面收口本身是成功的(§3),但新壳在长第二套:`apps/desktop-react/electron/main.ts:353` 的 `host:connection` 手写通道不在 `IPC_CHANNELS` 里,`transport:gate` 数不到。

候选治法:
- (a) voice / terminal / plugins 三域的分叉改成宿主端口(未注入 = 结构化降级),域处理器里删 `transport` 判断。
- (b) music 域补护栏,或把"谁在服务这个 store 谁的机器就是放音机"这条规则写进能力位下发而不是前端缺省 true。
- (c) `host:connection` 纳入 gate 量程。
- (d) `ONETHING_SERVER_TOOLS` 缺省值是行为裁定,列给你选:保持 `full`(桌面同等)或改 `readonly`(非本机可信时)。

### 2.7 依赖方向的三处真洞

层间边(import 语句数;所有文档承诺的 0 都成立:runtime→backend 0、core→上层 0、backend→electron 0):

| from \ to | core | runtime | backend | shared |
| --- | --- | --- | --- | --- |
| core | 842 | 0 | 0 | 0 |
| runtime | 320 | 1694 | 0 | 46 |
| backend | 227 | 752 | 1213 | 318 |
| **shared** | **30** | **15** | 0 | 182 |

- **`packages/shared` 不是叶子**:34 条 import 语句反向吃 core / runtime,含 `shared/prompt-references.ts:1 → ../onething-runtime/src/prompts/prompt-references.js` 这条**跨包相对路径**(绕过 exports 表)。契约层反吃产品层,没有任何 gate 管这个方向。
- **环要先分型边**:30.9% 的边是 `import type`,编译期擦除。算上它最大环 166 文件 / 253 文件在环里(19.1%);只算值边,最大环 **49** / **65** 文件(4.9%),**全部在 backend**。汇报"循环依赖"时不分型边会去修一个运行时不存在的问题。
- 49 文件真环集中在 `wiring/collab ↔ wiring/engine ↔ toolkit ↔ agents ↔ providers`,**靠 6 处动态 import 撑着**(`collab/actors/runtime.ts:996,1080` / `external-agents/host-tools.ts:78` / `toolkit/adapters.ts:175` / `tools/core/permission-policy.ts:131` …),去掉动态边只剩 18。环没被消除,只是改成了懒加载。全仓 60 处动态 import 只有 1 处写了理由。
- 两跳硬环:`stores/sessions.ts:29 → session/commands.ts` 与 `session/commands.ts:66 → stores/sessions.ts`——P0 命令面与它的 store 互相递归。`core/permission/index.ts:656 ↔ permission-policy.ts:1` 同型。
- 脊柱-接线环:`wiring/tools/core/sandbox.ts:17 → stores/connected-directories.ts → stores/sessions.ts → session/commands.ts → … → sandbox`,层向在这里没有意义。
- `apps/electron` 绕过 backend 直吃 runtime/core 45 条(`main-process.ts` 11 条),Vue 宿主退役后一并消失。

候选治法:
- (a) `shared` 反向边:把 `@onething/core/events` / `runtime/search/protocol` / `runtime/voice/text` 这些被 shared 引的东西下沉进 shared,或给 boundary checker 加"shared 不许 import @onething/*"。
- (b) 环:先解两跳硬环(把 `stores/sessions.ts` 对 `session/commands.ts` 的依赖倒过来,命令面吃 store 而不是 store 吃命令面),再处理 collab↔engine 那团;动态 import 每处补一句理由,或用接口断开。

### 2.8 "薄接线"名不副实;logging 住错了槽;引擎孪生文件

- `packages/backend/wiring/` 实有 **33** 个域(文档 28,未记:`engine` / `evals` / `files` / `gateway` / `settings`),131 脊柱文件 / 175 接线文件。`wiring/collab` 9325 行、`wiring/engine` 6712 行、`wiring/plugins` 3722 行——"薄"字对前三名不成立。
- 脊柱→wiring 174 条,其中 `rpc/` 101 条(域处理器调本域接线,合理)、`backend.ts` 25 条(装配配方,合理)、**`session/` 21 条里 19 条只是 `import … from '../wiring/logging/index.js'`**。`wiring/logging/index.ts` 扇入 **142**,是整个 backend 最被依赖的模块;跨域 wiring 边 244 条里约 60 条指向 logging。它是横切设施,不是一个 domain,住在 `wiring/<domain>/` 槽位里让层向倒了 19 次。
- `core/engine` 与 `backend/wiring/engine` 有 **7 个同名文件**:`agent-loop-executor` / `agent-loop-runtime` / `context-compact` / `stream-executor` / `stream-processor` / `system-prompt` / `index`。I2 不变量只管 core 对 runtime 这一对。引擎实际被劈在三层:core/engine(`agent-loop-executor.ts` 2748 行、`core-stream-engine.ts` 2023、`agent-loop-runtime.ts` 1373)+ runtime/engine(480)+ wiring/engine/stream(`agent-loop-executor.ts` 1151、`session-event-recorder.ts` 1209),而 wiring 那份直接 import `IPC_CHANNELS`(`@shared/ipc`)——装配层的引擎半边在说跨进程词汇。
- `*.wiring.ts` 实有 32 个,规则 0 违例;文档只点名约 10 个;`triggers/skill-review-state.wiring.ts` 零引用。
- 上帝文件 top 5:`server/runtime.ts` 3903、`core/engine/agent-loop-executor.ts` 2545、`runtime/themes/resolver.ts` 2304、`external-agents/claude-code-connector.ts` 1991、`core/engine/core-stream-engine.ts` 1841。

候选治法:
- (a) `wiring/logging` 搬到 backend 根(`backend/logging/`)或干脆只留 runtime 那份 facade,让 `session/` 不再反向吃 wiring。
- (b) 把 I2 扩到 core/engine 对 wiring/engine 这一对,先冻结再收敛;引擎三层的边界(哪些属于 core 的纯逻辑、哪些属于装配)需要一次专门的设计轮,本文不替它定。
- (c) 删 `skill-review-state.wiring.ts`;CLAUDE.md 的 28 名单改 33。

---

## 3. 健康的部分(不要误伤)

- 五道闸今天全绿:`boundary:gate` 0 红、`session:gate` 0、`log:gate` 4 已知无新增、`transport:gate` 42 常量无上升、架构边界测试 15/15。
- 层间不变量全部为 0:runtime→backend、core→上层、backend→electron、runtime→electron。`*.wiring.ts` 规则 0 违例。
- **事件总线没有重复实现**:`backend/events` 相比 `core/events` 只有 27 行泛型绑定,其余 757 行(coalescer / delta-stamp / ui-stream)是 core 没有的。
- 请求面真的收口了:Vue 宿主只剩 `rpc:invoke` / `shell:invoke` 两条泛型通道 + `voice:audio-chunk` 一条单向流,`ipcMain` 注册全仓 4 处。
- `http.ts` 不是上帝文件(见 §2.5)。
- 投影判定单一入口成立:后端没有绕过 `canonical.ts` 的本地豁免;唯一一处尺子外归一在 Vue renderer,随之退役。
- 消息层写面唯一:`session:check` 2231 文件 0 命中。
- `sandboxRoot` fail-closed(`sandbox.ts:57`,http 上下文缺它直接抛),多宿主隔离靠这个而不是 owner 字段,方向对。

---

## 4. CLAUDE.md 漂移清单

| 行 | 文档说 | 代码是 |
| --- | --- | --- |
| 246-277 | messages.jsonl 是唯一真相,events.jsonl 是影子,影子门是 gate | events.jsonl 是唯一账本,messages.jsonl 停写只读,影子门已退役(F4-c) |
| 60-64 | `wiring/` 28 个目录,逐一列名 | 33 个;缺 engine / evals / files / gateway / settings |
| 宿主表 | 三宿主 | 四宿主,缺 `apps/desktop-react/electron/main.ts`(owner=`shell`) |
| 三进程模型 | Vue renderer + preload + main | 现役壳是 React over HTTP/SSE,只有一条 `host:connection` IPC |
| plugins 段 | "桌面内嵌 HTTP 面有管理器、与 IPC 同一条路" | 只对 11 条写面成立,7 条读面走 server 镜像树 |
| `ChatMessage.turnContext` | 字段名 | 实际叫 `contextUpdate?`(`shared/ipc/chat.ts:491`) |
| `*.wiring.ts` | 点名约 10 个 | 32 个 |

---

## 5. 复现

四路原始报告(含全部表格)在本会话的 agent 输出里;可复现脚本:

- 依赖图:`import-graph.mjs`(按各包真实 exports 表解析,0 未解析)、`followup.mjs`(barrel / 环 / 接线域普查 / 动态 import)、`typeonly.mjs`(分型边后重跑 SCC)
- 端口清单:`ports.txt`(74 个 configure* 端口)

脚本已拷贝到 `docs/audit/backend-architecture-review-2026-09-02-scripts/`(从仓库根目录 `node <脚本>` 运行,只读)。
