# 学习 03：进程所有权、锁与生命周期

> [返回学习目录](./README.md) · [返回架构审查总览](../README.md)

## 进程、实例和 store 是三件事

- 进程：一个 Electron main、一个 `server:start` 或一个 CLI daemon。
- Backend 实例：进程中创建的一套 event bus、engine、store 和服务。
- Store：多个进程可能指向的同一份磁盘数据目录。

“一个进程只能创建一个 backend”不等于“一个 store 只有一个 writer”。模块级变量只能挡住当前进程，挡不住另一个进程。

## Discovery 为什么不是 Lock

Discovery 文件回答“服务在哪里”，Lock/Lease 回答“谁有权写”。它们解决的问题不同。

下面的流程存在 TOCTOU 竞争：

```text
进程 A：检查没有服务 ─────→ 启动 ─────→ 写 discovery
进程 B：检查没有服务 ─────→ 启动 ─────→ 写 discovery
```

两个进程可能同时通过检查。后写 discovery 的进程只会覆盖地址，不会让前一个 writer 消失。

真正的锁通常依赖原子操作，例如以 exclusive-create 创建锁文件。成功者成为 owner，失败者只能连接现有 core 或退出。

## Lock 与 Lease

Lock 只表示“有人占用”。Lease 还会记录可诊断信息：

- store 的规范化路径或指纹；
- owner 类型；
- PID 和启动时间；
- 协议版本；
- 必要时的续租时间。

如果进程异常退出，系统要能判断锁是否陈旧，但不能仅凭 PID 存在就认定它仍拥有正确的 store。

## 正确启动顺序

```text
解析 store 路径
  → 原子获取 CoreLease
  → 装配 Backend
  → 启动 HTTP/IPC adapter
  → 写 discovery
  → 开始接收请求
```

如果只想连接已有 core，则不获取写 lease，只读取 discovery 并探活。

## 正确关停顺序

```text
停止接受新请求
  → 停止调度新任务
  → 等待在途命令到安全边界
  → flush event/meta 队列
  → 关闭 SSE、MCP、watcher、HTTP
  → dispose Backend
  → 删除 discovery
  → 最后释放 CoreLease
```

所有退出入口——窗口退出、SIGTERM、SIGINT、测试 teardown——都应该调用同一套幂等 shutdown，而不是各写一份清单。

## 在本项目中对应什么

- Electron 启动与关停：`apps/desktop-react/electron/main.ts`
- standalone server：`apps/server/src/main.ts`
- CLI daemon 锁：`apps/cli/src/daemon-server.ts`
- StoreLock 实现：`packages/onething-runtime/src/storage/store-lock.ts`
- discovery：`packages/backend/server/discovery.ts`

读主文档第 01 篇时，重点区分“发现现有服务”和“拥有写权限”。
