# 03｜修正事件交付：SSE 断线后能够可靠恢复

> 顺序：03 / 10　风险级别：P1　建议阅读时间：10 分钟  
> [返回总览](./README.md) · [补充学习：RPC、SSE、续播与背压](./learning/04-rpc-sse-replay-and-backpressure.md)

## 为什么排在这里

弱网、睡眠唤醒和后端重启是桌面与移动端的正常场景。当前客户端主动携带续传游标，但默认 wildcard 订阅不会使用它；游标本身也不是跨会话全局序号。问题可由静态代码确定，尚未用生产网络做漏事件统计或慢客户端压测。

## 先讲人话

每个会话都有自己的票号 1、2、3……，但客户端把多个窗口的票混成一条队伍，只记住一个“最后票号”。断线后既不知道该补哪个会话，也可能拿着已经失效的内存清单。发送端还会不停往慢连接里塞数据，没有明确上限。

## 相关概念

- **SSE**：服务端在一条 HTTP 长连接中持续推送事件。
- **cursor**：客户端记录的恢复位置。
- **replay**：重连后补发 cursor 之后的事件。
- **backpressure**：客户端读得慢时，服务端暂停、合并或有界丢弃的机制。

背景学习：[RPC、SSE、回放与背压](learning/04-rpc-sse-replay-and-backpressure.md)。

## 当前流程

```text
client GET /api/events?after=N（未带 sessionId）
  → server 解析成 sessionId="*" + afterSeq=N
  → runtime：只有 sessionId != "*" 才 replay
  → wildcard 只订阅后续 live events
  → 把每个 session 自己的 sequence 写成同一连接的 SSE id
  → client 用最后一个 id 作为下次 after
```

## 当前现状与代码证据

- HTTP client 默认连接 `/api/events`，保存单个数字 `after`：`packages/client/transport/http.ts:168-203`。
- server 未收到 `sessionId` 时设为 `*`，仍把 `after` 传下去，并将 `envelope.sequence` 写成 SSE id：`packages/backend/server/http.ts:460-497`。
- runtime 仅在 `sessionId !== "*"` 时调用 replay；wildcard 分支直接订阅 live：`packages/backend/server/runtime.ts:2195-2215`。因此默认连接的 `after` 当前不生效。
- sequence 与 ring buffer 都是 per-session、进程内数据：`packages/core/events/event-bus.ts:41-67,260-269`。ring buffer 默认只保留 1000 条，满后覆盖旧项：`packages/core/events/ring-buffer.ts:1-13,24-26,45-61`。
- `writeSse()` 连续调用 `response.write()`，没有检查返回值或等待 `drain`：`packages/backend/server/http.ts:728-732`。

## 问题与实际后果

wildcard 重连可能漏掉断线期间事件；即使以后直接给 wildcard 加 replay，两个会话重复或倒退的 sequence 也无法由一个数字 cursor 表达。Core 重启或超过 ring 容量后，旧事件不在内存中，而且协议没有返回“游标已过期，请全量同步”。慢客户端持续存在时，Node 写缓冲可能增长；是否已造成线上内存问题需压测确认。

## 推荐目标

优先按现有数据模型拆开语义：

1. **持久 session event**：使用 `/api/sessions/:id/events` 和该 session 的 `seq`，从持久账本（或 snapshot + tail）补发。
2. **全局通知与流式 chunk**：明确为临时通道；重连后重新读取权威 session 状态，不冒充可持久回放。

若产品必须在单连接可靠混合所有会话，就新增真正全局、单调且可恢复的 delivery offset，不能复用 session sequence。服务端返回 `oldestAvailable/current/gap`，遇到缺口要求客户端 resync。SSE writer 使用有界队列：等待 `drain`；仅对声明为 transient 的 chunk 合并或丢弃；超过阈值关闭慢连接并让其重连。客户端应把“补发成功”和“已刷新到最新快照”都视为明确状态。

## 分步迁移

1. 先增加双会话交错、wildcard `after`、重启和慢连接的失败测试。
2. 为事件分类：durable session event 与 transient stream/notification。
3. 客户端改为按 session 保存 cursor；服务端实现账本 replay 与 gap 响应。
4. reconnect 遇到 gap 时拉取快照，再从确定序号继续。
5. 把所有 SSE 写入收口到带 backpressure 和容量上限的 writer。
6. 废弃含糊的 wildcard 数字 `after`；需要全局可靠流时另立协议。

## 验收清单

- [ ] 两个 session 都从 seq=1 交错推送，任意位置断线重连不漏、不串。
- [ ] Core 重启后能从持久账本补发，或明确返回 gap 并完成 resync。
- [ ] 超过 1000 条后不会静默缺失，客户端能识别游标过期。
- [ ] 同一 session 顺序稳定，重复事件可按 `(sessionId, seq)` 去重。
- [ ] 慢客户端压力测试中，单连接内存与队列有明确上限。
- [ ] transient chunk 可合并，但最终持久状态与重新查询一致。

## 明确不做

本项不承诺网络“恰好一次”，不持久化每个 token chunk，不靠扩大 ring buffer 掩盖协议问题，也不再把 per-session sequence 当全局 cursor。

## 术语表

**durable**：重启后仍可恢复；**transient**：允许重连后通过刷新状态恢复；**gap**：请求位置早于服务端可提供的最早事件；**drain**：底层写缓冲腾出空间的通知。
