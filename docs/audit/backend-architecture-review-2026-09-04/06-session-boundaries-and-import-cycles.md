# 06｜Session 边界与运行时循环依赖

> 顺序：06 / 10　风险级别：P1 结构债务　建议阅读时间：12 分钟  
> [返回总览](./README.md) · [补充学习：依赖注入、模块与循环依赖](./learning/05-dependency-injection-modules-and-cycles.md)

## 为什么排在这里

这是第 6 项：Session 是核心数据域，边界混乱会让每次修改都更危险；但目前有懒初始化和测试保护，尚不能说循环已经造成线上故障。它最好接在第 5 项实例级依赖注入之后处理，否则只是把环从一个文件挪到另一个文件。

## 先讲人话

现在有些 Session 模块互相当上级：Store 调 Command，Command 又调 Store；Event Surface 找 Writer 注册，Writer 又回头找 Surface。就像两个部门互相等对方先盖章——平时可能靠碰巧的加载顺序运行，一旦调整入口、测试方式或拆文件，问题就容易暴露。

## 相关概念

- **运行时依赖**：程序启动后真的要读取或调用的 import；不同于只给 TypeScript 检查的 `import type`。
- **循环依赖**：A 依赖 B，同时 B 经一条或多条路径又依赖 A。
- **SCC**：依赖图中互相可达的一组模块，即一个完整的环。
- **Ownership**：哪个组件有权修改状态、落盘和清理资源。

入门材料：[依赖注入、模块与循环依赖](./learning/05-dependency-injection-modules-and-cycles.md)；若还不熟悉“端口”，先读[分层、端口与组合根](./learning/01-layering-ports-and-composition-root.md)。

## 当前流程

```text
RPC / Engine
    │
    v
sessionCommands <──────────── stores/sessions
    │                              │
    └──────── 调用 store ports ────┘

writeSessionEvent -> event-log -> 同步观察者 -> Projection / Surface
          │                                  ^          │
          └──── event-writer -> event-surface ┴──────────┘

reads -> Projection，同时仍能访问 Store
```

## 当前现状与代码证据

代码已经有正确雏形：`createSessionCommands(ports)` 明确定义了依赖端口，[`packages/backend/session/commands.ts:108`](../../../packages/backend/session/commands.ts#L108)、[`packages/backend/session/commands.ts:294`](../../../packages/backend/session/commands.ts#L294)；事件账本有统一 append 与 flush/fsync，[`packages/backend/session/event-log.ts:445`](../../../packages/backend/session/event-log.ts#L445)、[`packages/backend/session/event-log.ts:607`](../../../packages/backend/session/event-log.ts#L607)；Projection 也明确以事件折叠为读模型，[`packages/backend/session/projection-cache.ts:15`](../../../packages/backend/session/projection-cache.ts#L15)。这些都值得保留。

问题出在生产接线仍放在业务模块内部：Store 导入 `sessionCommands`，[`packages/backend/stores/sessions.ts:29`](../../../packages/backend/stores/sessions.ts#L29)；Command 又导入六个 Store 实现，并在模块内保存 singleton，[`packages/backend/session/commands.ts:59`](../../../packages/backend/session/commands.ts#L59)、[`packages/backend/session/commands.ts:537`](../../../packages/backend/session/commands.ts#L537)。另一条直接环是 Surface 导入 Writer 的注册函数，[`packages/backend/session/event-surface.ts:33`](../../../packages/backend/session/event-surface.ts#L33)，Writer 又导入 Surface，[`packages/backend/session/event-writer.ts:53`](../../../packages/backend/session/event-writer.ts#L53)。本次值依赖扫描共发现 6 个非平凡 SCC；上述两组是最容易说明的直接环。

## 问题与实际后果

- ESM 初始化顺序可能出现“变量尚未完成初始化”或拿到半成品对象。
- 单测一个 Command 会拉起 Store、日志、Projection 等更大依赖图。
- 无法一句话回答“谁是唯一写入口、谁负责 flush、谁负责恢复”。
- 为避开环而增加 lazy singleton、barrel 或动态 import，只会隐藏依赖。

目前懒建 singleton、运行期注册观察者及 import-side-effect 测试降低了即时风险，所以这里描述的是结构风险，不宣称当前必然崩溃。

## 推荐目标

由组合根单向创建并连接以下实例：

```text
SessionCommandService -> SessionCommitter -> EventStore
                              │               │
                              v               v
                          Projection <---- Recovery

SessionQueryService ---------> Projection
SessionLifecycle -----------> Command / EventStore / cleanup ports
```

- **CommandService**：校验并表达业务动作，是 mutation 入口。
- **Committer**：唯一协调事件序号、活投影和耐久确认的组件。
- **EventStore**：只负责 append/read/flush 原始事件。
- **Projection / QueryService**：分别负责折叠状态和只读用例。
- **Lifecycle**：负责 create/delete/finalize 及相关清理。
- **Recovery**：启动时 repair/replay，在对外服务前完成。

## 分步迁移

1. 增加生产 value-import SCC 门禁；先记录现状，只许减少，排除 `import type`。
2. 将中立接口和事件类型放到不依赖实现的 contracts 文件，避免从 barrel `index` 反向导入。
3. 先断 `stores ↔ commands`：把现成 `createSessionCommands(ports)` 的生产绑定移到 `OnethingBackend/BackendContext`；旧导出仅委托实例。
4. 再断 `surface ↔ writer`：由组合根创建 `SessionEventPipeline` 并注册观察者，两边只依赖 EventStore/Projection ports。
5. 收口 Query、Lifecycle、Recovery；逐组删除 singleton、reset hook 和反向 import。
6. 每断一环运行冷启动、热写、flush、崩溃恢复和投影重放对拍，最后把 SCC 基线降为 0。

## 验收清单

- [ ] 生产代码非平凡 value-import SCC 为 0。
- [ ] Command、Writer、Surface、Query 的 import 不互相回指。
- [ ] import 任一 Session 模块不会注册观察者或创建 singleton。
- [ ] 所有 mutation 只经过 CommandService/Committer。
- [ ] 热投影与从磁盘冷重放结果一致。
- [ ] 删除、退出、恢复时的 flush/cleanup 有明确 owner 和测试。

## 明确不做

- 不改现有事件格式，不借机重写整套 Event Sourcing。
- 不用动态 import、换 barrel 或合并成更大文件来“消除”扫描结果。
- 不追求一个函数一个文件；边界按职责和所有权划分。
- 不在实例级 DI 之前大规模移动 Session 目录。

## 术语表

- **TDZ**：ES Module 变量创建但尚未初始化的时间窗口。
- **Committer**：统一协调一次业务写入各阶段的组件。
- **Projection**：由事件计算出的可查询状态。
- **Recovery**：重启后修复并从持久化事件重建状态。
