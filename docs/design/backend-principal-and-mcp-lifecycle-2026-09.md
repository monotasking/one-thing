# 凭证级信任、MCP 生命周期、审查修复(方案 B′,2026-09-03)

来源:B 线(`backend-transport-forks-2026-09.md`,提交 92bdb43c / 84678457 / 298c42c5 / 6fbde707)做完后的
全量审查(两路对抗式审查 + 本人核对),用户 09-03 三问:"有 token 不就已经过校验了吗,这块该怎么设计"、
"MCP 的生命周期我们有管理吗"、"其他问题也值得修"。本文回答这三件并分期。Vue 相关发现已按用户口径剔除。

## 0. 一句话

三件事,三个对象:
1. **信任从"进程级开关"改成"凭证级主体"**——宿主校验 token 之后给这次请求盖一个 `Principal`(`owner` / `client`),
   域处理器只问主体等级,`isHostLocallyTrusted()` 这个进程级布尔退役。
2. **MCP / ACP 各成为 backend 拥有的一个子系统对象**(`McpSubsystem` / `AcpSubsystem`),构造即登记 dispose,
   宿主只决定"何时 start",早退时 dispose 会等在途的 start 再关——审查第 2 条的孤儿子进程在结构上消失。
3. **审查剩下的机械修复**打成一批先落(`own()` 守卫、`rpc/sandbox.ts`、假测试、文档数字等)。

> **状态(2026-09-03 用户裁定)**:§2.1 的凭证级主体设计**搁置**,用户后续另行处理;随之搁置的还有 R8(环境变量改名)、
> R11 与分期表里的 C2。本轮只做 C0(机械修复)与 C1(MCP/ACP 子系统)与 C3 中不依赖 C2 的文档部分。
> §2.1 现存文字是"token 带作用域 + 工具调用许可不参与 API 授权"之前的一版,以对话记录为准,待重写。

## 1. 现状(已核对,HEAD 6fbde707)

### 1.1 信任

- HTTP 面只有**一把** token(`OnethingHttpServerOptions.authToken`):`ONETHING_SERVER_TOKEN` 有就用它,否则每次启动
  `randomBytes(24)` 随机生成(`server/embed.ts:89-92`、`apps/server/src/main.ts:41`),写进 `<store>/run/http.json`
  (0600,目录 0700)。`checkRequestAuthorization`(`http.ts:678-696`)只做 `tokenMatches`,匹配就放行;
  `GET /api/events` 是唯一接受 `?token=` 的路由(EventSource 带不了 header),token 不进日志。
- 校验之后铸的上下文(`runtime.ts:4106-4116`)是 `{transport:'http', ownerUid, workspaceId, sandboxRoot}`——
  **没有"这把 token 是谁"的信息**。谁可信由进程级的 `isHostLocallyTrusted()` 决定(`server/host-trust.ts`),
  三处声明:宿主表 `localTrust`(装配时)、`embed.ts`(内嵌面挂载时)、`apps/server/src/main.ts:137`(回环监听时)。
- 后果:一台回环 server 上,**所有**持 token 的调用方等级相同;想让本机 owner 与远端只读客户端共存做不到。
  `ONETHING_SERVER_FILES_SANDBOX=1` 现在压掉六个域的信任,名字只写了 files。
- `rpc/sandbox.ts:56` 仍按 `transport==='ipc'` 决定夹不夹,七个域共用,在棘轮量程外;React 壳走 HTTP,
  project-dirs / markdown / permission-grants 三个域在壳上仍被夹进工作区根。
- 用户裁定(09-03):**有 token = 已鉴权 = 本机 owner**,B2 对回环 server 放全等桌面是对的;
  之前"mcp stdio 只对桌面内嵌面放开"的保守裁定撤销,同按主体放行。

### 1.2 MCP

- `MCPManager`(runtime 单例,`HeadlessMCPManager` 子类)接口完整:`initialize / updateSettings / connectServer /
  disconnectServer / removeServer / disconnectAll / shutdown`,每 server `connect / disconnect / updateConfig /
  refreshCapabilities`。设置域改 MCP 设置时调 `updateSettings`(`rpc/domains/settings.ts:128`)。
- 生命周期归属散在宿主:daemon 在装配里(`backend.ts:477`,`mcpAcp:true`,disposer 已 own);React 壳开窗后
  `initializeShellMCP()`(`main.ts:280-292`,自己再配一遍 `configureMCPCapabilitiesChangedHandler`),**成功后**
  才 `own(MCPManager.shutdown)`;server 由 runtime 按 `processPorts` 决定(`runtime.ts:1310`)。
- 漏洞(审查第 2 条):`OnethingBackend.own()` 无"已 dispose"守卫(`backend.ts:214`);壳的 MCP / 调度器登记在
  `.then()` 里;启动后数秒退出 → stdio 子进程已拉起、shutdown 未登记 → 孤儿。ACP 同型。

### 1.3 其余审查发现(不含 Vue)

| # | 发现 | 位置 |
| --- | --- | --- |
| R1 | `own()` 在 dispose 后静默丢弃;三处异步登记 | `backend.ts:214-241`;`desktop-react/electron/main.ts:251-267` |
| R2 | `rpc/sandbox.ts` 按 transport 判,棘轮扫不到 | `rpc/sandbox.ts:56`;`scripts/transport-gate.mjs` 不递归 |
| R3 | A0 ⑨ 定时器断言空(unref 定时器不可见) | `__tests__/assembly-lifecycle.test.ts:223-246` |
| R4 | `plugins.configGet` 管理器在位时经 HTTP 交出原始配置,无 HTTP 侧断言 | `rpc/domains/plugins.ts:296-332`;`plugins-domain.test.ts` |
| R5 | `removeHttpDiscovery()` 不查 pid,挂载失败会删别人的发现文件 | `server/discovery.ts:110-116`;`main.ts:248/453` |
| R6 | `applyHostPorts` 只还原 `localTrust`,其余十四格不随 dispose 清 | `host-ports.ts:155-183` |
| R7 | `hasShellHost` 按内容判、`hasVoiceHost` 按闩判,口径不一 | `shell/host-ports.ts:61`;`voice/host-ports.wiring.ts:78` |
| R8 | `ONETHING_SERVER_FILES_SANDBOX` 名不副实 | `host-trust.ts:77` |
| R9 | 文档数字:十六格/十四可 null、壳十二 null、server 十四、A0 十条;§4 漏报 | CLAUDE.md、方案 B §4 |
| R10 | `dispose()` 不清 `parts`,尾段 safe 访问器返回已关的引擎(无实害) | `backend.ts:225-241` |
| R11 | `localTrust` restore 是身份守卡不是栈弹出,dispose 早于 close 时信任活过 dispose(今不可达) | `host-trust.ts:104` |

## 2. 目标形状

### 2.1 主体(Principal)

```ts
// packages/shared/ipc/rpc.ts
export type PrincipalGrade = 'owner' | 'client'
export interface Principal {
  /** owner = 与桌面用户同权;client = 远端客户端,只拿沙箱内的读写与自己会话的事 */
  readonly grade: PrincipalGrade
  /** 怎么认出来的,只供日志与排障;域处理器不许按它分叉 */
  readonly via: 'ipc' | 'owner-token' | 'client-token'
}
export interface RpcDispatchContext {
  transport: 'ipc' | 'http'
  principal: Principal            // 新增,必填;宿主鉴权后铸,永不读自 envelope
  ownerUid?: string; workspaceId?: string; callerId?: string | number; sandboxRoot?: string
}
```

**铸法**(与既有规则一致:宿主在自己的鉴权跑完之后铸上下文):

| 入口 | 主体 |
| --- | --- |
| 桌面 IPC(`apps/electron/src/main/ipc/rpc.ts`,Vue,退役但须编译) | `owner / ipc` |
| HTTP 面,匹配到 **owner token** | `owner / owner-token` |
| HTTP 面,匹配到 **client token** | `client / client-token` |

**token 分级**——HTTP 面从"一把 token"改成一个 `TokenRing`:

```ts
// packages/backend/server/token-ring.ts
export class TokenRing {
  constructor(entries: ReadonlyArray<{ token: string; grade: PrincipalGrade; label: string }>)
  authenticate(bearer: string): Principal | null      // 常数时间比较
  ownerToken(): string                                 // 写进发现文件的那把
}
```

| 来源 | 等级 | 理由 |
| --- | --- | --- |
| 每次启动随机生成的 token(写进 0600 发现文件) | **owner** | 只有同一 OS 用户读得到,拿到它 = 你自己的进程 |
| `ONETHING_SERVER_TOKEN`,绑定回环 | **owner** | 用户为本机自动化配的 |
| `ONETHING_SERVER_TOKEN`,绑定非回环 | **client** | 这把是发给远端设备的 |
| `ONETHING_SERVER_UNTRUSTED=1`(原 `ONETHING_SERVER_FILES_SANDBOX`,旧名保留别名) | 一律 **client** | 用户强制降级的总闸 |

发现文件照旧只写 owner token(`token` 字段),远端客户端拿的是环境变量那把。

**域处理器**:`isHostLocallyTrusted()` 的 7 处调用与 `rpc/sandbox.ts:56` 全部改成 `isOwner(context)`
(`context.principal.grade === 'owner'`)。`resolveRpcSandbox`:owner → `{confined:false}`;client → `sandboxRoot`
fail-closed(今天的 http 分支逐字)。`canSpawnLocalProcesses()` = `isOwner(context)`(撤销"只认桌面内嵌面")。
mcp / settings 的出界脱敏保留:它问的是"payload 走不走网络",与主体无关——一个 owner 用浏览器读设置,密钥
仍然该摘。**进程级 `isHostLocallyTrusted()` / `configureHostLocalTrust` / 宿主表 `localTrust` 一格全部退役**:
主体现在跟着请求走,不需要"这个进程可信"这句话;`/api/capabilities` 的 `localFileSystem` 改为按**这次请求**
的主体回答(owner → true)。`server/embed.ts` 与 `apps/server/src/main.ts` 的两处声明删除。

**棘轮**:`transport-gate.mjs` 递归扫 `packages/backend/rpc/**`(R2);新增第四族指标:`isHostLocallyTrusted|
configureHostLocalTrust` 全仓非测试调用 = 0(C2 结束时基线 0,只许降)。`context.principal` 读法不限——它就是
该问的那根轴。

**残余风险(写进文档,不在本方案解)**:`GET /api/events?token=` 仍在查询串里(EventSource 限制);owner token
被复制到别的机器等于把 owner 权限带走——0600 文件是今天唯一的护栏。

### 2.2 MCP / ACP 子系统对象

```ts
// packages/backend/wiring/mcp/subsystem.ts
export class McpSubsystem {
  constructor(private readonly deps: { manager: MCPManager; settings: () => MCPSettings; registerTools: () => Promise<void> })
  /** 幂等;记下在途 promise。宿主决定何时调(装配内或开窗后)。 */
  start(): Promise<void>
  /** 设置域改动后调;内部 updateSettings + registerTools。 */
  applySettings(next: MCPSettings): Promise<void>
  /** 等在途 start 结束再 shutdown;从未 start 过则 no-op。 */
  dispose(): Promise<void>
  readonly state: 'idle' | 'starting' | 'running' | 'disposed'
}
```

- `OnethingBackend.mcp: McpSubsystem` / `.acp: AcpSubsystem` 成为字段,在 `assembleSteps` **构造时**就 `own(() => mcp.dispose())`
  ——登记不再依赖 start 何时完成。`options.mcpAcp: true` = 装配内 `await mcp.start()`(daemon 今天的行为);
  否则宿主在开窗后 `backend.mcp.start()`(React 壳),`initializeShellMCP()` 删除,`configureMCPCapabilitiesChangedHandler`
  由子系统在构造时接一次,壳里那份重复接线删除。server runtime 的 `appMCPManager.initialize`(`processPorts==='own'`
  时)改成 `backend.mcp.start()`。
- 设置域 `updateMCPSettings` → `backend.mcp.applySettings(next)`。

**C1 落地记录(2026-09-03)与四处偏离**(第 1 条已于同日的收尾批销账,余三条仍成立):

1. ~~**server runtime 那处接线没改**~~ —— **已于本批收尾(2026-09-03,C1 收尾批)**。当时
   `server/runtime.ts` 由另一会话在改,一个字不碰,所以留了这条账。现在:
   `OnethingServerBackend` 多一格可选的 `mcp?: Pick<McpSubsystem, 'start'>`,
   `toOnethingServerBackend` 从产品后端透传,`ownsProcessPorts` 那一支改成
   `if (backend.mcp) void backend.mcp.start().catch(...)`,`getMCPSettingsForContext` 与
   server 自己那份 `configureMCPCapabilitiesChangedHandler`(单槽端口,子系统构造时已接
   逐字同一个 `registerMCPTools`)一并删除。**设置同源核实**:server 那条读法走
   `createDefaultContextServerSettingsStore`,它把**默认上下文**特判到
   `<store>/settings.json`,与子系统的 `getSettings().mcp` 同一个文件同一个
   `mergeWithDefaults`(`resolveEffectiveAppSettings` 只重算 `.ai`);唯一分叉是显式
   `ONETHING_SERVER_SETTINGS_ROOT` / `options.settingsRoot` / `options.settingsStore`,
   那会把连默认 owner 在内的设置整体挪到 `<root>/<uid>/<wid>.json` —— 而进程里的引擎
   照旧读 `<store>/settings.json`,也就是说那条路上 MCP 从前是全进程唯一一个跟着挪的
   读者,现在跟其余部分对齐了。仓里无人设这个 env。
   子系统"要不要 `shutdown()`"的判据仍然是"**我 start 过没有**"(不是"manager 现在
   initialized 没有"):它现在对 standalone server 也答"起过 → 该我关",于是 MCP 的收尾
   从"`backend.dispose()` 跑完之后那一圈 `mcpManagersByOwner`"提前到了 dispose 之内
   (`engineAbortAll` 之后、`pluginManager` 之前)—— 两个位置都在 abortAll 之后,约束不变。
   那一圈保留:它还管着 scoped owner 的 server-local manager,对默认 owner 是幂等的第二次调用。
   这条判据也仍然逐字保留了 C1 之前 `own('mcpAcp')` 里的 `if (!options.mcpAcp) return`
   (`mcpAcp:false` 且宿主从不 `start()` 的那些 backend 不替别人关门)。
   **收尾批实测出来的两件事,列在这里等裁定**:
   (a) *可观测性*——core 自己那两句 `mcp initializing` / `mcp connecting to servers`
   从此进不了独立 server 的 `server.jsonl`:`apps/server/src/main.ts` 要等 runtime 装配完
   才 `configureLogging`,而从前那句 `await getMCPSettingsForContext()` 带一次真实文件读,
   把 `initialize` 顶到了接线之后(是运气不是设计);子系统读设置是同步的。补法是
   server runtime 在 `start()` 兑现时自己记一行 `mcp subsystem started {servers:N}`
   ——实测 `{servers:0}` 与 `{servers:1}` 两档都到。
   (b) *收尾时长*——**用户裁定:不接受无界等待,已改**。发现的问题是:一台在初次握手上
   挂死的 stdio 服务器会把 `server:start` 的 SIGTERM 收尾拖满 5s 预算(实测 5.06s +
   `shutdown did not finish in time; pending session writes may be lost`),从前 0.05s ——
   因为收尾进了 `dispose()`,而子系统按设计要等在途 `start()`。
   改法:`McpSubsystem` / `AcpSubsystem` 的 `dispose()` 各给"等在途 start +
   `manager.shutdown()`"**合起来**设一个上限(`DEFAULT_*_DISPOSE_TIMEOUT_MS = 3000`,
   构造参数 `disposeTimeoutMs` 可覆盖,单测传 30ms),超时记一行
   `mcp|acp shutdown timed out; continuing dispose {elapsedMs, servers|agents}` 并照常返回,
   让排在 dispose 链后面的会话账本 flush 一定跑得到。3000 卡在 `apps/server/src/main.ts`
   那条 5s 死线底下并留出余量。摘 capabilities 口挪到计时区之外(同步、挂不住,而
   "超时就把已死的 backend 留在通知端口上"是另一个泄漏)。
   **超时之后可能留下一只孤儿 stdio 子进程,这是有意的取舍:会话数据比 MCP 子进程重要**
   ——C1 引进"等在途 start"针对的是早退孤儿(manager 几十毫秒就收摊的常态),握手挂死
   属于另一类事故。ACP 与 MCP 各自计时不共用预算(两台同时挂死才会合计 6s 顶穿死线,
   而共用预算会让先关的那格饿死后关的那格)。
   实测:挂死档 5.06s → **3.05s**,`pending session writes may be lost` 消失,warn 记到
   `{elapsedMs:3000, servers:1}`,其后 variables / stream engine / permission / interaction /
   event system 五格照常跑完;0 台档 0.04s、快速失败档 0.18s 不触发上限;
   `smoke:core` 的 `mcp-early-exit` 泳道残留仍是 0(常态收尾远在上限之内)。
2. **`start()` 的位置从"设置读完那一行"挪到反序登记块之后**。原文只说"构造即 own",但
   构造点(要在 `own` 的闭包之前)与 `own` 的位置(要保住关机顺序)天然分处两行;若 start
   仍留在前面,`initialize` 抛错时 `assemble` 的 catch 去 dispose,表里还没有 MCP 那一格 ——
   孤儿窗口原样还在。中间只跨过六句纯登记的 `own()`,零副作用。
3. **ACP 的权限桥没搬进子系统**。今天接它的是 Vue 宿主自己的 `initializeACP()`
   (`apps/electron/src/main/ipc/acp.ts`);装配层这条路(daemon 的 `mcpAcp: true`)从来没接过。
   搬进来 = 给 daemon 新开一条今天没有的行为,属产品决定,不在本期。**React 壳也不起 ACP**
   (原文只要求"壳不新增"),`backend.acp` 在壳上恒 `idle`,dispose 无害。
4. **子系统不进 `BackendHandle`**:新增 `current.ts` 的 `getCurrentBackendInstance()`
   (判据 = "槽里那只 own 得了 disposer 吗",`import type` 纯类型不产生运行期环),设置域 /
   ACP 域经它拿子系统;拿不到就退化直调 manager(不装 backend 的那些单测走的就是这条)。

**真机门的两半**(`apps/desktop-react/scripts/smoke-core-boot.mjs` 第三条泳道
`mcp-early-exit` + 自带的 `scripts/smoke/fake-mcp-server.mjs`):它抓的是**登记**那一半
(把两句 `own` 挪回 `if (options.mcpAcp)` → `pgrep` 读到 1 个残留,红)。"等在途 start 落地"
那一半在真机上被 `HeadlessMCPManager` 自己的串行队列兜住了(`shutdown()` 是 enqueue 的),
所以那一半的判据留在 `wiring/mcp/__tests__/subsystem.test.ts`(注入的替身没有那条队列,
去掉 `await inFlight` 即红)。假服务器**故意不在 stdin 断掉时自杀** —— 会自杀的假服务器
把孤儿伪装成没孤儿,门就恒绿了。
- `OnethingBackend.own()` 加守卫(R1):已在 dispose 或已 dispose → **立即执行**传入的 disposer 并返回其 promise,
  不再入表;React 壳与 Vue 主进程里三处 `.then()` 内的 `own()` 因此自动安全,同时把调度器那处改成同步登记
  (`initializeUserSchedulerTasks()` 返回 stop 是同步的,只是被包在动态 import 里——改成静态 import)。
- 测试:`start()` 在途时 `dispose()` → 等 start 完成后 `shutdown` 被调用恰好一次(反证:去掉 await → 红);
  `own()` 在 dispose 后立即跑(反证:去掉守卫 → 红);A0 加第 ⑪ 条:装配含 `mcpAcp:false` 时 `ownedLabels()` 含 `mcp`
  与 `acp`(登记与 start 无关)。

### 2.3 其余修复(机械)

| # | 修法 |
| --- | --- |
| R3 | A0 ⑨ 删掉定时器半边;定时器泄漏改由三个 disposer 各自的单测钉(`blob-gc` / `list-backfill` / `scheduler` 的 stop 后 `clearTimeout` 被调),用 `vi.useFakeTimers` + `vi.getTimerCount()`(它看得见 unref 定时器) |
| R4 | `plugins-domain.test.ts` 补"管理器在位 + http → `configGet` 返回真配置、`editable:true`"断言(这是有意行为:owner 用 HTTP 客户端管插件);方案 B §4 补一行 |
| R5 | `removeHttpDiscovery()` 只在文件 `pid === process.pid` 时删;测试:写一份别人的记录 → 调用后仍在 |
| R6 | 十六格端口各自的 `configure*` 返回 restore(大多数模块已有 `resetXForTests`,提成 `restore` 语义),`applyHostPorts` 返回的还原函数逆序跑全部;A0 ④ 加"第一份 `voice:{}` 第二份 `voice:null` → `hasVoiceHost()` false" |
| R7 | 三个 `has*Host()` 统一为"宿主声明过"(闩)语义:`shell: {}` 也算声明(声明了一张空表是宿主自己的事,与 `voice:{}` 同);oauth 的 `openExternal` 缺席仍走结构化失败——把 `.then(() => undefined)` 吞错去掉,让失败传回 authUrl 路径 |
| R8 | 随 §2.1 改名 `ONETHING_SERVER_UNTRUSTED`,旧名别名 + 启动 warn 一次 |
| R9 | CLAUDE.md 数字改正;方案 B §4 补三行(configGet / oauth 开浏览器 / 六域在回环 server 上的放开) |
| R10 | `dispose()` 末尾清 `parts`(safe 访问器回 null);A0 ③ 加 `getStreamEngineSafe()` 为 null |
| R11 | 随 §2.1 退役 `configureHostLocalTrust` 一起消失 |

## 3. 分期与门

每期:`bun run typecheck` 零错、改动文件 eslint 零新增、定向 vitest 全绿、八道闸绿(七道 + `gate:native`)、
两条真机探针绿、每条修复至少一条反证真红。

| 期 | 做什么 | 门 |
| --- | --- | --- |
| **C0 机械修复** ✅ 已落地 | R1 的 `own()` 守卫 + 同步登记;R2;R3 / R4 / R5 / R6 / R7 / R10;R9 的数字部分 | 各自反证;A0 变 12 条全绿;`assembly:gate` 不升 |
| **C1 MCP/ACP 子系统** ✅ 已落地(2026-09-03) | `McpSubsystem` / `AcpSubsystem` + 壳/装配接线 + 设置域接线 + `initializeShellMCP` 删除;**收尾批(同日)**把 server runtime 那处也接进子系统(§2.2 偏离 1 已销账) | 在途 start → dispose 的反证(单测);真机:`smoke:core` 第三条泳道 `mcp-early-exit`,探针退出后 `pgrep -f <marker>` = 0;A0 升到 14 条;收尾批另加 `runtime-over-backend.test.ts` 两例(`processPorts:'own'` → `start` 恰好一次且 `initialize` 未被直调 / `'host'` → 都不调) |
| **C2 主体** | `Principal` + `TokenRing` + 三入口铸法 + 8 处判据改 `isOwner(context)` + `resolveRpcSandbox` + 退役进程级信任与宿主表 `localTrust` + 能力位按请求主体 + 棘轮第四族 + R8 | 每处判据 owner/client 两态单测;`isHostLocallyTrusted` 调用 0;真机:回环 server 用发现文件 token → owner 行为,用 `ONETHING_SERVER_TOKEN` 非回环 → client 行为(log:smoke 加两条) |
| **C3 文档** | CLAUDE.md IPC 一节的"第二条规则"改成主体表述;host-ports 表删 `localTrust` 行;方案 B §4 补齐 | `grep -c isHostLocallyTrusted CLAUDE.md` = 0 |

顺序 C0 → C1 → C2 → C3。C0 与 C1 都动 `backend.ts` 的 `own()` 附近,不并行;C2 独立于 C1,但先落 C1 让 C2 的
server runtime 改动面更小。

## 4. 需要拍板的(缺省已写,不说话按缺省)

1. 随机 token 在**非回环**绑定的 server 上仍算 owner(缺省:是——它只在 0600 文件里,拿到它的仍是本机用户;
   远端设备拿的是环境变量那把)。
2. `ONETHING_SERVER_FILES_SANDBOX` 改名 `ONETHING_SERVER_UNTRUSTED`,旧名保留一个版本(缺省:是)。
3. `plugins.configGet` 对 owner 的 HTTP 客户端交出原始配置(缺省:是,与设置域不同,插件配置没有密钥概念;
   要改就得给插件 schema 加 `secret` 标记,那是插件系统的一票)。

## 5. 明确不做

- 不做多客户端 token 的管理面(签发 / 吊销 / 作用域)——`TokenRing` 的形状为它留了位,但今天只有两把。
- 不动 mcp / settings 的出界脱敏。
- 不碰 `packages/renderer` / `apps/electron` / `apps/web`(Vue 已退役,只要求编译)。
