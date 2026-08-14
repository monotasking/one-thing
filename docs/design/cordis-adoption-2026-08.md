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

## 7. C4 第一档落地记录与差距清单 #2（2026-08-15）

C4 = 把 C0 立起来的可逆注册基座**交到模型手里**：`feature_mount` / `feature_unmount` /
`feature_inspect` 三个会话工具，让模型在一次对话里现场挂载、卸载、自省一件功能，免重启。
对标 dsh 的 `cordis_define/run/stop/inspect` 四件套 —— **少一个 `define` 是有意的**：
「写文件」这件事本仓已经有 write/edit 两个工具在干，再造第三个入口只会分叉。

第一档只做**后端半**（无 UI）。UI 半是第二档，理由见下面 G12 对 G5 的复评。

### 7.1 改了什么

| 文件 | 改动 |
|---|---|
| `packages/onething-runtime/src/app/features/builtin/self-evolution.ts` | **新增**。一个 `FeatureDefinition`（id `self-evolution`），`mount` 里注册三个会话工具 + 一趟动态 feature 清扫器。 |
| `packages/onething-runtime/src/app/features/registry.ts` | 新增 `dumpFeatureEffects()`：每个 feature 的 cordis `Fiber.getEffects()` 标签树。C0 §5.2 说 label「是 C4 自省的原料」，这里是那笔原料的提货口。 |
| `packages/onething-runtime/src/app/features/index.ts` | 导出 `dumpFeatureEffects` / `FeatureEffectDump`。 |
| `packages/onething-runtime/src/app/rpc/index.ts` | 名册 `BUILTIN_FEATURES` **末尾**加一行 `selfEvolutionFeature`。既有 11 行位置一格未动。 |
| `packages/onething-runtime/src/app/features/__tests__/self-evolution.test.ts` | **新增**，15 条。 |
| `packages/onething-runtime/src/app/rpc/__tests__/app-rpc-features.test.ts` | 名册快照跟着长一行；域清单与 feature 清单从本期起拆成两张（自进化一个域都不注册）。 |

**自己也是 feature（吃自己狗粮）**。三个工具**不是**加进 `tools/builtin/index.ts` 那张表的第 25 个内置工具，
而是一个 feature 的注册项。理由是 D1 那句质问的直接推论：自进化能力如果自己走特权路进内核，
那它证明的就不是「feature 基座够用」，而是「基座之外还有一条更方便的路」。今天的自证有三条：
它挂在名册里、`feature_inspect` 看得见自己（标 builtin）、卸载它能把三个工具一起摘干净（有用例钉）。

**名册位置不可上移**（两重理由，都写在 `rpc/index.ts` 的注释里）：
(a) 它的工具注册面有一道「已经有 bash 的宿主才给」的门，判据要在工具注册表装好之后才为真，
而 `backend.ts` 的顺序恰好是「三档工具注册 → `registerAppRpcDomains`」；
(b) 放末尾 = 卸载时**第一个**被解绕，模型现场挂进来的那批动态 feature 因此在内置域拆掉**之前**
就已经收干净（动态 feature 可能骑在这些域上）。

### 7.2 三条 cordis 语义地雷：第一次真的踩到（对照 §5.5.3 与 G9）

G9 的自评说轨迹「太干净，三条一条没踩到」。本期是第一个**真的踩到**的 feature：

| 地雷 | 本期 | 处方 |
|---|---|---|
| 1. 并行 + 吞错的 `_unload` | **踩到**。卸载有真实顺序契约：必须**先**收掉全部动态 feature，**再**注销三个工具；反过来会留下一批没有控制面、还在跑的东西。 | 原样执行 G8 给 C3 的建议：**不加新注册面**，整趟清扫收进**一个** `registerDisposer`（cordis 只在单个 effect 内部保证逆序 + 串行）；它在注册顺序上排最后，于是适配层的逆序解绕让它第一个跑。有正面用例。 |
| 2. `apply` 抛错 = fiber FAILED | **踩到，且答案分两种**。本 feature 自身的 `mount` 继续用适配层接住的默认（首错原样抛给装配方）；但**动态 feature 的 mount 失败不走这条** —— 那是模型写的代码出错，不是接线 bug，由 `feature_mount` 接住翻成教学文本。一个模型写错的插件绝不该让宿主装配失败。 | 这是第一个「错误往哪走」要分两种情况回答的 feature。 |
| 3. `ctx.effect()` 在 UNLOADING 期抛 `INACTIVE_EFFECT` | **没有真踩到，但预防性上了闩**：清扫一开始就把 `sealed` 置真，`feature_mount` 当场拒绝并给出教学文本。守的是「清扫已跑完、三个工具还没注销」那条窄缝。 | 如实记：这条仍**没有被真实场景检验过**，信号质量与 G9 同级。 |

### 7.3 权限接法（D1 授信纪律在工具档的映射）

挂载 = 执行任意代码，所以三条护栏，**没有一条是新机制**：

1. **每挂一次问一次，且永不可记住**。`feature_mount` 的 `analyze()` 声明的 effect kind 是
   **`capability_change`** —— core 的 `NEVER_GRANTABLE_TYPES` 里唯一的成员，所以「以后都允许」
   这个选项在权限卡上根本不出现（`permission-ledger.ts` 已按同一判据不给授权行）。
   挑这个 kind 不是凑数：它的定义原文是「Repointing something the system itself acts on …
   it changes what the assistant can reach, so it is never silent and never grantable」，
   而挂载一个 feature 正是**改变助手够得着什么**的那件事。
   **本期没有新增 effect kind** —— 加一个 `feature_mount` kind 就是 D3 第一条禁止的「功能形状的洞」。
   权限卡的措辞走 `preview.title`（`titleForEffect` 里它排第一），所以卡面是
   「挂载 feature「demo-echo」— 执行 …/feature.mjs 里的代码」，不是 `capability_change` 的通用兜底句。
2. **不入自动放行类**：`autoExecute: false` + `permissionGuard: 'permission-gated'`，与 `edit` 同档
   （本仓写盘工具里最严的那个）。`feature_unmount` / `feature_inspect` 反过来是 `safe` + 自动执行 ——
   不对称是有意的：危险的是「让代码跑起来」，不是「让它停下来」或「看一眼」。
3. **只从一个目录加载**：`<store>/features-dev/<id>/`，`entryPath` 夹进**该 feature 自己的目录**
   （不是夹到 features-dev 根就算数 —— 夹到根的话 `../other/feature.mjs` 会横跨到别人目录）。
   夹紧复用 `rpc/sandbox.ts` 的 `isPathInside`，与联网宿主的 RPC 沙箱同一份实现，而不是再抄一遍
   `startsWith`（skills 拒迁时记下的教训）。id 另有一道字面量正则挡住 `..` 与分隔符：两层都在，
   因为第一层管「长得对不对」，第二层管「解析完落在哪」，后者才是护栏。

另有一道**宿主档门**：三个工具只在 `hasTool('bash')` 为真的宿主上注册。判据不是「是不是桌面」
（那是宿主探测，装配层不许干），而是一句可证的等价陈述 —— **挂载一个 feature 与跑一条 shell 是
同一量级的能力**，一个连 bash 都不给的宿主（`readonly` 档，联网 server 的降级形态）当然也不该给这个。
full 与 headless 两档有 bash、readonly 档没有，门自然落在正确的位置；且**默认拒绝** ——
工具注册表还没起来时判据为假，一个字都不注册（有用例钉）。

**目录不存在时工具自己不 mkdir**，只给创建指引 —— 与 E0 事件日志同纪律：凭空造目录会把
「这个宿主没配过这件事」这条信息抹掉。

### 7.4 教学式报错（dsh 判例：报错是写给模型看的操作指南）

九条失败路径，每一条的返回文本都回答两个问题：**发生了什么** + **下一步调什么**。
（全文逐字录在实施记录里；此处只列判据与要点。）

| 路径 | 要点 |
|---|---|
| 目录不存在 | 给 `mkdir -p <绝对路径>` + `write <入口>` + **内联最小模板**（含「任何副作用都要配一个注销」的示范）+ 「再调 feature_mount({id})」三步 |
| 目录在、入口不在 | 同一份模板，省掉 mkdir 那步 |
| id 不合法 | 说明「它同时是目录名」，给出合法字符集与一个正例 |
| entryPath 越界 | 报出解析后的实际路径 + 「挂载等于执行任意代码，所以加载面是白名单目录」+ 正确用法 |
| 模块求值失败 | 明说「挂载还没开始，什么都没注册进去，不需要清理」 |
| 模块形状不对 | 给出期望的**导出签名示例** + `ctx` 上现有的两个注册面签名 + 「改完直接重调，会重新读盘，不用重启」 |
| id 与模块声明不一致 | 两侧 id 都报出来 + 「否则你会卸载 A 却发现 B 还在」+ 两条改法 |
| mount 抛错 | 原始 message + 「**已经回滚**，没有半挂载记录」+ 「不需要先 unmount」 |
| 重复挂载 | 「同一个 id 两份实现同时在线永远是接线 bug」+ 指向 `feature_unmount` |
| 卸载内置 feature | 说明它是随应用构建的 + **列出当前可卸载的清单** |
| 二次卸载（幂等） | 「没挂过，或者已经卸过了（重复卸载不是错误）」+ 指向 `feature_inspect()` |

`feature_inspect` 的输出是三段：已挂载 feature（注册项 + **cordis effect 标签树** + builtin/dynamic 标记，
dynamic 那行带入口路径与「第 N 次挂载」）、可挂载而未挂的候选（每行直接给出可复制的
`feature_mount({ id: "…" })`）、以及目录不存在时的指引。

### 7.5 验收

| 项 | 结果 |
|---|---|
| `typecheck`（node + web） | 绿 |
| 新增 `self-evolution.test.ts` | **15 条全绿**（含完整闭环：挂 → dispatchRpc 调到新域 → inspect 标 dynamic → 改源码重挂 → 行为改变 → 卸载 → 域消失/出表 → 二次卸载幂等） |
| feature 基座 + RPC + 工具 + import 纯度 | 35 文件 / 276 条全绿 |
| `boundary:gate` | **ok —— 13 条已知失败，零新红** |
| `transport:gate` | 红 3 条，与 C2 记录逐字相同（`preload/bridge.ts` +117、`platform/web.ts` +45、`shared/ipc/channels.ts` +1），三份都是工作区在途改动；本期零传输面改动 |
| `server:build`（SSR，额外） | 绿 —— 动态 `import()` 带 `@vite-ignore`，打包器不试图静态解析它 |

闭环用例的关键证据是**「改源码重挂，行为真的变了」**那一步：Node 的 ESM 模块缓存以 URL 为键，
不做 cache-bust 的话第二次 `import()` 会给回第一次的模块对象，症状是「代码明明改了却没生效」——
一个极难自证的坑。`?t=<时间戳>-<第几次>` 让每次挂载都是一个新键，用例直接断言行为从
`toUpperCase()` 变成 `toLowerCase() + '!'`。

### 7.6 差距清单 #2

格式同 §6.5。**本期新增 6 条（G10–G15）+ 2 条复评（G5 / G8）**。

**G10. 动态 feature 注册不了工具 —— `FeatureContext` 的表达力对第一方与动态方不对等**
- *缺口*：第一方 feature 编译进 bundle，能 import 任何东西（自进化自己就是这么注册三个工具的）；
  动态 feature 是从磁盘 import 的裸 `.mjs`，**它 import 不到 `@onething/app` 的内部路径**，
  所以它的全部能力就是 `ctx` 上那两个面（RPC 域 + 通用 disposer）。想注册一个工具、一个变量、
  一条斜杠命令，今天做不到。
- *原语化改写*：`ctx.registerTool(def)`——而这一次它是**被需求驱动的**：C2 的 G8 说
  「轨迹没提出需求」，本期自进化自己提出来了。
- *裁决*：**提案采纳，排进 C5；本期仍用 `registerDisposer`。** 理由：本期已经证明
  `registerDisposer` 接得住（G8 的结论成立），而 `registerTool` 面的正确形状要等第二个消费者
  才看得清（D3 第一条）。**但这个洞是真的，而且它是 C4 第二档之前最该补的一格** ——
  「模型现场造一个新工具」是自进化最自然的下一个诉求，而今天它做不到。

**G11. 动态 feature 没有、也不该有「授信免卡」**
- *缺口*：D1 的四条纪律里本期只落了「默认拒绝 + 知情披露」（每次挂载一张永不可记住的权限卡）。
  「可撤销」由 `feature_unmount` 代偿；「降级不驱逐」完全不适用（动态 feature 没有降级档：
  要么以完整权限跑，要么不跑）。
- *原语化改写*：把动态 feature 纳入插件 ledger 的授信状态机（一次授信 = 这个 id 以后免卡）。
- *裁决*：**拒绝，而且这条拒绝是本期最重要的一条。** 免卡正是这里最不该有的东西：
  模型每次挂的都可能是**新写的代码**，「同一个 id」不代表「同一份代码」。插件 ledger 的授信对象
  是一个带 integrity 校验的 npm tarball，而 features-dev 里的文件下一秒就能被同一个模型改掉。
  **在 features-dev 上引入常驻授信 = 把 `NEVER_GRANTABLE_TYPES` 那条线从侧门绕过去。**

**G12.（G5 的复评，本期承诺的那一条）renderer 侧仍无挂卸语义 —— 判据未触发，但现在具体了**
- G5 的裁决原话是「本期拒绝，C4 重新评估……C4 要做『模型现场挂卸 demo feature』，
  那个 demo 若带 UI，这条才变成真需求」。
- *复评结论*：**C4 第一档的 demo 不带 UI（它注册的是一个 RPC 域），所以 G5 维持拒绝。**
  但触发条件从「若带 UI」收紧成一句可执行的判据：**动态 feature 需要在 renderer 注册任何东西的
  那一刻**，G5 立刻变成必须做的事 —— 那时缺的不止是 `mountRendererFeature`，还有一条
  「后端挂载完通知 renderer 去注册」的下行通道（今天 renderer 的 feature 全是模块求值即注册，
  没有任何运行期入口）。这两样是 C4 第二档的实际工作量，不是一个 `registerWorkspacePanel` 的事。

**G13.（G8 的复评）`registerDisposer` 接得住，缺的确实是顺序 —— 处方第一次被执行，并暴露一处可读性债**
- G8 原话：「不加新注册面，而是把整组工作收进**一个** `registerDisposer`」。
- *复评结论*：**结论成立，处方原样照做，有用例钉住**（§7.2 地雷 1）。
- *新记一条经验*：cordis 只保证**单个 effect 内部**串行 + 逆序；effect **之间**的顺序仍然只能靠
  注册顺序表达。也就是说本层的「顺序」是**由注册顺序编码的隐式契约** —— 读代码的人必须先知道
  「最后注册的最先解绕」才看得懂 `self-evolution.ts` 末尾那三行为什么是那个次序。
  这是**可读性债，不是正确性债**：不提案加「顺序声明」API（那会把 D2 明确拒绝的依赖排序从后门放进来），
  但 C5 收口时值得考虑给 `registerDisposer` 加一个可选 label，让 `getEffects()` 的标签树自己讲出次序。
  （今天四个 disposer 在标签树里长得一模一样：`feature(self-evolution):disposer` ×4。）

**G14. 测试环境的动态加载器 ≠ 生产环境的动态加载器**
- *缺口*：vitest 下 `import(file://…)` 走的是 vite-node 的 transform 管线，不是 Node 原生 ESM。
  证据是语法错用例拿到的 message 是 vite 的
  「Failed to parse source for import analysis…」而不是 Node 的 `SyntaxError`。
  也就是说：cache-bust 用例在测试里证明的是「vite-node 的缓存被绕开了」，
  生产里绕开的是 Node 的 ESM 缓存 —— 两者机制都以 URL 为键，结论**大概率**一致，但不是同一次证明。
- *原语化改写*：无（这是测试基础设施的性质，不是 API 缺口）。
- *裁决*：**如实记，不修。** 修它的唯一办法是给这条路径加一个真机/子进程用例，
  而那要新起一套 harness。**记下判据**：C4 第二档真机走查时，第一件要手验的事就是
  「改文件 → 重挂 → 行为变了」在打包产物里也成立。在那之前，这条的信号质量是**中**（不是高）。

**G15. 动态 feature 的代码不经过任何静态检查**
- *缺口*：模型写的 `.mjs` 不过 typecheck / boundary / lint，它 import 什么、碰什么全靠运行期。
- *原语化改写*：加载前做一道静态扫描（禁 import 清单）。
- *裁决*：**拒绝。** 两条理由：(1) 它是**安全剧场** —— 一个能执行任意代码的模块可以用
  `await import(...)` 绕开任何静态禁令；(2) 真正的边界是「要不要让它跑」，而那道门已经在
  （每次一张永不可记住的权限卡 + 宿主档门 + 目录白名单）。要更强的隔离只有一条真路：
  进程/worker 隔离（Agent 沙箱那条线，`project_agent_sandbox_design`），而那不是加一个扫描器能凑出来的。

**G16.（G6 的第二次触发点）`feature_inspect` 只看得见后端半**
- G6 的裁决是「暂缓，等 C3 迁完三个双半 feature 再看」。本期没有增加双半 feature，
  但 `feature_inspect` 让这个洞第一次**有了消费者**：模型问「这件功能现在长什么样」，
  拿到的答案只覆盖后端半（`trajectory` 在 inspect 里看起来只有一个 RPC 域，它的面板不在场）。
- *裁决*：**判据不变，仍然暂缓。** 但记一条给 C4 第二档：inspect 的输出格式要**预留 renderer 半的位置**，
  别到时候改格式 —— 模型会照着这份输出学「一个 feature 长什么样」。

**清单条数**：#1 是 9 条（G1–G9）。#2 = 新增 6 条（G10 / G11 / G14 / G15 各一条真缺口或裁决，
G12 / G13 是 §6.5 承诺的两条复评）+ 1 条触发点更新（G16）。
状态：**1 条排期（G10→C5）、3 条明确拒绝（G11 / G15，以及维持拒绝的 G12/G5）、
1 条已执行并结案（G13/G8）、2 条如实记录待触发（G14 真机判据、G16 等 C3）**。

#1 里的其余条目本期无变化：G1（聊天入口表达力档）仍排 C3；G2 / G4 维持拒绝；
G3（renderer 测试补 import）计数未增；G7（`registerAppRpcDomains` 改名）仍排 C5，
本期又给了它一条新理由 —— 名册里现在有一个**一个 RPC 域都不注册**的成员，
函数名比内容窄的已经不是半格了。
