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
