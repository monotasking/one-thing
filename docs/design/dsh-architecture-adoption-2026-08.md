# dsh 架构研究与 onething 整合路线（2026-08-13）

> 研究对象：~/data/code/deepseek-harness（DeepSeek 开源 agent harness，下称 dsh）。
> 动机：dsh 展示了三个让人眼馋的体验——(1) 每个 turn/工具调用可追踪、可 inspect（含当时的参数、结果、schema、耗时）；(2) Agent 在会话中给产品加功能、免重启立即生效；(3) 新增功能不需要横穿宿主壳文件。
> 本文回答：这三个体验各自靠什么机制撑着、onething 的差距在哪、按什么顺序整合。
> 结论先行：不重写、不引入 Cordis。三条主线（传输面统一 / 事件日志追踪 / 自进化）分别用我们已有的半成品走到底。

---

## 1. dsh 设计主线：四条支柱

1. **没有特权内核。** 运行中的 dsh 是一棵 Cordis 插件树；模型适配器、工具注册表、会话日志、agent loop 本身全是插件。产品 = 组装配方（profile 按序叠 bundle，再叠用户 patch），`--dump-config` 可打印实际配置树，任何条目可被 patch 整体替换。
2. **可逆副作用。** 每项注册（服务/事件/工具/UI）挂在 fiber 上，`dispose()` 干净解绕。这是热插拔与自进化的地基——动态插件只是"挂载时机不同的普通插件"。
3. **事件日志是唯一事实。** 每 session 一个 append-only `SessionEvent` 数组（`seq === index`，append 时打 `Date.now()`）；消息历史、token 压力、耗时、UI 卡片、trace 谱系全部是纯函数投影。运行时断言的宪法："模型可见即已记录"。
4. **能力 seam 三角。** 一项能力 = Service Definition + Provider + Consumer 一起设计。换一个 fs/进程 provider 指向远程沙箱，Bash/PTY/LSP 一并跟着搬。

### 1.1 追踪机制（体验 1 的谜底）

- **只记事实，不记结论。** 全仓无 duration/status 字段（唯一例外 hook `durationMs`）。耗时 = 投影层对 `event.time` 做差；"执行中" = call 事件尚未配到 result。层级用扁平字段（turn/step/callId）+ 括号事件；因果用 `sourceEventSeqs` 显式引用。
- **执行前先记账。** `tool/call` 在执行前落日志（arguments 存模型原始 JSON 串）。崩溃恢复 = 补账不截断（补合成 error result + `turn/end {interrupted}`）。
- **记录"当时模型看到的世界"。** `request/header` 事件按 epoch 快照当次请求的完整工具 schema 目录（仅变化时追加）。UI 展示的是那次调用时模型真实看到的 schema；拿不到就显示 unavailable，绝不伪造。
- **存储巧思**：热路径纯内存 append + write-behind 到 `session/flush` 检查点；连续流式 delta 压成 ChunkRow（seq0/time0+dt[]，~56×）；JSONL(+zstd) 与 SQLite 双后端共享一份 contract 测试。
- **UI = 第二投影。** trajectory 时间线是"纯消费者插件（no service）"；chat 与 trajectory 是同一事件窗口的两次独立装配。chat→inspect 跳转用 one-shot store handoff（写 callId 进 store、数据层 find 定位，不依赖 DOM——表格是虚拟化的）。
- **代价**：同构计时 fold 在仓库里有四份实现（host stats / token meter / client 装配器 / 时间线 layout）。

### 1.2 自进化机制（体验 2 的谜底）

动态双半插件：模型可调 `cordis_define`（注册不可变包版本）/ `cordis_run`（挂载）/ `cordis_stop`（卸载）/ `cordis_runtime_inspect`（自省）。Host 半在 vm 协作式沙箱求值（fs/网络/进程/定时器 trap 到 ctx 服务），作为受守卫子 fiber 挂载，失败立即 dispose；Client 半由宿主经 `cordis/request-run` 事件问页面要不要跑，浏览器把代码当 async 函数体求值（参数表即全部世界），走与静态插件**相同的** loader/激活门控/清理。**报错是写给模型看的教学文本**（"包名被占用，先 stop 旧 run 再跑"），连 React 渲染崩溃都回流。页面刷新后动态插件故意不恢复。文档诚实承认这不是 containment。

承重的只有四块：可逆注册、注册表驱动的 UI、模型可调的生命周期工具、教学式报错。**事件溯源、config-as-data、无内核激进主义都与此体验正交。**

### 1.3 新增功能的边际成本（体验 3 的谜底，实证）

端到端实证（含 commit 级核对）：**"零壳文件"不成立，但被压缩到"1 个新包 + 9~11 处单行登记"**：

- 功能的**行为**（host service / tool / command / projection / slot 注册 / React 组件 / 样式 / i18n）100% 收在包内；web 壳（13 个文件）对具体功能零感知。
- **传输层零手写**：host service 上 `@Remote('edit')` 装饰器 → typert generator 在构建期（tsdown writeBundle 钩子）把 TS 类型分析成编解码，产物写进包自己的 `lib/typert.host.js` + `lib/typert.remote-client.js`；生成不出严格 codec 直接 build 失败，不降级 unknown。客户端 `ctx.remote.goals.edit(...)` 是真 Service（非 Proxy）。
- **事件下行 = 一行**：`api/remotes/src/remote-events.ts` 一个 allowlist 数组，"Forwarding one more event is an entry here and nothing else"；wire 上事件名就是宿主事件名，参数原样转发。
- 手改的中心文件全部是声明式登记（bundle patch.yml 名册、package.json 依赖、tsconfig references、README 索引），90% 单行，漏了会在编译/构建期四处门禁炸掉。唯一"真中心汇编"是 `api/remotes/src/client/index.ts`（加一个 Remote namespace 改 3~4 行）。
- 两类真正零壳改动：纯 host 工具的 UI 卡片（`presentCall`/`presentResult` 返回 `card` 标签，两侧 runtime 各自映射）；Chat conversation node（Definition + keyed renderer，明令禁碰中心 dispatcher）。

---

## 2. onething 差距账本

### 2.1 壳税（量化）

同一个功能要横穿的手写平行面，共约 **6500 行**：

| 文件 | 行数 |
|---|---|
| `apps/server/src/http.ts`（每域 HTTP 路由） | 2303 |
| `apps/electron/src/preload/bridge.ts`（每域 electronAPI 暴露） | 1870 |
| `packages/renderer/platform/web.ts`（每域 fetch/SSE 对等） | 1771 |
| `packages/shared/ipc/channels.ts`（通道常量枚举） | 569 |

### 2.2 已有但荒废/局部的解药

- **`defineRouter` + `createRouterAPI`**（`@onething/core/ipc` + `apps/electron/src/preload/create-api.ts`）：定义一次 domain router、自动生成 invoke 包装——但 `packages/shared/ipc/` 40+ 域文件**零使用**，server `http.ts` 与 renderer `web.ts` 零引用。铺了一半的路。
- **`session:command` 统一通道判例**：聊天域已经证明了通用 envelope 模式——server 转发整个 command 不拆字段，desktop 走单通道 `session:command`，事件经 EventBus→IPCBridge/SSE 通用扇出。聊天加一种 command 不需要动壳。
- **插件系统资产**：双侧 teardown（CI 测试守着）、descriptor-tree UI 五锚点（`ui:render:*` 通道宿主按需重拉）、npm ledger + file: dev channel、隔离策略表。四块自进化承重墙我们已有两块半，缺"模型可调的生命周期工具"和"教学式报错"。
- **会话存储**：per-session JSONL 目录（append 型，方向兼容事件日志），但持久单位是**消息**，事件 ring buffer 重启即失——这是做不出历史 inspect 的根因。`steps`/`toolCalls` 挂在消息上的双存异味同源。

### 2.3 与 dsh 的本质差异（保留项）

- 我们的 UI 插件是 descriptor tree 纯数据，宿主永不执行插件代码——比 dsh 的协作式沙箱**更硬的安全线，保留**。表达力天花板的合法逃生门是 L3 webview（H 线，未建，攒够真实用例再拍）。
- 我们的装配是函数（`createOnethingBackend`）不是数据（patch 树）。不追求 config-as-data；追求"装配层每功能一行"。

---

## 3. 整合总路线：三条主线

> 原则：不引入 Cordis，不做大爆炸重写。每期独立可用、验收门自证（脚本/测试级，不靠人肉走查）。

### 主线 T：传输面统一（治"两侧都要做实现"——本轮最高优先）

目标线：**加一个域 = 写一个 router 文件 + 一个 backend handler 注册，三个壳零改动**（对齐 dsh 的"1 包 + 单行登记"水位）。

- **T0 通用 RPC 通道**【✅ 已落地 2026-08-14，Opus 实施 + Fable review，未提交】：试点域选定 usage（getSummary/getSession），旧线整体拔除无双轨。注册表 `src/app/rpc/registry.ts`，域名册 `src/app/rpc/index.ts`（加域=router 文件+handler 文件+此处一行）。关键发现：`RoutePayload` 原为 `JsonValue|void`，interface 无隐式索引签名导致所有域接口过不了 `extends`——这就是 defineRouter 零采用的根因，已放宽为 `unknown`（序列化契约由传输层保证）。遗留：`runtime-facade.ts` 的 `RuntimeUsageAdapter` 成死码（T1 顺手清）；设 `ONETHING_SERVER_DATA_ROOT` 的 server 读 ledger 目录语义有变（默认路径不变）。原方案：新增一条 generic envelope 通道（仿 `session:command`）：`rpc:invoke {domain, method, payload}`。`@onething/app` 起一个 dispatch 注册表（`registerRouterHandlers(router, handlers)`），Electron `@main` 与 server `http.ts` 各写**一次**通用适配器（单通道 handler / `POST /api/rpc` 单路由），不再按域加代码。preload 复用现成 `createRouterAPI`；`platformApi` web 侧写一个通用 `createRouterClient`（fetch 版）。
  验收门：一个试点域（选新近、面窄的，如 `project-dirs` 或 `spaces`）完全走新通道，desktop + web 全绿；壳文件 diff 为零。
- **T1 存量域迁移（棘轮）**：把 40+ 域逐批迁到 router 定义。上线一个 `transport:gate` 棘轮脚本：统计 `channels.ts` 常量数 / `bridge.ts` / `web.ts` / `http.ts` 行数，只许降不许升；新功能禁止再加手写通道（棘轮报新增即红）。
  验收门：棘轮基线单调下降；每批迁移后 `bun run test` + `typecheck` 全绿。

  **第一批【✅ 已落地 2026-08-14，未提交】**：棘轮 `scripts/transport-gate.mjs`（`bun run transport:gate`，`--self-test` 7 项自测，`--write-baseline` 收紧），基线 `docs/audit/transport-baseline-2026-08-14.txt`。迁了三个域：
  - `prompts`（5 方法，三壳齐全）；
  - `goal`（3 方法，原本只有 desktop——web.ts 是三个写死的错误桩；迁完 web/server 拿到真实现，这条是**顺带补齐**不是等价搬迁）；
  - `todo-plan` **数据面**（6 方法）；窗口面（open/hide/toggle/pin）与 `todo-plan:changed` 推送留在 `@main`，分界线是"**碰窗口的不迁，碰数据的迁**"。

  指标：IPC_CHANNELS 379 → 365（−14），四壳 6638 → 6474 行（−164）。

  **本批最贵的发现——「不可迁清单」的成因是同一个**：通用 RPC 信封不带 request context，而 server 侧几乎每个 adapter 都是 owner-scoped 或 sandbox-scoped 的。于是域分成三类：
  1. **可迁**：server 侧只是"换个路径存"（prompts、todo-plan 数据面）。迁移把 per-owner 分库收敛成 `<store>` 下的单库——单用户前提下是收敛，但**旧的 `owners/<uid>/<wid>/` 数据不会自动搬家**。与 T0 usage ledger 同类。
  2. **迁了会掉安全护栏**（本批**回退**，等信封带 context 再说）：`markdown`（server 有 `prepareServerMarkdownRequest` + `sanitizeServerMarkdownAsset` 的工作区沙箱）、`permission-grants`（`canRevokePermissionGrant` / `resolveServerWorkspaceGrantRoot` 的归属校验）、`files` / `project-dirs` / `spaces` 同理。
  3. **宿主原生，永不迁**：`notify`（BrowserWindow + Notification + dock）、`todo-plan` 窗口面、`interaction`（宿主把通道亲和盖成 `'ipc'`，通用化会盖错）、`app-state`（server 的 `appState.get` 是从会话库现编的合成态，不是读 `app-state.json`）。
  4. **等 T2**：带事件推送的域（`practice` 的 10 条请求 + `PRACTICE_EVENT`、`media`、`scratchpad`）——请求面本身是纯的，但值得和事件下行一起收。

  副产物：`canRevealTodoPlanDirectory()`（`app/todo-plan/store.ts`）——端口未注入时 `revealTodoPlanDirectory()` 静默成功，对内部调用无害，对一条要回给用户的 RPC 就是撒谎（迁移前 server 给的是明确的"此宿主不支持"）。谓词把那句实话留住了。
  另一处**差点掉的东西**：todo-plan 数据面迁走后，server 那个 per-owner store 连同它的 `notifyChanged` 一起没了，`/api/todo-plan/events` 这条 SSE 就断了货源。修法是 server 也去注入 `configureTodoPlanHost`（和 scratchpad 同形）——**部分迁移一个带推送的域，必须回头检查推送的货源还在不在**。

  **第二批【✅ 已落地 2026-08-14，未提交】**：迁了四个域，全部整只迁、无双轨、无部分迁移，客户端一律照 E1 判例搭在壳外（`platform/<域>-client.ts` 走通用 `platformApi.rpcInvoke`），**四壳一行未加**：
  - `channelIdentity`（8 方法）——本批收益最大的一个，而且**不是等价搬迁**：迁移前 server 的 8 条 HTTP 路由读的是 `createServerChannelIdentityApi` 自己那份 `<dataRoot>/channel-identity.json`（约 370 行手写平行实现），而同一个进程里的会话路由 / 出站回投吃的是 `@onething/app` 的 `ChannelIdentityStore`。**同一个 server 里 HTTP 面和引擎面看的是两本账**，迁完收成一本。渲染侧唯一消费者是 `ChannelsSettingsTab.vue`。
  - `agents`（5 方法）——server 侧是 per-owner 路径选择（默认 context 写的就是同一个 `agents.json`），第 1 类"换个路径存"。
  - `providers`（3 方法）与 `models`（6 方法）——两处**顺带补齐**说清楚：server 的 `providers.list` 原本返回一张写死的表，迁完读真注册表（`configureAppProviderRegistry()` 每个宿主都跑）；`providers.usage` 原本无条件抛 "requires OAuth in the desktop host"，而 headless 宿主的 token store 有 plaintext 回退、凭证在同一个 store 里，所以不再假装不支持。与第一批 `goal` 补齐 web 桩同类。

  指标：IPC_CHANNELS 365 → 343（−22），四壳 6474 → 6057 行（−417）。累计（T1 前 → 现在）：379 → 343（−36），6638 → 6057（−581）。

  连带清掉的死码：`RuntimeAgentsAdapter` / `RuntimeProvidersAdapter`（`packages/core/runtime-facade.ts`，两侧都没实现了）、`apps/electron/src/ipc/{agents,models,providers}.ts` 三个 host 工厂 + 它们的测试 + 三条 alias / package.json exports、server 那套只服务于已删适配器的模型兜底表（`localEchoModel` / `GROK_FALLBACK_MODELS` / `createFallbackModel` / `getFallbackModel*` / `providerModelConfigsForContext`）。

  棘轮改造：`headless-boundary-check.ts` 里 8 条与这四个域相关的 ownership 检查会因为"@main 文件不见了"变红。修法照第一批 prompts 的判例——三条 `checkElectronHostOwns{Agents,Providers,Models}IpcHost` 改写成**反向**检查（`check{Agents,Providers,Models}DomainRidesTheRpcChannel`：旧文件复活 / channels.ts 常量回来 / router 或域 handler 缺失 / 装配点漏登记，任一即红），五条 `checkRuntimeOwns*` 把 `mainFile` 指针从 `@main/ipc/*.ts` 改指 `app/rpc/domains/*.ts`——守的还是同一件事：**适配器不许把 runtime 拥有的那套流程再抄一遍**，只是适配器换了地址。

  **本批新增的不可迁记录**（都实际读过代码后放弃，不是猜的）：
  - `scheduler`（9 方法）——**server 自己跑着一个活的 per-owner `Scheduler`**（`getSchedulerRuntimeForContext`：注册 taskHandles、`runServerSchedulerAgentTask` 直接驱动 backend 起会话）。而 `@onething/app` 的 `getScheduler()` 在 server 上**从来没被 `configureAppScheduler()` 装配过**。迁过去等于把定时任务交给一个没启动的调度器——不是路径变了，是功能没了。归第 3 类（宿主持有活对象）。
  - `variables`（3 方法）——server 的 `getVariableRuntimeForContext` 不只是个 store：它同时接着 search providers、会话变量快照广播（`session:variables-updated`）和 `sanitizeServerVariablesFile` 的工作区路径夹紧。第 2 类 + 第 3 类兼有。
  - `skills`（6 方法）——server 有 `"Skill path must stay inside the owner skills root"` 这条明确的归属校验 + `ensureServerSkillsDirectories` 的 per-owner 根目录。第 2 类（迁了会掉安全护栏）。
  - `acp`（8 方法）——server 上是刻意的桩（`ServerACPManager` 永远返回 disconnected）；迁过去会让 server 拿到真 `ACPManager`，即**凭一条 HTTP 请求在服务器上拉起外部 agent 子进程**。这不是传输面该顺手做的决定。
  - `mcp`（16 方法）——server 有自己的 `HeadlessMCPManager` + `mcp-client.ts`，与 desktop 的 `MCPManager` 是两套生命周期。同 acp，归第 3 类。
- **T2 事件下行统一**：非会话域的零散事件推送收敛到 EventBus + **单一 allowlist 文件**（对齐 dsh `remote-events.ts`："加一个事件 = 这里一行"）。IPCBridge 与 SSE 共用同一份转发表。
  验收门：allowlist 之外无 `webContents.send` / SSE 手写事件（脚本扫描）。
- **T3 收尾蒸发**：`channels.ts` 只剩少数真特殊通道（流式/二进制/窗口管理），`bridge.ts` 收敛为 router 循环 + 特例区，`web.ts`、`http.ts` 同理。
  验收门：四文件合计行数 < 原 6500 的 1/3；CLAUDE.md"加 IPC 五步"章节改写为"加 router 两步"。

### 主线 E：事件日志与追踪（体验 1）

- **E0 请求快照事件**【✅ 已落地 2026-08-14，Opus 实施 + Fable review（修复 enabled 永久缓存漏账）；同日格式修订：工具目录拆成独立事件】：**七种**事件（tools/header/start/first-token/tool-call/tool-result/end）落 `sessions/<id>/events.jsonl`；纯编解码在 `src/sessions/session-events.ts`，写入口 `src/app/session/event-log.ts`（**永不 mkdir**——只往已存在的会话目录追加，未启用会话每次 append 重查一次目录、出现即接上），采集器挂 agent-loop 同步 `onEvent`（工具 enqueue 前记账）。读取器 `readSessionEvents` + `resolveToolCallInspection` 是 E1 地基。

  **格式修订（落盘前，零迁移成本）**：原设计把工具 schema 目录塞在 `request/header` 里，与 system 指纹共用一个去重键。实测（`~/.onething/log/provider-requests` 采样）目录序列化 ~40KB 且会话内恒定，而 system prompt 会话内**会变**（变量/上下文注入）——于是 system 每变一次就陪葬一份没变的 40KB，50 轮的会话就是 ~2MB。改法：新增 `request/tools`（`{requestIndex, toolsHash, tools}`，目录正文只此一份），`header.tools` 换成 `toolsHash`（`hashSessionEventTools()` 对数组 `JSON.stringify` 后取 sha256 前 16 位；不做键排序，前提是目录按注册顺序生成、一次装配内稳定，写在函数注释里）。两者**各自独立去重**：system 变只写 ~230B 的 header，目录变才写那 40KB；同一 turn-start 内先写 tools 后写 header（读侧不依赖此序，但顺序对的日志人也能顺着读）。recorder 新增 `lastToolsHash`，跨重启从文件里那条 `request/tools` 的 `toolsHash` 字段恢复（不重算大数组）。`resolveToolCallInspection` 的 schema 改从「seq ≤ call.seq 的最后一条 `request/tools`」取——「历史调用解析到当时那份」的语义**不变**，只是换了取处；拿不到仍是 undefined，不回填。轨迹面板组头的工具数同样改成往回找 `request/tools`，拿不到显示 `unavailable`（`TrajectoryGroup.toolCount` 由 `number` 改成 `number | undefined`——不用 0 冒充「一个工具都没有」）。50 轮会话量级：~2MB → ~64KB。

  遗留：legacy-json 新建会话不记、非 agent-loop 旧流路无采集、中断回合无 `request/end` 补账。原方案：每次 provider 请求落一条持久 `request/header` 型事件（provider/model、system 指纹、当次工具 schema 目录、时间戳），仅信封变化时追加。落在现有 per-session 目录里新增 `events.jsonl`（纯增量，不动 `messages.jsonl` 读路径）。工具 call/result、step 开始、首 token 的时刻一并入事件（只存时刻，不存时长）。
  验收门：store 级测试——重放 events.jsonl 能重建任意历史调用的 (参数, 结果, 当时 schema, 起止时刻)。
- **E1 轨迹面板**【✅ 已落地 2026-08-14，Opus 实施 + Fable review，未提交】：`sessionEvents` 域骑 T0 通道上线，**四壳零改动实证成立**（客户端搭在壳外 `platform/session-events-client.ts`，走通用 `platformApi.rpcInvoke`——比"壳里各加一行"更贴目标水位，后续域照此办理）；域 handler 带 sessionId 路径穿越守卫（server 上是开放网络输入，与 media:// 同纪律）；面板=panel-registry `trajectory` + `TrajectoryPanelContent.vue`（PanelShell、左 ledger 右 inspector、主表零 token、Schema unavailable 不回填）；跳转=`workspace/trajectory-inspect.ts` one-shot ref（取即清、数据层定位）。遗留：Result 只有 500 字预览无全文读路、配对逻辑 runtime/renderer 各一份未共享（共享需先把纯配对从含 node:crypto 的模块拆出）。原方案：RightWorkbenchPanel 加"轨迹"工作区 tab（PanelShell 骨架），消费 events.jsonl 做第二投影：ledger 表 + inspector（Payload/Result/Schema/Timing 分 tab）。聊天工具卡片加 Inspect 入口，one-shot store handoff（写 callId → 切 tab → 数据层定位 → 用完即清）。主表不显示 token/耗时（留给 inspector）。schema 拿不到显示 unavailable，不回填。
  验收门：点击任意历史 tool call 可 inspect；跳转不依赖 DOM（数据层定位测试）。
- **E2 时间线**【✅ 已落地 2026-08-14，未提交】：条带从**同一份投影**派生（纯函数 `deriveTrajectoryTimeline(groups, mode)` 在 `packages/renderer/workspace/trajectory-projection.ts`，输出 0..1 相对位置 + 请求组边界刻度；面板只把比例落成 CSS，不量 DOM）。两档：`sequence` 等宽（一操作一格）/ `duration` 真实时间轴（组间空闲 > 2s 压成固定 400ms 轴量并留 `skippedMs` 记号）。assistant 按首 token 切「等待 / 生成」两段，缺首 token 退单段、缺 `request/end` 退开区间；时长仍全部现算，零 duration 字段。档位记忆 `onething.trajectory.timelineMode`（`workspace/trajectory-timeline-mode.ts`，投影层保持纯）。条带 ↔ ledger 选中双向同步；tooltip 是面板内绝对定位层（不 Teleport）且**只在 hover 时格式化**。顺带修一个 E1 遗留：`.trajectory-split` 的 `@container` 断点查的是自身而非祖先容器，从未生效（窄面板列没并成一列），根上补了面板级容器。遗留：并行工具不做泳道分配（同组重叠工具画在同一条 tools 泳道上会互相压）、`TrajectoryTickRow` 新增的 `tickKind` 只有条带在消费。原方案：轨迹面板加时间条带（序号等宽 / 真实时长两档起步；assistant span 按 TTFT 分段）。
- **E3（远期，单独拍板）消息即投影**：事件日志升格为唯一事实、消息成为派生。收益含根治 steps/toolCalls 双存。前置条件：E0-E2 的 events.jsonl 已有真实消费者，且 chunk 体积方案（打包/压缩）验证过。

### 主线 S：自进化（体验 2）

- **S0 生命周期工具**：`plugin_scaffold`（生成 dev channel 插件骨架）/ `plugin_mount` / `plugin_unmount` 会话内工具，走现有 npm ledger file: 通道；挂载即生效（descriptor tree 锚点本来就是运行时拉取）。
- **S1 教学闭环**：插件加载/守卫/降级错误全部改写为模型可读的教学文本进工具结果（含"下一步该调什么"）；新增 `plugin_inspect` 自省工具（已挂载插件、锚点占用、降级原因、配额）。
- **S2 天花板评估**：攒真实"现场加功能"用例，统计 descriptor tree 撞墙率，再拍 L3 webview 建不建。**在此之前不打破"宿主不执行插件代码"。**

### 依赖与推荐顺序

```
T0 ─→ T1 ─→ T2 ─→ T3        （T 是地基：让"加功能"本身变便宜）
E0 ─→ E1 ─→ E2 ─┈→ E3      （独立于 T，可并行；E1 面板若在 T0 后做会更省）
S0 ─→ S1 ─┈→ S2             （独立；S1 的 inspect 工具受益于 E0 的事件）
```

建议启动顺序：**T0 + E0 并行**（都是小而硬的地基件），然后 E1（最快让"惊艳体验"可见）、T1（还债棘轮化后台推进）、S0/S1。

---

## 4. 明确不采纳（及理由）

| 不做 | 理由 |
|---|---|
| 整体迁移 Cordis / 重写为插件树 | 219 包规模的世界观移植，代价配不上目标体验；四条支柱可分别用现有架构达成 |
| 模型代码在 UI 求值（dsh client 半模式） | 放弃"宿主不执行插件代码"的安全线换表达力，不值；先走 descriptor tree + L3 评估 |
| config-as-data 全套（profile/patch 树） | 我们单产品单装配，收益低；目标降为"装配层每功能一行" |
| span/duration 显式追踪字段 | 学 dsh：只存时刻事实，时长永远派生 |

## 5. 研究材料索引

- dsh 权威文档：`docs/architecture.zh.md`、`docs/agent-lifecycle.zh.md`、`docs/tool-execution-pipeline.zh.md`、`docs/cookbook/*`、`packages/client/AGENTS.md`
- dsh 设计笔记：`.agents/notes/implemented/architecture/`（event-sourced-sessions、typert-remote-method-calls、remote-event-delivery、trajectory-conversation-context-assembly 等）
- 本仓对照物：`@onething/core/ipc`（defineRouter）、`apps/electron/src/preload/create-api.ts`、`session:command` 链路、插件系统（`docs/design/plugin-system-redesign-2026-08.md`）
