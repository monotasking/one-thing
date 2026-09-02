# 装配层组合根(方案 A,2026-09-02)

来源:`docs/audit/backend-design-patterns-review-2026-09-02.md` §6 的路线 A,用户 09-02 拍板"做 A"。
本文是施工方案。姊妹审计里的 §2.1(能力只挂在 Vue 宿主)、§2.2(装配是全局脚本)、§2.3(关机不对称)
是它要消掉的三条;`server/runtime.ts` 的内嵌面链上/覆盖逻辑**不在本方案里**(那是路线 B 之后的事,见 §6)。

## 0. 一句话

`createOnethingBackend` 从"往模块全局变量里塞东西的 35 步函数"变成"构造一个 `OnethingBackend` 实例":
装配产物是实例的字段,宿主能力是构造时必须整个交出来的一个对象,关机是实例的 `dispose()`。
121 个 `getXxx()` 访问器**保留**,但它们不再各自持有一份 `let`,而是读"进程当前实例";
一个进程里已有活实例时再装配一次,**抛错**而不是静默返回第一份。

## 1. 现状(施工前的事实,已核对)

- `packages/backend/backend.ts:145-297`:35 步,0 步把上一步产物当参数传给下一步;`getSettings()` 79 个调用文件、`getEventBus()` 46 个。
- 三个单例模块各持一份 `let`:`events/index.ts`(eventBus / streamChannel)、`session/index.ts`(转给 core 的 `getCoreSessionManager`)、`wiring/engine/index.ts`(streamEngine / onethingRuntime)。三者的 `initializeX` 都是"已存在 → warn → return"。
- 宿主注入:74 个 `configure*` 单槽端口,其中**宿主实现的**约 16 个(见 §3.2 表),其余是装配层内部的适配绑定(`configureApp*` 11 个)与 server 专用槽。未注入 0 抛错。
- 四个宿主各自调用:Vue 桌面 37 处、React 壳 10 处、server 与 daemon 只传 `sandboxHost`。
- 关机:`backend.shutdown()` 关 18 件;daemon 手写 16 行少 8 件;`stopTodoPlanWatcher` 零调用;用户调度器无 stop;`LogDirJanitor` 定时器在宿主的 `configureLogging` 里,不归 backend。
- 测试:全仓没有测试真正调用 `createOnethingBackend`。

## 2. 目标形状

### 2.1 实例

```ts
// packages/backend/backend.ts
export class OnethingBackend {
  readonly eventBus: EventBus
  readonly streamChannel: StreamChannel
  readonly sessionManager: SessionManager
  readonly engine: StreamEngine
  readonly runtime: MainOnethingRuntime
  readonly options: Readonly<OnethingBackendOptions>

  static async assemble(options: OnethingBackendOptions): Promise<OnethingBackend>

  /** 谁起了一件会留尾巴的东西,谁把收尾登记进来。dispose 按登记逆序执行。 */
  own(disposer: () => void | Promise<void>): void

  /** 幂等;逆序跑完 own() 登记的全部 disposer,再清掉进程当前实例槽。 */
  dispose(): Promise<void>

  /** @deprecated 过渡别名 = dispose() */
  shutdown(): Promise<void>
}

/** 过渡别名,四个宿主的调用点先不改名。 */
export const createOnethingBackend = (o: OnethingBackendOptions) => OnethingBackend.assemble(o)
```

`assemble` 内部仍是今天那 35 步的顺序,区别只有两点:每一步的产物落成局部变量并直接传给下一步
(`initializeSessionLayer(eventBus, streamChannel)` 而不是让它自己 `getEventBus()`);每一步留下的尾巴用
`own()` 登记,`dispose()` 不再手抄一份清单。

### 2.2 进程当前实例槽(唯一保留的全局)

```ts
// packages/backend/current.ts  —— 整个 backend 里唯一允许的模块级 let
let current: BackendHandle | null = null
export function setCurrentBackend(b: BackendHandle | null): void
export function getCurrentBackend(): BackendHandle      // 没有 → 抛 BackendNotAssembledError
export function getCurrentBackendSafe(): BackendHandle | null
```

`BackendHandle` 是一个只含字段的窄接口(eventBus / streamChannel / sessionManager / engine / runtime),
不是类本身,避免 `events/index.ts` ↔ `backend.ts` 成环。

三个单例模块改成薄委托,导出名一个不变:

```ts
// events/index.ts
export function getEventBus() { return getCurrentBackend().eventBus }
export function createEventSystem(): { eventBus: EventBus; streamChannel: StreamChannel }  // 纯工厂,不碰全局
// initializeEventSystem / shutdownEventSystem 删除(只有 backend.ts 与 daemon 在调)
```

`session/index.ts`、`wiring/engine/index.ts` 同样:`createX(deps)` 纯工厂 + `getX()` 读当前实例。
`getStreamEngineSafe()` 保留,读 `getCurrentBackendSafe()?.engine ?? null`。

**二次装配**:`assemble` 第一行 `if (getCurrentBackendSafe()) throw new BackendAlreadyAssembledError()`。
这是本方案唯一一条行为改动,且只影响开发者(今天这条路静默返回第一份、shutdown 会把两份一起关,是 bug)。

### 2.3 宿主端口聚合

```ts
// packages/backend/host-ports.ts
export interface OnethingHostPorts {
  storePath: StorePathHost                    // 必填,不可 null(没有它 store 都找不到)
  sandbox: SandboxHost                        // 必填,不可 null
  auth: AuthHostPorts | null                  // null = 没有凭证加密能力(今天 server 的处境)
  logging: AppLoggingHostPorts | null
  shell: ShellHostPorts | null
  voice: VoiceRuntimeWindowPorts | null
  skillsEnvironment: SkillsEnvironmentHostPorts | null
  todoPlan: TodoPlanHostPorts | null
  scratchpad: ScratchpadHostPorts | null
  plugins: PluginsHostPorts | null
  gateway: GatewayHostPorts | null
  settings: SettingsHostPorts | null
  evals: EvalsHostPorts | null
  mcp: { clientFactory: MCPClientFactory | null; identity: { name?: string; version?: string } } | null
                                              // clientFactory null = 用内置 MCPClient(今天的缺省);mcp 整个 null = 不接 MCP
}
```

**每一项必填,但允许显式 `null`。** 这是本方案的关键取舍:宿主"没有语音"是合法的,但必须写出来
`voice: null`;漏写一项是 `tsc` 错误。运行时 `null` 走今天已有的降级路(结构化拒绝或 noop),
不新增任何降级行为。`assemble` 第一步 `applyHostPorts(options.host)` 把它们逐个交给现有的
`configure*` 函数——那 16 个函数本身不改,只是不再由宿主直接调。

`OnethingBackendOptions` 改成:

```ts
export interface OnethingBackendOptions {
  host: OnethingHostPorts            // 新增,必填
  toolRegistry?: 'full' | 'headless' | 'readonly'
  promptVersion?: boolean
  sessionSkills?: boolean
  collab?: boolean
  mcpAcp?: boolean
  sender?: BindableStreamSender
  hooks?: OnethingBackendHooks       // 不动
}
// sandboxHost 字段删除,并入 host.sandbox
```

不进聚合的 `configure*`(留在原地,由 backend 自己调或 server runtime 调):`configureApp*` 11 个内部绑定、
`configureServer*Port` 3 个 server 槽、`configureLogging`(宿主在装配**之前**调,它产生日志文件与
janitor,寿命比 backend 长,归宿主)、`configureGlobalWindowShortcuts` / `configureBrowserWindowProvider` /
`configureDeepLinkService` / `configureVoiceTray`(窗口系统,归壳)。

### 2.4 关机对称

规则一句话:**谁起的,谁 `own()`。** `assemble` 内部起的东西在起的那一行紧接着 `own()`;
宿主在装配后起的东西(内嵌 HTTP 面、用户调度器、todo/草稿纸 watcher、MCP)由宿主调 `backend.own(...)`。
`dispose()` 逆序执行,每个 disposer 单独 try/catch 并记 error,不让一个失败挡住后面的。

需要新增 stop 口的:`initializeUserSchedulerTasks` 对应的 `stopUserSchedulerTasks`(`runtime/src/scheduler/`
今天没有);其余(`stopTodoPlanWatcher` / `stopScratchpadWatcher` / `stopEmbeddedOnethingHttpServer` /
`MCPManager.shutdown`)已存在只是没人调。

四个宿主的关机路统一为 `await backend.dispose()`:daemon 删掉 `headless/backend.ts:123-152` 的手抄清单;
Vue 桌面的 `beforeQuit` 表里凡是 backend 已关的行删掉(窗口/托盘那些留着);React 壳与 server 已经是。

### 2.5 布尔闩

26 个模块级单向闩分两类处理:
- **纯适配注册**(`configureApp*` 那 11 个,把 runtime 的端口指向 backend 的实现,无状态):保持幂等,不动。
- **持有状态的**(`providerRegistryInitialized`、`bootstrapped`、`builtinTriggersRegistered`、`skillsLoaderConfigured` 等):
  改成"注册时返回 disposer,`own()` 进实例",dispose 时清掉,让 assemble → dispose → assemble 真的重跑。
  A3 逐个审,审出来的清单写进 A3 的提交说明。

## 3. 分期与门

每期结束:`bun run typecheck` 零错、`bun run lint:ci` 零新增、`bun run test` 全绿、五道闸
(`boundary:gate` / `session:gate` / `transport:gate` / `log:gate` / `ui:gate`)全绿,外加本期自己的门。
真机门用两条既有探针:`apps/desktop-react/scripts/smoke/core-boot-probe.ts`(壳装配到 ready)
与 `bun run log:smoke`(server 起在临时 store 上)。

| 期 | 做什么 | 门(自证) |
| --- | --- | --- |
| **A0** | 新建 `packages/backend/__tests__/assembly-lifecycle.test.ts`:临时 store(`ONETHING_STORE_PATH`,照 `server/__tests__` 先例),最小 options(`toolRegistry:'headless'`,不开 collab / mcpAcp / sessionSkills)。断言:① 装配后 `engine` / `eventBus` 可用;② **不 dispose 直接二次装配 → 抛错**(今天静默,这条现在是红);③ dispose 后 `getEventBus()` 抛;④ dispose → 再装配得到**新的** eventBus 实例(`not.toBe`);⑤ 第二份 dispose 干净。 | ② 在 A0 提交时**红**(记进提交说明),A2 变绿。其余四条 A0 即绿 |
| **A1** | `host-ports.ts` 聚合接口 + `applyHostPorts()`;`OnethingBackendOptions.host` 必填、删 `sandboxHost`;四个宿主改成传对象——React 壳把它没有的能力**显式写 `null`**;Vue 桌面把 `main-process.ts` 里 16 个 `configure*Host` 调用搬进对象;server 与 daemon 补齐(大多是 `null`)。 | `tsc` 零错本身就是门:任何宿主少一项编译不过。再加一个类型测试文件用 `// @ts-expect-error` 钉"缺 `voice` 键不过" |
| **A2** | `OnethingBackend` 类 + `current.ts` + 三个单例模块改薄委托 + `own()` / `dispose()` + 二次装配抛错 + `createOnethingBackend` 别名;四宿主改调 `dispose()`,daemon 手抄清单删除。 | A0 的 ② 变绿;`grep -c '^let ' packages/backend/{events,session,wiring/engine}/index.ts` = 0 |
| **A3** | 关机对称收尾:`stopUserSchedulerTasks` 新增;宿主起的服务在起的地方 `backend.own()`;26 个闩逐个审并处理;新增 `scripts/assembly-gate.mjs`(`bun run assembly:gate`):统计 `packages/backend` 非测试文件里模块级 `let` 数,基线 = A2 结束时的数,**只许降**。 | A0 全绿;`assembly:gate` 绿;真机两条探针绿;`ps` 扫不到 dispose 后残留的定时器(用 `why-is-node-running` 或 `process.getActiveResourcesInfo()` 在测试里断言 dispose 后无新增 Timeout) |
| **A4** | CLAUDE.md:`createOnethingBackend` 一节按新形状重写(options 表、`OnethingHostPorts` 表、`own/dispose` 规则),宿主表补 React 壳,`configure*Host` 端口表改成"在聚合里的 / 留在外面的"两栏。**只改 A 触到的段落**,会话存储那段过期文字另开一票。 | 文档与代码同一提交;`grep sandboxHost CLAUDE.md` = 0 |

顺序严格 A0 → A1 → A2 → A3 → A4,每期一个提交。A1 与 A2 都动 `backend.ts`,不并行。

## 4. 明确不做

- 不迁移 121 个 `getXxx()` 的调用方(79 + 46 + … 个文件)。它们继续工作,只是底下从"各自的 let"变成"当前实例"。把调用方改成显式传参是后续每个域自己的事。
- 不动 `server/runtime.ts` 的内嵌面链上/跳过/覆盖逻辑,只把 `createRealServerBackend` 改成新 options 形状。
- 不把插件 / 语音 / 网关等接进 React 壳——A 让"没接"从静默变成 `voice: null` 这行代码,接不接是产品决定。
- 不改 `configureLogging` 的归属。
- 不动 `stores/sessions.ts` / `stores/settings.ts` 的模块级仓库实例(它们在 import 时创建,寿命等于进程;改它们要先解 `stores ↔ session/commands` 的环,不在 A)。

## 5. 风险与回退

- **风险 1:三个单例模块改薄委托后,某个调用方在 `assemble` 中途(实例还没 `setCurrentBackend`)就调 `getEventBus()`。** 对策:`assemble` 在第 10 步(事件系统建好)后立刻 `setCurrentBackend(partialHandle)`,句柄字段用 getter 按需暴露,没建好的字段访问抛 `BackendNotAssembledError('engine')`,与今天各模块"未初始化就抛"语义一致。A0 的 ① 会抓住这类回归。
- **风险 2:Vue 宿主的 `beforeQuit` 表裁掉后漏关窗口系统的东西。** 对策:只删与 `dispose()` 重复的行,窗口/托盘/网关行原样保留;Vue 宿主按用户口径已退役,只要求编译通过与 `main-process` 的既有测试绿。
- **风险 3:`current.ts` 成为新的"全局"。** 它是有意保留的唯一一个,`assembly:gate` 只对它豁免。
- 回退:每期一个提交,任一期红就 `git revert` 该期。A0 的测试文件独立,可以先留着当红灯。

## 6. 与 B / C 的接口

B(transport 分叉改端口)要的是 `OnethingHostPorts` 里再加 `terminal` / `voice` / `plugins` 的"有没有"判据——
A1 的聚合接口就是那张表,B 只是让 RPC 域读它而不是读 `context.transport`。内嵌面的链上/覆盖逻辑要等
`server/runtime.ts` 能拿到"自己的实例"才能消失,那要先把它对 `getX()` 的 15 处 owner 分片读法改成读实例,排在 B 后。
