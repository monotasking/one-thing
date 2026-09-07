# 02｜统一命令提交：让“成功”有明确含义

> 顺序：02 / 10　风险级别：P0/P1　建议阅读时间：10 分钟  
> [返回总览](./README.md) · [补充学习：一致性、事件溯源与幂等](./learning/02-consistency-event-sourcing-and-idempotency.md)

## 为什么排在这里

锁只能保证一个人记账，还要保证这个人先把账记稳，再给出正确回执。当前 RPC 成功、业务处理完成和磁盘提交是三个不同时间点，却没有在契约中区分。静态代码确认存在崩溃窗口；本次没有注入断电来证明已经丢过真实数据。

## 先讲人话

现在像前台收到订单就说“已完成”，厨房和收银随后异步处理。多数时候没问题；如果中途进程退出，用户拿到了成功回执，账本里却可能没有对应结果。我们需要区分“已受理”和“已记账”。

## 相关概念

- **accepted**：命令已进入处理流程，不保证已落盘。
- **committed**：关键事实已写入权威账本，可以在重启后恢复。
- **projection**：从事件折叠出的当前会话状态，可重建。
- **幂等**：同一个请求重试多次，只产生一次业务效果。

背景学习：[一致性、事件溯源与幂等](learning/02-consistency-event-sourcing-and-idempotency.md)。

## 当前流程

```text
RPC 命令
  → EventBus 分配内存 sequence、放入 ring buffer
  → 同步 fan-out（不等待异步业务处理）→ RPC success
  → Engine 异步执行
  → live projection 立即更新
  ├→ events.jsonl 异步追加队列
  └→ meta/index 独立节流队列
```

## 当前现状与代码证据

- RPC 等待的是 `eventBus.emit()`：`packages/core/events/ipc-operations.ts:62-79`；HTTP 命令入口见 `packages/backend/rpc/domains/session-command.ts:177-208`。
- EventBus 所谓 “Commit” 是内存 sequence、ring buffer 和同步 fan-out：`packages/core/events/event-bus.ts:93-134`。fan-out 调用 handler，但不等待 Promise：同文件 `351-405`。
- Engine 的发送、重试等 handler 启动异步任务后仅 `.catch()`：`packages/core/engine/core-stream-engine.ts:564-588`。所以 RPC success 目前表示“总线已接受并通知”，不是业务完成或持久提交。
- 事件追加会先通知 live state，再排队写文件：`packages/backend/session/event-log.ts:445-524`；异步写失败被记录并粘住，当前调用者不会立刻收到：同文件 `524-530`。
- session meta 使用另一条默认 300ms 的保存队列：`packages/onething-runtime/src/sessions/session-repository.ts:189-218,228-242`。正常 shutdown 会排空，但强杀或断电仍存在窗口。

## 问题与实际后果

“success”语义过宽，客户端无法决定是否安全重试；事件、内存投影和 meta/index 没有统一提交回执。异常发生在两个队列之间时，重启后的 cold replay 可能暂时或永久不同于退出前界面。若盲目重试，又可能重复发送消息或重复执行工具。

## 推荐目标

引入唯一的 `SessionCommitter`，成为会话事实的唯一写入口：

```text
校验 requestId → 生成事件 → 持久追加 → 折叠 projection
                 → 更新可重建索引 → 发布事件 → 返回 CommitReceipt
```

`events.jsonl` 明确为权威事实；meta/index 尽量降为可重建读模型。长时间 AI 执行不需要等到结束：先可靠提交一条“命令已受理”事实，再返回 `accepted`；需要持久保证的短 mutation 返回含 `commitSeq` 的 `committed`。回执至少带 `requestId/sessionId/status/commitSeq/errorCode`，并持久记录幂等结果。这样客户端能据状态选择等待、刷新或安全重试，而不是猜测。

## 分步迁移

1. 先写契约测试，明确每个命令何时 accepted、何时 committed。
2. 增加 `CommandReceipt` 与 `requestId`，保留旧响应适配层。
3. 建立按 session 串行的 `SessionCommitter`；先迁移一个低风险 mutation 验证。
4. 让序号分配、append 和错误返回归它所有；EventBus 只广播已提交事件。
5. 逐批迁移 projection、meta/index 与其他命令，禁止双写。
6. 最后加入持久幂等记录并删除旧入口。

## 验收清单

- [ ] 收到 committed 后立即强杀，重启仍能回放该事实。
- [ ] append 失败时 RPC 不会返回 committed；错误码稳定可判断。
- [ ] 同一 `requestId` 重试不会重复消息、工具调用或事件。
- [ ] 同 session 并发命令顺序稳定，不同 session 可并行。
- [ ] live projection 与从零 cold replay 的结果一致。
- [ ] 迁移期每条 mutation 只有一个 writer，没有双写分支。

## 明确不做

本项不要求立刻换数据库，不做分布式事务，不等待整次 AI 回复完成才回执，也不同时维护新旧两份权威账本。

## 术语表

**回执**：服务端对命令状态的结构化回答；**权威账本**：重启恢复时最终可信的数据；**cold replay**：只从持久事件重建状态；**双写**：同一事实由两条独立路径写入两份权威数据。
