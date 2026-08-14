# Cordis 底座采纳（2026-08-15，用户拍板）

> 决策："架构得改，得改为 Cordis"——用户 08-15。本文取代 `kernel-shrink-builtin-plugins-2026-08.md` 的 **D2**（自制 FeatureContext 底座），K 线其余决策（D1 信任轴、D3 三规则、D4 事件三分）与迁移次序**全部保留**，各期重编号为 C。
> 为什么此刻转向是对的：K0/K1 做完后我们实际上在手写一个简化版 Cordis（disposer、挂载表、二次装配语义全是它的形状）；继续走的终点是"拥有并维护一个更差的 Cordis"。换底座的最便宜窗口就是现在——K2 还没把任何功能迁上自制底座。

## 0. 选型

采用 **`@deepseek-ai/cordis@4.0.1`**（dsh 的 vendor 发布版，MIT，npm 可装）：被一个完整 agent harness 实战验证过、版本号已转正；上游 `cordis` 4.0 还在 rc（rc.8，活跃维护），转正后评估切换（thin adapter 保留切换余地）。版本 pin 死，升级走显式 PR。

## 1. "改为 Cordis"的确切含义（与不含义）

**含义**：`@onething/app` 装配层内部是一个 Cordis 应用。`createOnethingBackend` 启动 Context，feature = cordis plugin，注册的可逆性由 fiber/scope 的 effect 语义承载。

**不含义（边界，防止理解成 dsh 式全仓重写）**：
- `packages/core` **保持零依赖**——cordis 加入 core 的禁入清单（boundary checker）；
- `packages/onething-runtime/src`（产品层）不感知 cordis，仍是纯库；
- hosts（electron/server/web/CLI）不感知；
- **装配顺序初期仍显式**：`ctx.plugin()` 按 backend.ts 现有次序逐个挂，`inject` 依赖激活按需渐进采用（K 线"要可卸载不要自动排序"的清醒分界保留为默认，解除封印需逐处论证）；
- renderer 的 K1 注册表照用（client 侧 cordis context 是远期可选项，不在本线）。

## 2. 分期（C 线，替换 K 线编号）

| 期 | 内容 | 验收门 |
|---|---|---|
| **C0 底座替换 spike** | 引入依赖；backend 内建 Context；K0 的 `mountFeature`/`FeatureContext` 改为 cordis 适配（`mountFeature`→`ctx.plugin` + fiber dispose；`registerDisposer`→scope effect；`registerRpcDomain` API 面不变）；`dumpFeatures` 改读 cordis registry | **K0 全部既有测试原样跑绿**（二次装配/逆序解绕/import 纯度/host-assembly-smoke）+ 四查全绿 + bundle/启动耗时影响测量入档 |
| **C1 服务与事件域对表** | `configure*Host` 端口逐个评估是否映射为 cordis service（不强迁）；拍板 EventBus 与 cordis events 分工（对齐 D4：会话事件域=events.jsonl+EventBus 不动，装配/能力域=cordis events） | 对表文档 + 迁 1 个端口作样例 |
| **C2** | =原 K2：轨迹迁为第一个真 cordis 插件；**第一份差距清单** | 功能等价（105+ 测试）+ 差距清单入档 |
| **C3** | =原 K3：practice/音乐/todo-plan 批量迁移，差距清单逐次递减（可证伪判据） | 每迁一个四查绿；清单条数递减曲线 |
| **C4** | =原 K4 自进化：feature_mount/unmount/inspect + 教学报错——此期直接受益于 cordis 的 fork/隔离能力，dsh 动态双半插件的全套判例可对照采用 | 模型现场挂卸 demo feature 自动化用例 |
| **C5** | =原 K5 收口：feature 名册 = 显式插件数组；CLAUDE.md 架构节重写 | 加 feature ≤3 步零壳文件 |

## 3. 风险与对策

| 风险 | 对策 |
|---|---|
| fork 跟随 dsh 需求漂移 / 上游 rc 变动 | pin 4.0.1；适配层薄（`app/features/` 的 API 面不变），换上游只动适配 |
| fiber/scope 语义学习成本 | dsh `docs/cordis-primer.md` + cordis 论文已在参照库;C0 spike 即学习载体 |
| 装配顺序回归 | K0 测试群 + host-assembly-smoke 是护栏;C0 宪法=行为零变化 |
| 包体积/启动 | C0 实测入档,超预算(>50KB gz / >20ms)再议 |

## 4. 既有资产去向

K0 测试群 → C0 验收门（原样跑绿）；K0 的 features/ API 面 → 保留为适配层（消费方无感）；K1 注册表 → 照用；T 线 RPC 域 → 首批 cordis 插件（C0 顺手完成）；E 线 → C2 原料，不动。

## 5. C0 落地记录（2026-08-14）

### 5.1 改了什么

依赖：根 `package.json` 加 `"@deepseek-ai/cordis": "4.0.1"`（`bun add --exact`，不带 `^`；npm 上有正式发布，传递依赖只有 `@deepseek-ai/cosmokit` 与 `@standard-schema/spec`，都是零原生模块的纯 JS）。**没有** vendor，没有降级到上游 rc。

代码只动了三个文件 + 一条护栏：

| 文件 | 改动 |
|---|---|
| `packages/onething-runtime/src/app/features/cordis-root.ts` | **新增**。惰性持有装配层唯一的 cordis `Context`；`dropFeatureRootContextForTests()` 配合 `resetFeaturesForTests`。 |
| `packages/onething-runtime/src/app/features/context.ts` | `FeatureContextImpl` 多收一个 `scope: CordisContext`；每一项注册改为 `scope.effect(() => dispose, label)`。 |
| `packages/onething-runtime/src/app/features/registry.ts` | `mountFeature` 改为 `rootCtx.plugin({ name, apply })`；卸载 = 逐项解绕 + `fiber.dispose()`。 |
| `scripts/headless-boundary-check.ts` | 新增 `CORDIS_FORBIDDEN_PATTERNS`，接进 core 检查与 runtime 非 `src/app` 分支。 |

**`backend.ts` 与 `rpc/index.ts` 的 diff 都是 0 行**——适配层的 API 面一个字没改，消费方零感知，这正是 C0 想证明的事。

### 5.2 cordis 原语的选用与不选用

| 语义 | 用的 cordis 原语 | 为什么 |
|---|---|---|
| feature 的作用域 | `ctx.plugin({ name, apply })` → `Fiber` | 一个 feature = 一个 plugin fiber。每次挂载都是新的 plugin 对象（cordis 以 `apply` 的函数身份作 registry 键），卸载时 runtime 记录一并回收（实测 200 轮装卸后 `registry.size === 0`）。 |
| 一项注册的可逆性 | `ctx.effect(() => dispose, label)` | effect 的 wrapper 是**单次生效**的 disposer，并发调用汇入同一次 teardown——K0 手写的「幂等 disposer」正是它。label 进 `fiber.getEffects()`，是 C4 自省的原料。 |
| feature 整体卸载 | `fiber.dispose()`（**兜底**，不是主路径） | 主路径是适配层自己逆序解绕；`fiber.dispose()` 收 fiber 本身、并兜住任何绕过适配层留下的 effect。 |
| 依赖激活 | **不用** `inject` | K 线「要可卸载不要自动排序」的分界保留。装配顺序仍由 `rpc/index.ts` 的循环与 `backend.ts` 的调用序决定。 |
| service | **一个都不注册** | C1 的对表工作。根 Context 上目前只有 cordis 自带的 events/logger/reflect/registry。 |

**三处刻意不交给 cordis**（K0 测试逐条钉着，交出去就变行为）：

1. **逆序解绕**。`Fiber._unload()` 是 `Promise.all(...)` **并行**跑 disposables 的。逆序是 K0 的语义，所以适配层保留自己的 entries 账本。
2. **`AggregateError`**。`_unload()` 对每一项 `catch → ctx.logger.error(...)`，异常被吞。「shutdown 路径静默失败」正是这类基座最容易埋的雷，所以卸载错误仍由适配层聚合抛出。
3. **mount 失败的处理**。`definition.mount` 的异常在 plugin 的 `apply` 内部就被接住，不让它冒进 fiber——cordis 对启动失败的处理是 `logger.error` + 并行 `_unload` + 把错误藏进 `fiber._error`，而 K0 要的是「首错原样抛出、回滚逆序、过程不打日志」。

`dumpFeatures()` 的账本也没有改从 cordis registry 反推：`fiber.getEffects()` 只给得出 `EffectMeta { label, children }`（一棵标签树），要还原「哪一项是 RPC 域、域名叫什么」只能反解字符串标签。**诚实优先**——dump 的准确性不为「纯 cordis」让路；cordis 那边能提供的（effect 存活性、标签树、`registry.size`）是本账本的交叉验证面，不是替代。

### 5.3 验收门

K0 全部既有测试**一条断言未改**跑绿：

- `features/__tests__/features.test.ts` 11 条
- `rpc/__tests__/app-rpc-features.test.ts` 3 条（含二次装配门）
- `app/__tests__/import-side-effect-free.test.ts` 3 条（含「import 不建 Context」）
- `collab/actors/__tests__/host-assembly-smoke.test.ts` 3 条

装配顺序 diff 为零（`RPC_FEATURES` 名册与 `backend.ts` 均未改）。

底座确实换到了 cordis 上（不是「引了依赖但没用」）——装完内置名册后从根 Context 反查：

```
root.registry.size === 11
effect labels = [ "feature(rpc:usage):rpcDomain:usage", …, "feature(rpc:permission-grants):rpcDomain:permissionGrants" ]
```

且绕过适配层直接 `fiber.dispose()` 也能把注册解绕干净（`registry.size` 回到 0）——fiber 是真正的持有者，适配层的账本只负责顺序与错误聚合。

### 5.4 测量入档

**包体积**（`bun run build` / `bun run server:build` 前后对比，gzip -9）：

| 产物 | raw Δ | gz Δ |
|---|---|---|
| `out/main/index.js` | +30 B | **+17 B** |
| `out/main/cli.js` | 0 | −1 B |
| `out/preload/index.js` | 0 | 0 |
| `dist/server/main.js` | +3,792 B | **+1,350 B** |
| `dist/web/**` | 0（无 cordis 痕迹） | 0 |

数字这么小是因为**两个宿主都把 cordis 外部化了**：electron 主进程走 `externalizeDepsPlugin()`，server 走 vite SSR 默认外部化，所以库本身不进 bundle，而是作为运行期 `node_modules` 依赖装机。它的真实占地是 `cordis/lib/index.js` 60,378 B（gz 16,722）+ `cosmokit/lib/index.js` 13,336 B（gz 4,124）= **gz 约 20.8 KB**，加上 bundle 内的适配代码 ~1.4 KB gz，合计远低于 §3 定的 50 KB gz 预算。web 端确认零影响。

**装配耗时**（vitest 环境下 200 轮，装的是 11 域的内置名册；同一套量法前后各跑一遍）：

| | 换底座前 | 换底座后（热 Context） | 换底座后（每轮重建 Context） |
|---|---|---|---|
| mount 11 个 feature，mean | 0.0099 ms | **2.29 ms** | 3.02 ms |
| 同上 p50 | 0.0088 ms | 2.00 ms | 2.33 ms |
| unmount，mean | 0.0039 ms | 0.45 ms | 0.52 ms |
| `new Context()` 单次 mean | — | 0.70 ms | 同左 |

即：桌面启动一次多付 **约 3 ms**（0.7 ms 建 Context + 2.3 ms 挂 11 个 feature），在 §3 定的 20 ms 预算内。

**耗时去了哪**（不是 proxy，是栈快照）：cordis 为 effect 诊断在 `buildOuterStack()` 与 `composeError()` 里各 `new Error()` 一次，`ctx.plugin()` 与 `ctx.effect()` 两条路都会走到。所以成本是**每次注册两次栈捕获**，约 0.2 ms/feature（vitest + sourcemap 环境放大，生产 bundle 栈更浅）。**这条要带进 C2/C3**：feature 数量从 11 涨到几百时它是线性的，届时若要压，压的是「每 feature 的 effect 条数」，不是 proxy 开销。

### 5.5 C0 发现的、未修的问题

1. **`package-lock.json` 与 `bun.lock` 不同步**。`bun add` 只写 `bun.lock`，`package-lock.json` 里没有 `@deepseek-ai/cordis`。本次打包没受影响（`scripts/run-electron-builder.mjs` 的采集器读的是磁盘上的 node_modules 树、预检用的是按 node 解析算的真实闭包，实测「依赖采集完整：283 个包」并且 `app.asar` 里确有 `@deepseek-ai/cordis` 与 `@deepseek-ai/cosmokit`），但两份锁文件长期分叉本身是隐患——**这不是 C0 引入的，是仓库既有状态**，值得单独收口。
2. **C1 对表的第一道坎：`configure*Host` 端口 ≠ cordis service**。七个端口现在是「模块级 late-bound 函数」，语义是「最后一个写者赢、随时可重配」；cordis service 的语义是「fiber 提供、fiber 卸载即撤回，消费方通过 `inject` 等它」。这两套语义不是同构的——直接映射会把「宿主随时可覆盖」变成「覆盖 = 换 fiber」。C1 要先拍板端口是**保持函数**还是**升为 service**，逐个论证，别整体迁。
3. **C2 会撞到的三个 cordis 语义**（现在就写下来，免得迁移时当场发明）：
   - **并行 + 吞错的 `_unload`**。任何把「卸载顺序」当契约的功能（轨迹、音乐、todo-plan 都有「先停写再关文件」这类顺序）不能靠 fiber 自动卸载，必须走适配层的逆序解绕，或把相关工作收进**同一个 effect**（cordis 只在单个 effect 内部保证逆序+串行）。
   - **`apply` 抛错 = fiber FAILED + logger.error**。cordis 的失败模型是「记下来、继续活」，我们的是「首错原样抛给装配方」。迁移每一个 feature 时都要决定错误往哪走，默认继续用适配层接住。
   - **`ctx.effect()` 在 `UNLOADING` 期间抛 `INACTIVE_EFFECT`**。任何在 dispose 路径里还想注册东西的代码（例如「卸载时补记一条日志的 disposer」）会炸。
4. **`resetFeaturesForTests()` 丢弃而不 dispose 根 Context**。这是 K0 契约（「清表，不跑任何 disposer」）的忠实实现，也意味着测试里被丢下的 fiber 不会解绕。cordis 的 Context 不持定时器、不挂 process 监听，所以不漏资源；但等 C1 往 Context 上挂真 service 之后，这条要重新评估。

### 5.6 四查与三构建

| 项 | 结果 |
|---|---|
| `typecheck`（node + web） | 绿 |
| `test`（9,674 条） | 9,662 passed / 4 failed —— **4 条全部与 C0 无关**，来自工作区里在途的 context-compact 与 `BackgroundJobsStatusBar.vue` 改动（`history-messages` / `message-helpers` / `status-band`）；这三个文件都不经过 `features/`，全仓只有 `app/rpc/index.ts` 一个消费方 |
| `boundary:gate` | ok —— 4 条已知失败，**零新红**；新增的 cordis 规则用探针文件验过会真的触发（core 与 runtime 非 app 层各插一行 import，两处都报） |
| `transport:gate` | 红，但**红在 `preload/bridge.ts` / `shared/ipc/channels.ts` 的行数**，两者都是工作区在途改动，C0 一个字没碰传输面 |
| `bun run build`（electron-vite） | 绿 |
| `bun run server:build`（SSR） | 绿 |
| `bun run web:build` | 绿，产物里零 cordis 痕迹（验证过） |
| `bun run build:unpack`（额外） | 绿；预检「依赖采集完整：283 个包（采集器 = npm）」，`app.asar` 内含 `@deepseek-ai/cordis` 与 `@deepseek-ai/cosmokit` |

> 注：C0 开工时工作区**并非干净**（93 个改动文件在途），上表中的两处红都在这些在途改动里，与本期无关。

## 6. C2 落地记录与差距清单 #1（2026-08-14）

C2 = 把**轨迹**迁成第一个真 cordis feature，并产出第一份「纯 feature API 复刻不了什么」的清单。
选轨迹的理由在 K1 记录里：最新、边界最清楚（消费事件日志的纯投影）、被既有测试钉死。

### 6.1 改了什么

**后端半（一个真 cordis plugin）**

- 新增 `packages/onething-runtime/src/app/features/builtin/trajectory.ts`：`FeatureDefinition`，
  `id: 'trajectory'`，`mount(ctx)` 里 `ctx.registerRpcDomain(sessionEventsRouter, sessionEventsRpcHandlers)`。
  文件头把 §5.5.3 的三条地雷**逐条对照**写死（见 6.5 G9：本期三条都不适用，那是被试品太干净，不是地雷不存在）。
- `app/rpc/index.ts` 的名册里，`rpc:session-events` 那一行换成 `trajectoryFeature`——**位置一格没动**。
  `dumpFeatures()` 里那一格从 `rpc:session-events` 变成 `trajectory`（注册的域仍是 `sessionEvents`）。

**前端半（注册搬家 + 「谁 import」的拍板）**

- 新增 `packages/renderer/features/trajectory.ts`：`registerWorkspacePanel({ id: 'trajectory', … })` 从
  `panel-registry.ts` 搬到这里。顺带消掉一处抄件——`windowEvent` 现在直接引
  `trajectory-inspect.ts` 的 `TRAJECTORY_OPEN_WORKSPACE_EVENT` 常量，不再抄字面量。
- 新增 `packages/renderer/features/index.ts`：**名册**，内容就是一列 `import`（一行一个 feature），
  由启动入口 `packages/renderer/main.ts` import 一次。
- `panel-registry.ts` 少一个面板与两条 import（组件树 + 图标），文件头记下"这个数组不是内置面板
  的全集，是**还没迁的那批**"。

### 6.2 两处名册的形状（拍板）

| | 形状 | 为什么 |
|---|---|---|
| 后端 | `rpc/index.ts` 里**一张有序数组** `BUILTIN_FEATURES`（原 `RPC_FEATURES`），成员两种：还没迁的 `rpc:<域>` 内联包装，和 import 进来的 feature | 一张表、一个入口，迁一个功能 = 把一行内联包装换成一次 import，**装配顺序一格不动**。另起一张表 + 第二条装配调用会把顺序拆成两处、给 `backend.ts` 加一行，与 C5「feature 名册 = 一个显式数组」正好相反 |
| 前端 | `features/index.ts` = **一列 import**，由 `main.ts` import 一次 | renderer 没有装配序列，feature 模块必须被某处静态 import 才会求值（K1 留下的第一个真问题）。三个候选被否：让 panel-registry 反过来 import 各 feature（注册表依赖注册者）、各消费方各 import 各的（又一份手抄清单）、`import.meta.glob`（"有哪些 feature"退化成运行期发现，删个文件静默少一件功能） |

两边都遵守各自的注册时机纪律，**这条不是笔误**：app 层 import 零副作用（有显式装配序列，顺序必须留在那一处可读），
renderer 层模块求值即注册（没有装配序列，"import 到了就一定可用"才是对的）。K1 的判例原样成立。

### 6.3 设计轮（用户原话："做的很粗糙"）

行为语义一格未改（分组 / 配对 / 选中 / 跳转 / 两档模式全保留），改的全是表现层。要点：

1. **控制条按房规重写**：六个兄弟面板没有一个在控制条里放自己的标题，计数一律归状态条。
   轨迹此前两样都抄了一份，窄面板下还得靠 `display:none` 把自己抄的那份藏起来——抄件的典型下场。两条一起删。
2. **三枚文本动作统一走全局 `.text-action`**，删掉自绘的 `.trajectory-reload` 边框丸（26 行 CSS）。
   组头时刻的选中态用它自带的 `is-primary` 修饰符而不是自写颜色规则——自写的 `.group-open.is-active`
   会与 `.text-action:hover:not(:disabled)` 撞成 (0,3,0) 平局，由注入顺序裁决（ui-system §1 的平局判例）。
3. **时间线开关的文案改成稳定的"时间线"**，开合由 `aria-expanded` + 主色说。换文案的按钮每点一次都要
   重读才知道当前状态，宽度还跟着跳。
4. **账线行长出时刻沟**：`PanelLedgerRow` 的 `lead` 槽（Tasks 的 mono 时间列同款用法）放调用时刻，
   行尾耗时定宽右对齐。刻度行首格与它同宽同起点——整份 ledger 的时刻读在同一条竖线上。
   刻度行的种类判据取 `tickKind` 不取 `label`（与条带同纪律），顺带给"`tickKind` 只有条带在消费"的
   E2 遗留补上第二个消费者。
5. **inspector 的分节头换成共享 `LedgerGroupHeader`**：原来那枚 `.inspector-section-label` 的配方
   （10px / 700 / .09em / uppercase / faint）与 `.lgh-label` 逐字节相同，就是同一个组件被抄了一遍。
   换过来顺带拿到拉通线，inspector 从"一坨 dl"变成「信封 / Usage」两节账页。
6. **条带**：泳道加居中基线（空泳道此前在屏上什么都没有，读起来像"画漏了"而不是"这一段没有工具"）；
   泳道名右对齐定宽，两条 track 起点对齐；span 的 hover 从 `opacity: .75` 改成描边升主色——
   降透明会把 `is-active` 的外圈一起冲淡（同一条通道互相取消，正是"选中行必须保留 hover 反馈"要防的形态）。
7. 杂项：`border-radius: 10px` → `var(--radius-md)`；数字格一律 `tabular-nums`；空态收 8px 顶距 + 限行宽。

`ui:gate` 绿（81 条已知，零新增）。

### 6.4 验收

| 项 | 结果 |
|---|---|
| `typecheck`（node + web） | 绿 |
| 轨迹 / E 线 + feature 基座 10 个 suite | **173 条全绿**（含面板 16、投影 16、E0 采集器 9、域 5、sessions 21、二次装配门 3、feature 基座 11、注册表 15、工作台 28、侧栏 49） |
| renderer 全量 | 313 文件 / 3063 条绿 |
| `@onething/app` 全量 | 265 文件 / 2361 条绿 |
| `packages/core` + `apps/*` | 145 文件 / 1167 条绿 |
| `ui:gate` | 绿，81 条已知零新增 |
| `boundary:gate` | 1 条红：`packages/onething-runtime owns Markdown asset service`——**不是本期的**：它由工作区在途的 `scripts/headless-boundary-check.ts` / `boundary-gate.mjs` 改动引起（另一条会话正在改这两个文件），触发点是 `apps/electron/src/main/ipc/markdown.ts` 的缺席，本期一个 markdown 文件都没碰 |
| `transport:gate` | 3 条红：`preload/bridge.ts` +117 行、`platform/web.ts` +45 行、`shared/ipc/channels.ts` +1 行——三份都是工作区在途改动，本期零传输面改动（轨迹的域早就骑在通用 RPC 通道上） |

### 6.5 差距清单 #1

格式：**缺口 → 原语化改写 → 采纳/拒绝 + 理由**。这份清单是 C3/C4 的方向盘，宁多勿漏。

**G1. 聊天「检查」入口没有 feature 侧的落点**
- *缺口*：轨迹的第三个表面是聊天里工具卡片上的「检查」按钮。它今天是
  `components/chat/ToolActivityDetails.vue` 直接 `import { requestTrajectoryInspect }`——
  也就是说**内核组件硬编码知道有轨迹这件功能**。轨迹这次只迁走了面板与后端域，入口还留在内核里。
- *原语化改写*：不需要新锚点。既有的 ui-slot 锚点 `message.footer`（block，ctx 带 `messageId`）
  与 `message.actions`（trigger，同样带 `messageId`）正好接得住这个形状。缺的是**表达力档**：
  `ui-anchor-registry` 今天只接插件贡献的**描述树**，第一方 feature 要挂的是一个真组件。
  提案：给 slot 注册增加 `component` 一档，判据与 panel-registry 的 `component` 完全相同
  （D1「可信 by construction」才填得起），第一方与插件同表注册、同锚点、不同表达力档。
- *裁决*：**提案采纳，排进 C3；本期不做。** D3 第三条（锚点加设问）已被满足——要长的是既有锚点的
  表达力，不是新锚点，所以它是原语不是洞。不塞进本期的理由是它要动 `ui-anchor-registry` 与
  `PluginTriggerPopover` 两处宿主代码，那是一次独立的原语改动，不该混在"迁一个 feature"里。

**G2. E0 采集器（`session-event-recorder` / `agent-loop-executor`）的归属**
- *缺口*：事件日志的**写侧**长在引擎流水线里，它是轨迹面板唯一的数据来源，却不属于轨迹 feature。
- *原语化改写*：要迁就得有一个"往引擎流水线挂钩子"的注册面（`ctx.registerStreamHook(...)`）。
- *裁决*：**拒绝迁；采纳"这是基础设施不是 feature"的定性。** 三条理由：
  (1) 采集器**没有消费者也要跑**——事件日志是账本不是面板的私有缓存，面板卸载了账照记；
  (2) 它有真实的写侧生命周期（先停写再关文件），正撞 §5.5.3 的第一条地雷，迁它就得当场发明
  "把一组顺序敏感的工作收进同一个 effect"的约定；
  (3) `registerStreamHook` 会是本仓第一个**往热路径挂东西**的注册面，它的失败模型（一个坏 hook
  会不会拖垮一次请求）必须先单独想清楚。
  结论：E0 留在内核，轨迹 feature 是它的**纯消费者**——这正是选轨迹当第一个被试品的理由。

**G3. renderer 没有装配序列，名册的求值时机要在测试里手动重现**
- *缺口*：`features/index.ts` 只被 `main.ts` import，而 `main.ts` 不参与单测。于是任何断言
  "某 feature 的面板在场"的用例都要自己补一行 `import '@/features'`。本期补了 3 处：
  `panel-registry.test.ts` / `Sidebar.workbench.test.ts` / `RightWorkbenchPanel.test.ts`
  （少一处的症状是"某个入口里这个面板不见了"，红得很清楚，不会静默）。
- *原语化改写*：(a) 把名册 import 下沉进 `panel-registry`——注册表反过来依赖注册者，否决；
  (b) 沉进 vitest 的 setup——当前 `vitest.setup.ts` 是全仓共用的，node 环境的 app 测试 import 它
  会当场缺 `document`，除非 renderer 拆出独立的 vitest project（`environment: happy-dom` + 自己的
  `setupFiles`）。
- *裁决*：**本期采纳"逐测试显式 import"**——它诚实（测试确实在重现启动入口做的那一件事），
  爆炸半径为零。记成待办：C3 再迁两三个面板后这个成本线性上升，那时是拆 renderer vitest project
  的时机；**判据是"补 import 的测试文件数超过 6"**，不是感觉烦了。

**G4. 编译期 id 联合是内核特权**
- *缺口*：`WorkspacePanelId` 是从 panel-registry 的静态数组抽出的字面量联合。面板一迁走就掉出联合，
  `workspacePanelWindowEvent('trajectory')` 从"编译期抓拼写"降级成"运行期抛错"。
- *原语化改写*：让 feature 模块也能贡献字面量——TS 里唯一可行的形态是名册文件里再写一份
  `export const FEATURE_PANEL_IDS = [...] as const`，那就是把 id 清单**再抄一遍**。
- *裁决*：**拒绝。** 判据：迁出内核 = 交出编译期特权，这是插件面板一直在付的价（它们的 id 本来就是
  运行期字符串），第一方 feature 没有理由例外；而消灭抄件正是这张注册表存在的理由。
  补偿是运行期抛错必须**保留且响亮**（`workspacePanelWindowEvent` 查不到就抛）。
  代价如实记：`openWorkspaceTab('trajectroy')` 这类拼写错误现在到运行期才发现。

**G5. renderer 侧的 feature 没有挂卸语义**
- *缺口*：同一个 feature 的两端可逆性不对称——后端半是 cordis fiber（装卸可往返 200 轮，实测），
  renderer 半是"模块求值即注册"，`registerWorkspacePanel` 返回的 disposer 被丢弃，不可卸。
- *原语化改写*：renderer 也建一条装配序列（`mountRendererFeature(def)` + 名册数组），两端同构。
- *裁决*：**本期拒绝，C4 重新评估。** 理由：可卸载在 renderer 侧今天**没有消费者**——没有任何产品
  动作是"运行期停用一个第一方 feature"（插件面板的整批注销走的是另一条已有的路）。
  C4 要做"模型现场挂卸 demo feature"，那个 demo 若带 UI，这条才变成真需求。

**G6. 一个 feature 是两个半，没有一处能同时看见它们**
- *缺口*：`trajectory` 在后端名册与 renderer 注册表里都叫 `trajectory`，但两者之间**没有任何链接**——
  改一边的 id 另一边不会知道；`dumpFeatures()` 只看得见后端半。
- *原语化改写*：一个跨端的 feature 清单（共享常量），或让 renderer 注册表也进 dump。
- *裁决*：**暂缓，不是拒绝。** 一条判例做不出制度：现在只有一个 feature 是两个半的。
  C3 迁完 practice / 音乐 / todo-plan（三个都有 UI 半）之后再看——那时"两半对不上"若真出过一次事故，
  就有确凿的形状可依。**先记下这个洞，不预雕。**

**G7. `registerAppRpcDomains` 的名字比内容窄了半格**
- *缺口*：名册已经不只是 RPC 域了（`BUILTIN_FEATURES` 里有一个真 feature），函数还叫
  `registerAppRpcDomains`，表还住在 `rpc/index.ts` 里。
- *原语化改写*：名册搬到 `features/builtin/index.ts`，函数改名 `mountBuiltinFeatures()`，
  `backend.ts` 跟着改一行。
- *裁决*：**采纳，排进 C5（收口期）。** 本期不做的理由：它要动 `backend.ts`，而 C2 的宪法是
  "迁功能不动装配序列"。

**G8. `FeatureContext` 只有两个注册面（rpc / 通用 disposer）**
- *缺口*：轨迹恰好只需要 `registerRpcDomain`，所以本期一个新注册面都没提出需求。
  但 C3 的三个功能各要一类资源：定时器（scheduler）、外部进程（音乐的 ncm 守护）、文件监听（todo-plan）。
- *原语化改写*：**别加功能形状的注册面**。`registerDisposer` 这个逃生舱已经能接住全部三类资源，
  真正缺的是**顺序**——三者都有"先停写再关"的次序契约。
- *裁决*：**本期不加任何注册面**（D3 第一条：差距清单驱动，轨迹没提出需求）。
  给 C3 的做法建议：第一个真正需要顺序的 feature 落地时，不要加新注册面，而是把整组工作收进
  **一个** `registerDisposer`——cordis 只在单个 effect 内部保证逆序 + 串行（§5.5.3 第一条已写死）。
  同理记一条空结果作为对照基线：面板 descriptor 的 `context` / `emits` 两张有限清单，本期
  **零新增需求**（轨迹只用到 `component` + `windowEvent`）。

**G9. 三条 cordis 语义地雷，本期一条都没真正踩到**
- *记录（不是缺口，是信号质量的自评）*：轨迹只注册一项、`mount` 同步、dispose 路径不注册任何东西——
  §5.5.3 的三条逐条不适用。**这不是"地雷不存在"的证据，是"第一个被试品太干净"的证据。**
  差距清单在这一项上的信号质量是低的；C3 的三个功能（都有顺序契约）才是真检验。
- *裁决*：如实记下来，**免得 C3 时有人拿"C2 都没事"当跳过论证的理由**。

**清单条数基线**：9 条（G1–G9），其中 2 条已排期（G1→C3、G7→C5）、3 条明确拒绝（G2 / G4 / G5）、
2 条暂缓（G3 待触发判据、G6 待第二个双半 feature）、1 条空结果（G8）、1 条自评（G9）。
C3 每迁一个 feature 复核一次这张表，**递减曲线是可证伪判据**（§2 的 C3 验收门）。
