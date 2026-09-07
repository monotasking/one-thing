# 10. 整体目标架构与分阶段迁移路线

> 顺序：10 / 10　性质：执行总账　建议阅读时间：15 分钟  
> [返回总览](./README.md) · [补充学习：如何安全评审架构重构](./learning/07-how-to-review-an-architecture-refactor.md)

## 为什么这篇排在最后

这篇不是第十重要，而是前九篇的执行总账。先理解前面的具体问题，再看路线会更容易判断每一步为什么存在。真正实施时，应从本篇的阶段 0 和阶段 1 开始。

如果你第一次参与架构重构，建议先读 [如何安全评审和推进一次架构重构](./learning/07-how-to-review-an-architecture-refactor.md)。

## 先讲人话

不建议重写后端，也不建议先搬目录。推荐采用“绞杀式迁移”：

1. 先给现有行为加测试和门禁；
2. 在旧 API 后面建立新的、边界清楚的实现；
3. 每次只迁移一条完整业务流程；
4. 旧 API 改为调用新实现；
5. 调用点归零后再删除兼容层和移动文件。

这样每一批都可验证、可回滚，不需要同时理解整个代码库。

## 目标架构

箭头表示左边可以依赖右边：

```text
Host process
  ├─ ProcessLease + signal lifecycle
  └─ BackendContext / composition root
          │
          ├─ inbound adapters: RPC / HTTP / CLI
          │             │
          │             ▼
          ├──── application use cases + ports
          │             │
          │             ▼
          │        core domain / policies
          │             ▲
          └─ infrastructure adapters
             event store / files / provider / MCP

client ──────────────→ shared wire contracts
RPC adapter ─────────→ shared wire contracts
```

目标不是追求教科书目录，而是落实五条硬规则：

1. 一个 store 同时只能有一个 core writer。
2. 每个 mutation 只有一个应用入口和一种明确的提交语义。
3. domain/application 不依赖 HTTP、Electron、Node 文件路径或全局 locator。
4. transport DTO、domain model、persistence record 分开演进。
5. 所有资源都属于一个可释放的实例或进程对象。

## 迁移总顺序

```text
阶段 0：冻结事实和行为
   ↓
阶段 1：先封住数据、安全和协议风险
   ↓
阶段 2：建立逻辑边界与 BackendContext
   ↓
阶段 3：收口 Session 写入与清除循环
   ↓
阶段 4：拆 Server Runtime 和 Engine
   ↓
阶段 5：删除兼容层、整理物理包
```

## 阶段 0：冻结事实和行为

### 目标

先让每项债务可以被计数，让后续重构失败时能够被自动发现。

### 工作项

- 为当前生产 value-import SCC 建“只许降”基线；当前扫描为 6 个强连通分量。
- 为模块级 mutable state 和 legacy locator 调用数建立基线；现有 assembly 基线是 99 个槽位、63 个文件。
- 禁止新增 `stores → commands`、`event-store → projection/surface` 等反向边。
- 给直接 `appendSessionEvent`、直接 `saveSession` 的生产调用点建立允许名单。
- 修正 boundary 检查对 `@shared/events` 等路径覆盖不完整的问题。
- 冻结 RPC JSON、SSE event、`meta.json`、`events.jsonl` fixture。

### 验收

- gate 自己有“故意制造违例就会红”的测试。
- 所有既有测试与 fixture 保持不变。
- 本阶段不改变产品行为。

## 阶段 1：安全止血

### 目标

先处理可能造成数据损坏、越权或用户可见丢事件的问题。

### 工作项

- 所有宿主在装配 backend 前获取统一 `CoreLease`，discovery 只负责告诉客户端连接地址。
- Electron、server、CLI 共享同一套 signal shutdown：停止接单、排空写队列、关闭 adapter、释放 backend，最后释放 lease。
- 明确本机单用户或真实多租户模型；为 session command 增加统一授权点。
- 修正 SSE wildcard/per-session cursor 冲突和重启后的 replay 语义。
- 给 HTTP body 加上限，给 SSE 慢客户端增加有界队列或淘汰策略。
- 给 mutation 增加 request/command id；先定义 accepted 与 committed 的区别。

### 验收

- 两个进程争用同一 store 时只能有一个 writer。
- 收到 committed 后立刻杀进程，重启仍可恢复该命令。
- 跨 owner 的 session command 被拒绝。
- SSE 断线与 backend 重启测试不漏、不乱、不重复应用事件。
- 慢客户端内存占用有明确上限。

## 阶段 2：建立逻辑边界与实例级上下文

### 目标

新代码不再依靠模块级 `getXxx()` 或 `configureXxxHost()` 找依赖。

### 建议对象

```text
BackendContext
  hostPorts
  logger / clock / idGenerator
  rpcRegistry
  sessionCommands / sessionQueries
  eventBus / engine
  subsystems
  dispose()
```

### 兼容方式

- 保留一个 `LegacyDefaultBackend` adapter，让旧访问器只通过它转发。
- 新 factory 显式接收 `BackendContext` 或窄 ports，不允许 import legacy adapter。
- 真正进程级的 signal、lease、Electron app 放在 `ProcessContext`，不伪装成业务服务。
- 先在现有 package 内建立逻辑目录和 exports，不立即拆 workspace。

### 验收

- 同进程可创建两个独立的 in-memory service graph，event、settings、cache 不串线。
- dispose 一个实例不影响另一个。
- 新增模块级 mutable singleton 为 0。
- legacy locator 调用数只减不增。

## 阶段 3：收口 Session 子系统

### 目标形状

```text
SessionCommandService
        │ decide / validate
        ▼
SessionCommitter
  ├─ SessionEventStore
  ├─ SessionProjectionStore
  ├─ SessionMetaIndex
  └─ EventPublisher

SessionQueryService ──→ SessionProjectionStore
SessionLifecycleService
SessionRecoveryService
```

### 迁移顺序

1. 先迁 rename、pin、archive 等低风险元数据命令；
2. 再迁 model、agent、working directory；
3. 再迁 message mutation 和 streaming；
4. 最后迁 branch、delete、recovery 和 hydration。

旧的 `stores/sessions.ts`、`store.ts` 暂时保留签名，但内部只能委托给新服务。每迁完一组，立即删除旧写路径并收紧 gate。严禁新旧实现同时写同一事实。

### 验收

- Session 子图 runtime SCC 为 0。
- 除 `SessionCommitter/EventStore` 外没有直接 event append。
- store/repository 不再 import command。
- live projection 与从磁盘 cold replay 的结果逐字段一致。
- 写失败、flush 失败、尾部损坏、foreign writer、崩溃恢复都有故障注入测试。

## 阶段 4：拆 Server Runtime 和 Engine

### 前提

必须等 `BackendContext` 和 application ports 稳定后再拆，否则只是在多个文件中复制相同的全局依赖。

### 建议拆分

- `OwnerScopeRegistry`：唯一管理 owner → scope。
- `OwnerScope`：拥有该 owner 的 session/settings/plugin/MCP 等状态及 dispose。
- session、settings、event stream、media、MCP adapter：各自只依赖窄 application ports。
- trust、audience、workspace resolver：独立 policy。
- runtime 根文件只负责 create、wire、dispose。

Engine 同时按规则归位：纯算法和状态机进 core；用例编排进 application/runtime；Provider、文件、IPC/HTTP 等适配进 infrastructure/backend。

### 验收

- runtime 根不再持有各 feature 的多张 `xxxByOwner` Map。
- server adapter 不直接 import backend store。
- default owner 与 embedded desktop 复用同一 application service。
- scoped owner 的数据与生命周期互相隔离。
- core/application 不出现 transport 常量或 Node 文件系统依赖。

## 阶段 5：清理兼容层和物理结构

只有在调用量归零后才进行：

- 删除 default backend locator 和旧 `configureXxxHost` 单槽；
- 删除大桶式 `store.ts` 和旧 DTO alias；
- 清除 `shared → runtime` 实现重导出；
- 补齐 workspace package 的直接依赖声明；
- 根据已稳定的逻辑边界决定是否物理拆包；
- 将循环依赖和 legacy import gate 从基线棘轮改为零容忍。

## 每一批都要遵守的规则

- 旧 API 可以调用新实现，新实现不能反向调用旧 façade。
- 读路径可以 shadow compare，写路径不能 shadow commit。
- 一批只改变一个 ownership 边界，不顺手改协议和数据格式。
- 文件格式保持兼容；需要升级时使用 versioned codec/upcaster。
- 每批必须有独立回滚点和一条能证明改动有效的反证测试。

## 最终完成标准

- production value-import graph 是 DAG，SCC 为 0。
- 一个 backend 的所有状态都能从其实例字段追溯。
- package graph 没有未声明依赖和 `shared ↔ runtime` 双向边。
- 所有 mutation 都有唯一入口、稳定错误码和清楚的确认语义。
- 单写者、崩溃恢复、owner 隔离、SSE replay、双实例隔离都有自动测试。
- 所有现有 boundary、assembly、transport、session、client 和 build gate 通过。

## 明确不建议做

- 不要先把 4,000 行文件机械切成十几个文件。
- 不要为了获得事务感立刻把整个文件存储换成数据库。
- 不要一次删除所有全局访问器。
- 不要同时维护两套写实现做“双写验证”。
- 不要在没有 fixture 和回放测试时修改磁盘格式。
