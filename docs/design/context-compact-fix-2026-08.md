# Compact 链路修复与 pi 对齐(2026-08)

参照:[How Compaction Works in Pi](https://earendil.com/posts/compaction-in-pi/)(earendil, 2026-08-13)。
调查记录:本文 §1 的五个问题来自 2026-08-14 的全链路走查(前端 slash → 命令 → 引擎 → 事件回传)。

## 0. pi 的三个可采纳点

1. **追加式 compaction entry**。pi 把压缩结果**追加**到会话日志末尾,entry 自带切点引用;不往历史中部插消息。展示位置=时间位置,天然与前端追加式事件流一致。
2. **turn 结束后触发自动压缩**。压缩发生在用户空闲期,下一次发送零等待;发送前检查只做兜底。缓存友好:turn 内的请求继续复用前缀缓存。
3. **独立摘要请求 + 保留 token 预算**。摘要是一条不带会话历史的独立请求(独立 system prompt,可换便宜模型);切点由"保留 N token"(pi 默认 20k)决定而不是轮数,落在 turn 边界。

onething 现状对照:摘要请求已经是独立请求(`buildContextCompactSummaryMessages`,`compact.md?raw` 静态 prompt,JSON 输出)——第 3 点前半已具备;其余是差距。

## 1. 修什么(走查结论)

| # | 问题 | 位置 |
| --- | --- | --- |
| 1 | 占位消息位置分歧:后端 `insertMessageAfter(cutoff)` 插中部,渲染器 `handleMessageCreated` 一律 push 到尾部;重载后标记"跳位" | `app/engine/context-compact.ts:83` vs `renderer/stores/chat.ts:2545` |
| 2 | 三层死通知面:`CONTEXT_COMPACT_STARTED/COMPLETED` IPC 通道 preload 订阅、主进程从不发送;web 端却实现了,还先检查一个后端从不 emit 的幻影事件 `context:compact-started`,再退回逐条 `JSON.parse` 嗅探消息内容;renderer 里零消费者 | `channels.ts:52-53`、`preload/bridge.ts:702,714`、`platform/web.ts:423-484` |
| 3 | 前端 120s 硬超时 vs 后端分块摘要无时限:长会话必然假超时,先报失败、后卡片变成功 | `renderer/services/commands/index.ts:362` |
| 4 | 互斥单向且有洞:(a) 用户消息**先落库**再撞 `activeCompactions` → 该轮永无回应;(b) `contextCompactEnabled === false` 或 provider 自管窗口时守卫被整个跳过 → 手动 compact 与新 stream 真并发;(c) `handleCompactContext` 查 `activeStreams` 之后还有 await,TOCTOU | `core-stream-engine.ts:657,702,1233-1240` |
| 5 | 小:/compact 无草稿会话短路("Session not found");web 嗅探与序列化格式硬耦合 | `commands/index.ts:99`、`web.ts:468` |

**关键前提**(已核实):模型历史重建只按 `summaryUpToMessageId` 切片(`packages/core/engine/history.ts:680`),compact 标记消息是纯展示物,它在 `session.messages` 里的位置对模型请求零影响。P0 因此是安全的。

## 2. 不变量(设计原则)

- 完成通知只有一条正路:`session:event` 信封里的类型化事件(`context:compact-started` / `context:compact-completed`)。不再有专用 IPC 通道、不再嗅探消息内容。
- 压缩的生死时限归**后端**所有;前端只做事件驱动的等待与呈现,不自设墙钟。
- 互斥闸在**命令入口、持久化之前**,且不受 `contextCompactEnabled` / provider 能力开关影响——那些开关只管"要不要自动压",不管"压缩进行中能不能并发改会话"。
- 会话消息数组是追加式账本:引擎不再往历史中部插消息(唯一的既有例外 `insertMessageAfter` 随 P0 退役此用途)。

## 3. 分期总览

| 期 | 内容 | 修 | 依赖 |
| --- | --- | --- | --- |
| P0 | 追加式 compaction entry(标记追加到尾部 + `compactedThroughMessageId` 入内容) | #1 | 无 |
| P1 | 通知面收敛(真 `context:compact-started` 事件;删三层死代码与嗅探;renderer 挂 per-session compacting 状态) | #2 | 无,可与 P0 并行 |
| P2 | 互斥补洞(入口统一等待闸 + compact 登记同步化) | #4 | P1(等待期的用户反馈) |
| P3 | 时限与进度归后端(前端去 120s;后端 per-chunk 超时;marker 内容带进度;/compact 草稿短路) | #3 #5 | P1 |
| P4(选) | pi 采纳:post-turn 自动压缩、保留 token 预算切点、独立摘要模型档位 | 提质 | P0-P2 |
| P5(选) | 呈现:composer 压缩中状态、切点折叠线 | 提质 | P1,折叠线依赖 P0 |

P0-P3 是修 bug 主线,一次批量落地也可;P4/P5 单独拍板。

## 4. 各期细化

### P0 追加式 compaction entry

**改动**
- `packages/core/engine/context-compact.ts`:`CoreContextCompactContent` 增加可选字段 `compactedThroughMessageId?: string`;`createContextCompactMessage` / `buildContextCompactCompletedContent` / `buildContextCompactFailedContent` 透传该字段。
- `packages/onething-runtime/src/app/engine/context-compact.ts:83`:`store.insertMessageAfter(sessionId, plan.cutoffMessage.id, compactMessage)` → `store.addMessage(sessionId, compactMessage)`(创建时即写入 `compactedThroughMessageId: plan.cutoffMessage.id`)。
- 渲染端**零改动**:`handleMessageCreated` 的 push 从此就是正确位置;实时与重载一致。

**兼容**
- 旧会话中部的历史标记:字段可选、位置任意,`ContextCompactPanel` 照常渲染,无迁移。
- `selectCompactPlan` 对追加在尾部的 system 标记天然免疫(只数 user/assistant;cutoff 按 id 定位)。
- `insertMessageAfter`(`app/stores/sessions.ts:691`)失去唯一调用方:保留一个提交周期,若无他用随 P3 清理。

**测试**
- `app/engine/stream/__tests__/agent-loop-runtime-compact.test.ts` 与相关快照更新。
- 新增:压缩后标记是 `session.messages` 末元素;`buildHistoryMessages` 输出与标记位置无关(中部/尾部两种布局产出相同模型历史)。

### P1 通知面收敛

**新增事件**(`packages/shared/events/session-events.ts`)
```ts
export interface ContextCompactStartedEvent {
  type: 'context:compact-started'
  requestId?: string
  auto?: boolean
  compactedThroughMessageId?: string
}
```
emit 点:`runContextCompact` 在 `activeCompactions.add` 成功之后、真正开跑之前(手动/自动统一走这一处,`core-stream-engine.ts:1418` 附近)。手动路径带 `requestId`。

**删除**(三层死代码)
- `packages/shared/ipc/channels.ts:52-53` 两常量。
- `apps/electron/src/preload/bridge.ts:702-728` 两订阅方法。
- `packages/renderer/platform/web.ts:423-484`:`createContextCompactStartedSubscription` / `createContextCompactCompletedSubscription` / `isContextCompactStartedMessage` 嗅探,及 1581-1582 两行注册。
- `packages/renderer/types/index.ts:1451` 起的两个平台方法声明;`platform/__tests__/web.test.ts:657-659` 相应测试。

**新增消费**(这才是通知真正接上 UI 的地方)
- `renderer/services/ipc-hub.ts` 的 session:event switch 增加两个 case:`context:compact-started` / `context:compact-completed` → chatStore 新状态 `compactingSessions: Map<sessionId, boolean>`(started 置真,completed 置假)。启动兜底:`stream:error`/会话切换不清这个位;仅 completed 清。SSE 重连有 ring buffer `?after=` 回放,事件不丢。
- P1 只挂状态不做呈现;呈现在 P5。slash waiter 逻辑不变(仍按 requestId 匹配 completed)。

**测试**:ipc-hub 事件路由单测;grep 断言(boundary 级)`CONTEXT_COMPACT_STARTED` 全仓零引用。

### P2 互斥补洞

**入口统一闸**(`packages/core/engine/core-stream-engine.ts`)
- 引擎持有 `compactionGates: Map<sessionId, Promise<void>>`。`runContextCompact` 开跑时放入 promise,finally resolve 并清除。
- `handleSendMessage` / `handleEditAndResend` / `handleRetryMessage` / `handleResumeAfterConfirm` 在**持久化任何消息之前**:
```ts
await this.waitForCompactionIdle(sessionId)  // gate promise + 上限(复用 P3 的压缩总预算);超时放行并 logError
```
  语义是**等待而不是拒绝**:压缩通常几十秒,用户消息不丢、不需要手动重试;等待期间 P1 的 compacting 状态给可视反馈。该闸无条件执行——不看 `contextCompactEnabled`、不看 `coreProviderOwnsItsContextWindow`(§2 不变量)。
- `maybeCompactBeforeSend:1237` 原 `activeCompactions` 分支退化为兜底断言(理论到不了)。

**compact 侧同步化**
- `handleCompactContext`:入口**同步**完成 `activeStreams` 检查 + `activeCompactions.add`(在第一个 await 之前),失败路径 finally 释放;`runContextCompact` 里的重复 add 合并掉。消除 `resolveProvider` await 窗口的 TOCTOU。
- 反向天然闭合:stream 启动前必过入口闸,被 gate promise 挡住。

**测试**:并发单测——compact 进行中 send:用户消息在 completed 之后才落库、正常得到回应;`contextCompactEnabled=false` 下同样成立;compact 与 compact 互斥保持既有报错;compact 进行中 abort/切会话不死锁(gate finally 必然 resolve)。

### P3 时限与进度归后端

- **前端**(`renderer/services/commands/index.ts`):删 120s `setTimeout`,waiter 纯事件驱动;保留 `emitCommand` 失败时的 `cancel()`。可留 10 分钟兜底(仅防传输死亡,文案改"仍在压缩,请稍后查看会话内卡片")。
- **后端**(`app/engine/context-compact.ts`):`summarizeInChunks` 每个 chunk 的 `generateChatResponse` 挂 AbortSignal 超时(默认 120s/chunk,常量即可,不进设置页——设置极简)。超时/中断走既有失败路径:marker 改 `failed` + `context:compact-completed(success:false)`。总预算 = chunk 数 × 单块超时,P2 的 `waitForCompactionIdle` 上限复用它。
- **进度**:`CoreContextCompactContent` 增加 `progress?: { chunk: number; totalChunks: number }`;多块摘要每块完成后 `store.updateMessageContent` + `onMessageUpdated` 刷 marker(复用 `message:updated`,零新协议);`ContextCompactPanel` compacting 态显示 `2/5`。单块会话无进度刷新,不多发事件。
- **/compact 草稿短路**:`commands/index.ts` 的 compact 命令加 `context.isDraftSession` 检查,返回 "Nothing to compact yet"(对齐 /goal 的处理)。

**测试**:chunk 超时产出 failed marker + completed(error) 事件;进度字段渲染;draft 短路。

### P4(选)pi 采纳:触发时机与切点

拍板后另拆细案,这里记方向与边界:

- **post-turn 自动压缩**:turn 正常收尾后(`app/engine/triggers/` 后处理链,与标题生成同段位)检查阈值,达标即后台 `runContextCompact`(`auto: true`)。用户空闲期完成,下一次发送零等待;`maybeCompactBeforeSend` 保留为 hard-limit 兜底。与 P2 闸的互动已闭合:后台压缩中用户发消息 → 入口闸等待,有 P1 反馈。
- **保留 token 预算切点**:`selectCompactPlan` 的 `keepRecentTurns`(6 轮)换成 `contextCompactRetainTokens`(默认对齐 pi ≈20k),从尾部按 `estimateTextTokens` 累计到预算为止,切点仍落在用户轮边界。hard-limit 循环从"递减轮数"改为"预算折半"。设置迁移:`contextCompactKeepRecentTurns` 保留读取、内部换算,不加新设置项曝光(极简原则,预算走默认档)。
- **独立摘要模型档位**:`summarizeInChunks` 允许 provider/model 覆盖(内部能力,先不暴露 UI)。pi 的结构化摘要段落(goal/progress/key decisions)与现有 `compact.md` JSON schema 做一次对齐审阅。

### P5(选)呈现

- composer:`compactingSessions` 为真时 ctx 表位置显示压缩中态,发送按钮转排队语义(点击仍可发——P2 会等待,不是禁用)。
- 折叠线:`MessageList` 按最近一条 completed 标记的 `compactedThroughMessageId` 在对应消息下画一条画线风细线("以上历史已压缩入摘要"),标记卡片本体仍在时间位置。UI 过 `bun run ui:gate`。

## 5. 风险与兼容

- **事件新增对多宿主的影响**:桌面 IPCBridge `onAnySessionAny` 无过滤转发,server SSE 同样透传;gateway 对未知事件类型按既有 switch 忽略(落地时确认一处)。
- **P0 改变标记的视觉位置语义**:从"摘要边界"变为"压缩发生的时间点"(pi 同款)。边界语义由 P5 折叠线补回;不做 P5 时卡片文案里已有 compactedMessageCount 说明覆盖范围。
- **等待闸的风险**:gate promise 必须 finally resolve(P2 测试覆盖 abort/异常路径),否则会话卡死——这是本方案唯一引入的新阻塞点,超时放行是兜底。
- 验收全部走脚本级自证(vitest + gate 棘轮),不留人肉走查项。
