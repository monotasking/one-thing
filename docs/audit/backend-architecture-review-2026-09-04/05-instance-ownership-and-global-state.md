# 05｜实例所有权、依赖注入与全局状态

> 顺序：05 / 10　风险级别：P1 结构债务　建议阅读时间：10 分钟  
> [返回总览](./README.md) · [补充学习：依赖注入、模块与循环依赖](./learning/05-dependency-injection-modules-and-cycles.md)

## 为什么排在这里

这是第 5 项：它通常不会像数据丢失或越权那样立刻伤害用户，却是后续拆模块、消除循环依赖和可靠测试的基础。应保留已经做对的 `OnethingBackend`，再逐步把隐藏在模块全局里的依赖收回实例，而不是重写整个后端。

## 先讲人话

`OnethingBackend` 已像一位总管：知道启动了什么，也知道关机时按顺序收回什么。但不少模块仍有自己的“公共抽屉”，任何代码都能通过 `getXxx()` 找到当前对象。调用者表面没有参数，实际却偷偷依赖“全局那一份已经初始化”。这会让启动顺序、测试隔离和多实例变得难懂。

## 相关概念

- **依赖注入（DI）**：对象需要什么，由创建它的人明确传入。
- **Composition Root**：唯一负责创建对象并把依赖接起来的入口。
- **Service Locator**：业务代码主动去全局位置查找依赖；方便，但依赖被藏起来。
- **实例所有权**：谁创建资源，谁负责释放它。

建议先读：[分层、端口与组合根](./learning/01-layering-ports-and-composition-root.md)；再读：[依赖注入、模块与循环依赖](./learning/05-dependency-injection-modules-and-cycles.md)。

## 当前流程

```text
宿主
  └─ OnethingBackend.assemble()
       ├─ 安装 Host Ports
       ├─ 创建 EventBus / Engine / Session / RPC
       ├─ 登记 disposer（逆序释放）
       └─ 写入 current backend 全局槽

业务模块 ── getEventBus()/getStreamEngine() ──> current backend
其他模块 ── 自己的 module-level let / singleton
```

## 当前现状与代码证据

优点很明确：`OnethingBackend` 已是实例对象，[`packages/backend/backend.ts:171`](../../../packages/backend/backend.ts#L171)；`own()` 与 `dispose()` 实现幂等、逆序释放且单个失败不阻断其余清理，[`packages/backend/backend.ts:247`](../../../packages/backend/backend.ts#L247)；重复装配会被拒绝，半途失败会回滚，[`packages/backend/backend.ts:335`](../../../packages/backend/backend.ts#L335)。这部分应保留。

但实例之外仍有进程级当前槽，[`packages/backend/current.ts:134`](../../../packages/backend/current.ts#L134)，例如 `getEventBus()` 通过它查找对象，[`packages/backend/events/index.ts:33`](../../../packages/backend/events/index.ts#L33)。现有 assembly 棘轮记录了 63 个生产文件、合计 99 个模块级状态槽；它的规则是“只许减少、不得新增”，且明确豁免 `current.ts`，[`docs/audit/assembly-baseline-2026-09-02.txt:1`](../assembly-baseline-2026-09-02.txt#L1)。门禁是好事，但 99 是债务基线，不是理想终态。

## 问题与实际后果

- 函数签名看不出真实依赖，读代码必须追踪 `get/configure/reset`。
- 轻量单测需要先装配或清全局状态；并行测试更容易互相污染。
- 同一进程天然只能有一个 backend；未来做隔离预览、迁移验证或双实例测试困难。
- dispose 是否完整取决于每个模块是否记得暴露 reset/dispose。

当前产品本来就按“一进程一 backend”运行，因此这不是已知线上故障；它主要是演进成本和错误放大器。纯常量、无副作用缓存也不必为了形式全部注入。

## 推荐目标

让 `OnethingBackend` 持有一个实例级 `BackendContext`，其中包含 host ports、event bus、session services、registries、engine 与 lifecycle。各工厂只接收自己所需的窄端口，不把整个 context 传遍全仓。

迁移期间保留一个 `LegacyBackendAccess`：旧 `getXxx()` 统一委托给它，新代码禁止新增 locator 调用。它是可统计、可删除的兼容桥，不是第二个永久架构。

## 分步迁移

1. 给 99 个槽分类：实例资源、可注入配置、缓存、注册表、纯测试状态；先迁真正有生命周期的资源。
2. 从现有 `OnethingBackend.parts` 提炼 `BackendContext`，保持行为与装配顺序不变。
3. 选择一个叶子功能纵向迁移：工厂接收窄 ports，返回 `{ service, dispose }`，由 backend 持有。
4. 旧访问器改走 `LegacyBackendAccess` 并标记 deprecated；每迁一组就收紧 baseline。
5. 最后迁 Session/Engine 等中心模块；待旧调用为零后删除 current slot，而非一次性替换。

## 验收清单

- [ ] `OnethingBackend` 的回滚、LIFO dispose 和 Host Ports 还原行为保持不变。
- [ ] 两个测试用 `BackendContext` 的 event、settings、cache、registry 不串线。
- [ ] 释放其中一个 context 不影响另一个。
- [ ] import 模块不触发装配或注册副作用。
- [ ] assembly baseline 每批只下降、不反弹。
- [ ] 新业务 service 的依赖从构造参数或工厂参数可见。

## 明确不做

- 不删除或推倒 `OnethingBackend`；它是迁移的正确起点。
- 不把一个巨大的 `BackendContext` 传给所有函数，这只是换一种 Service Locator。
- 不为纯函数、常量和无生命周期值制造无意义接口。
- 不先搬目录；依赖方向改变后再做物理整理。

## 术语表

- **BackendContext**：一套 backend 实例拥有的依赖集合。
- **Legacy adapter**：迁移期兼容旧调用的薄桥。
- **Module-level state**：模块加载后在进程内共享的可变值。
- **LIFO dispose**：后创建的资源先释放。
