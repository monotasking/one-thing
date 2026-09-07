# 01｜统一进程所有权：一个 Store 只能有一个 Core 写入

> 顺序：01 / 10　风险级别：P0　建议阅读时间：8 分钟  
> [返回总览](./README.md) · [补充学习：进程所有权、锁与生命周期](./learning/03-process-ownership-and-lifecycle.md)

## 为什么排在这里

会话历史是后续恢复、回放和排障的根。如果两个进程同时给同一份数据分配序号并写文件，损坏可能长期不被发现。代码已经明确存在“双写入口”；账本是否已在真实环境损坏，本次未做破坏性复现，因此这里只把“入口存在”列为静态确认，把“发生损坏”列为满足并发双写条件后的后果。

## 先讲人话

把 Store 想成一本账，Core 是记账员。桌面端、独立服务器和 CLI 都可以成为记账员，但同一时刻只能有一个。发现文件只是门牌，告诉客户端“记账员在哪里”，不能代替门锁。

## 相关概念

- **Store**：某个数据目录及其中的会话账本。
- **Core**：持有内存状态、执行命令并写 Store 的后端实例。
- **CoreLease**：对“规范化后的 Store 路径”取得的排他租约；覆盖所有宿主，而非只锁 Electron。
- **Discovery**：Core 的地址、端口和 token，只用于连接发现。

背景学习：[进程所有权与生命周期](learning/03-process-ownership-and-lifecycle.md)。

## 当前流程

```text
宿主启动
  → 读取 discovery 并探活
  → 找到其他 Core：连接或退出
  → 没找到：装配 Backend → 启动 HTTP → 覆盖 discovery
                         （这里没有统一排他租约）
```

## 当前现状与代码证据

- CLI daemon 已使用 `StoreLock`：`apps/cli/src/daemon-server.ts:33-45`。
- standalone server 只有当 discovery 的 owner **不是** `server` 才拒绝；第二个 server 会绕过判断，`--force` 也允许继续：`apps/server/src/main.ts:64-97`。
- discovery 直接写文件，它本身不提供互斥：`packages/backend/server/discovery.ts:48-59`。
- Electron 会“发现则连接、否则自建 Core”，但创建前未取得 Store 级租约：`apps/desktop-react/electron/main.ts:424-448`。
- 正常 `will-quit` 会等待 `backend.dispose()`；`SIGTERM/SIGINT` 却直接退出：`apps/desktop-react/electron/main.ts:464-493`。standalone server 已有带超时的完整关停：`apps/server/src/main.ts:196-240`。

## 问题与实际后果

两个同类型 server、并发冷启动或使用 `--force` 时，可能出现两个 writer。它们各自维护内存序号，条件成立时会产生重复序号、覆盖错误区间或分裂的内存真相。另一个独立问题是 Electron 收到系统信号时跳过刷盘和资源释放；正常关闭路径没有这个问题。

## 推荐目标

建立统一的 `CoreLease`：所有可写宿主必须先获得租约，才能装配 Backend；租约成功且 HTTP 就绪后才发布 discovery。未获得者只能连接现有 Core 或清晰退出。discovery 带本次 lease/instance 标识，只允许发布者删除。`--force` 不得绕过写租约，可另设明确的只读恢复模式。租约由 Backend 生命周期持有，所有退出信号汇入同一个、有时间上限的 `dispose()`。租约要先于缓存、序号分配器和写队列创建，避免失败方留下半装配状态；失败方即使转为客户端，也绝不能创建本地写队列。

## 分步迁移

1. 统一 Store 路径规范化、owner/instance 标识和冲突错误，不改变启动行为。
2. 复用并加固现有 `StoreLock`，封装为所有宿主共用的 `CoreLease`。
3. 依次接入 server、Electron、CLI：先取租约，再装配；失败绝不写 Store。
4. 将 discovery 改为“服务就绪后发布、按 instance 删除”，清理启动竞态。
5. 让 Electron 的信号、窗口关闭和异常关停复用同一条限时收尾链。

## 验收清单

- [ ] 同一 Store 同时启动任意两个宿主，只有一个 writer；两个 server 也一样。
- [ ] 不同 Store 可并行运行；失败方不会覆盖或删除胜出方的 discovery。
- [ ] `--force` 无法制造双写，陈旧租约可按明确规则恢复。
- [ ] `SIGINT/SIGTERM` 会执行队列 flush、HTTP 关闭和 lease 释放；超时有非零退出及日志。
- [ ] 有多进程竞态、崩溃后重启、正常退出的自动化测试。

## 明确不做

本项不重写事件存储，不取消内嵌 HTTP，不给只读客户端加写锁，也不把 Electron 单实例锁当作 Store 锁。

## 术语表

**排他租约**：同一资源同时只允许一个持有者；**writer**：会改变 Store 的进程；**陈旧租约**：持有进程已不存在但遗留的锁记录；**优雅退出**：停止接单、排空写队列、释放资源后再退出。
