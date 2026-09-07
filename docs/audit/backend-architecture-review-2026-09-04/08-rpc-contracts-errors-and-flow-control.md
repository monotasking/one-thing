# 08｜补齐 RPC 契约、错误模型与流量控制

> 顺序：08 / 10　风险级别：P1/P2　建议阅读时间：8 分钟  
> [返回总览](./README.md) · [补充学习：RPC、SSE、续播与背压](./learning/04-rpc-sse-replay-and-backpressure.md)

## 为什么排在这里

它很重要，但应先由第 02、03、04 篇确定“何时算提交”、SSE 游标和调用者身份，否则幂等、重试和错误码会建立在摇摆语义上。这里多数措施可兼容增量上线，所以排在结构性正确性之后。

## 先讲人话

现在 RPC 像一张只写“部门、事项、包裹”的快递单：能送到处理者，却缺少统一单号、过期时间和包裹验收规则。出错时通常只回一句文字；慢客户端来不及收 SSE，服务端也没有明确的排队上限。

## 相关概念

- **Envelope**：每个请求共同携带的外壳。
- **Schema validation**：在进入业务前检查 payload 的真实形状。
- **Idempotency**：同一个 mutation 重试两次，业务结果仍只发生一次。
- **Backpressure**：下游较慢时暂停、有界排队或断开，而不是无限积压。

背景说明见 [RPC、SSE、续播与背压](./learning/04-rpc-sse-replay-and-backpressure.md)。

## 当前流程

```text
client.invoke({domain, method, payload})
  → POST /api/rpc
  → 全量读 body + JSON.parse
  → 只校验 domain/method
  → handler(payload: unknown)
  → {ok:true,data} / {ok:false,error:{message,code?}}

事件 → response.write(...) → SSE 客户端
```

## 当前现状与代码证据

- [rpc.ts:17](../../../packages/shared/ipc/rpc.ts#L17) 的请求只有 `domain`、`method`、`payload: unknown`；没有通用关联 ID、deadline 或幂等键。
- [registry.ts:101](../../../packages/backend/rpc/registry.ts#L101) 只验证 envelope 的两个字符串；handler 抛错后仅保留 message。[rpc.ts:94](../../../packages/shared/ipc/rpc.ts#L94) 的错误 code 可选，dispatcher 只定义三种路由级 code。
- [http.ts:706](../../../packages/backend/server/http.ts#L706) 把所有 chunk 收完才解析，没有字节上限；大请求会持续占用内存。
- [http.ts:728](../../../packages/backend/server/http.ts#L728) 连续调用 `response.write()`，没有处理返回 `false`、`drain` 或连接级队列上限。
- 已有请求日志会记录 method、path、status、耗时和 sessionId，这是好基础；但缺少贯穿 client、RPC handler 和异步工作的统一关联 ID。[http.ts:76](../../../packages/backend/server/http.ts#L76)

## 问题与实际后果

1. 非法 payload 可能深入业务后才以普通异常失败，客户端无法稳定区分校验、权限、冲突、瞬态故障。
2. 响应丢失后，没有幂等键就不能安全自动重试 mutation；盲目重试可能重复创建或执行。
3. 没有 deadline，调用结束不代表下游工作停止；慢 SSE 消费者也可能造成无界缓冲。
4. 只有文字错误时，监控、告警和客户端恢复逻辑只能匹配文案，改一句提示就可能失效。

## 推荐目标

```text
RpcRequestV2
  meta: { requestId, deadlineAt?, idempotencyKey?, contractVersion }
  domain + method + payload

RpcError
  { code, message, retryable, details? }
```

每个 method 在入口拥有运行时 schema；mutation 按 owner + method + idempotencyKey 去重。错误码至少区分 validation、unauthenticated、forbidden、not-found、conflict、timeout、unavailable、internal。SSE 每连接使用有界队列：`write=false` 时等待 `drain`，溢出则安全断开并允许续播。

## 分步迁移

1. 先给 envelope 增加可选 metadata；旧客户端缺省时由服务端生成 `requestId`。
2. 为一个低风险域试点 method schema 和统一 error mapper，再逐域覆盖。
3. 设置全局 body 上限、解析失败映射和 deadline；把取消信号传到支持取消的下游。
4. 将 requestId、domain、method、耗时、结果 code 接入现有日志；不记录 payload、token 和密钥。
5. 为 SSE 加 `drain`、队列上限、慢连接测试和断开策略。
6. 等提交语义稳定后，再为 mutation 建有界幂等记录；读请求无需幂等账。

## 验收清单

- [ ] 每个 RPC payload 在业务执行前完成运行时校验。
- [ ] 错误 code 稳定且客户端不依赖 message 文案。
- [ ] 超大 body 返回 413；deadline 到达能停止可取消工作。
- [ ] 同一幂等键重复 mutation 只产生一次已提交结果。
- [ ] 慢 SSE 客户端的队列内存有上限，断线后可按既定游标恢复。
- [ ] 一次请求可用 requestId 串起入口、handler 和错误日志。

## 明确不做

- 不为迁移另建一批定制 REST 路由，也不强制改变现有“HTTP 200 + RpcResponse”语义。
- 没有幂等键时不自动重试 mutation。
- 不把内部堆栈和敏感 payload 返回给客户端或写入常规日志。

## 术语表

- **Deadline**：请求允许执行到的最晚时刻。
- **Error taxonomy**：稳定、可编程判断的错误分类。
- **Correlation ID**：贯穿一次调用链的追踪编号。
