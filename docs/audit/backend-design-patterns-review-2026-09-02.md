# 后端设计评估:分层、模式、可扩展性(2026-09-02)

姊妹篇:`backend-architecture-review-2026-09-02.md` 讲"哪里坏了";本篇讲"这套设计是什么、模式用得对不对、
往哪个方向扩要碰几处"。不评功能接没接全。数字来自同一批脚本,补充读数见 §5。

---

## 0. 一句话判断

**内核设计得像框架,装配层写得像脚本。** `packages/core` 有 932 个接口、2 个抽象类、62 个类,是接口驱动的;
`packages/backend` 有 23 个类对 971 个导出函数,是过程驱动的;中间的 `runtime` 181 个类对 2112 个函数。
产品层与内核层的抽象(注册表、事件溯源、命令/reducer、plan→apply 工具、Wire×Dialect)是对的,可扩展性差在装配层:
**没有一个拥有子系统的对象,宿主接入靠 74 根散线,两套依赖注入风格并存。** 设计模式上真正缺的只有一样:
组合根(composition root,一个集中创建并持有全部对象的地方)。补上它,姊妹篇 §2.1 / §2.2 / §2.3 与内嵌面的
"链上/覆盖/跳过"三种语义一起消失。

---

## 1. 骨架:它是哪种架构

- **分层六边形**(ports & adapters):core ← runtime ← backend ← apps,依赖单向,五道 checker 守着,层间不变量全 0。
- **事件溯源 + 投影**:`events.jsonl` 是唯一账本,`projectChatMessages` / `projectModelHistory` 是投影,`canonical.ts` 是唯一尺。
- **命令面 / 读面分离**(CQRS 雏形):`sessionCommands`(12 命令 + core 纯 reducer,COW)与 `sessionReads`(全 readonly)。
- **事件总线**:core 泛型 + backend 27 行绑定,每会话环形缓冲,16ms 合批扇出到 IPC 与 SSE。
- **注册表驱动扩展**:工具目录、提示词源、RPC 域、插件注册表、feature 挂载表、触发器,每张表"重复 id 抛错"。
- **装配 = 服务定位器**(service locator):74 个 `configure*` 单槽端口 + 121 个零参 `get*()` 进程级访问器 + 26 个单向布尔闩。

前五条是框架级设计,第六条是脚本级实现。它们之间的缝就是全部问题所在。

---

## 2. 模式清单:在哪、用得好不好

| 模式 | 在哪 | 读数 | 评价 |
| --- | --- | --- | --- |
| 分层 + 包按环境 | 四包 + checker | 层间违例 0;`shared` 反向 34 处;backend 内 49 文件真环 | 骨架成立,靠闸守住。`shared` 反向和 backend 内环是闸没覆盖的两个方向 |
| 端口与适配器(构造注入) | `CoreStreamEngineRuntime` 12 槽;`runtime/engine/ports.ts` 5 个可选端口;core 932 接口 | `core-stream-engine.ts` 只读 `this.runtime.*`,不碰全局 | **用对了**。核心引擎可以在测试里用假槽整个实例化 |
| 端口与适配器(全局单槽) | 74 个 `configure*`,7 个域各自的 `*HostPorts` 接口,无聚合类型 | 未注入 0 抛错;`configureMCPClientHost` 未注入 = 真连 | **变成了服务定位器**。同一件事(宿主能力)在引擎里是构造参数、在其余地方是全局变量,两套风格并存 |
| 模板方法 + 继承 | `CoreStreamEngine` 12 个 protected 钩子 → `ProductStreamEngine` 覆盖 4 个;`HeadlessMCPManager` → `MCPManagerClass`;`HeadlessBackend` | 覆盖点克制 | 用得节制。问题在"核心"本身太胖:`core-stream-engine.ts` 2023 行、`agent-loop-executor.ts` 2748 行,钩子只有 12 个,余下 1800 行对子类是死板的 |
| 事件溯源 + 投影 + 单尺 | `core/session/{events,projection}` | reducer 1770 行;`ChatMessage` 31 字段里 6 个派生字段仍在类型上(`DERIVED_KEYS`) | 全仓最"有设计"的部分,方向正确。代价是类型层还没跟上(派生字段该是投影类型,不是账本类型) |
| 命令面 / 读面 | `backend/session/{commands,reads}.ts` + `core/session/commands.ts` | `session:gate` 0;`stores/sessions.ts:29 ↔ session/commands.ts:66` 两跳环 | 闸守住了"谁能改消息",但**命令面与仓储互相持有**,说明还没定"谁拥有谁":仓储该是命令面的依赖,不该反过来 import 它 |
| 事件总线 + 环缓冲 + 合批 | `core/events` + `backend/events` | 绑定 27 行,独有 757 行,0 重复 | 干净 |
| 注册表 | 工具 Catalog→Surface;PromptSource ×6;RPC 域 ×42;plugin `Core*Registry` ×7;feature mount;triggers | `register*` 导出函数 core 4 / runtime 19 / backend 18 | 是这个仓最主要的扩展手段,做得一致。但**两套"带界面的产品功能"扩展机制并存**:`features/`(cordis 挂载表,只有 self-evolution 与 trajectory 两个内置)与 plugins(core 15341 行契约)——同一个问题两个答案 |
| 策略 / 配方 | provider Wire×Dialect:17 wire × 23 dialect;credential-strategy;thinking 六档 | 加 grok 触 runtime 27 文件(wires 8 / dialects 7 / thinking 4 / providers 3 / auth 1 / base 1 / 顶层 2) | 抽象方向对(传输格式与厂商方言分离,08-22 重建成果),但**没有一个 Provider 聚合把四个子目录收在一起**,加一家厂商要跨四个目录改 |
| plan → apply + 效果类权限 | `core/toolkit`:`Tool { plan → apply }`,`Intent.effects`,10 个 family 基类,19 个工具 | 加 `web_open` 触 3 文件 | **最好的扩展轴**。权限只看效果类,不看工具名,是真正的开闭 |
| Actor 模型 | `runtime/collab/actors`:room / agent / referee actor + `*-rules.ts` + protocol | runtime/collab 5 类 / 373 函数;`wiring/collab/actors/runtime.ts` 1863 行 | "actor" 是名字,实现是过程式规则表 + 一个调度中心;调度中心与 engine 互环(49 文件真环的核心) |
| `*-bound.ts` 单例绑定 | 14 个 | 纯模块一文件 + 进程单例绑定一文件 | 仓自创的模式,"把纯逻辑和进程状态拆开"想法对,但把单例复制了 14 次而不是收进一个容器——它是组合根缺席的症状 |
| `*.wiring.ts` 文件名承载角色 | 32 个 | 违例 0 | 靠命名约定 + checker,成立。文档只列了 10 个 |
| 门与棘轮 | boundary / session / transport / log / ui / squeeze / a11y | 全绿 | 治理模式成熟,是 27 万行还能改的原因;缺口是没有一道门管"装配"(见 §3 加宿主) |

---

## 3. 可扩展性:按扩展轴看要碰几处

| 扩展轴 | 机制 | 要碰 | 有闸? | 评分 |
| --- | --- | --- | --- | --- |
| 加一个工具 | `Tool` 子类 + 目录登记,权限走效果类 | 3 文件(`toolkit/builtin/x.ts` + family + catalog) | 目录测试钉三档同集 | ★★★★★ |
| 加一段提示词 | `PromptSource` 或 `registerPromptFragment` | 1 文件 | 快照基线 | ★★★★★ |
| 加一个 RPC 域 | `defineRouter` + `rpc/domains/<d>.ts` + client | 3 文件 + exports 键 | 重复域抛错;`transport:gate` | ★★★★ |
| 加一个 UI 壳 | HTTP/SSE + `POST /api/rpc` | 壳自己;React 壳 437 行 main 已证明 | 能力位与后端护栏两套判据 | ★★★★ |
| 加一种插件能力 | `core/plugins` 契约 + `PLUGIN_DEFERRED_REGISTRIES` 明确"哪些不开、为什么" | 契约 + 注册表 + 政策表 | 断路器 + 拆卸测试 | ★★★★ |
| 加一种传输 | 泛型 RPC 已收口 | 13/42 域里每个 `transport` 分叉都要再判一次 | `transport:gate` 数不到新壳的 `host:connection` | ★★★ |
| 加一家 provider | Wire×Dialect | runtime 27 文件 + shared 2 + UI 4 | wire 快照测试 | ★★ |
| 加一个子系统 / domain | `wiring/<d>` + `runtime/<d>` + exports 键 + `backend.ts` 一行启动 + 一行关机 + 可能的 rpc 域 | 5-6 处,没有接口约束(`features/` 有 `mount/unmount` 契约但只 2 个用) | 无 | ★★ |
| **加一个宿主** | 74 个 `configure*` 逐个调,无聚合接口、无清单、无缺失检查 | React 壳 437 行只接上 10 件 | **无**——漏接一根线是静默 | ★ |

结论:**越靠近内核的扩展轴越好,越靠近装配的越差。** 这与 §0 的判断一致。

---

## 4. 模式之间打架的地方(设计层的真问题,按优先级)

1. **两套依赖注入并存。** 引擎走构造注入(12 槽 + 5 端口),其余 74 个能力走全局单槽。同一个 MCP,`backend.ts` 用 `configureMCPClientHost` 全局注入,而 12 槽里没有它。后果是引擎可以在测试里整个实例化,backend 不能(全仓无测试调用 `createOnethingBackend`)。这是**组合根缺席**的直接表现。
2. **单槽端口的"链上 / 跳过 / 覆盖"三种语义是模式本身逼出来的。** 全局单槽只能容一个实现,第二个宿主(桌面内嵌 HTTP 面)只能靠手工 chaining 模拟"多实例":4 个链上、5 个跳过、3 个无守卫覆盖,零测试。有组合根就没有第二个宿主要"抢"同一个槽的问题——它拿到的是自己的实例。
3. **`transport` 分叉把宿主能力写成了传输属性。** voice 11/11、terminal 7/7、plugins 18/19 整域二分,判据说的其实是"这台机器有没有外设",与 `configureShellHost` 那种端口是同一类事,却用了另一种机制。React 壳走 http 就永远拿假态,不是因为它没有终端。
4. **命令面与仓储互相持有。** `stores/sessions.ts ↔ session/commands.ts` 两跳环。CQRS 的前提是仓储在命令面之下。
5. **引擎劈成三层还共用 7 个文件名。** core / runtime / wiring 各一份 `agent-loop-executor` 等;wiring 那份直接 import `IPC_CHANNELS`。"core 引擎"2000+ 行不是内核,是全部逻辑加 12 个钩子。I2 不变量只管 core 对 runtime,不管 core 对 wiring。
6. **两套产品功能扩展机制。** `features/`(cordis,内部)与 plugins(外部)对"带界面的功能"各给一个答案,前者只有两个使用者。要么 features 成为 plugins 的内部形态,要么退役其一。
7. **provider 没有聚合根。** 抽象是对的,但 wire / dialect / thinking / providers / auth 五处各管一段,加一家要跨五个目录。一个 `Provider` 对象把 dialect + wire + thinking 档 + 凭证策略收在一起,加一家就是一个文件。
8. **logging 当 domain 放。** 横切设施住在 `wiring/logging`,扇入 142,让 `session/` 反向吃 wiring 19 次。
9. **表面耦合远高于真实耦合。** 30.9% 的边是 `import type`;去掉类型边与 barrel,环从 253 文件缩到 65。大 barrel(`core/index.ts` 582 行扇入 60、`core/engine/index.ts` 668 行)是耦合放大器,让每次"加一个东西"看起来都牵一片。

---

## 5. 面向对象审核(按用户的架构要求逐条过)

| 审核项 | 现状 | 判定 |
| --- | --- | --- |
| 有没有一个对象拥有子系统并管生命周期 | 无。`createOnethingBackend` 返回 `{engine, eventBus, streamChannel, shutdown}` 四件,其余全在模块全局 | ✗,这是主病根 |
| 依赖是否显式(构造注入)而非隐式(全局读) | 引擎是;其余 29/35 步隐式 | 半 |
| 接口先于实现 | core 932 接口;toolkit / prompt / provider / plugin 都有契约 | ✓ |
| 开闭:加东西不改旧代码 | 工具 / 提示词 / RPC 域 / 插件能力 ✓;provider / 子系统 / 宿主 ✗ | 半 |
| 单一职责 | `server/runtime.ts` 4135 行、`agent-loop-executor.ts` 2748 行、`api-builder.ts` 1787 行(317 个方法)违反 | ✗(三个上帝对象) |
| 继承用在真正的"是一个"关系上 | `CoreStreamEngine → ProductStreamEngine`、family 基类 → 工具 | ✓,用得克制 |
| 状态与行为同住 | 会话状态在 store,行为在 commands,二者互相 import | ✗ |
| 可测试性(能否不起进程就实例化) | core / toolkit / provider 能;backend 不能 | 半 |

---

## 6. 方向(不是拍板,是给你选)

三条路,按投入递增:

- **A. 只补组合根,不动其它模式。** 把 `createOnethingBackend` 改成构造一个 `OnethingBackend` 类,74 个端口收进一个 `HostPorts` 聚合接口作为构造参数,每步产物成为字段并显式传给下一步,`shutdown` 就是 dispose。§4 的 1 / 2 / 3 / 8 与姊妹篇 §2.1-2.3 一起消失。宿主接入从"74 根线"变成"实现一个接口",缺一项是编译错误。
- **B. A + 把 `transport` 分叉改成端口。** voice / terminal / plugins 的判据从"http 还是 ipc"改成"端口有没有注入",与 `configureShellHost` 同一机制。这样加传输(mobile、WebSocket)不再每域判一次。
- **C. B + provider 聚合根 + 引擎三层收敛。** 这两个是独立的大轮次,各自需要设计文档;本篇只指出方向,不展开。

无论选哪条,先做两件零风险的事:(1)补一个真正调用 `createOnethingBackend` 的测试(assemble → shutdown → assemble),把"二次装配静默"变成已知红;(2)给 boundary checker 加"`shared` 不许 import `@onething/*`"和"core/engine 与 wiring/engine 不许同名"。

---

## 7. 补充读数(本篇新跑的)

- `register*` 导出函数:core 4 / runtime 19 / backend 18;`PromptSource` 实现 6;`ProviderDefinition` 实现 5;wire 17 / dialect 23;工具 19 / family 基类 10;`*-bound.ts` 14;`*.wiring.ts` 32;`configure*` 74;`api-builder.ts` 317 个方法;core 接口 932 / 抽象类 2。
- `core-stream-engine.ts`:12 个 runtime 槽的使用次数 streams 10 / provider 10 / history 7 / skills 3 / compaction 3 / 其余各 1;12 个 protected 钩子;`ProductStreamEngine` 覆盖 `followUpMessage` / `onShutdown` / `steerMessage` / `takeSteeringDelivery`。
- `wiring/engine/stream`:1 个类、39 个导出函数、13 处 `get*()` 全局调用。
- runtime 各域的类/函数密度(类多的三个:agent-loop 69 类 / toolkit 33 / variables 14;函数多的三个:collab 373 / providers 202 / tools 116;plugins 0 类 / 109 函数)。
- `features/registry.ts` 文件头自述:基于 cordis,不解析依赖、不排序、不自动重挂,挂载顺序 = `backend.ts` 里写死的顺序。
