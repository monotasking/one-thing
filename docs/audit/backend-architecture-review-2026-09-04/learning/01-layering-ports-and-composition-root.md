# 学习 01：分层、端口适配器与组合根

> [返回学习目录](./README.md) · [返回架构审查总览](../README.md)

## 分层到底在解决什么

分层不是为了多建几个目录，而是为了控制变化传播。

例如 HTTP 协议变化，不应该迫使核心会话算法跟着变化；文件存储换实现，也不应该让 RPC handler 重写。一个健康边界会让变化停在负责它的那一层。

判断分层是否有效，最重要的是依赖方向，而不是文件位置：

```text
宿主/协议层 → 应用用例层 → 领域规则层
                      ↑
                基础设施实现端口
```

领域规则不知道 HTTP、Electron、磁盘路径；外层可以知道内层，内层不反向知道外层。

## Port 和 Adapter

Port 是内层声明的“我需要什么能力”，通常是接口：

```ts
interface SessionEventStore {
  append(event: SessionEvent): Promise<CommitReceipt>
}
```

Adapter 是外层提供的具体实现，例如把事件写入 `events.jsonl`。应用服务只依赖 `SessionEventStore`，不依赖 Node `fs`。

它带来两个直接好处：

- 测试可以换成内存实现；
- 文件、数据库或远程服务变化时，用例本身不用改。

## Composition Root

对象最终总要被创建并连接。唯一负责这件事的位置叫组合根：

```text
创建 logger、store、engine、RPC handlers
          ↓
把端口与实现连接起来
          ↓
记录谁负责 dispose
```

组合根可以依赖所有组装所需模块，但业务模块不应该反向依赖组合根。本项目的 `packages/backend/backend.ts` 已经具备这个雏形，这是应该保留的部分。

## “按技术分层”和“按业务切片”

大型项目通常混合两种组织方式：

- 技术分层：`application`、`infrastructure`、`transport`；
- 业务切片：`sessions`、`plugins`、`settings`。

推荐先按业务找到 ownership，再在业务内部区分 application/ports/infrastructure。否则一个名为 `services` 或 `wiring` 的大目录很容易重新变成杂物间。

## 如何快速判断边界是否坏了

看到下面信号就值得检查：

- store/repository import command/controller；
- core import HTTP、IPC 或 Node 文件系统；
- handler 同时处理鉴权、路径、业务规则和磁盘 I/O；
- 一个 `createX()` 函数创建几十个不相关子系统；
- 同一个概念在三层各有同名“大文件”。

## 在本项目中对应什么

- 组合根：`packages/backend/backend.ts`
- 宿主端口：`packages/backend/host-ports.ts`
- 应用与执行层：`packages/onething-runtime/src`
- 核心规则：`packages/core`
- 传输适配：`packages/backend/server/http.ts`、`packages/client/transport`

读主文档第 05、06、07 篇时，会反复使用这里的概念。
