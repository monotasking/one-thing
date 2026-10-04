# 深层引用收口第四批停下的 58 处(按今天的图数 57):最终决定(s33,2026-10-04)

只读分析;仓库文件没动。证据脚本都在本目录:`sites.mjs`(逐处列今天的非测试深层引用)、`paths.mjs`(值图上的闭包与最短路)、
`build-scen.mjs` → `sIP.json` / `s33.json`(场景)、`sim2.mjs`(s31 的模拟器)。图是 `gen-graph.mjs` 按 `scripts/lib/backend-structure.mjs` 现算的 HEAD 值图(1586 文件 / 4745 边)。

## 0. 决策表

| # | 停下的地方 | 处数 | 决定(一句话) | 改法类型 | 可感知行为 | 装配顺序 | 要动的测试(实数) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | task(D181) | 2 | `deliverInternalMessage` 改成 `createTaskDispatchLayer(deps)` 的一格,由 backend.ts 把插件入口的那只函数递进去;入口里的纯口径搬进 `task-rules.ts`;入口交出派工层 | 端口注入 + 入口瘦身 | 无 | 无(910 行多递一个函数值,不在构造时调用) | 1(`task-dispatch.test.ts`:桩插件入口 → 直接递 deps) |
| 2 | interaction(D181) | 3 | 已在 `entry-leftovers` §1.2 决定:`noHumanInTheRoom` 下沉 session,三读者改引 session 入口;本单不另立 | 按方向搬家 | 无 | 无 | 0(那单已计) |
| 3a | permission(D181) | 1 | `session-permission-events.ts` 拆两只按方向搬家:`permission/permission-session-ledger.ts` + `interaction/interaction-session-ledger.ts`,各自入口交出 install/uninstall,backend.ts 各调一次;session 不再引 interaction | 按方向搬家 | 无 | 967 行一次调用变两次,相邻 | 0(该文件无测试) |
| 3b | permission(D182) | 1 | 纯策略那只改名 `evaluatePermissionPolicy`(`permission-policy.ts`),进程绑定那只保留 `decidePermission`;入口两只都交;`toolkit-authorizer` 改引入口 | 改名 | 无 | 无 | 1(`toolkit-client-api-self-evolution.test.ts` 桩 `permission-asks` 里的 `decidePermission` → 改桩 `permission-policy` 的 `evaluatePermissionPolicy`) |
| 4 | acp 3 + external-agent 7(D181/D182) | 10 | 方向定死「驱动 → 契约」:ACP 连接器 `external-agent-acp-connector.ts` 搬进 `acp/acp-connector.ts`;连接器登记表改成只读表,`bindExternalAgentConnectors({ connectors, sessionLinks })` 由 backend.ts 填;external-agent 入口交出登记表与 `resolveHostToolSurface`(异步那只);同步那只改名 `resolveHostToolIds`;`acp-host-mcp-bridge` 的 `resolveSurface` 经 `AcpSubsystem` deps 注入,动态缺省删掉;`acp-translate` 改引入口 | 搬家 + 读表 + 端口 | 无 | 651 行 `bindExternalAgentConnectors` 改收组好的表(表在同一行上方组;惰性 getter,见 §1.4);`AcpSubsystem` 多一格惰性函数 | 4 + 5(见 §9) |
| 5 | plugin 6 + deeplink 1(D181) | 7 | 新功能 `plugin-contract/`(L2):插件与宿主约定的词汇 —— 作用域/表面/严重度策略、熔断阈值、健康账、凭证策略与检索供给方两张登记契约(13 只文件,闭包里只有自己);三张登记表改引它的入口;`plugin-deep-link.ts` 回 deeplink 成 `deeplink-contract.ts`;确认卡的显示名随登记携带,deeplink 不再引 plugin;plugin-api 改引 deeplink 入口;`plugin/plugin-contract.ts` 这只 740 行的桶拆掉(名字也与新入口撞,`name:gate` 不许) | 按方向搬家(词汇下沉)+ 读表 | 一条待用户选:确认卡显示名改从登记表读(§1.5、§10) | 无 | 8 搬家 + 1 改桩 + 1 改引 + 41 改说明符(桶拆掉,工具机械做) |
| 6 | resource(D181) | 3 | `toolkit-audit-sink` 那处随 sT-A 已定(常量进 shared);`plugin-api-builder` / `plugin-resource-verbs` 改引 resource 入口 —— 模拟证明 task 端口落地后 resource 入口不再碰到 plugin | 改引入口 | 无 | 无 | 0 |
| 7 | mcp(D183) | 8 | 工具桥 11 个名字并进 `mcp.ts`,删 `mcp-index-with-bridge.ts` 与它的 exports 键;8 处读者改引入口;测试替身改打入口并展开真模块 | 删桶 | 无 | 无 | 11(7 只裸工厂 → `importOriginal` 展开 + 工厂;3 只只改说明符;1 只嵌套工厂同法) |
| 8 | gateway(D184) | 10 | 启动面搬出入口:`gateway-standalone.ts`(可 import 的 startGateway 一族)+ `gateway-standalone-main.ts`(只有 `main` 与主模块判断,谁都不许 import);入口交出装配要的 6 个名字;检查器两条断言改指 standalone 文件;`gateway-channel-session-router` 改引 session 入口 | 搬家 | 无(生产没人跑独立网关;守卫只是换了文件) | 无 | 2 + 1 + 检查器 2 处 |
| 9 | search(D185) | 2 | 脱敏三名字进入口,`scripts/lib/search-corpus-redact.mjs` 改从入口再导出(四个读者路径不改);`scripts/gate-*/` 作为「门的被测产物入口」按规则不计(与构建配方同类) | 入口交出 + 规则 | 无 | 无 | 0 |
| 10 | collab(D186) | 7 | 6 处运维脚本改走 collab 入口(入口补 ~20 个纯规则名;实测 bun 装入口 242 ms);`permission-enforcement` 的 30 分钟提醒改发全局事件 `permission:ask-stale`,collab 在 backend.ts 装一只监听器把它写进房间 | 入口交出 + 事件 | 无(监听器无条件装) | afterEngine 多一只 own() 的订阅 | 0 现存;建议补 1 |
| 11 | variable(D178/D186) | 1 | `MusicSubsystem` 选项多一格惰性端口 `variables.listForSession`,backend.ts 填 `() => getVariableRegistry().list(...)`;music 不再引 variable | 端口注入 | 无 | 697 行多递一个惰性函数(构造时不取值,注册表那时还没建) | 1(`radio-authorization.test.ts`) |
| 12 | eval(D186) | 1 | eval 入口交出 `createIncidentForTurn`;命令文件只剩一次 `import('@onething/backend/eval')`;测试两只裸工厂并成一只 | 入口交出 | 无 | 无 | 1(2 处桩合 1) |
| 13 | project-dir(D182) | 2 | 两只改名说清差别:`buildProjectDirsPromptVarsForSpace`(prompt.ts,按空间)/ `buildProjectDirsPromptVarsForSession`(bootstrap,按会话);入口两只都交;引擎两读者改引入口 | 改名 | 无 | 无 | 6(机械改名) |
| 14 | session | 2 | 路由那处随 #8;`session-events-codec.ts` 搬到 `packages/shared/session/events/codec.ts`(它的 `types.ts` 本来就住那里,闭包只有 shared) | 按方向搬家 | 无 | 无 | 0 |
| 15 | entry:gate | — | 非测试部分改零基线硬闸:判据「引用方不是测试、也不在 `scripts/gate-*/`」;测试部分仍只减不增 | 门 | — | — | — |

**91 vs 58 的对账**:今天 `sites.mjs` 数出非测试 91 处;其中 34 处属施工中四家(logging 12 / event 12 / toolkit 7 / interaction 3,`toolkit-adapters:34` 读 `interaction-no-human` 那条算在 interaction 里),余 **57** 处是本单的(gateway 10 / mcp 8 / external-agent 7 / collab 7 / plugin 6 / acp 3 / resource 3 / task 2 / project-dir 2 / session 2 / permission 2 / search 2 / variable 1 / deeplink 1 / eval 1)。第四批记的 58 比这多 1,差的就是 interaction 那条被两边各数了一次;本文按 57 处决定,interaction 的 3 处只引用上一份决定。施工中四家按 `entry-leftovers` 那份决定归零(logging 最后 2 处靠那份 §3 的 `configureEntry` 装配入口槽位,门按类不计)。

## 1. D181 环:逐个说卡在哪条边、怎么拆

### 1.1 task(2 处)
卡的边:`task-dispatch.ts → @onething/backend/plugin`(只要 `deliverInternalMessage` 一个名字)。插件入口的闭包经 `plugin-contract 桶 → plugin-api-builder → toolkit 入口 → builtin/toolkit-builtin-task → task 入口`,所以 task 入口一交出派工层就是环。
另一半病:`task-dispatch.ts:54` 引自家入口拿 `TASK_*` 常量(D126 违例),入口里放着实现。
改法:
- `task/task-rules.ts`:把 `task.ts` 里的常量、`isTaskSession`(假设:toolkit 那家按 `entry-leftovers` 把它下沉 session,下沉后这里只再导出;若那家没下沉,`task-rules.ts` 自己持有它、`toolkit-scene.ts:20` 继续引 task 入口 —— `toolkit.ts → task.ts` 这条边本来就在模拟里,两种落法本单的环证明相同)、`sessionHiddenToolIds`、`describeTaskRejection`、`renderTaskReport`、`taskSessionName` 整段剪过去;`task.ts` 只剩转交。`task-dispatch.ts` 改引 `./task-rules.js`。
- `createTaskDispatchLayer(deps)` 多一格 `deliverInternalMessage: typeof deliverInternalMessage`(类型从插件入口 `import type`,不入值图);216 行改调 `deps.deliverInternalMessage(...)`。backend.ts 910 行递 `deliverInternalMessage`(它本来就静态引插件入口)。
- 入口交出 `createTaskDispatchLayer` / `dispatchTask` / `runningTaskCount` / `TaskDispatchLayer`;backend.ts 改引入口。D170 给 `task-tool-adapters.ts` 定的「backend.ts 直接引,不经入口」那条例外随之作废 —— 那只适配器也经入口交出(环的病根已拆)。
模拟:`task-dispatch` 剩下的值依赖是 session / agent-loop / logging / backend-current(全是 `import type`)/ shared;`session.ts → task.ts` 无路、`agent-loop.ts → toolkit.ts` 无路,所以 toolkit → task 入口 → 派工层不回头。

### 1.2 interaction(3 处)
已在 `docs/design/entry-leftovers-toolkit-event-logging-2026-10.md` §1.2 决定并在施工:`noHumanInTheRoom` / `NO_HUMAN_DECLINE_REASON` 搬进 `session/session-room-presence.ts`,`toolkit-ask-user-adapters`、`external-agent-connector-registry:14`、`acp-elicitation-bridge:44` 改引 session 入口;`interaction-no-human.ts` 删掉。做完 interaction 入口闭包只有 logging + shared(15 只文件),是真叶子。

### 1.3 permission(1 处)
卡的边:`session/session-permission-events.ts` 要 `Permission.setRecorder`(permission-asks 里的核心命名空间),而 permission 入口经 `permission-enforcement → session 入口 → session-permission-events`,所以它不能改引 permission 入口。
真相:这只文件是「把权限问答与交互问答记进会话账本」,它属于记账的那一方,不属于 session。
改法:拆两只、各回各家:
- `permission/permission-session-ledger.ts`:`Permission.setRecorder(...)` 那半,引 session 入口的 `writeSessionEvent` / `currentSessionRunId`(都已在入口上);permission 入口交出 `installPermissionSessionLedger` / `uninstallPermissionSessionLedger`。
- `interaction/interaction-session-ledger.ts`:`Interaction.setRecorder(...)` 那半,同样引 session 入口;interaction 入口交出一对。
- backend.ts 967/973 行改成两次调用、两次 own()。session 入口删掉那两行再导出;`session → interaction` 这条边消失(今天 session 入口闭包里 interaction 2 只就是它)。
为什么不是合在一只里搬进 permission:那样是「permission 替 interaction 装记录器」,R2 口径下读者要先知道这层代办关系。
方向核对:permission → session 本来就有(enforcement 读会话);interaction → session 是新边,`session.ts → interaction.ts` 搬完后无路,不成环。

### 1.4 acp(3 处)+ external-agent(7 处)
今天两家互相引:external-agent 的 `external-agent-acp-connector.ts` 引 acp 三只内部文件,登记表 `external-agent-connector-registry.ts` 引 acp 入口(`ACPManager`、`createAcpHostMcpPort`)并写死 `[ACP_CONNECTOR_ID]: createAcpConnector(...)`;反过来 acp 的 6 只文件引 external-agent 入口(权限效果描述、启动环境、文本 diff、两个类型)。登记表没被入口交出,所以今天不红;一交出就是 `external-agent.ts → 登记表 → acp.ts → acp-permission-bridge → external-agent.ts`。
定方向:**external-agent 是契约(连接器形状、登记表、宿主工具面、权限效果、diff),acp 是它的一种驱动。驱动引契约,契约永远不写驱动的名字。**
改法:
- `git mv external-agent/external-agent-acp-connector.ts acp/acp-connector.ts`(它引的 `acp-manager` / `acp-session-links` / `acp-translate` 变兄弟;它引的 `ExternalAgentConnector` 等类型从 external-agent 入口拿);acp 入口交出 `createAcpConnector` / `capabilitiesFromHandshake`(`ACP_CONNECTOR_ID` 已在)。它的测试同名搬到 `acp/__tests__/acp-connector.test.ts`。
- 登记表改读表:`bindExternalAgentConnectors({ isAccepting, connectors, sessionLinks })` —— `connectors` 是 `Record<connectorId, ExternalAgentConnector>`,`sessionLinks` 是惰性 getter `() => ExternalAgentSessionLinkStore`(今天 37–45 行直接摸 `ACPManager.getSessionLinkStore()`)。backend.ts 651 行上方组表:`{ [ACP_CONNECTOR_ID]: createAcpConnector({ hostMcp: createAcpHostMcpPort() }) }`、`sessionLinks: () => ACPManager.getSessionLinkStore()`(都从 acp 入口拿,backend.ts 本来就引 acp 入口)。顺序依据:`AcpSubsystem` 在 1224 行才构造,晚于 651 行;今天登记表自己在绑定时也是这样先建连接器(`createAcpHostMcpPort` 的 bridge 是惰性读当前实例),`sessionLinks` 是惰性 getter 且 `ACPManager.getSessionLinkStore()` 是静态访问器 —— 所以「装配顺序不动」靠的是惰性 + 静态访问器,不是子系统已先建。
- external-agent 入口交出登记表的全部公开名字(`bindExternalAgentConnectors` / `getExternalAgentConnectors` / `takeExternalAgentSteering` / `interruptExternalAgentSessions` / `disposeExternalAgentConnectors` / `askExternalAgentPermission` / `askExternalAgentInteraction` / `resolveExternalAgentSessionLink` / `persistExternalAgentSessionLink`)。五处读者改引入口:backend.ts(动态取 → 静态入口,它静态闭包早有入口)、backend-assemble-engine:82、`collab-actors-runtime` 两处动态取(D178 判据核过:`collab-actors-runtime` 的静态闭包经 `provider-call → acp → acp-permission-bridge` 已装着 external-agent 入口,改取入口不多装任何模块)、`provider-call-factory:16`。
- 宿主工具面:入口交出 `external-agent-host-tools.ts` 的异步 `resolveHostToolSurface`(D182 改名见 §2);`acp-host-mcp-bridge` 的 `defaultResolveSurface`(动态深取)删掉,`resolveSurface` 变必填,由 `AcpSubsystem` deps 新格 `hostToolSurface` 透传给 `new HostMcpBridge({ resolveSurface })`。核过:生产里 `HostMcpBridge` 只在 `acp-subsystem.ts:141` 构造一次(`deps.hostMcpBridge ?? new HostMcpBridge()`),`acp-host-mcp-port.ts` 的 `currentBridge()` 只是从当前实例读 `acp.hostMcpBridge`,所有宿主共用 `OnethingBackend.assemble` 里那一次构造,backend.ts 递一次即可。它是函数值,只在请求来时调用,装配顺序不动。
- `acp-translate:11` 改引入口的 `buildTextDiffChange`(acp-fs-bridge 已这样引)。
入口闭包代价:external-agent 入口从 515 只文件长到约 1081(多了 toolkit 目录与会话仓库那棵树,原注释说的「不该因为子系统被构造就进每一份单测的模块图」就是这一笔);acp 入口 790 → 约 1100。代价只落在单测装载,生产主进程 bundle 本来就全装。接受:一个功能的入口就是它的全部对外面,把一只公开函数留在入口外换来的只是假的小闭包。
模拟:`external-agent.ts → acp.ts` 无路(搬完连接器与读表后),`acp.ts → external-agent.ts` 保留,单向。

### 1.5 plugin(6 处)+ deeplink(1 处)
卡的边:credentials-strategy / deeplink-registry / search-plugin-registry 各要 `plugin-contract.ts` 桶里的常量、纯函数、类型与 `plugin-health.ts` 的四只函数(探测 / 报成功 / 报失败 / 灰否)。插件入口经 `plugin-llm-service → provider-call → credentials 入口 → credentials-strategy`、经 `plugin-manager → plugin-api → search 入口 → search-plugin-registry` 与 `plugin-api → deeplink-registry` 到这三家,所以三家改引插件入口都是环。
真相有两层:
- 这三张登记表是「插件在凭证 / 深链 / 检索里的落脚点」,方向是插件写表、功能读表(`能力自述、别人读表`),登记表住在读表的功能里是对的。
- 它们要的东西是**插件词汇**:作用域、表面、超时、结果规范化、健康账。可 `plugin/plugin-contract.ts` 这只桶名不副实 —— 它还再导出 `plugin-freeze`(→ session 入口)、`plugin-api-builder`(→ toolkit 入口)、`plugin-store`,闭包 767 只文件;真正的词汇文件各自闭包只有自己:`plugin-policy`(9 只,全在 plugin 内)、`plugin-runtime-guard`(10)、`plugin-credential-strategy` / `plugin-search-provider` / `plugin-deep-link`(各 1)。
改法:
- 新功能 `plugin-contract/`,登记 L2(health 有进程态 + 宿主端口,不是纯事实),13 只文件 `git mv` 并按 N2 加前缀:`plugin-contract-policy.ts`、`-panel`、`-ui-anchor`、`-file-pick`、`-request-channel`、`-background`、`-canonical-order`、`-webview`、`-runtime-guard`、`-runtime-guard-constants`、`-credential-strategy`、`-search-provider`、`-health`;入口 `plugin-contract/plugin-contract.ts`。`plugin-health` 改引兄弟(不再引桶)。8 只测试同名随行(N6)。
- `plugin-deep-link.ts` 搬回 deeplink 成 `deeplink/deeplink-contract.ts`(`DeepLinkIntent` / `parseDeepLink` / `DEEPLINK_TEXT_MAX_BYTES` 与插件深链动作的登记契约,全仓读者只有 plugin 与 deeplink);deeplink 入口交出;`plugin-api:30` 改引 deeplink 入口的 `registerPluginDeepLinkAction`;plugin 入口那几行深链再导出删掉。
- 确认卡 `resolvePluginDisplayName` 今天问插件管理器要 `manifest.name`;改成登记时携带:`registerPluginDeepLinkAction(pluginId, registration, { displayName })`,plugin-api 把 `manifest.name` 递进去,卡片从登记表读、查不到退回 id。deeplink 从此不引 plugin(`deeplink-confirm-card:27` 那行删)。
- `plugin/plugin-contract.ts` 桶**拆掉**:它的名字与新入口撞(`name:gate` N1 零基线),而且它就是 D126 那类「桶里放再导出」。30 只非测试读者、41 只测试读者改引声明文件(搬走的 13 只改引 `@onething/backend/plugin-contract`),用 scratchpad 根目录 `codemod-a.mjs` 那套按类型检查器把名字解析到声明文件的改写器机械做(`--write` 前先 dry-run 比对);1 只测试在桶上打桩,改打声明文件(D180)。守门脚本里没有按字面写这些文件路径的规则(`scripts/*.ts` / `*.mjs` grep 为 0),不用改检查器。
- 三张登记表改引 `@onething/backend/plugin-contract`;plugin 入口 / 内部读者要用词汇时也从它拿(plugin → plugin-contract,单向)。
- `plugin-health.ts` 有一只模块级 `let host`,`assembly` 基线老行减新行加(8c4b9413b 先例)。
模拟:`plugin.ts → credentials.ts`、`→ search.ts` 保留,`credentials.ts → plugin.ts`、`search.ts → plugin.ts`、`deeplink.ts → plugin.ts` 均无路;`plugin-contract` 入口闭包里没有别的功能。
可感知行为(条件):显示名改从登记表读。`registerPluginDeepLinkAction` 返回的是撤销函数(`deeplink-registry.ts:50–70`),插件 API 把它交还给注册方;只要插件卸载时登记随之撤销(插件系统「两侧拆除」的既有规矩),卸载后仍是「退回 id」,与今天逐字相同。**施工时在 `deeplink-registry.test.ts` 补一条「撤销后显示名退回 id」的断言**,这条断言就是这条等价性的证明。

### 1.6 resource(3 处)
`toolkit-audit-sink:44` 要的 `NO_ORIGIN_SESSION` 已在 sT-A 决定改读 `@shared/ipc/resources`。剩两处 `plugin-api-builder:116` / `plugin-resource-verbs:68` 要 `ReadOutcome`(一只闭包为 1 的纯文件)。今天不能改引 resource 入口是因为 `resource.ts → resource-music-provider → toolkit-adapters → task-dispatch → plugin.ts`;sT-A 把音乐适配器搬回 music、§1.1 把 task 派工层对 plugin 的边改成端口之后,`resource.ts → plugin.ts` 无路(模拟核过:`resource.ts → toolkit.ts → toolkit-wiring` 一线,在施工中那家把拦截钩子改端口后也不再碰 plugin)。两处改引 resource 入口,plugin → resource 单向。

### 1.7 deeplink(1 处)
见 §1.5。

## 2. D182 同名不同物:三对名字

| 功能 | 今天 | 定名 | 差别一句话 |
| --- | --- | --- | --- |
| project-dir | `project-dir-prompt.ts` 与 `project-dir-bootstrap.ts` 各一只 `buildProjectDirsPromptVars` | `buildProjectDirsPromptVarsForSpace(workingDirectory, { spaceId })` / `buildProjectDirsPromptVarsForSession(workingDirectory, { sessionId })` | 前者按空间名册算,后者先把会话解析成空间再调前者;bootstrap 本来就以 `…ForSpace` 别名引前者,只是把别名变正名 |
| permission | `permission-policy.ts` 的纯策略与 `permission-enforcement.ts` 的 `permissionRuntime().decide(input)` 同叫 `decidePermission` | 纯的改 `evaluatePermissionPolicy`,绑定进程的保留 `decidePermission` | 「评估一条策略」不读进程状态、同输入同输出;「决定一次权限」会用上装配好的授权记录 |
| external-agent | `host-mcp/external-agent-host-mcp-tools.ts` 的同步版(入参是场地 / 白名单,返回 `string[]`)与 `external-agent-host-tools.ts` 的异步版(入参是会话 id,返回 `HostToolSurface`)同叫 `resolveHostToolSurface` | 同步版改 `resolveHostToolIds`,异步版保留 `resolveHostToolSurface` | 名字跟返回值:一个给 id 列表,一个给工具面;入口两只都交。入口今天交出的是同步那只,改名后入口同名换成异步那只 —— 非测试没人从入口拿同步版(grep 过),tsc 兜底 |

读者:project-dir 两只引擎文件改引入口拿 `…ForSession`;`toolkit-authorizer:20` 改从 permission 入口拿 `Permission` + `evaluatePermissionPolicy`(toolkit 三只文件本来就引 permission 入口,不添新边;`permission.ts → toolkit.ts` 无路);`permission-runtime.ts` 内部别名同改。

## 3. D183 mcp 旧桶怎么退役

`mcp-index-with-bridge.ts` = `export * from './mcp.js'` + 工具桥 11 个名字。`mcp-bridge.ts` 不引入口(闭包 395 只,无 toolkit),所以 11 个名字直接写进 `mcp.ts` 不成环;`toolkit.ts ↔ mcp.ts` 两向都无路。
- `mcp.ts` 加一组「跨进程工具桥」再导出;删桶文件与 `./mcp/mcp-index-with-bridge` 键;8 处读者(backend.ts、engine 三只、http-server-runtime、settings-client-api、tool-client-api、toolkit-mcp-catalog)改引 `@onething/backend/mcp`。
- 11 只测试,断言一行不动,只改替身:
  - 7 只裸工厂 `vi.mock('…/mcp-index-with-bridge', () => ({ A, B }))` 改成 `vi.mock('@onething/backend/mcp', async (importOriginal) => ({ ...(await importOriginal()), A, B }))`。今天桶上的裸工厂让桶的读者拿不到工厂没写的名字(拿到 `undefined`),展开真模块后拿到真函数 —— 只会让本来就会炸的路不炸,不会改变任何通过中的断言。
  - 2 只(`http-server-mcp-wiring`、`http-server-runtime-over-backend`)与 1 只动态 `import()`(`assembly-lifecycle:416`)只改说明符。
  - `mcp-client-api.test.ts` 的嵌套工厂(`MCPManager` 的方法表)同第一类。
- 为什么不是从 `mcp-bridge.ts` 转交并让测试继续桩桶:D183 自己说了,那样桩拦不住改走入口的读者。改打入口 + 展开真模块是 D173 / D180 用过两次的同一套替身法。

## 4. D184 gateway 启动面怎么切

事实:`gateway/gateway.ts` 末尾的 `if (import.meta.url === pathToFileURL(argv[1]).href) main()` 在单文件包里每个模块都成立,所以装配一引入口就起网关(`host-process` / `http-server-runtime-session-crash-recovery` 两只真进程测试当场红)。全仓没有任何脚本、app 或文档命令真的把这只文件当进程跑(package.json 零条 gateway 脚本;`startGateway` 的唯一调用方就是同文件的 `main`)。
切法:
- `gateway/gateway-standalone.ts`:`startGateway` / `startGatewayFromEnv` / `createGatewayChannelsFromEnv` / `loadGatewayConversationRuntimeFromEnv` / `isCoreConversationRuntime` / `ONETHING_GATEWAY_RUNTIME_MODULE` / `selectRuntimeExport` / `stopGateway` 整段搬来 —— 可以被 import,没有主模块判断。
- `gateway/gateway-standalone-main.ts`:只有 `main()` 与主模块判断,引兄弟 `./gateway-standalone.js`。**谁都不许 import 它**(规则写进文件头与 §6 的门),于是单文件包里永远不会出现那段守卫。
- `gateway.ts`(入口)只剩名字:今天已交的渠道 / 配置 / hub,加上装配要的六个:`createOnethingRuntimeFromStreamRuntime`、`CoreConversationRuntime`(类型)、`getChannelSessionRouter`、`OutboundReplyDispatcher`、`registerChannelPromptContextProvider` / `unregister…`、`configureGatewayHost` / `resetGatewayHost` / `getGatewayHost` / `GatewayHostPorts`;再交 `startGateway` / `startGatewayFromEnv`(从 standalone 转交,给将来的进程壳用)。
- 10 处读者:backend-assemble-engine 5 处、backend-host-ports:61、settings-client-api:78、`scripts/gateway-smoke-test.ts` 3 处(hub 名字入口早已交出)全改引 `@onething/backend/gateway`;删 `./gateway/gateway-conversation-runtime`、`./gateway/gateway-lifecycle-port`、`./gateway/hub` 三把深键;backend-assemble-engine 57–59 行那段「不走入口」的注释删掉。
- `apps/` 里谁调它:今天没有人,也不发明一个没有用户的 `apps/gateway`。进程入口就是 `gateway-standalone-main.ts`,加一条 `package.json` 脚本 `gateway:start = bun packages/backend/gateway/gateway-standalone-main.ts`;将来要单文件包就用 CLI 的配方(`scripts/build-cli.mjs` 同款 esbuild)以它为入口 —— 守卫文件不是任何入口的再导出来源,这个坑结构上不会再出现。
- 检查器:`scripts/headless-boundary-check.ts` 的 `checkGatewayLoadsRuntimeFromHostBoundary` 与 `checkGatewayRegistersConfiguredChannels` 把 `gateway/gateway.ts` 改成 `gateway/gateway-standalone.ts`(它们要的符号都在那只文件里),D174 / D188 的「过时断言改检查器」先例。
- 顺手:`gateway-channel-session-router:8` 那处深引 session-layer 的理由是它的测试把 `session-layer.js` 整只换成只有 `getSessionManager` 的替身;测试改成 `importOriginal` 展开,路由改引 session 入口。
模拟:gateway 入口闭包从 33 只长到 1261(`gateway-onething-runtime` 引 collab / engine);它的读者只有包根、L4 面与脚本,`session.ts` / `engine.ts` / `agent-loop.ts` / `collab.ts` → `gateway.ts` 均无路,0 环;gateway 仍是 L3。新交出的 6 只文件顶层逐只核过(D176 同一道检查):没有 `configure*` / `register*` / `install*` 的模块级调用,也没有订阅、计时器,`import-side-effect-free` 不受影响。
可感知行为:无。生产里没人以主模块方式起过它;守卫换文件后,独立网关的起法是显式脚本。

## 5. D185 / D186:哪些是规则、哪些该改

| 处 | 判定 | 理由 |
| --- | --- | --- |
| search:`scripts/gate-embed-runtime/entry.ts` 引嵌入运行时 | **永久例外,写成规则**:`scripts/gate-*/` 下的文件是真机门的被测产物入口,由门用 esbuild 打成独立进程,它与构建配方同类 —— 按文件路径指模块,不经功能入口;`entry:gate` 把这个目录类与 `__tests__` / client-api 一样按类不计 | 嵌入运行时按入口文件头的明文只许在 Worker 里装载,进入口就进主进程 bundle;这是进程边界,不是引用风格 |
| search:`scripts/lib/search-corpus-redact.mjs` | **改**:入口交出 `redactText` / `findRedactionHits` / `REDACT_RULE_IDS`(闭包 1 只纯文件),shim 改成从 `@onething/backend/search` 再导出,四个读者路径一字不改 | 入口不在 Worker 闭包里(Worker 按路径引内部文件,从不引 `search.ts`),加三个纯名字不改 Worker 一字 |
| collab:6 处 `scripts/collab-v3-*.mjs` | **改**:走 collab 入口,入口补约 20 个纯规则名(inspect 12 / scheduler-log 4 / room 1 / mind 1 / migrate 2) | D186 的理由「别让一次性脚本装整个 L3 入口」经不起量:那些「纯规则文件」闭包各 535 只(经 collab 内部早已牵到 session / provider),入口 983 只,bun 实测装入口 242 ms。`collab-v3-migrate.mjs` 自 08-03 迁移落地后只被改名提交碰过;要不要直接删它(连同 `./collab/actors/collab-actors-migrate` 深键)列给用户 —— 删比加名字小,但旧 store 还有没有要迁的我不知道 |
| collab:`permission-enforcement:214` 动态取 `collab-room-config` | **改成事件**:enforcement 的 30 分钟提醒改 `getEventBus().emitGlobal({ type: 'permission:ask-stale', sessionId, title, elapsedMs })`(`@shared/events` 的 `GLOBAL_EVENT_LEAVES_PROCESS` 表加一行 `false`);collab 出一只 `installPermissionStaleReminder(eventBus)`(查房、`postCollabSystemLine` 同一句话),backend.ts afterEngine **无条件**装并 own() | 这是 L2 动态够 L3 的越层,动态 import 只是把它藏起来;发事件是 L2 → L0。无条件装是为了与今天一致 —— 今天任何宿主只要有会话就有这条提醒,不看 `collab` 选项 |
| variable:`music-radio:427` 动态取 `variable-registry` | **改成端口**:`MusicSubsystem` 选项多一格 `variables?: { listForSession(sessionId) }`,透传进 `createRadioScope(options)`(`buildRadioLifeContext` 是 `createRadioScope` 闭包里的内层函数,用的 `owner` 在 128 行,所以端口落在 scope 的 options 上,内层函数直接读);backend.ts 697 行递 `{ listForSession: (id) => getVariableRegistry().list({ sessionId: id }) }`(惰性,构造时不取值 —— 那一刻变量注册表还没建,这是「装配顺序不动」成立的条件)。`radio-authorization.test.ts` 今天桩的是模块路径,改成在 `createRadioScope` 的 options 里递替身 | 今天 variable 入口静态引 music(`variable-gateways` 直接拿 `getMusicNowPlaying` / `getRadioStore`),所以 music 不能静态引 variable;病根是 `variable-gateways` 按能力枚举(music / goal / note),按 CLAUDE.md 的法应改成各功能登记自己的网关 —— 那是变量系统自己的一单,本单只拆 music 这一头 |
| eval:`session-client-api-commands:139` | **改**:eval 入口交出 `createIncidentForTurn`,命令文件只 `import('@onething/backend/eval')` 一次;它的测试把 `eval-turn-incident` 与 `eval` 两只裸工厂并成一只打在入口上 | eval 入口今天不到 session(`eval.ts → session.ts` 无路),交出后到;反向 `session.ts → eval.ts` 无路,不成环 |
| session:`search-index-ledger-feed:36` 引 `session-events-codec` | **改(搬家)**:编解码搬到 `packages/shared/session/events/codec.ts`,Worker 与 session 都从 shared 拿 | 它的记录类型 `types.ts` 本来就住 shared 那个目录;编解码闭包只有 shared,是「纯逻辑」;搬完 Worker 的模块集合 88 只不变,只有这一只换了路径 |

规则一条(写进 `server-client-split` §4「功能入口」):**进程入口不经功能入口。** 被构建配方或真机门当作独立进程 / 线程起的文件(`*-worker.ts`、`*-standalone-main.ts`、`scripts/gate-*/` 下的入口)按文件路径指它要的模块,因为它的定义就是「不装那个功能的入口闭包」;反过来,这类文件不许被任何功能文件 import。`entry:gate` 按类不计 `scripts/gate-*/`,其余照数。

## 6. entry:gate 非测试部分能否改零基线硬闸

能。判据:
- 「非测试」= `isTestPath(importer)` 为假,且 importer 不在 `scripts/gate-*/`(§5 的规则,与 `__tests__` / client-api 同一种按类不计)。
- 不计的目标还有一类:层次表里登记了 `configureEntry: true` 的装配入口(`entry-leftovers` §3 的 `logging-configure.ts`,只许包根 / http-server / apps 引)—— 与 client-api 同一种「声明过的第二入口」,门读层次表判,不写死文件名。
- 非测试深层引用处数 > 0 即红,红的那行打印 `目标 ← 引用方:行`(今天 `--list <功能>` 的格式)。
- 测试部分保持今天的每功能棘轮:只减不增,不跑 `--write-baseline`。
预计读数:本单 57 处 → 0;施工中四家 34 处按 `entry-leftovers` 归零(logging 最后 2 处 `backend.ts:156` / `backend-host-ports:41` 走上面第二条的槽位规则)。两份决定对这个数字一致:0。硬闸的落地顺序:等那家落地后再翻硬,中间用 `--list` 盯。测试行的预计变化只会降(mcp 11 只测试改引入口;gateway 2 只;session-router 1 只;eval 1 只;plugin 的 41 只改引声明文件 —— 这些读者仍是深层,plugin 行不降反可能升,D14 口径接受),具体数字以施工后 `entry:check` 为准。

## 7. 模拟器证明

`node sim2.mjs s33.json`(只叠本单,HEAD 图):**跨功能值边 1866;低层引高层 0 条 / 0 对;入口级环(真门口径)0 个;原图 SCC 3/2(与 HEAD 相同)**。
`node sim2.mjs sIP.json s33.json`(再叠施工中四家的假设):**1856;0 / 0;0 个;SCC 3/2**。
两份都是 0 环,说明本单不依赖施工中那四家怎么落。

`sIP.json` 的假设要摆明:s31 的三份场景在今天的 HEAD 上有 3 条 cut 已不存在(施工已动过),原样叠加会算出一只 66 文件的假环;sIP 剔掉不存在的 cut,并补了一条假设「toolkit-wiring 的两只插件拦截钩子改成装配填端口(切 `toolkit-wiring → plugin 入口`,backend.ts 递)」—— 这是对 toolkit 那家的假设,按 `entry-leftovers` §1.2 的口径;若那家另有改法,只要 toolkit 入口不回头引 plugin 入口,本单结论不变。

叠加后按值图重数非测试深层引用,剩 5 条:acp 3 条是搬家文件在场景里还挂着旧路径(搬完就是兄弟边),logging 2 条属施工中。

Worker:`search-index-worker.ts` 的闭包 88 只文件,与本单动到的文件交集只有 `search-index-ledger-feed.ts`(改一行 import)与 `session-events-codec.ts`(搬去 shared);模块集合不变,字节差只在路径字符串,以 `gate:search-index` 的 Worker 读数实测为准。

## 8. 要动的三张表与门

- `docs/audit/feature-layers-2026-10.json`:加一行 `{ feature: 'plugin-contract', layer: 'L2', why: '插件与宿主约定的词汇:作用域 / 表面 / 严重度策略、熔断阈值、健康账、凭证策略与检索供给方的登记契约;health 带进程态与宿主端口,所以不是 L1' }`;`feature-map` 重生成(D189)。
- `docs/audit/assembly-baseline-2026-09-02.txt`:`plugin/plugin-health.ts 1` 改成 `plugin-contract/plugin-contract-health.ts 1`;其余 15 只搬家文件没有模块级 `let`。
- `packages/backend/package.json` exports:删 `./mcp/mcp-index-with-bridge`、`./gateway/gateway-conversation-runtime`、`./gateway/gateway-lifecycle-port`、`./gateway/hub`、`./task/task-dispatch`、`./external-agent/external-agent-connector-registry`、`./external-agent/external-agent-host-tools`、`./plugin/plugin-contract`、`./plugin/plugin-health`、`./resource/resource-read-outcome`、`./resource/resource-api`(若无别的读者)、`./project-dir/project-dir-bootstrap`、`./eval/eval-turn-incident`、`./variable/variable-registry`、`./collab/collab-room-config`、`./collab/actors/*`、`./deeplink/deeplink-registry`、`./interaction/interaction-no-human`;加 `./plugin-contract`。`./permission/permission-asks` 键**留着**:做完本单它的非测试读者是零(`toolkit-authorizer` 改引入口,账本记录器搬走),它活着只靠 8 只测试在它上面打桩 —— D189 的扫描把 `vi.mock` 字符串算读者,施工按「再无人引用的深键删掉」时别把它误删。
- `name:gate`:新名全过了「全包唯一」(`acp-connector` / `deeplink-contract` / `task-rules` / `permission-session-ledger` / `interaction-session-ledger` / `gateway-standalone` / `gateway-standalone-main` 今天都不存在);`plugin-contract.ts` 今天存在一只(那只桶),所以桶必须拆或改名,本单选拆。
- `headless-boundary-check.ts`:gateway 两条断言改路径(§4)。
- `entry:gate`:§5 的目录类规则 + §6 的硬闸。

## 9. 测试实数汇总(按文件数)

task 1 · permission 1 · acp/external-agent 4(连接器测试搬家;`connector-registry-lifecycle` / `steering-delivery` 不再桩连接器模块,改经 `bindExternalAgentConnectors({ connectors })` 递替身;`assembly-lifecycle` 两处 `vi.spyOn` 改打 acp 入口的 `createAcpConnector`)+ 5(`resolveHostToolSurface` 改名机械跟改;`acp` 三只构造 `HostMcpBridge` 的测试本来就递 `resolveSurface`,不动)· plugin-contract 8 搬家 + 1 改桩 + 1 改引 + 41 改说明符(桶拆掉)· mcp 11 · gateway 2 + 1 + 检查器 2 处 · eval 1 · variable 1 · project-dir 6 · 其余 0。断言一行不动;改的全是替身打在哪只文件、说明符指向哪里。

## 10. 写给用户的「决策与理由」

这 58 处停下的地方,我逐个看过它们卡在哪条边上,结论是没有一处需要「豁免」。它们分四种病:
1. **方向反了**(acp 与 external-agent、deeplink 与 plugin、session 与 permission/interaction)。契约不该写驱动的名字,读表的一方不该引写表的一方。治法是按依赖方向搬家:ACP 连接器回 acp,深链词汇回 deeplink,记账的记录器回 permission 与 interaction,插件词汇下沉成一个零依赖的小功能 `plugin-contract`。搬完每一对都是单向边,模拟器在 HEAD 上和叠上施工中四家的假设上都算出 0 环、0 层次违例。
2. **入口里放了实现或桶**(task 入口的常量、mcp 的旧桶、plugin 那只 740 行的「契约」桶、gateway 入口兼作进程启动脚本)。这是可读性陷阱:读者以为引的是说明书,其实引进了一台机器。治法是实现搬去兄弟文件、桶拆掉、启动面搬成两只独立文件(守卫那只谁都不许 import,单文件包的坑结构上消失)。
3. **同名不同物**(三对)。换说明符等于换函数,所以先改名再收口:`…ForSpace` / `…ForSession`、`evaluatePermissionPolicy` / `decidePermission`、`resolveHostToolIds` / `resolveHostToolSurface`。
4. **用动态 import 藏起来的越层或环**(task 要插件的投递函数、music 要变量注册表、permission 要往协作房间喊话、eval 的事故单)。治法是端口与事件:装配时把函数递进去,或发一条全局事件让上层自己听。都是惰性函数,构造时不取值,装配顺序一处不动。

真正的永久规则只有一条:**进程入口不经功能入口**(索引 Worker、独立网关的 main、真机门的被测产物)——它们的定义就是「不装那个功能的全部」,所以按文件路径指模块;门按目录类不计。这是规则,不是豁免表。

可感知行为:除了一条,全是零。那一条是深链确认卡上的插件显示名:今天问插件管理器要 `manifest.name`,我的方案改成登记动作时随登记携带、从登记表读。两者相同的前提是「插件卸载时它的登记随之撤销」(登记函数本来就返回撤销器,插件系统的两侧拆除规矩也要求这样),施工时补一条断言证明。两个选项并列:(a)接受这个前提,deeplink 从此不引 plugin(推荐,这是方向对的那一边);(b)保留问插件管理器,deeplink 继续引 plugin,那一处深层引用留下、`entry:gate` 非测试就翻不了硬闸。
另要你拍一件小事:`scripts/collab-v3-migrate.mjs` 是 8 月初那次协作 v3 迁移的工具,之后只被改名碰过 —— 删掉它比往 collab 入口加两个名字更小,但旧 store 还有没有要迁的只有你知道;不删就走入口。

做完这些,`entry:gate` 的非测试部分可以改成零基线硬闸(预计读数 0,等 logging 最后两处按上一份决定落地后翻硬);测试部分继续只减不增。

## 11. 实施结果(s34,2026-10-04,未提交)

按本文施工,用户拍 D203 选 (a)、D204 保留迁移脚本;落地记录 D205–D218(`docs/design/backend-structure-decisions-2026-10.md`),
正本 `docs/design/server-client-split-2026-10.md` §6「第四批停下处收口落地记录」。

**动手前按今天的图重跑**(HEAD `45e4304a1`,图 1596 文件 / 4746 边;D205):非测试深层引用 56 处(本文按 653a433b7 数 57,
resource 的 `toolkit-audit-sink` 那处已随 D191 落地)。`s33.json` 在今天的图上算出 2 个两只文件的入口环 —— 场景没写
`task-dispatch` 改引 `task-rules`(仍挂着引自家入口的边),确认卡那条加边指向 deeplink 入口而不是兄弟登记表;按实施修正后叠不叠 `sIP`
都是 0 环、0 层次违例。

**每单读数**(非测试深层引用 / 合计,门全绿,检索 Worker 三份各 −16 字节只差路径注释):
1. gateway + session:56 → 44 / 903 → 889。
2. mcp / eval / project-dir / permission / search:→ 31 / 865。
3. task / 记账器 / variable:→ 27 / 859(#6 resource 当场成环,挪到第 5 单,D206)。
4. acp / external-agent:→ 17 / 844。
5. plugin-contract + deeplink + resource:→ 8(合计因 plugin-contract 成新行而在第 7 单前红 —— 那 11 处测试从 plugin 行换到新行)。
6. collab:→ 1(只剩 `scripts/gate-embed-runtime/entry.ts`,按进程入口规则不计)。
7. 门:非测试零基线硬闸,**非测试 0,测试 838**(改前测试 847);进程入口名册 4 只,零 import。

**与本文的出入**(都已登记):gateway 内部 8 只文件原用三把深键自引、`./gateway` 键此前不存在(D207);mcp 第二入口的替身打声明文件(D208);
project-dir-bootstrap 等 5 把深键仍有读者、保留(D209 / D218);连接器表做成惰性工厂、无主登记表为空并加测试钩子、
`resolveSurface` 保持可选(D213);`PersistedPluginHealth` 随健康账下沉、检查器的插件文件表要改、插件入口不再转交词汇(D214);
显示名做成惰性 getter 由插件管理器递(D215);`entry:gate` 的进程入口名册读构建配方而不按 `*-worker.ts` 文件名判(D217)。

**可感知行为**:零。深链确认卡的显示名改从登记表读,`deeplink-registry.test` 新钉「登记在读到显示名、拆除后退回 id」;
协作房间那条 30 分钟提醒措辞逐字相同,监听器无条件装。验收全量见正本 §6。
