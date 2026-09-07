# 学习 04：RPC、SSE、续播与背压

> [返回学习目录](./README.md) · [返回架构审查总览](../README.md)

## RPC 是什么

RPC 把一次远程调用包装成请求和响应：

```json
{ "domain": "sessions", "method": "rename", "payload": {} }
```

TypeScript 类型只在编译时存在。请求穿过网络后只是陌生 JSON，因此入口还需要运行时 schema 校验。

一个完整 RPC 契约通常包含：

- `requestId`：追踪这次请求；
- `commandId/idempotencyKey`：mutation 安全重试；
- `deadline`：调用方愿意等多久；
- 结构化错误：`code`、`message`、`details`、`retryable`；
- 认证后生成的 principal，而不是信任 body 中的身份。

HTTP 是否返回 200 不是重点；重点是客户端能否根据稳定错误码采取正确动作。

## SSE 是什么

SSE 是服务端持续向客户端发送文本事件的单向连接：

```text
id: 42
event: session:event
data: {...}
```

连接会断，因此客户端必须保存 cursor，重连时告诉服务端“从哪个位置之后继续”。

## Cursor 必须属于一个明确序列

如果 sequence 是每会话计数：

```text
session A: 1, 2, 3
session B: 1, 2, 3
```

那么跨会话连接不能只保存一个数字 cursor，因为 `2` 无法说明属于 A 还是 B。可选方案是：

- 每个 session 单独订阅并保存自己的 cursor；
- 或建立真正全局单调的 transport offset。

## Replay 与持久化

内存 ring buffer 只适合短暂断线。进程重启后 buffer 消失，如果协议承诺跨重启续播，就需要从持久化日志或另一个 durable outbox 恢复。

常见安全切换流程是：

```text
先读取 session 快照/账本并得到 lastSeq
             ↓
订阅该 session，携带 after=lastSeq
             ↓
服务端 replay 握手窗口内的事件
```

客户端应用事件也要幂等：重复收到旧 sequence 时忽略，发现缺号时触发重同步。

## Backpressure 是什么

网络客户端可能比服务端慢。Node 的 `response.write()` 返回 `false` 表示内部 buffer 已满；如果继续无上限写入，内存会持续增长。

服务端需要明确策略：

- 等待 `drain`，让生产者减速；
- 每连接有界队列，溢出后断开并要求 replay；
- 合并可合并的高频 delta；
- 记录慢客户端和队列深度指标。

“每 16ms 合批”只能减少调用次数，不能代替有界背压。

## 在本项目中对应什么

- RPC dispatcher：`packages/backend/rpc/registry.ts`
- HTTP/SSE：`packages/backend/server/http.ts`
- server event adapter：`packages/backend/server/runtime.ts`
- client transport：`packages/client/transport/http.ts`
- per-session sequence：`packages/core/events/event-bus.ts`

读主文档第 03、04、08 篇时，重点找清楚 authentication、cursor、replay source 和慢消费者策略。
