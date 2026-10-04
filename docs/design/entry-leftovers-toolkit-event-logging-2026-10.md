# 三件留账的决定(D170 toolkit / D172 event / D164 logging)+ agent-loop 入口瘦身判据

日期 2026-10-04。只读分析,未改仓库任何文件。证据脚本都在本目录:
`gen-graph.mjs`(现算值引用图,HEAD = `69055c8e7`)、`sim2.mjs`(从 s24 拷来的图级模拟器)、
`deep-edges.mjs`(列出指向某功能内部文件的跨功能值边)、`measure-worker.mjs`(用产品同一份
`searchWorkerEsbuildOptions` 配方在内存里打检索 Worker,比字节;六个变体)、`measure-worker-sibling.mjs`(按 §3.2 的真实布局再打一遍,
新文件用 esbuild 虚拟模块给出)、`measure-worker-sibling-bisect.mjs`(逐只去掉转交做二分)、`out-head.cjs` / `out-sibling.cjs`(两份产物,可 diff)、
`agent-loop-usage.mjs`(按语法树数入口名字的读者)。
场景文件:`sT-A.json`(toolkit,选定方案)、`sT-toolkit.json`(第一、二轮被环打回的版本)、`sT-B.json`(toolkit 的另一条路,43 只环,否决)、
`sE-event.json`、`sL-logging.json`。复跑:`cd s31-fable && node gen-graph.mjs && node sim2.mjs sT-A.json sE-event.json sL-logging.json --scc`;
Worker:`cd <仓根> && node s31-fable/measure-worker-sibling.mjs`。

## 0. 决策表

| 留账 | 决定 | 读者去向 | 可感知行为变化 | 装配顺序 | 模拟器 | Worker |
| --- | --- | --- | --- | --- | --- | --- |
| D170 toolkit 剩 7 处 | 四只文件四种处理:`toolkit-wiring` 的插件拦截改成装配时递进来的端口;`toolkit-audit-sink` 要的常量 `NO_ORIGIN_SESSION` 搬进 shared;`toolkit-tool-ports` 删掉;`toolkit-adapters` 拆开回家(goal / practice / music 三只经各自入口交出,task 那只住 task 但不经 task 入口、装配处直接引,ask_user 与 web 两只留 toolkit)。随手两件:`isTaskSession` 与 `noHumanInTheRoom` 这两条「会话长什么样」的判据下沉 session;`goal-manager` 不再引自家入口(D126)。 | 7 处全部改引 toolkit 入口(`backend.ts` ×2、`acp-fs-bridge`、`engine-stream-tool-execution`、`external-agent-host-tools`、`tool-client-api`),`resource-music-provider` 改引 music 入口 | 没有插件管理器的进程里,工具调用不再经过两条空的拦截链(今天链路空转、结果相同);`getOrBuildToolkitCatalog()` 的兜底目录(没人装配时自建的那份)不再含 goal / practice / task / radio 四只工具 —— 生产三宿主都走 `backend.ts` 的正路,不碰兜底 | `buildToolkitCatalog(tier, { adapters, interceptor })` 仍在原来那一步(工具目录按档)调用;拦截端口与适配器都是「调用时才读当前实例」的闭包,顺序不变 | 入口级环 0、低层引高层 0;指向 toolkit 内部文件的跨功能值边 6 → 0;task 2 → 1 | 检索 Worker 不含 toolkit / event / task / goal / plugin 任何模块(实测 metafile),字节不可能变 |
| D172 event 剩 12 处 | ① 三只泛型基类改名 `GenericEventBus` / `GenericStreamChannel` / `GenericRingBuffer`(不用 `EventBusBase`:入口里已经有事件形状 `EventBase`,两个名字并排只差三个字母),会话子类保留 `EventBus` / `StreamChannel` / `RingBuffer`,入口分两组交出;② 四只访问器搬进兄弟文件 `event-current.ts`,入口只转交,两只流文件改引它,入口再交出那两只 | 12 处全部改引 event 入口 | 无。基类改名是改名;访问器搬家后同一个函数、同一个当前实例槽 | 无 | 入口级环 0;指向 event 内部文件的跨功能值边 5 → 0 | 不含 event 模块,不变 |
| D164 logging 剩 12 处 | 把「当前 root 那套机器」从入口文件搬进兄弟 `logging-runtime-root.ts`(入口只转交,与 event-current 同一个药方),**无副作用的函数面**(宿主端口表、`resolveLevelSpec`、`writeAppLog`、`setLogLevelSpec` / `getLogLevelSpec`、`applyDiagnosticsMode`)都写在这只兄弟的当前 root 上、经入口交出;**装配期才建的状态**(`root` / 内存环 / 文件 sink / 管家 / 崩溃钩子 / console 劫持,以及 `configureLogging` / `shutdownAppLogging` / `getAppLogPath` / `getRootLogger` / `ConfigureLoggingOptions`)留在 `logging-configure.ts`,并把它**登记为功能的装配入口**(与 client-api 同类的第二入口,用新旗子 `configureEntry`,只许 L4 与 apps 引) | 10 处改引入口(`writeAppLog` ×4、`applyDiagnosticsMode` ×2、宿主端口表 1,以及 `backend.ts` 那行里 configure 之外的名字),**5 处**留在装配入口且全是 L4 / apps(`backend.ts`、`http-server-runtime.ts`、CLI 守护、`onething mcp`、独立 server) | 接线**之前**调 `writeAppLog` 的记录落入口侧的 200 条兜底环而不是 configure 的 400 条环 —— 那 400 条环在产品里没有读者(`dumpRecentLogRecords` 非测试读者 0,桌面崩溃现场读的是入口那只);四个调用点都在装配之后才跑。其余逐字相同:`configureLogging` 第一句就把当前 root 指到自己那只,之后两边是同一个对象 | 无 | 入口级环 0;指向 logging 内部文件的跨功能值边 10 → 1(`backend.ts` → 装配入口,L4,登记槽位后不计);顺手消掉 `logging-configure` / `logging-diagnostics` 两只引自家入口的 D126 违例 | **按真实布局(三只新兄弟 + 入口转交)实测 1276500 → 1276513 字节**,diff 只有一行:esbuild 的源文件路径注释 `// …/logging.ts` 变成 `// …/logging-runtime-root.ts`,代码零增量;对照:入口再导出 configure +4182,去掉 storage 引用后再导出仍 +2643 |
| 顺带:agent-loop 入口 687 个名字 | 判据 = D166 已有的那条:只交「功能外非测试读者经入口真在用的名字」;按语法树实数:687 里包内非测试读者在用 272,只有测试在用 109,没人经入口要 306 | — | 无 | 无 | — | — |

下面每件把改法、依据、读者对照、测试清单、风险逐一写清。

## 1. D170 toolkit:四只「引上层」的文件

### 1.1 今天的事实(`deep-edges.mjs - toolkit`,值边口径)

```
resource/resource-music-provider.ts        -> toolkit/toolkit-adapters.ts
tool/tool-client-api.ts                    -> toolkit/toolkit-tool-ports.ts
backend.ts                                 -> toolkit/toolkit-audit-sink.ts
backend.ts                                 -> toolkit/toolkit-wiring.ts
engine/stream/engine-stream-tool-execution -> toolkit/toolkit-wiring.ts
acp/acp-fs-bridge.ts                       -> toolkit/toolkit-audit-sink.ts
(+ external-agent-host-tools 的动态 import('…/toolkit-wiring'),值图不记)
```

四只文件各自的上层边,逐只核过:

- `toolkit-wiring.ts`(373 行)只有两条上层边:`plugin/plugin-tool-call-intercept-bound` 与 `plugin-tool-result-intercept-bound`,
  用在 `runPreparedTool` 里拼出的那个 `Interceptor`(`beforePlan` 跑工具调用拦截链、`afterApply` 跑结果拦截链)。其余引用全是 toolkit 兄弟、
  session 入口、logging 入口、包根槽位 `backend-current`。
- `toolkit-audit-sink.ts`(90 行)只有一条上层边:`resource/resource-api` 里的常量 `NO_ORIGIN_SESSION`(声明在 `resource-kernel.ts:145`,值是
  `'@no-origin'`,意思是「这次调用不是从任何会话发起」)。其余是 session 入口(`appendSessionEvent`)、storage 入口、toolkit 兄弟。
- `toolkit-tool-ports.ts`(111 行)是一只再导出桶,交出 75 个名字,其中 `tool-client-api.ts` 只用 2 个(`runToolkitToolDirectly`、
  `toolkitCatalogToolDefinitions`),另有一只测试整块替换它。它把 `toolkit-wiring`、`toolkit-audit-sink`、`toolkit-adapters` 三只都再导出了,
  所以谁引它谁就把上层拖进来。它就是 D170 说的「第二个入口」。
- `toolkit-adapters.ts`(约 130 行)是七只适配器工厂:`webSearchAdapters` / `webOpenAdapters`(只依赖 settings 与 tool)、`goalAdapters`
  (goal 入口 + `goal-manager`)、`taskPorts`(`task-dispatch`)、`askUserAdapters`(interaction 入口 + `interaction-no-human` + 包根槽位)、
  `practiceAdapters`(`practice-service-slot`)、`radioAdapters`(`music-access`)。读者只有 `toolkit-tier-catalogs`(造工具时递进去)与
  `resource-music-provider`(只要 `radioAdapters`)。

### 1.2 决定

**(a) 插件拦截改成端口,`toolkit-wiring` 不再认识 plugin。**
`buildToolkitCatalog(tier)` 改成 `buildToolkitCatalog(tier, { adapters, interceptor })`。端口**只替换两次调用**:`toolkit-wiring.ts` 里那只
`PluginInterceptor` 类的 `beforePlan` 调 `runPluginToolCallIntercept(...)`、`afterApply` 调 `runPluginToolResultIntercept(...)` 的两行,
改成调端口的 `beforeCall(input)` / `afterResult(input)`,端口的两个函数签名与这两只 bound 函数逐字相同;那只类其余的东西
(`currentInput` 记账、`projector.track`、fail-closed 的措辞、`toolResultView`)一个字不动、留在 wiring。端口对象存进 `toolkit-wiring.ts`
已有的那只 `built` 变量(`built = { catalog, tier, adapters, interceptor }`),**不新开模块级 `let`**(`assembly:gate` 对 `toolkit-wiring.ts`
的额度是 2,今天已用满)。plugin 那边新建 `plugin/plugin-tool-interceptor.ts`,把两只 bound 函数原样装进这个形状,经 plugin 入口交出;
`backend.ts` 在造目录那一步把它递进去。端口缺省 = 不拦截。
依据:CLAUDE.md 文件头的法(「凡按能力枚举的地方改成能力自述、别人读表」),以及 `runtime/engine/ports.ts` 五个可选端口的先例
(「缺席的端口 = 这个能力不存在,而不是替代实现」)。

**(b) `NO_ORIGIN_SESSION` 搬进 shared,`toolkit-audit-sink` 不再认识 resource。**
它是 `Invocation.sessionId` 的保留坐标,是契约值不是 resource 的逻辑;`packages/shared/ipc/resources.ts` 的注释里已经点名这只 sink。
新家:`packages/shared/toolkit/no-origin-session.ts`(`shared/toolkit/` 已有 `effects.ts`)。`resource-kernel.ts` 改从 shared 引并照旧由
`resource-api` 再导出(resource 的读者一个字不动);`toolkit-audit-sink.ts` 改引 shared。之后它的边只剩 session / storage / toolkit,
session → toolkit 的唯一值边在 `session/testing/`(测试夹具,不入图),所以入口交出它不成环 —— 模拟器 `sT-A.json` 证实。

**(c) 删掉 `toolkit-tool-ports.ts`。**
`tool-client-api.ts` 的两个名字改从 toolkit 入口拿;它的测试 `tool-client-api.test.ts:46` 的
`vi.mock('@onething/backend/toolkit/toolkit-tool-ports', () => toolkit)` 改成 D173 式
`vi.mock('@onething/backend/toolkit', async importOriginal => ({ ...await importOriginal(), ...toolkit }))`,断言不动。
75 个名字里凡 toolkit 入口还没交出而 tool-client-api 之外有人要的,逐个核一遍(按 1.1 的读者表,没有)。`package.json` exports 删一把键。

**(d) `toolkit-adapters.ts` 拆开回家,toolkit 不再认识 goal / practice / task / music / interaction。**
依据是越层清零 A1 的先例(协作四只工具连同适配器搬回 `collab/tools/`,由 `registerCollabTools` 在装配时登记),
以及 R5(读 toolkit 不必先读 goal 的内部文件)。七只工厂的去处:

| 工厂 | 新家 | 经谁交出 | 为什么 |
| --- | --- | --- | --- |
| `goalAdapters` | `goal/goal-tool-adapters.ts` | goal 入口 | 它绑的是 goal 的 store 与 `goal-manager`。**前提**:`goal-manager.ts` 今天从自家入口 `@onething/backend/goal` 引 11 个名字(D126 的违例),改引兄弟 `goal-state.js` / `goal-records.js`,否则 goal 入口交出 `goal-manager` 就成 `goal.ts ↔ goal-manager.ts` 两只环(第一轮模拟抓到) |
| `practiceAdapters` | `practice/practice-tool-adapters.ts` | practice 入口 | 只依赖 `practice-service-slot` |
| `radioAdapters` | `music/music-tool-adapters.ts` | music 入口 | 只依赖 `music-access`;`resource-music-provider.ts:110` 改引 music 入口(resource → music 的边已有 4 条) |
| `taskPorts` | `task/task-tool-adapters.ts` | **不经 task 入口**,`backend.ts` 直接引 | task 入口一交出 `task-dispatch`,闭包就经 `plugin-session-messenger → plugin-contract → plugin-api-builder → toolkit 入口 → toolkit-tier-catalogs → toolkit-builtin-task → task 入口` 成 9 只环(`sT-toolkit.json` 第二轮);把 `deliverInternalMessage` 从 plugin 搬去 session 的另一条路(`sT-B.json`)模拟出 **43 只**的环(session 入口闭包吞进 permission / agent / music / file),否决。所以这只适配器是 D170 原话「装配处直接引」的那一类:task 的深层引用由 2 变 1,留账给 task |
| `askUserAdapters` | 留 toolkit,改名 `toolkit-ask-user-adapters.ts` | toolkit 入口 | 它绑的是 interaction 登记表 + 「房里有没有人类」+ 当前实例。它**不能**住 interaction:`session-permission-events.ts` 要 `Interaction.setRecorder`(session → interaction 值边),而 `interaction-no-human.ts` 读 `getSession`(interaction → session),interaction 入口一交出它就是 4 只环(第一轮模拟抓到)。解法见下一条 |
| `webSearchAdapters` / `webOpenAdapters` | 留 toolkit,改名 `toolkit-web-adapters.ts` | toolkit 入口 | 只依赖 settings 与 tool,本来就不引上层 |

两条「会话长什么样」的判据顺手下沉 session(与越层清零单 5–6「会话种类判据下沉 session」同一条规矩):
- `isTaskSession(session)`(`task/task.ts:66`,就是 `Boolean(session?.task && typeof session.task === 'object')`)与 `TaskSessionLike` 搬进
  session(放在 `resolveCollabVenue` 旁边),task 入口原样再导出(task 自己的两处读者不改说明符),`toolkit-scene.ts:20` 改从 session 入口拿 ——
  这一条是 toolkit → task 唯一的值边,也是第二轮模拟那个 9 只环的一半。
- `noHumanInTheRoom(sessionId)` 与 `NO_HUMAN_DECLINE_REASON`(`interaction/interaction-no-human.ts`,43 行,只读 `getSession` 与
  `isAgentPairDmRoom`,两者都在 session)搬进 session(`session/session-room-presence.ts`,「这间房里有没有人类」),`interaction-no-human.ts` 删掉。
  三个读者改引 session 入口:`toolkit-ask-user-adapters`、`external-agent-connector-registry.ts:17`、`acp-elicitation-bridge.ts:44`。
  指向 interaction 内部文件的跨功能值边 4 → 0(`deep-edges.mjs sT-A.json interaction` 为空)。
- `backend.ts` 直接引 `task/task-tool-adapters.ts` 走包说明符,`package.json` exports 要**加**一把键 `./task/task-tool-adapters`(与删掉的
  `./toolkit/toolkit-adapters` 对冲)。

适配器怎么到工具手里:`createCatalogForTier(tier, adapters)` 多一个参数,`ToolkitBuiltinAdapters` 的形状声明在 `toolkit-tier-catalogs.ts`
(`{ goal, practice, task, radio, askUser?, webSearch?, webOpen? }`,后三只有 toolkit 自己的缺省)。`backend.ts` 在造目录那一行组这个对象:
`{ goal: goalToolAdapters(), practice: practiceToolAdapters(), task: taskToolPorts(), radio: musicRadioAdapters() }`。
端口类型(`GoalToolAdapters` 等)仍声明在 `toolkit/builtin/*`,四只新家文件对它们只做类型引用(`import type`,不入值图)。

**(e) 入口交出:** `buildToolkitCatalog` / `getOrBuildToolkitCatalog` / `refreshToolkitMcpTools` / `resetToolkitCatalogForTests` /
`runToolkitToolDirectly` / `ToolkitDirectContext` / `ToolkitInterceptor`(新) 来自 `toolkit-wiring.ts`;`toolkitAuditSink` 来自
`toolkit-audit-sink.ts`;`askUserAdapters` / `webSearchAdapters` / `webOpenAdapters` / `ToolkitBuiltinAdapters` 来自两只留下的适配器文件。
文件头按 R3 补一组「装配用的接线」。`package.json` exports:`./toolkit/toolkit-tool-ports`、`./toolkit/toolkit-adapters` 两把随文件一起删
(引它们的 4 只测试 —— `tool-client-api`、`practice-lifecycle`、`music-lifecycle` 各 1、另 1 —— 本来就要随文件改:前者改打入口,后两只改引 practice / music 入口的新适配器);
`./toolkit/toolkit-audit-sink` 没有测试在用、删;`./toolkit/toolkit-wiring` 有 3 处测试在用(`tool-client-api-cancellation.test.ts` 的
`typeof import()` 与动态 `import()`、`external-agent-host-tools.test.ts:81` 的桩),照 D159 保留 —— 在内部文件上打的桩经入口转交照样拦得住(D173),
那几只测试不必为删键而改。

### 1.3 读者对照(7 处 → 0)

| 读者 | 今天 | 改后 |
| --- | --- | --- |
| `backend.ts:113` | `toolkit/toolkit-wiring` 的 `buildToolkitCatalog` / `refreshToolkitMcpTools` | toolkit 入口;多传 `{ adapters, interceptor }` |
| `backend.ts:121` | `toolkit/toolkit-audit-sink` 的 `toolkitAuditSink` | toolkit 入口 |
| `acp/acp-fs-bridge.ts:38` | 同上 | toolkit 入口 |
| `engine/stream/engine-stream-tool-execution.ts:33` | `toolkit/toolkit-wiring` 的 `runToolkitToolDirectly` | toolkit 入口 |
| `external-agent/external-agent-host-tools.ts:75` | `await import('@onething/backend/toolkit/toolkit-wiring')` | `await import('@onething/backend/toolkit')`(仍是动态 import,原因不变) |
| `resource/resource-music-provider.ts:110` | `../toolkit/toolkit-adapters.js` 的 `radioAdapters` | music 入口的 `musicRadioAdapters` |
| `tool/tool-client-api.ts:86` | `toolkit/toolkit-tool-ports` 两个名字 | toolkit 入口 |

### 1.4 要动的测试(实数)

引这四只文件的测试文件 7 只(`grep -rl`),其中打桩 2 只:`external-agent-host-tools.test.ts:81`(桩 `toolkit-wiring`,改打入口、
`importOriginal` 展开)、`tool-client-api.test.ts:46`(见上);其余 5 只只换说明符。另有 2 只测试直接调 `createCatalogForTier` /
`buildToolkitCatalog`(`grep -rl` 实数),随新参数各补一个夹具适配器对象(四只工厂的夹具版,几行)。
新建的文件(`toolkit-ask-user-adapters` / `toolkit-web-adapters` / `plugin-tool-interceptor` / 四只回家的适配器文件)从头守 D126:只引兄弟,
不引自家入口;`toolkit-wiring` / `toolkit-audit-sink` 今天就没有引 `./toolkit.js`(核过)。

### 1.5 可感知行为变化(列给用户,不替用户拍)

1. **没有装配 plugin 的进程**(React 壳今天就不装插件管理器;独立 server;CLI 守护)里,工具调用不再经过两条空的拦截链。
   今天这两条链在没有任何插件登记钩子时直接放行,结果与「不拦截」逐字相同;只是从「跑一遍空链」变成「不跑」。
2. `getOrBuildToolkitCatalog()` 的兜底(没人调过 `buildToolkitCatalog` 时自建一份 `'full'` 目录)拿不到四只回家的适配器,
   兜底目录里就没有 goal / practice / task / radio 四只工具(日志一行说明)。三个生产宿主都经 `backend.ts` 的正路建目录,碰不到兜底;
   兜底今天服务的是测试与「RPC 直调的轻量进程」。若要逐字保持,可让兜底也从当前实例取(四只新家文件都只在调用时读当前实例),
   代价是 toolkit 又要认识那四个功能 —— 不推荐。
3. `noHumanInTheRoom` 换了家、名字不变,行为逐字相同。

### 1.6 模拟器读数

- HEAD:`跨功能值边 1891;低层引高层 0;入口级环 0;深层值引用(非测试) 358`。
- `sT-A.json`:`跨功能值边 1885;低层引高层 0 条;入口级环 0 个;深层值引用 346`;`deep-edges.mjs sT-A.json toolkit task` → toolkit 空,task 只剩 `backend.ts -> task/task-dispatch.ts`(代表新文件 `task-tool-adapters.ts`)。
- 被否决的两条路都留了场景:第一轮(四只适配器全经各自入口交出)3 个环(task/toolkit 14 只、interaction/session 4 只、goal 2 只);`sT-B.json`(把内部投递搬去 session)1 个 43 只的环。

## 2. D172 event:同名不同物与访问器环

### 2.1 事实

- 泛型基类:`event-bus.ts` 的 `EventBus<TMessage, TGlobal>`、`event-stream-channel.ts` 的 `StreamChannel<TChunk>`、`event-ring-buffer.ts` 的
  `RingBuffer<TEvent>`,经 `event-bus-primitives.ts` 桶交出。会话子类:`event-session-bus.ts` 等三只,**类体为空**(只固定类型参数),入口交出的是它们。
- 要基类的读者(值边,`deep-edges.mjs - event`):`http-server-runtime.ts:44`(`EventBus<AgentEngineSessionEvent>` 与
  `class ServerStreamChannel extends StreamChannel<AgentEngineStreamChunk>` —— 真用泛型)、`agent/agent-engine.ts:3-4`(`new EventBus<AgentEngineSessionEvent>()`)。
  只要类型的:`session-manager` / `-lifecycle` / `-subscriber` 六处 `EventBus<any, any>` / `StreamChannel<any>`,`session-client-api-live-delivery.ts:2`
  的 `Pick<EventBus<AgentEngineSessionEvent>, …>`。
- `AgentEngine`:全仓非测试没有一处 `new AgentEngine(`,只剩 `agent/agent.ts:55` 的再导出 —— 疑为死码,**记为候选、本单不删**。
- 访问器环:`getStreamChannel` 声明在入口,`event-tool-progress-stream.ts` / `event-ui-stream.ts` 引入口(D126 例外),所以入口不能再交出它们。
  三只直接测这两只文件的测试(`event-ui-stream.test`、`event-tool-progress-stream.test`、`tool-progress-not-in-ledger.test`)**都没有打桩**,
  用的是真 `createEventSystem()` + 真访问器。35 只在 event 入口上 `vi.mock` 的测试里,替换了 `getStreamChannel` 的只有 4 只
  (`assemble-engine-gateway-session`、`service-tts`、`agent-loop-stream-integration`、`session-client-api`)。

### 2.2 决定

**① 基类改名,子类保留。** `EventBus<T,G>` → `GenericEventBus`,`StreamChannel<T>` → `GenericStreamChannel`,`RingBuffer<T>` → `GenericRingBuffer`。
为什么是这三个名字:不用仓里现有的 `CoreEventBus` 别名,因为 R2 禁层字眼、N4 把 `core` 列为泛名;也不用 `EventBusBase`,因为入口今天已经交出
事件的基本形状 `EventBase`(类型),`EventBase` 与 `EventBusBase` 并排只差中间三个字母,正是 R2「读者一眼分清」要防的;「Generic」说的是这三只
的真正区别 —— 它们带自己的消息类型参数,会话子类则把参数钉死 —— 而且三个名字在入口列表里排在一起、离 `EventBase` 很远。
文件名不动(已全包唯一)。入口按两组交出:「会话总线与通道的类」(`EventBus` / `StreamChannel` / `RingBuffer`)与「泛型基类(自带消息类型时才用)」
(三只 `Generic*`)。读者:`http-server-runtime`、`agent-engine`、`live-delivery` 改用 `Generic*`(经入口);session 三只把 `EventBus<any, any>` 改成入口的
会话 `EventBus`(装配递进来的本来就是它:`backend.ts:836` 的 `createSessionLayer(eventBus, streamChannel)` 递的是 `createEventSystem()` 造的会话总线,
`session-testing-*` 两只夹具同样;`http-server-runtime` 不调会话层,它那只 `GenericEventBus<AgentEngineSessionEvent>` 不会递进来 —— 所以去掉 `any`
是纯收益,tsc 不会红,零运行时变化)。`event-bus-primitives.ts` 保留为目录内部桶(三只会话子类文件在引),
文件头写明「只给本目录用」。exports 键:`./event/event-bus` / `./event/event-stream-channel` 两把没有测试在用、读者改走入口后删;
`./event/event-bus-primitives` **保留** —— 四只目录内部文件(`event-session-bus` / `-stream-channel` / `-ring-buffer` / `-bus-types`)用的是包说明符,
另有 8 只测试在引它(`session-event-broadcast`、`core-session-lifecycle`、`http-server-*` 三只、`gateway-onething-runtime` 等),
D159 的规矩是测试还在用的键不删;若要删,先把四只内部文件改成相对路径(D171 给 storage 入口自引用改相对路径的先例)并把 8 只测试改走入口,另起一笔。

**② 访问器搬进 `event-current.ts`。** `createEventSystem` / `getEventBus` / `getStreamChannel` / `isEventSystemInitialized` 四只搬过去,
入口原样转交(名字不变);两只流文件改引 `./event-current.js`;入口再交出 `pushSessionToolProgress` / `isToolProgressStreamEnabled` /
`pushSessionUiStreamEvent` / `isUiEventStreamEnabled` / `onethingUiStreamMode` 与它们的类型;`engine-stream-tool-execution.ts:34`、
`engine-agent-loop-executor.ts:24` 改引入口。exports:`./event/event-ui-stream` 没有测试在用、删;`./event/event-tool-progress-stream` 有 1 只测试
(`tool-progress-not-in-ledger.test.ts`)在用,照 D159 保留或随那只测试一起改走入口;`./event/event-current` 不加(两只兄弟相对路径引,
只有测试要打桩时才需要键)。

不选「两只流文件改收 channel 参数」:`pushSessionToolProgress` 的契约是「事件系统没装配也不打断这次工具调用」(内部 try/catch),改成由调用方解析
channel 就把这层兜底推给了 engine,两处调用点都要补 try/catch,得不偿失。

### 2.3 测试代价(实数,不是 D172 写的 36)

入口上的桩拦得住所有经入口的读者,搬家后只有两只流文件绕开它。受影响的测试 = 替换了入口 `getStreamChannel` **且**执行路径到达这两只文件的:
候选只有 `agent-loop-stream-integration.test.ts:231`(engine 执行器,`ONETHING_UI_STREAM=events` 时才到 `event-ui-stream`;工具报进度时才到
`event-tool-progress-stream`)与 `assemble-engine-gateway-session.test.ts:41`。最坏情况两只各加一行把 `event-current` 也打上同一只桩;
`service-tts`、`session-client-api` 不经过这两只文件,零改动。三只直接测流文件的测试零改动(它们用真访问器)。

### 2.4 读者对照(12 处 → 0)

| 读者 | 今天 | 改后 |
| --- | --- | --- |
| `http-server-runtime.ts:44` | `event-bus-primitives` 的 `EventBus` / `StreamChannel`(基类) | 入口的 `GenericEventBus` / `GenericStreamChannel` |
| `agent/agent-engine.ts:3-4` | `event-bus` / `event-stream-channel` 的基类 | 入口的 `Generic*` |
| `session-client-api-live-delivery.ts:2` | `event-bus-primitives` 的 `EventBus` 类型 | 入口的 `GenericEventBus` 类型 |
| `session-manager.ts:12-13`、`session-lifecycle.ts:1-2`、`session-subscriber.ts:16-17` | `event-bus` / `event-stream-channel` 的基类类型(`<any, any>`) | 入口的会话 `EventBus` / `StreamChannel` |
| `engine-stream-tool-execution.ts:34` | `event-tool-progress-stream` | 入口 |
| `engine-agent-loop-executor.ts:24` | `event-ui-stream` | 入口 |

### 2.5 模拟器读数

`sE-event.json`:`跨功能值边 1891;低层引高层 0;入口级环 0;深层值引用 353`;`deep-edges.mjs sE-event.json event` → 空。Worker 不含 event 模块。

## 3. D164 logging:configure 怎么切

### 3.1 事实(实测)

`measure-worker.mjs`(产品同一份 `searchWorkerEsbuildOptions`,`write:false`,`onLoad` 插件在内存里换源文件;先打 HEAD 得基线):

| 变体 | Worker 字节 | 模块数 | logging+storage 模块 |
| --- | --- | --- | --- |
| HEAD | 1276500 | 198 | 11 |
| 入口再导出 configure 的接线 API(D155 复现) | 1280682(+4182) | 222 | 35(configure 本身 + 文件 sink / 管家 / 崩溃钩子 / 旧 console sink / 滚动文件 / 旧调试变量 + storage 17 只) |
| 同上,但 configure 去掉 storage 引用(logDir 由宿主传) | 1279143(+2643) | — | configure 自己那六只模块仍进来 |
| `writeAppLog` / `setLogLevelSpec` 写在入口的 currentRoot 上 | 1276500(0) | 198 | 11 |
| 宿主端口表作为纯槽经入口交出 | 1276500(0) | 198 | 11 |
| 诊断模式写在入口上(多引 `legacy-debug-env`) | 1276500(0) | 199 | 12(多的那只被摇掉,字节不变) |
| 以上三者合一 | 1276500(0) | 199 | 12 |

结论:**`configureLogging` 那半无论怎么标 PURE 都进 Worker(+2643 不是 storage 的锅,是 configure 自己那六只模块有顶层副作用);
函数面那半经入口交出 0 字节增量。** 所以切法不是「能不能全经入口」,而是「函数面经入口,装配面另立门」。

今天 `logging-configure.ts` 里的东西,按「有没有副作用 / 是不是装配期才建」分两堆:

| 无副作用的函数面(搬去入口侧) | 装配期才建的状态(留在 configure) |
| --- | --- |
| `AppLoggingHostPorts` + `configureAppLoggingHost` / `resetAppLoggingHost`(一个纯槽,被 `backend-host-ports.ts` 读) | `root` / `memoryRing`(模块求值时就 `new`)、`fileSink` / `legacyConsole` / `crashHooks` / `janitor` / `rendererConsoleCapture` / `exitHandler` / `activeLogDir` |
| `resolveLevelSpec`(只依赖 `legacy-debug-env`) | `configureLogging` / `initializeAppLogging` / `shutdownAppLogging` / `LoggingHandle` / `ConfigureLoggingOptions` |
| `writeAppLog`(`src` 恒为 `main`,直接 emit 一条记录) | `getAppLogDir` / `getAppLogPath`(要 storage 的 `getOnethingLogDir`) |
| `setLogLevelSpec` / `getLogLevelSpec` | `getRootLogger` / `dumpRecentLogRecords`(`onething mcp` 往这只 root 挂 stderr sink,D162) |
| `applyDiagnosticsMode`(`logging-diagnostics.ts`,只要 `setLogLevelSpec` + `resolveLevelSpec` + `setOnethingProviderRequestDumpEnabled`) | 六只机制模块的再导出(`JsonlFileSink` / `LegacyConsoleSink` / `LogDirJanitor` / `RollingFileLogger` / `installProcessCrashHooks` / `consolePort` …) |

### 3.2 决定

**(a) 先把「当前 root 那套机器」从入口文件搬进兄弟,再把函数面写在它上面,入口只转交。** 今天 `getLogger` / `currentRoot` /
`setRuntimeLoggerRoot` 都**声明在入口文件 `logging.ts` 里**,于是 `logging-diagnostics.ts:2` 与 `logging-configure.ts:17` 都在引自家入口
(两处现存的 D126 违例);入口若再交出 `applyDiagnosticsMode`,就是 `logging.ts → logging-diagnostics.ts → logging.ts` 的环 ——
与 D172-② 的 `event.ts ↔ event-ui-stream` 同一种病,药也同一种(event-current)。具体文件:
- 新建 `logging-runtime-root.ts`:从 `logging.ts` 整段剪过去 —— `fallbackRing` / `fallbackRoot` / `currentRoot` / `generation` /
  `setRuntimeLoggerRoot` / `getRuntimeLoggerRoot` / `dumpRuntimeLogRecords` / `DeferredLogger` / `getLogger` / `captureRuntimeLogs`,
  再加三只新函数:`writeAppLog(level, source, message, metadata)` = `currentRoot.emit({ …, src: 'main' })`;`setLogLevelSpec(spec)` =
  `currentRoot.setLevelSpec(spec)`;`getLogLevelSpec()`。`src: 'main'` 照旧写死(D164 说明过它不能换成 `getLogger`,那会让守护进程里的记录
  变成 `src: 'daemon'`)。scratchpad 里 `s27-logging-runtime-root.ts` 是上一轮同名的草稿,思路一致。
- 新建 `logging-host-ports.ts`:`AppLoggingHostPorts` / `RendererCaptureLogEntry` / `configureAppLoggingHost` / `resetAppLoggingHost` /
  `appLoggingHostPorts()`(读槽,给 configure 用)。`backend-host-ports.ts:41` 改引入口。
- 新建 `logging-level-spec.ts`:`resolveLevelSpec`(从 configure 剪过去,只引 `legacy-debug-env`)。
- `logging-diagnostics.ts` 改引兄弟 `./logging-runtime-root.js`(`setLogLevelSpec`、`getLogger`)与 `./logging-level-spec.js`,不再引入口、不再引 configure;
  入口交出 `applyDiagnosticsMode` / `isDiagnosticsModeApplied` / `resetDiagnosticsModeForTests`。`settings-store.ts:11` 与 `backend.ts:64` 改引入口。
  不改成订 `settings:changed`:`broadcastSettingsChanged` 只在 RPC 面(`settings-client-api.ts:173`)喊,`settings-store` 的两条 `saveSettings*`
  被程序化保存走得更多,换成订阅会漏。
- `logging.ts`(入口)只剩转交:上面三只兄弟的名字 + 今天已有的那组再导出。
- `logging-configure.ts` 删掉搬走的声明,改引兄弟 `./logging-runtime-root.js` / `./logging-host-ports.js` / `./logging-level-spec.js`(不再引入口),
  `writeAppLog` 等照旧原样转交给仍从 configure 拿它们的测试(`toBe` 钉同一个函数,与 D161 处理 `getLogger` 同法)。
- `assembly:gate`:`let hostPorts`(从 configure 搬到 host-ports)、`let currentRoot` / `let generation`(从入口搬到 runtime-root)总数不变,
  但那把尺子对「不在基线里的文件」判红(`compare()` 的 `isNewFile`),要**手改** `docs/audit/assembly-baseline-2026-09-02.txt`:
  老文件的行减、新文件的行加 —— 越层清零单 0–2(`8c4b9413b`)搬文件时就是这样改的,有先例;不跑 `--write-baseline`。

**(b) `logging-configure.ts` 登记为功能的「装配入口」。** 与 D26 的 client-api 同类机制,但**不能复用 `secondEntry` 旗子**:
`backend-structure.mjs:360` 断言 `secondEntry` 槽位最多一行。所以层次表 `slots` 加一行用新旗子
`{ "slot": "(装配入口)", "layer": "L4", "configureEntry": true, "why": "功能里装配期才建的状态与接线 API(<功能>-configure.ts),只许包根、http-server 与 apps 引" }`,
`backend-structure.mjs` 加 `CONFIGURE_ENTRY_PATTERN = /^packages\/backend\/([^/]+)\/\1-configure\.ts$/` 与 `configureEntryFeatureOf()`,
三处各认一次:`loadLayerTable` 的 `groupOf` 把它归到这个槽位、`entry:gate` 对它与 client-api 同样不计深层、`client-api:gate` 加一条
「谁可以引 `-configure.ts`:只许 L4(包根、http-server、两种第二入口槽位)与 `apps/`」。今天的五个读者全在这个范围内。
`./logging/logging-configure` 这把 exports 键保留;`./logging/logging-diagnostics` 删。
依据:行业里 `pino` 与 `pino/file`、`vitest` 与 `vitest/config` 这种「运行时 API」与「装配 API」分两个子路径的做法;而本仓库的硬线
「Worker 字节不许长」把这两半在物理上分开了(3.1 的 +2643 证明 configure 那半无论如何进不了入口),门只是把这个事实写成规则。

### 3.3 读者对照(12 处)

| 读者 | 要的名字 | 改后 |
| --- | --- | --- |
| `permission/permission-enforcement.ts:11`、`gateway-outbound-reply-dispatcher.ts:6`、`gateway-channel-session-router.ts:3`、`gateway-channel-identity-service.ts:5` | `writeAppLog` | logging 入口 |
| `settings/settings-store.ts:11`、`backend.ts:64` | `applyDiagnosticsMode` | logging 入口 |
| `backend-host-ports.ts:41` | `configureAppLoggingHost` / `resetAppLoggingHost` / `AppLoggingHostPorts` | logging 入口 |
| `backend.ts:150` | `configureLogging` / `shutdownAppLogging` / `ConfigureLoggingOptions` | 留在装配入口(L4) |
| `http-server-runtime.ts:66` | `ConfigureLoggingOptions`(类型) | 留在装配入口(L4) |
| `apps/cli/src/daemon-server.ts:17` | `configureLogging` | 留在装配入口(apps) |
| `apps/cli/src/mcp-command.ts:60` | `getRootLogger` | 留在装配入口(apps);D162 的做法一个字不动 |
| `apps/backend-server/src/main.ts:19` | `getAppLogPath` | 留在装配入口(apps) |

留在装配入口的是 5 处(`backend.ts`、`http-server-runtime.ts`、两只 CLI 命令、独立 server),没有一处在 L0–L3。

### 3.4 可感知行为变化(列给用户)

1. **接线之前**调 `writeAppLog` 的记录落入口的 200 条兜底环,不再落 configure 的 400 条环。两只环的记录今天都不落文件(D161 实测);
   400 条环的 `dumpRecentLogRecords` 非测试读者为 0(桌面崩溃现场 `electron/main.ts:595` 读的是入口的 `dumpRuntimeLogRecords`);
   四个调用点(网关三只、权限执行面)都在装配之后才跑。接线之后两边是同一个 root 对象(`configureLogging` 第一句 `setRuntimeLoggerRoot(root)`),记录逐字相同。
2. **接线之前**调 `setLogLevelSpec` 改的是兜底 root 的等级:今天改的是 configure 那只 root,但 `configureLogging` 一进来就
   `root.setLevelSpec(resolveLevelSpec(options.level))` 盖掉,所以今天接线前的调用本来也不生效;改后它只影响兜底环里接线前那几条记录的过滤。
   产品里 `applyDiagnosticsMode` 在 `assemble` 里设置加载之后才调,永远在接线之后。
3. `onething mcp`、独立 server、CLI 守护的接线一个字不动。

### 3.5 模拟器与 Worker

`sL-logging.json`:`跨功能值边 1887;低层引高层 0;入口级环 0;深层值引用 352`;`deep-edges.mjs sL-logging.json logging` → 只剩
`backend-host-ports.ts -> logging-configure.ts`(搬完宿主端口表后这条也没了)与 `backend.ts -> logging-configure.ts`,登记槽位后不计。
(功能内部的环模拟器不看,所以 3.2(a) 那条入口 ↔ diagnostics 的环是靠读代码抓的,不是靠它。)

Worker 两轮实测:第一轮 `measure-worker.mjs` 把函数面直接 append 进 `logging.ts`,六个变体里函数面那三个都是 1276500(0 增量);
第二轮 `measure-worker-sibling.mjs` 按 3.2(a) 的**真实布局**打(三只新兄弟用 esbuild 虚拟模块给出,diagnostics 改引兄弟,入口只转交):
**1276500 → 1276513**。把两份产物按 `;` 拆行 diff(`out-head.cjs` / `out-sibling.cjs`),差异只有一行 —— esbuild 的源文件路径注释
`// packages/backend/logging/logging.ts` 变成 `// packages/backend/logging/logging-runtime-root.ts`,13 个字符,代码零增量;
`measure-worker-sibling-bisect.mjs` 逐只去掉 host-ports / level-spec / diagnostics 的转交,字节不变,证明这 13 字节只来自那一行注释。
进 Worker 的 logging 模块 11 → 16(多的五只是 runtime-root、host-ports、level-spec、diagnostics、legacy-debug-env,后四只被摇空),storage 仍为 0 只。

## 4. 三件合在一起

`node sim2.mjs sT-A.json sE-event.json sL-logging.json`:`跨功能值边 1881;低层引高层 0 条 / 0 对;入口级环(真门口径) 0 个;原图 SCC 3/2(与 HEAD 相同);深层值引用(非测试) 358 → 333`。
`entry` 基线要手改的行:toolkit 26 → 19(非测试 7 → 0)、event 24 → 12(非测试 12 → 0)、logging 34 → 27(非测试 12 → 5,再随装配入口槽位登记降到 0)、
task(非测试 2 → 1,读者从 toolkit-adapters 换成 backend.ts)、interaction 4 → 0;具体数字以施工后 `entry:check` 为准,不跑 `--write-baseline`。
`assembly` 基线:logging 三只 `let` 搬家,老行减新行加(见 3.2(a));toolkit 不新增 `let`。

施工顺序(每步跑三套 tsc、`cycle` / `layer` / `name` / `entry` / `assembly` 门、两份 Worker 字节、全量 vitest 逐文件比对):
1. logging(最独立,Worker 读数是它的硬门)→ 2. event(改名 + 搬访问器,纯机械)→ 3. toolkit 前置两件(`isTaskSession` / `noHumanInTheRoom` 下沉、
`goal-manager` 改引兄弟)→ 4. toolkit 本体(端口、常量、删桶、适配器回家、入口交出)。装配入口槽位的门规则在第 1 步一起落。

## 5. 顺带:agent-loop 入口 687 个名字的瘦身判据

判据不用新发明,就是 D166 给四只 `export *` 入口改具名时用的那条,加 D39 一句:
**只交「功能外非测试读者经入口真在用的名字」;只有测试在用的名字不为测试进入口(测试改引内部文件);没人要的不交。**
按语法树实数(`agent-loop-usage.mjs`,含 `import type`、`typeof import()` 3 处、动态 import 解构):

| 口径 | 个数(值 / 类型) |
| --- | --- |
| 入口今天交出 | 687(296 / 391) |
| ① 包内非测试读者经入口在用 | **272**(121 / 151)—— 这是目标 |
| ② 只有 apps / scripts / evals 在用 | 0 |
| ③ 只有测试在用 | 109(103 / 6) |
| ④ 没有任何人经入口要 | 306(72 / 234),其中 `Core*` 前缀 185 |

做法:入口改成只列 ①(272 个,按今天的分组保留),③ 的 109 个让那些测试改引内部文件(与 D157 / D158 同法:桩打在哪只文件上不变),④ 直接删行。
顺手的观察:① 里 `Core*` 前缀 76 个、④ 里 185 个 —— 这批 `Core*` 名字是合包前 core 包的命名残留,等入口瘦到 272 之后再按 R2 / N2 批量去前缀
(另一笔,不与瘦身同批)。读者最集中的 8 只文件(`engine-agent-loop-stream-runtime` 54 个名字、`engine-agent-loop-executor` 27 …)就是审 ① 的入口。

## 6. 顺带记下、本单不动

- `agent/agent-engine.ts` 的 `AgentEngine` 全仓没有生产构造点,疑为死码;删它可让 event 基类的值读者只剩 `http-server-runtime`。
- `task-dispatch.ts:67` 引 `plugin/plugin-session-messenger` 的 `deliverInternalMessage`(N1 的跨会话信使住在 plugin,task 与装配层都在借用):
  它该有自己的家,但 `sT-B.json` 证明搬去 session 会成 43 只环,搬去 engine 又让 task(L2)引 L3。留待 engine 三层拍板时一起看。
- `toolkit-executions.ts:1` 引 `http-server/http-server-runtime-facade.js` 的类型(L2 引 L4 的类型位,值图不计),读起来仍扎眼。
- `goal-manager.ts` 引自家入口 11 个名字,是 D126 的现存违例;本单第 3 步顺手修。
