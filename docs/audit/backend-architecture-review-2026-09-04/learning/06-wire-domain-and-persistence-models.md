# 学习 06：Wire、Domain 与 Persistence 模型

> [返回学习目录](./README.md) · [返回架构审查总览](../README.md)

## 为什么同一个“消息”需要三种模型

它们描述的对象相似，但服务的变化方向不同：

1. **Wire DTO**：发给客户端，受 API 兼容和隐私约束；
2. **Domain Model**：业务规则使用，表达系统真正关心的状态；
3. **Persistence Record**：写到磁盘，受历史数据和升级兼容约束。

```text
外部 JSON             业务世界                磁盘格式
ChatMessageDto  ↔  Message / Session  ↔  MessageRecordV2
```

如果三者共用同一个 TypeScript interface，给前端增加一个展示字段可能意外改变磁盘格式；修复旧磁盘数据也可能迫使 API 暴露内部字段。

## DTO 是什么

DTO（Data Transfer Object）是边界上的数据包。它应该：

- 可序列化；
- 经过运行时校验；
- 不携带文件句柄、服务对象或隐式行为；
- 只暴露调用方应该看到的字段；
- 有清楚的版本兼容策略。

DTO 不等于领域实体。领域实体可以有更严格的不变量和行为。

## Mapper、Codec 与 Upcaster

- Mapper：在 DTO 与 domain 之间转换；
- Codec：把 persistence record 编码/解码；
- Upcaster：读取旧版本记录时转换成当前版本。

初期 mapper 即使只是逐字段复制，也有价值：它建立了明确边界，未来两边变化时不会依赖 TypeScript 的结构兼容悄悄穿透。

```ts
function toSessionDto(model: SessionReadModel): SessionDto
function decodeEventRecord(raw: unknown): SessionEvent
function encodeEventRecord(event: SessionEvent): SessionEventRecordV2
```

## Schema Version

持久化记录最好带显式版本：

```json
{ "schemaVersion": 2, "type": "message/appended", "data": {} }
```

版本的作用不是要求频繁迁移全部文件，而是让读侧知道应该使用哪个 decoder/upcaster。迁移期间可以继续读取旧记录，所有新写入只采用当前格式。

## Shared 包应该放什么

一个共享 contracts 包适合放：

- RPC request/response DTO；
- SSE event envelope；
- 稳定错误码；
- 可序列化枚举。

它不应该重导出 runtime 的文件锁、repository 或 Node 实现，否则所谓“共享底层”会反向依赖应用/基础设施层。

## 在本项目中对应什么

- 当前共享会话类型：`packages/shared/ipc/chat.ts`
- RPC envelope：`packages/shared/ipc/rpc.ts`
- Session repository 泛型：`packages/core/session/storage/types.ts`
- 文件记录读写：`packages/onething-runtime/src/sessions/storage-driver.ts`
- server 扩展会话结构：`packages/backend/server/runtime.ts`

读主文档第 09 篇时，重点寻找一个字段是否同时影响 API、业务状态和历史磁盘文件。
