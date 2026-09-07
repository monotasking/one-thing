# 07｜收窄 Server Runtime 与 Engine 的职责边界

> 顺序：07 / 10　风险级别：P2 结构债务　建议阅读时间：8 分钟  
> [返回总览](./README.md) · [补充学习：分层、端口适配器与组合根](./learning/01-layering-ports-and-composition-root.md)

## 为什么排在这里

它会持续拖慢改动，但暂时没有证据表明“文件大”本身正在造成数据错误。前六项先解决单写者、提交语义、续播、身份、实例化和循环依赖；尤其要先完成实例级依赖注入，再拆这里，否则只是把同一批隐式依赖分散到更多文件。

## 先讲人话

现在像是一位总管同时记住每位用户的会话、设置、插件、媒体和变量，还兼任引擎接线员。业务仍能运行，但任何一项变化都容易惊动很多邻居。目标不是“把大文件切小”，而是让总管只负责组装，每个业务区和每个 owner 自己管理资源。

## 相关概念

- **Port（端口）**：上层只声明“需要什么能力”，不直接认识文件系统、Provider 等实现。
- **Composition Root（组合根）**：唯一负责创建对象和接线的位置。
- **Owner Scope**：某个用户与工作区专属的一组状态和服务，应能整体创建、查询和释放。

入门说明见 [分层、端口与组合根](./learning/01-layering-ports-and-composition-root.md) 和 [依赖注入、模块状态与循环依赖](./learning/05-dependency-injection-modules-and-cycles.md)。

## 当前流程

```text
Host → OnethingBackend → Server Runtime
                         ├─ owner A 的多张 Map → 各域服务
HTTP/RPC ────────────────┤
                         └─ Engine
                            CoreStreamEngine
                                  ↑ extends
                            ProductStreamEngine ← backend wiring 注入实现
```

## 当前现状与代码证据

- [server/runtime.ts:944](../../../packages/backend/server/runtime.ts#L944) 全文件约 4332 行，其中主工厂一直延伸到 2513 行；同一闭包既建 facade，也处理多 owner 状态和 shutdown。
- [server/runtime.ts:964](../../../packages/backend/server/runtime.ts#L964) 同时维护 session、permission、settings、MCP、agent、prompt、plugin、media、variables 等多张集合；[server/runtime.ts:2447](../../../packages/backend/server/runtime.ts#L2447) 又集中清理它们。
- 引擎已经有正确雏形：[engine/ports.ts:52](../../../packages/onething-runtime/src/engine/ports.ts#L52) 定义产品端口，[stream-engine-bound.ts:53](../../../packages/backend/wiring/engine/stream-engine-bound.ts#L53) 负责接线。
- 但职责仍横跨三层：[core-stream-engine.ts:409](../../../packages/core/engine/core-stream-engine.ts#L409) 是通用引擎，[runtime/engine/stream-engine.ts:101](../../../packages/onething-runtime/src/engine/stream-engine.ts#L101) 叠加产品规则，[stream-engine-runtime.ts:59](../../../packages/backend/wiring/engine/stream-engine-runtime.ts#L59) 再组装 store、provider、执行器和压缩器。

## 问题与实际后果

1. 新增一个 owner 级能力，容易同时修改创建、查找、权限和清理代码，漏清理的风险随 Map 数量增加。
2. Runtime facade、owner 隔离、域实现和生命周期挤在一个闭包，单元测试很难只替换其中一块。
3. Engine 三层都有相近的 executor、processor、prompt 概念，开发者难判断规则应该落在哪里，改动影响面和循环依赖都可能扩大。

这些是可维护性风险，不等于当前功能已经错误。

## 推荐目标

```text
ServerCompositionRoot
  ├─ OwnerScopeRegistry → OwnerScope（拥有并释放该 owner 的服务）
  ├─ DomainAdapters（sessions/settings/plugins/...）
  └─ EventStreamAdapter

core engine：纯算法、状态机和通用策略
product runtime：产品用例与业务规则
backend wiring：实现端口和组装，不做业务判断
```

## 分步迁移

1. 先列出 runtime 内每项状态的 owner、创建者、使用者和释放者，并用现有测试锁住行为。
2. 先定义 `OwnerScope`、域 adapter 和 engine port 的最小接口；不要先移动文件。
3. 把多张 `*ByOwner` Map 收进可幂等释放的 `OwnerScopeRegistry`，先保持原实现委托。
4. 按 sessions → settings → plugins/MCP → media/files 逐域抽出 adapter，每次只迁一条路径。
5. 对 engine 重复概念逐个判定归属：规则进 core/runtime，Node、store、Provider 实现留 backend。
6. 所有调用切换后再缩小 facade、删除兼容委托和旧导出。

## 验收清单

- [ ] 创建和销毁一个 owner 可独立测试，资源只释放一次。
- [ ] Server Runtime 根部不再直接持有成组的 `*ByOwner` Map。
- [ ] backend wiring 只适配端口，不新增产品规则。
- [ ] 三种宿主行为、已有 RPC/SSE 契约和 shutdown 测试保持通过。
- [ ] 拆分没有新增运行时循环依赖。

## 明确不做

- 不因行数一次性重写，也不先调整 workspace/package 布局。
- 不把多张 Map 换成一个无类型的“大对象袋”。
- 本阶段不顺便更改 RPC、存储格式或用户可见行为。

## 术语表

- **Facade**：给调用方看的统一入口。
- **Adapter**：把具体实现翻译成端口要求的形状。
- **Scope**：共享同一生命周期和归属的一组对象。
