# 04｜身份、Principal 与 Owner 隔离

> 顺序：04 / 10　风险级别：部署相关，多租户时 P0　建议阅读时间：10 分钟  
> [返回总览](./README.md) · [补充学习：RPC、SSE、续播与背压](./learning/04-rpc-sse-replay-and-backpressure.md)

## 为什么排在这里

这是第 4 项，因为它先于内部重构决定产品的安全边界：服务究竟只是“同一个人在本机使用”，还是会让多个互不信任的人接入。前者当前风险有限；后者若沿用现状，Owner 隔离不能当作安全保证。在完成 01–03 的数据可靠性问题后，应先拍板这个分叉，再调整后续接口。

## 先讲人话

现在的 Bearer Token 更像一把共用的门钥匙：能证明“你拿到了钥匙”，却不能证明“你就是 Alice”。进门后，请求还能用 Header 自报 `userId/workspaceId`。若只有本机一个用户，这可以只是方便的数据分区；若多个用户共用服务，同一把钥匙的持有者就可能自称另一个 Owner。

## 相关概念

- **认证（Authentication）**：确认来访者是谁。
- **Principal**：服务端认证后产生、不可由请求正文伪造的调用者身份。
- **Owner**：数据归谁所有；它是资源属性，不等于请求自报的名字。
- **授权（Authorization）**：判断 Principal 能否对某个 Owner 的资源执行某动作。

入门补充：[RPC、SSE、重放与背压](./learning/04-rpc-sse-replay-and-backpressure.md)。

## 当前流程

```text
HTTP 请求
  ├─ Bearer Token ──> 共享密钥校验
  └─ x-onething-user-id / workspace-id（客户端填写）
                         │
                         v
              RuntimeRequestContext
                         │
                         v
               RpcDispatchContext
                         │
           ┌─────────────┴─────────────┐
     部分域按 context 限定范围    session-command 直接使用 sessionId
```

## 当前现状与代码证据

做得好的部分：身份字段不放在可控的 RPC body 中，而由 HTTP 适配层创建 context，[`packages/shared/ipc/rpc.ts:27`](../../../packages/shared/ipc/rpc.ts#L27)；未配置 Token 时会拒绝身份 Header，并用恒定时间比较 Token，[`packages/backend/server/http.ts:668`](../../../packages/backend/server/http.ts#L668)。

缺口在于：配置 Token 后，`userId/workspaceId` 仍直接取自请求 Header，[`packages/backend/server/http.ts:649`](../../../packages/backend/server/http.ts#L649)，随后被标成 `ownerUid/workspaceId`，[`packages/backend/server/runtime.ts:4234`](../../../packages/backend/server/runtime.ts#L4234)。Token 与某个 Principal 没有服务端绑定。

至少在关键写入口 `session-command` 中，handler 只取请求的 `sessionId`：abort、权限应答和普通命令均未比较当前 Principal 与会话 Owner，[`packages/backend/rpc/domains/session-command.ts:188`](../../../packages/backend/rpc/domains/session-command.ts#L188)。这说明“通过认证”尚未完整落实为“有权操作这条会话”。

## 问题与实际后果

- **本机单用户模式**：若只监听可信本机、Token 不共享，主要是模型含义不清和误配置风险，不应夸大成已发生越权。
- **真实多租户模式**：共享 Token 持有者可选择别人的身份命名空间；知道或猜到 `sessionId` 时，关键命令入口缺少资源级授权。
- 注释把 context 称为“authenticated owner”，容易让新增 handler 误以为无需再检查资源归属。

## 推荐目标

先做产品二选一：

1. **本机单用户**：服务端固定生成 `LocalPrincipal`，拒绝外部自报身份；Owner 只是内部命名空间。
2. **真实多租户**：凭证在服务端解析为 Principal；Header 最多表达“想进入哪个 workspace”，还必须校验成员关系。所有 Session 操作统一经过 `authorize(principal, session, action)`。

不要同时保留两套含糊语义。可以有两种部署模式，但必须显式配置、默认安全。

## 分步迁移

1. 写一页 ADR，明确默认部署模式、是否允许远程用户、Token 是否会共享。
2. 定义最小 `Principal { subjectId, workspaceMemberships, authKind }`，由宿主认证适配器创建。
3. 增加集中式 `SessionAuthorizer`；先覆盖 send、abort、permission-respond、delete，再覆盖全部读写。
4. Session 查询先解析资源及 Owner，再执行业务命令；不存在与无权限对外使用一致策略，避免枚举。
5. 增加包含 principal、resource、action、result 的审计日志；逐步移除“Header 就是已认证身份”的假设。

## 验收清单

- [ ] 产品文档明确选择本机单用户或真实多租户。
- [ ] Principal 只能由服务端认证层创建，RPC payload 不能覆盖。
- [ ] Alice 的凭证不能通过改 Header 成为 Bob。
- [ ] 跨 Owner 的 send、abort、权限应答、读、删均被拒绝。
- [ ] 桌面本机流程无需登录升级且回归测试通过。
- [ ] 每个新增 Session handler 都有授权测试。

## 明确不做

- 不因“以后可能多租户”立即引入一整套 OAuth/IAM；本机模式可保持简单。
- 不把随机 `sessionId` 当授权机制，也不只在前端隐藏资源。
- 不把 Owner 检查散落复制到每个 handler；应复用一条授权策略。

## 术语表

- **Bearer Token**：持有即获准使用的凭证。
- **Principal**：服务端确认的调用主体。
- **Owner scope**：某个用户/空间的数据范围。
- **资源级授权**：针对“谁、对哪个资源、做什么”的判定。
