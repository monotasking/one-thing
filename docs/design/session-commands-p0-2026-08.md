# P0:会话消息写路径收口 + 读门面(2026-08-19)

> 上游:`session-event-sourcing-2026-08.md` §7/§8 —— 事件溯源审查的结论是"会话消息没有单一写路径",P0 是 S 线的硬前置,**也独立有价值**(修今天就存在的 server/desktop 双写与 `Object.assign` 就地改)。用户 2026-08-19 拍板 P0 先落地。
> 清单依据:写面/读面全量盘点(Explore 2026-08-19):有效业务 mutator 调用点 **78 处 / 24 文件**,裸写 **12 处**(core 3 + app 1 + server 8),`.messages` 会话语义读 **≈118 处 / 45 文件**,server 专项 12 项,冻结风险 12 条。
> **P0 不改持久化契约**:仍是 `messages.jsonl` + 300ms/5s 节流 + `writeSuffix`;P0 只收"谁能改、怎么改、谁能读"。

---

## 1. 目标形状

```
packages/core/session/commands.ts        纯函数:applySessionCommand(session, cmd) → { session', changed, writePlan }
                                          COW:改哪条消息就新建哪条(及其父数组),其余引用复用
packages/onething-runtime/src/app/session/commands.ts   sessionCommands.<cmd>(sessionId, payload)
                                          = 取 session → 纯函数 → 持久化(plan)→ sqlite → index meta → emit
packages/onething-runtime/src/app/session/reads.ts      sessionReads.<method>(sessionId, …) → readonly 视图
                                          唯一另一个允许持有 session.messages 的地方
白名单之外:packages/core / runtime / apps/* 任何地方不得访问 `session.messages`,不得改 ChatMessage/Step/ToolCall 字段
```

- `packages/core/session/store-helpers.ts` 的消息原语(#1–#10)与 `session-message-runtime.ts` 的 22 个 mutator → 降为 **命令的薄包装**(P0.1 先包、P0.2 逐个删)。
- core 引擎注入的小接口(`CoreStreamProcessorStore` / `CoreAgentLoopContentPartStore` / `CoreAgentLoopToolExecutionStore` / event-only-emitter 的 step 端口)**形状不变**,app 侧实现改走命令;core 自己就地改对象的点(F3/F4/F6)改 COW。
- 开发/测试期:从 store 取出的消息对象**深冻结**(复用 `core/plugins/freeze.ts` 的 `deepFreezeCorePluginValue`,改名为通用 `deepFreeze`),生产期不冻(性能),靠棘轮守。

## 2. 命令集(12)

| 命令 | payload | 吞掉 | 写计划 |
|---|---|---|---|
| `appendMessage` | `{message, stampCollab?}` | `addMessage`、`appendSessionMessage`、`stampCollabAgentId`(改为返回新对象)、server `:2723/4967/5116` | `{message, dirtySeq: len}` |
| `upsertMessage` | `{message}` | server `:5111-5118`;`insertMessageAfter`(0 调用,直接删) | 存在→patch plan;不存在→append plan |
| `patchMessage` | `{messageId, patch, hint?: 'stream'\|'settle'}` | `patchSessionMessage` + 19 个 `updateMessage*`;server `:5127/5129/2776/5137`(SV9 改为按 messageId,不再"最后一条 assistant") | `{message, index+1}`;`hint:'stream'` → lazy(与今天 content/reasoning/contentParts/thinkingTime 的 5s 档一致) |
| `appendContentPart` | `{messageId, part}` | `appendSessionMessageContentPart`、`addMessageContentPart` | message plan |
| `upsertStep` | `{messageId, step}`(按 toolCallId 去重) | `addOrUpdateSessionMessageStep`、`addMessageStep` | message plan |
| `patchStep` | `{messageId, stepId, updates}` | `updateSessionMessageStep`、`updateMessageStep`(status undefined → lazy 保留) | message plan |
| `patchStepsUsageByTurn` | `{messageId, turnIndex, usage}` | `updateStepsUsageByTurn` | message plan(仅有变更时) |
| `setToolCalls` | `{messageId, toolCalls}`(**必须是新数组新对象**;dev 期断言入参未被冻结对象污染) | `updateMessageToolCalls`(13 处调用点先就地改 toolCall 再整表写回 = F3 病根,迁移时改 spread) | message plan |
| `truncateFrom` | `{messageId, inclusive, newContent?, contentParts?}` | `truncateSessionMessagesFrom`、`updateSessionMessageAndTruncateAfter`、`deleteMessageAndTruncate`、`updateMessageAndTruncate` | structural(截断语义,与今天同) |
| `deleteMessage` | `{messageId}` \| `{matchMarker}` | `deleteSessionMessage`、`deleteMessage`、`system-messages.ts` 按内容查删、server `:2736-2759` | structural + **补 index meta**(修 E4) |
| `replaceAll` | `{messages, reason: 'clear'\|'replaced'\|'normalize'}` | `clearSessionMessages`(`:740`)、`store-helpers.ts:1149/1187`、server `:4937/5733/5989` | structural;`clear` 保留 archive 行为 |
| `repairOnLoad` | `{policy: 'startup'\|'loaded'}` → **返回 patch 列表**,命令面统一应用 | `sanitizeSessionOnStartup` / `sanitizeLoadedSession` / `sanitizeInterruptedStepRecursive` / `sanitizeStaleContextCompactMessage` / `repairSessionTimelineMetadata`(B32/F4) | 有 patch 才 structural |

配套:`saveSnapshot`(server 后门 `saveSessionSnapshot`)退役,server 走命令;`updateSessionSummary/Model/Agent` 等会话级字段不在本命令面(已走 repository),但 `repairOnLoad` 的 summary 修复走命令。

## 3. 读门面(13)

`listMessages(sessionId,{sanitize})`(吸收 renderer-sanitizer,去掉 `===` 身份判断 F9,改返回 `{messages, changed}`)、`pageMessages`(升格现有 `getSessionMessagesPage`)、`listUserMarkers`、`getMessage`、`findMessage(pred,{from})`、`getMessageIndex`、`countMessages`、`lastMessageOfRole`、`firstUserPreview`(收 server 三重实现)、`sliceForHistory`(6 处 `history.buildMessages(session.messages, session)` + compact 的切片;**这是 S 线 `projectModelHistory` 的读侧落点**)、`iterateMessages`(搜索/媒体/权限扫描,不物化)、`scanSessionsForSearch`(`getSessionRaw` 语义,不入 LRU 不 sanitize 不回写)、`readTranscriptFile`(收 `collab/history-tool.ts:164`、`collab/actors/migrate.ts:435` 两处绕驱动直读)。

返回值一律 `readonly`;dev 期深冻结。

## 4. 棘轮:`bun run session:gate`

`scripts/session-gate.mjs`,**用 TypeScript 编译器 API 做类型感知**(不是正则,见上游 M8):
- 规则 A:表达式类型可赋给 `ChatSession`(或含 `messages: ChatMessage[]` 的会话形状)的 `.messages` 属性访问 → 只允许在白名单文件:`core/session/commands.ts`、`app/session/commands.ts`、`app/session/reads.ts`、`sessions/storage-driver.ts`、`sessions/session-dehydrate.ts`(脱水是存储形状)、测试。
- 规则 B:对类型为 `ChatMessage` / `Step` / `ToolCall` 的表达式的属性赋值、`Object.assign(x,…)`、`x.steps.push/splice`、`x.contentParts.push/splice` → 只允许在 `core/session/commands.ts`。
- 规则 C:`session.messages =` 整体赋值 → 0 处(白名单内也不允许,命令面 COW 返回新 session)。
- 同名噪音(`message-queue.ts` / `room-rules.ts effects.messages` / provider `options.messages`)因类型不同天然不命中。
- 基线 `docs/audit/session-gate-baseline-2026-08-19.txt` = P0.1 落地时的计数;只许降。`bun run session:check` 打全表。

## 5. 子期

| 期 | 交付 | 门(脚本可判) |
|---|---|---|
| **P0.1 骨架(strangler)** | core `commands.ts`(12 命令纯函数 + COW + writePlan 计算统一,消灭 E2 的 5 处隐式 structural)+ app `commands.ts` / `reads.ts`;现有 store-helpers/runtime/stores 的全部消息 mutator 改为**调用命令**的薄包装(调用点零改动,行为不变);dev 深冻结开关;`session-gate.mjs` + 基线 | 12 命令单测(COW:未改消息引用相同、改的消息引用不同;writePlan 逐命令断言);`bun run test` 全绿;`typecheck`;`boundary:gate`;`session:gate` 基线生成 |
| **P0.2 调用点迁移** | 按区并行:①core 引擎(B6/B7/B10/B16/F3/F6,COW 化 toolCall/step 写法)②runtime app(engine/stream、context-compact、turn-context、image-generation、tool-call-state、stream-abort)③collab(reactions/reply-quote/mentions/room-config/ingress/say-tool/actors)④electron ipc(chat/tools/sessions)+ ipc-operations/system-messages;读侧 C1–C7 改走 reads;F5/F7/F9/F11 修;`sanitize*` → `repairOnLoad`;删零调用的薄包装 | 每区:`session:gate` 计数单调下降且附映射表(旧 mutator → 命令);`bun run test` 全绿;dev 深冻结下跑一次全量测试(冻结断言暴露漏网就地改) |
| **P0.3 server** | SV1–SV12 全部改走 `sessionCommands`/`sessionReads`;删 `saveSessionSnapshot` 后门与 server 自己的 normalize/refreshSessionMeta/upsert/update 实现;`saveSessionImmediately` 走命令 plan(消灭 server 每写全量重写) | `apps/server` 目录 `session:gate` = 0;server 现有测试 + `scripts/smoke-test*.ts` 过;desktop/server 对同一会话交替写(脚本:起 server 写 2 条 → 停 → desktop 进程读)一致 |
| **P0.4 收口** | 白名单外归零;删 `insertMessageAfter` 等死路径;E4 index meta 修;文档:本文 §6 落地记录 + CLAUDE.md 一段(会话消息只能通过 sessionCommands/sessionReads) | `session:gate` 基线 = 0(白名单外);全套 gate 绿 |

派工:P0.1 一个 opus 实施(单人定骨架,避免并行冲突);P0.2 四个区并行四个 opus(各自 worktree 或串行合并——共享 `stores/sessions.ts` 的删除留到 P0.4);P0.3、P0.4 各一个。Fable 只做每期 review 与门核验。

## 6. 明确不做(P0)
- 不改 `messages.jsonl` 格式、不改节流/写计划语义(只是把计算集中);
- 不改 renderer;
- 不引事件(那是 S0);
- 不改 core 引擎小接口的形状(只改其实现与就地变异)。

## 7. 风险
- 冻结只在 dev/test:生产漏网靠棘轮;P0.2 每区完成后必须在冻结开启下跑全量测试。
- `hint:'stream'` 的 lazy 档映射若写错会把流式 content 从 5s 档降到 300ms 档(性能退化)或反之(崩溃丢更多):P0.1 单测逐命令断言 plan 与今天一致。
- server 的 `getSessionRaw` vs `getSession`(LRU/sanitize 差异,`runtime.ts:5885` 注释的竞态):读门面保留两种语义(`scanSessionsForSearch` 明确 raw),不合并。

---

## 8. P0.1 落地记录(2026-08-19)

**交付**

| 文件 | 角色 |
|---|---|
| `packages/core/freeze.ts` | `deepFreeze` 从 `core/plugins/freeze.ts` 上移(原名 `deepFreezeCorePluginValue` 原位置继续导出,插件调用点零改动) |
| `packages/core/session/commands.ts` | 12 命令的纯 reducer:`applySessionCommand(session, cmd) → { session, changed, changedMessageIds, writePlan, lazy, indexMetaChanged, meta? }`,加 `adoptSessionCommandResult` |
| `packages/core/session/timeline.ts` | 新增纯计算版(`computeSessionTimelineMetadataRepair` / `computeSessionRepairOnLoad` / `computeInterruptedStepRepair` / `computeInterruptedToolCallRepair` / `computeStaleContextCompactContent`);`repairSessionTimelineMetadata` / `sanitizeInterruptedStepRecursive` / `sanitizeLoadedSession` / `sanitizeSessionOnStartup` 降为**就地薄壳**(签名不变) |
| `packages/core/session/store-helpers.ts` | 9 个消息原语改为命令的薄包装(`insertSessionMessageAfter` 标 `@deprecated`,是唯一没搬的) |
| `packages/onething-runtime/src/sessions/session-message-runtime.ts` | 22 个 mutator 全部走 `applySessionCommand`;新增 `upsertMessage` / `patchMessageFields` / `deleteMessageWhere` / `replaceAllMessages` / `repairOnLoad` 五个命令入口 |
| `packages/onething-runtime/src/app/session/commands.ts` | `createSessionCommands(ports)` + 懒建单例 `sessionCommands`(12 方法) |
| `packages/onething-runtime/src/app/session/reads.ts` | `sessionReads`(13 方法) |
| `packages/onething-runtime/src/app/session/freeze.ts` | 深冻结开关 |
| `packages/onething-runtime/src/app/stores/sessions.ts` | `stampCollabAgentId` 改为返回新对象;`clearSessionMessages` 走 `replaceAll`;`getSession/getSessionMessages` 挂深冻结;新增命令面接线口 |
| `scripts/session-check.mjs` / `scripts/session-gate.mjs` | 类型感知检查器 + 棘轮(`bun run session:check` / `session:gate`) |
| `docs/audit/session-gate-baseline-2026-08-19.txt` | 基线 **195** 条(access 128 / field-assign 59 / messages-assign 3 / field-delete 3 / object-assign 2) |

**口径裁定(原文没写死的地方)**

1. **写回策略是"盖回原容器"而不是"换掉 LRU 里的会话对象"**:reducer 是彻底 COW 的(新消息、新数组、新 session),但 `adoptSessionCommandResult` 把结果 `Object.assign` 回原会话对象。理由是今天仍有调用点先 `getSession()` 拿到会话、之后再读它(§7.2 M8 点名的 `context-compact.ts:247`),换掉对象它们会静默读到旧数据。COW 的收益全在消息这一层,容器复用不影响。P0.2 迁完调用点后可以撤掉这层。
2. **`hint` 缺席时按 patch 的键推断 lazy 档**:显式 `hint` 永远优先;不给 hint 时,键集合完全落在 `content/reasoning/contentParts/thinkingTime` 里才算 stream 档。这与今天四个 `{lazy:true}` 的 mutator **逐条等价**(单测逐条断言),同时让还没改口径的老包装不必逐个传 hint。
3. **规则 C 在核心侧已经降到 3**:`store-helpers.ts:1149/1187` 与 `stores/sessions.ts:740` 三处整体赋值随 reducer 一起消失,只剩 `apps/server/src/runtime.ts` 的 3 处(P0.3)。
4. **E4 已修**:`deleteMessage` 命令带 `indexMetaChanged: true`,runtime 侧补上 `applySessionUpdatedAtToMeta`。这是 P0.1 唯一一处**故意的行为变化**(老路径漏盖,会话列表的 updatedAt 停在删除之前)。
5. **`sanitize*` 的就地薄壳仍然改原消息对象**:COW 版只给命令面的 `repairOnLoad` 用。冷加载/启动扫描的调用点(以及现有单测)都假设"改的是手里那一条",翻成 COW 会静默改语义。
6. **深冻结默认在 vitest 下开**(`ONETHING_SESSION_FREEZE=0` 可关):全量在冻结下是绿的。但这份绿的含金量有限 —— core 引擎的已知就地改点在单测里拿的是 mock store,冻不到。真正的验收在 P0.2 每区完成后。

---

## 9.1 P0.2 区 ①落地记录:packages/core 引擎与会话层(2026-08-19)

**结果**:`session:check` 里 `packages/core/**` 从 **89 条 → 0 条**(access 40 / field-assign 47 /
field-delete 1 / object-assign 1);全仓 195 → 73(其中 89 条是本区,其余是区 ③ 同期的)。
`session:gate` 绿(none new),`boundary:gate` 绿(13 known),`typecheck` 只剩 `spaces/__tests__/provider-dials.test.ts`
的 3 条既有错,`lint:ci` 335 条(与基线同数)。

### 映射表(旧写法 → 命令 / 读门面)

| 旧写法(文件:症状) | 新写法 |
|---|---|
| `engine/stream-processor.ts` `applyCoreToolCallChunk` 就地改 toolCall + `delete streamingArgs` | 解构掉 `streamingArgs` 造新对象 → `toolCalls[i] = next`;`store.updateMessageToolCalls(…, coreToolCallSnapshot(toolCalls))` |
| `stream-processor` `handleToolCallComplete` `toolCall.receivedAt/argsFinalizedBy =` | `patchCoreToolCall(toolCalls, created, {receivedAt, argsFinalizedBy})` |
| `stream-processor` `handleToolInputEnd` 失败分支 `placeholder.status = 'failed'` | `patchCoreToolCall(…, {status:'failed'})`,发的是新对象 |
| `tool-orchestration.ts` `markToolCallAbortedBeforeExecution` 就地改 | 返回新对象(`{...toolCall, status:'failed', …}`) |
| `tool-orchestration.ts` `buildToolMetadataStepUpdate` `toolCall.changes =` | 只产出 `metadataUpdates.toolCall = {...toolCall, changes}`,入参不动 |
| `tool-orchestration.ts` `buildToolExecutionFinalPresentation` 就地写 6 个结算字段 | 造新 toolCall,并作为 `presentation.toolCall` 返回给调用方 |
| `tool-orchestration.ts` `executeCoreToolAndUpdate` 全流程就地改 `toolCall`/复用的 `step` | `toolCall` 变成本地游标:`patchCoreToolCall` / `replaceCoreToolCall` 换进 `allToolCalls`;`step` 复用时 `{...existingStep, …}`;四处写回全部 `coreToolCallSnapshot(allToolCalls)` |
| `CoreToolOrchestrator.start` doom-loop 就地改 + `publishToolCall(_, true)` 的 `status='queued'` | `patchCoreToolCall` + `replaceCoreToolCall(turnToolCalls, …)` |
| `CoreToolOrchestrator` `await executeTool` 之后读 `toolCall.status/rejected` | **按 id 从工作表重新取**(`findCoreToolCall`)—— 捕获引用跨 await 已过期 |
| `agent-loop-executor.ts` `settleAgentLoopToolCallResult` 就地写 9 个字段 | 返回新 toolCall(`settlement.toolCall`),调用方 `replaceCoreToolCall` 换进工作表 |
| `agent-loop-executor.ts` `startAgentLoopToolExecution` 就地写 `status/startTime`(返回 void) | COW + **返回开跑后的那一版**;`applyAgentLoopToolInputEnd/CallFallback` 改为返回它 |
| `agent-loop-executor.ts` `applyAgentLoopToolMetadata` `toolCall.changes =` | 只产出 `metadataUpdates.toolCall = {...toolCall, changes}` |
| `agent-loop-executor.ts` `finalizeLingeringAgentLoopToolWork` 就地改**会话里那条消息**(且从不落盘,靠对象共享偷偷生效) | 改为纯函数返回 `{toolCalls?, steps?}` patch;新增端口 `patchMessage` → `sessionCommands.patchMessage(hint:'settle')` **显式落盘** |
| `history.ts:609/646` `assistantMessage.toolCalls = …`(F6,本地新对象,非会话消息) | 一次性字面量构造(条件展开),不再先建后改 |
| `session/timeline.ts` `sanitizeSessionOnStartup/LoadedSession` 就地改会话与消息(F4) | 移到 `session/commands.ts`,走 `applySessionCommand{type:'repairOnLoad'}`,**返回新会话 / `undefined`**;`store-helpers` 的两个调用点(`sanitizeSessionsOnStartupWithAdapters` / `loadSessionWithAdapters`)改为落盘、同步、入缓存都用新会话 |
| `session/timeline.ts` `repairSessionTimelineMetadata` / `applyTimelineRepairInPlace` | `applyTimelineRepair`(COW)+ COW 版 `repairSessionTimelineMetadata(session, messages, options)` |
| `session/timeline.ts` `sanitizeInterruptedStepRecursive`(`Object.assign(step, …)`) | `= computeInterruptedStepRepair` 的 `@deprecated` 别名(返回新 step) |
| `session/timeline.ts` `computeInterruptedToolCallRepair` / `computeInterruptedStepRepair` 对副本逐字段赋值 | 一次性展开构造 |
| `session/timeline.ts` `findLatestRetainedAssistant` / `deriveRetainedContextSize` / `computeSessionRepairOnLoad` 从 session 取 `.messages` | `messages` 提为显式入参(`deriveRetainedContextSize(messages, session)`) |
| `session/store-helpers.ts` `runMessageCommand` 读 `result.session.messages[0]` | 读 `result.meta!.message` |
| `session/store-helpers.ts` `updateSessionMessageStepsUsageByTurn` 读 `result.session.messages[0].steps` | 读 `result.meta!.message!.steps` |
| `session/store-helpers.ts` `extractSessionMeta(session)` 读 `session.messages` | `extractSessionMeta(session, messages, options)`(0 个生产调用点,仅单测) |
| `session/store-helpers.ts` `insertSessionMessageAfter` 直接 `push/splice` | 函数体搬进 `session/commands.ts` 的 `applyLegacyInsertMessageAfter`(白名单内),`store-helpers` 保留同名 `@deprecated` 转发壳,P0.4 删 |
| `session/store-helpers.ts` `applySessionMessageMutationWithAdapters`(`mutateMessage(session,id)` 契约) | **删**(0 个生产调用点,仅一个单测,同删) |
| `engine/context-compact.ts` `selectCompactPlan(session)` / `estimateSessionInputTokens(session)` 读 `.messages` | 两者都提出 `messages` 入参;`getContextCompactReason` / `shouldAutoCompactBeforeSend` / `getAgentLoopContextBlockReason` 的 `session` 收窄为 `Omit<…,'messages'>` + 新增可选 `sessionMessages` |
| `engine/core-stream-engine.ts` 16 处 `session.messages`(首条判定 / `history.buildMessages` ×6 / `messages:replaced` ×2 / `find(id)` ×3 / 最后一条 user / voice 判定) | `StreamEngineStoreAdapter` 新增 **`listMessages(sessionId)` / `getMessage(sessionId, id)`**(必填),宿主接 `sessionReads.listMessages/getMessage`;`await` 之后一律**现取**,不再持有 `sessionAfterTruncate`/`session` 的数组 |
| `engine/tool-orchestration.ts:910` `session?.messages?.find(…)` | `CoreToolExecutionStore.getMessage?`(可选,mock store 回落旧读法),app 接 `sessionReads.getMessage` |
| `app/engine/stream/tool-orchestrator.ts` `updateToolCalls()` 把 `processor.toolCalls` 本体交给命令面 / `getSession()?.messages.find` | `coreToolCallSnapshot(...)` + `sessionReads.getMessage(...)` |
| `app/engine/context-compact.ts:80` `selectCompactPlan(session, …)` | `selectCompactPlan(session, sessionReads.listMessages(id).messages, …)` |

新增的公共小件:`packages/core/engine/tool-call-cow.ts`(`patchCoreToolCall` / `replaceCoreToolCall` /
`findCoreToolCall` / `coreToolCallSnapshot`),从 `@onething/core/engine` 导出。

### 口径裁定

1. **捕获数组的陷阱是真的**:`CoreToolOrchestrator` 在 `await executeTool()` 之后读 `toolCall.status`
   决定「失败即停链」。COW 之后这个引用必然过期 —— 改成按 id 从工作表重取。同类:
   `startAgentLoopToolExecution` 从 `void` 改为返回开跑后的那一版,两个 `applyAgentLoopTool*`
   把它当返回值传出去。这是本区**唯一**一处如果漏改会静默错(链不停)的地方。
2. **交给 store 的永远是 `.slice()` 快照**:命令面的 `setToolCalls` 把入参数组直接挂到消息上,
   引擎的工作数组不能与它同一个(生产期读出会被深冻结,`push` 立刻炸)。
3. **`finalizeLingeringAgentLoopToolWork` 从前根本没落盘**:它改的是会话里那条消息的对象本体,
   靠共享引用「顺便」生效。改 COW 之后必须显式写回,于是给它补了 `patchMessage` 端口
   (`hint:'settle'`,与其他收尾写同档)。这是本区唯一一次真实的**行为补齐**(从前不脏标、
   不进写计划,靠下一次别的写顺带落盘)。
4. **`sanitize*` 的返回值语义翻转**:`boolean` → `TSession | undefined`。真值性不变,所以
   `if (!sanitize(session)) continue` 这类调用点零改动;但**落盘/同步/入缓存必须用返回值**
   —— `store-helpers` 两处、`sessions/session-repository.ts:587` 已改。P0.1 §8 口径 5
   (「就地薄壳仍然改原消息」)到此作废。
5. **`getContextCompactReason` 的估算路径**:生产三个调用点都显式给 `inputTokens`,估算分支只在
   `getAgentLoopContextBlockReason`(0 生产调用点)与单测里走到,所以把 `sessionMessages` 做成
   可选、缺席按空数组估,不构成生产行为变化;单测显式传了。
6. **F6 是误报**:`history.ts:609/646` 改的是刚 new 出来的 `CoreHistoryMessage`(没有 `id`,
   检查器天然不命中),不是会话消息。仍按要求改成一次性构造,但它不是 bug。

### 冻结验收的诚实交代

`ONETHING_SESSION_FREEZE=1 bun run test` 全绿(10686 passed;2 条 red 在
`packages/renderer/styles/__tests__/ui-token-vars.test.ts`,是工作区里另一条线未提交的
todo-plan 面板改动,与本区无关)。**但这份绿不能当作 F3 的验收**:本区改的四条路径
(`stream-processor` / `tool-orchestration` / `agent-loop-executor` / `core-stream-engine`)
的单测**全部 mock 掉了 store**(`vi.mock('../../store.js')` / 手搓 `runtime.store`),
生产的深冻结在那里根本触发不到,真实 store fixture 也不实际(要拖起 settings→paths→整棵存储树)。

补的是同口径替身:`packages/core/engine/__tests__/tool-call-cow-freeze.test.ts` —— store 端口
**收到什么就 `deepFreeze` 什么**(与生产 `getSession`/`getSessionMessages` 同口径),然后把
F3 的四条路径 + F4 的冷启动修复各跑一遍,并断言「先写回的快照不会被后来的结算追改」。
任何一处退回就地改,这个文件立刻红。

另外这几个单测因为迁移改成了 mock 读门面(与它们已有的 `store.js` mock 同一份假会话):
`app/engine/__tests__/context-compact-append.test.ts`、`context-compact-plugin.test.ts`、
`stream-engine-resume-agent-loop.test.ts`;`packages/core/__tests__/context-compact-{gate,progress}.test.ts`
与 `core/engine/__tests__/send-message-busy-gate.test.ts` 则是给手搓的 `runtime.store` 补上了
`listMessages`/`getMessage` 两个新端口。

### 未动 / 待办

- `session/store-helpers.ts` 的 `insertSessionMessageAfter` 按派工要求**保留**(转发到命令面里的
  `applyLegacyInsertMessageAfter`),P0.4 连同 `applySessionInsertMessageAfterWithAdapters` 一起删。
- `agent-loop-executor.ts` 的 `emitAgentLoopFinalMessageUpdateWithAdapters` 与
  `tool-orchestration.ts` 的 `executeCoreToolAndUpdate` 里,`getMessage` 端口是**可选**的
  (缺席回落 `getSession()?.messages.find`)——为的是不逼所有 mock store 一起改。
  真正收口(改必填、删回落)留 P0.4。
- `agent-loop-executor.ts:2398` 的 `triggerContext.messages = input.session.messages`
  与 `store-helpers.ts:1498` 的 `findSessionMessage(session, id)` 类型上不命中检查器
  (缺会话标记字段),本区未动;要收得先把这两个端口的形状收进读门面,属 P0.4。

## 9.2 P0.2 区 ②/④ 落地记录:runtime app 余量 + electron ipc + F9(2026-08-19)

**范围**(区 ①③ 与 P0.3 之外的全部剩余命中):`search/providers.ts`(产品层)、
`app/engine/triggers/session-toc.ts`、`app/engine/prompt/session-turn-context.ts`、
`app/session/validation.ts`、`app/engine/context-compact.ts`、
`agent-loop/stream-runtime.ts`(产品层)、`apps/electron/src/main/ipc/evals.ts`;
外加 **F9** 两处身份判断(`sessions/renderer-sanitizer.ts`、
`core/engine/agent-loop-runtime.ts`)。

**门**:本区 `session:check` 命中 **12 → 0**(本区完成时全表 73 → 61,余量当时全部是
`apps/server` 的 P0.3 与四个白名单文件的 P0.4;P0.3 随后落地后全表 13);
`session:gate` 绿(none new);`boundary:gate` 绿(13 known);`typecheck` 只剩
`spaces/__tests__/provider-dials.test.ts` 的 3 条既有错;`lint:ci` 335(与基线同数,
本区文件 0 error);`ONETHING_SESSION_FREEZE=1 bun run test` 10693 passed,红的只有既有的
`ui-token-vars.test.ts` 2 条 + `AIProviderTab.interaction.test.ts` 的 unhandled rejection
(另有一次 `apps/server/src/http.test.ts` 与 `toolkit/__tests__/jobs.test.ts` 的红分别来自
并行在途的 P0.3 与满载下的计时抖动,单跑均绿)。

### 映射表(旧写法 → 命令 / 读门面 / 端口)

| 旧写法(文件:症状) | 新写法 |
|---|---|
| `search/providers.ts:206-208` `adapters.getSessionRaw(id)?.messages` 全库扫消息(**产品层,不许 import `@onething/app`**) | 端口改形:新增 `iterateSessionMessages?(sessionId): Iterable<OnethingSearchMessage>`,宿主接 `sessionReads.iterateMessagesRaw`;`getSessionRaw` 降为 `@deprecated` 可选回落端口,返回类型收窄成 `OnethingSearchSessionMessages{messages?}`(**交出来的是一份消息日志,不是一条会话**),`OnethingSearchSession` 只剩 `workingDirectory` |
| `agent-loop/stream-runtime.ts:848` `adapters.buildHistoryMessages(latestSession.messages, latestSession)`(同上,产品层) | 宿主端口新增 `listSessionMessages(sessionId): TChatMessage[]`(必填,生产唯一实现在 `app/engine/stream/agent-loop-runtime.ts` 接 `sessionReads.listMessages`),回合中重建历史时**现取** |
| `engine/triggers/session-toc.ts:40` 尾扫最后一条 assistant | `sessionReads.lastMessageOfRole(sessionId, 'assistant')` |
| `engine/triggers/session-toc.ts:124` `messages.filter(assistant && id!==newest).slice(-1)[0]` | `sessionReads.findMessage(pred, {from:'end'})` |
| `engine/prompt/session-turn-context.ts:91/107` `store.getSession(id).messages` + `.summaryUpToMessageId` | 端口从「整会话 store」收窄成三个具名端口:`listMessages` / `getSessionMeta`(**不含 messages**)/ `updateMessageTurnContext`;生产接 `sessionReads.listMessages` / `sessionReads.getSession` / `sessionCommands.patchMessage(hint:'settle')` |
| `app/session/validation.ts:61` `storeSession.messages.find(id===activeMessageId)` | `sessionReads.getSession` + `sessionReads.getMessage`(`activeMessageId` 缺席时直接 undefined,与旧 `find(undefined)` 同解) |
| `app/engine/context-compact.ts:253` `buildHistoryMessages(session.messages, session)` | `buildHistoryMessages([...sessionReads.listMessages(id).messages], session)` —— 这个函数在 `addMessage` + 整串压缩 `await` **之后**才跑,现取才拿得到压缩标记那条 |
| `apps/electron/.../ipc/evals.ts:139` `(session?.messages ?? []) as …` | `[...sessionReads.listMessages(id).messages] as …` |
| `evals.ts:322/326` `session?.messages?.find(id&&assistant) ?? session?.messages?.filter(assistant).slice(-1)[0]` | `sessionReads.getMessage(id, turnId)`(再判 role)`?? sessionReads.lastMessageOfRole(id,'assistant')` |
| **F9** `sessions/renderer-sanitizer.ts` `contentParts === message.contentParts` / `messages === session.messages` | 三个入口各多一个 `*Result` 版本,显式带回 `{value, changed}`;旧名字签名一字不改(取 `.value`);`reads.ts` 的 `listMessages{sanitize}` 改用 `sanitizeOnethingMessagesForRendererResult().changed` |
| **F9** `core/engine/agent-loop-runtime.ts:1482` `nextMessages === options.messages ? undefined : …` | 显式 `changed` 标记(注入 / 挂尾块两处置位)—— COW 之后身份判断可能恒为假,那样"什么都没发生"会被报成"重开一条回复" |

### `reads.ts` 新增一个方法

`iterateMessagesRaw(sessionId): Generator<Readonly<ChatMessage>>` —— 与
`scanSessionsForSearch` 同族的 **raw 语义**(`getSessionRaw`:不进 LRU、不 sanitize、
不回写)。全库消息搜索一次翻 N 间会话,走 `iterateMessages`(`getSession` → LRU +
sanitize + 可能回写)会把整个会话库灌进 LRU —— 差别是真实的,所以给它自己的名字,
不与 `iterateMessages` 合并。替身 `testing/facade-mock.ts` 同步补上。

### 口径裁定

1. **产品层的两处只能改端口**:`search/providers.ts` 与 `agent-loop/stream-runtime.ts`
   在 `packages/onething-runtime/src/` 下,按架构不许 import `@onething/app`。所以收口
   落在**注入端口的形状**上:端口从此不交出会话、只交出消息。这也是这两处真正的病根 ——
   搜索要的从来只是消息,把整条会话递过去才是多给的。
2. **`search` 的旧端口保留为可选回落,不是遗忘**:`apps/server/src/runtime.ts:2133` 仍在接
   `getSessionRaw`,而 server 属 P0.3 的并行工段。回落端口的返回类型已经收窄成
   `{messages?}`(没有任何会话级字段),所以它在语义上和检查器口径上都不再是"一条会话";
   P0.3/P0.4 宿主迁完即删。同一份精神的先例见 §9.1「未动/待办」的可选 `getMessage`。
3. **`SessionTurnContext.attach()` 仍然是同步的**:门面两侧(`sessionReads.listMessages` /
   `sessionCommands.patchMessage`)都是同步方法,幂等闸仍然是「持久化的
   `turnContext`/`contextUpdate` 字段 + 进程内 `decided` 集合」两道。写档也逐字等价:
   老路 `store.updateMessageTurnContext` 不带 hint → 按键集合推断为常规 300ms 档,
   新路显式 `hint:'settle'` → 同一档。`turn-channel.test.ts` 的 8 条(含「只写一次」
   与「同一回合重复 build 字节不变」)全绿,请求字节没动。
4. **`session-toc` 的两处读法归一后行为不变**:`lastMessageOfRole` 与
   `findMessage({from:'end'})` 都是从尾往前的第一命中,与旧 `filter(...).slice(-1)[0]`
   同解,但不再物化整份数组。
5. **`context-compact` 的捕获数组已复核**:主流程在 `store.getSession()` 之后经过
   `addMessage` 与整串压缩 `await`,但 `computeRetainedContextSizeAfterCompact` 自己
   重新取会话、且消息改为从读门面**现取**;`selectCompactPlan` 那一处(§9.1 已迁)本来
   就在 `addMessage` 之前。会话容器本体因 `adoptSessionCommandResult` 盖回原对象而不过期,
   过期的只会是数组 —— 而数组已经没有人捕获了。
6. **F9 的两处是同一种病**:靠 `===` 判断"这次改没改"。COW 之后上游随时换数组,
   身份判断恒为假 —— renderer sanitizer 那处的代价是每次都整份复制会话(性能),
   agent-loop 那处的代价是把"什么都没发生"报成"重开一条回复"(行为)。两处都换成显式
   `changed`,并各补一条单测(`renderer-sanitizer.test.ts` 的「换了容器但内容没动 →
   changed=false 且返回原对象」)。

### 单测

- `session-toc.test.ts`:从 `vi.mock('../../../store.js')` 改挂共用替身
  `session/testing/facade-mock.ts`(与区 ③ 同一份),断言一行没改。
- `turn-channel.test.ts`:假 store 改成新端口形状(`listMessages` / `getSessionMeta`)。
- `search/__tests__/providers.test.ts`:**新增两条** —— 新端口在场时优先走它(旧端口一被
  碰就抛),宿主没接时回落 `getSessionRaw`。
- `renderer-sanitizer.test.ts`:新增 F9 那条。
- `agent-loop/__tests__/{stream-runtime,runtime-adapters}.test.ts`:补 `listSessionMessages`。

### 未动 / 待办

- `apps/server/**`(P0.3)与四个白名单文件(`app/stores/sessions.ts`、
  `sessions/session-repository.ts`、`sessions/session-message-runtime.ts`、
  `sessions/storage-driver.ts`,P0.4)按派工未动。
- `app/search/providers.ts` 的行数贴着 boundary 的「facade 必须薄」判据(非空行 ≤ 50,
  现在正好 50):再往里加接线之前先把某段挪走,否则 `boundary:gate` 会红。

## 9.3 P0.2 区 ③ 落地记录:collab + plugins/headless/scheduler(2026-08-19)

**范围**:`app/collab/**`、`collab/**`、`app/plugins/sessions.ts`、`app/headless/backend.ts`、
`app/tasks/dispatch.ts`、`app/goals/index.ts`、`app/music/radio.ts`、`app/channel/*`、
`app/usage/index.ts`、`app/permission/message-anchor.ts`、`app/tools/core/permission-policy.ts`。

**门**:本区 `session:check` 命中 **32 → 0**(全表 195 → 128,其余降幅来自并行的区 ①/②);
`session:gate` 绿(none new);`boundary:gate` 绿(13 known);本区 eslint 0 error;
`bun run test` 本区全绿(collab 40 文件 503 测试全过)。

### 写面映射

| 旧调用 | 新命令 | 落点 |
|---|---|---|
| `store.updateMessageReactions(room, id, next)` | `sessionCommands.patchMessage(room, {messageId, patch:{reactions}})` | `app/collab/reactions.ts:67` |
| `store.updateMessageReplyTo(room, id, snapshot)` | `sessionCommands.patchMessage(room, {messageId, patch:{replyTo}})` | `app/collab/reply-quote.ts:75` |
| `store.updateMessageMentions(room, id, mentions)` | `sessionCommands.patchMessage(room, {messageId, patch:{mentions}})` | `app/collab/mentions.ts:57` |
| `store.clearSessionMessages(room)` ×2 | `sessionCommands.replaceAll(id, {messages: [], reason:'clear'})` | `app/collab/room-config.ts:146,:156` |
| `store.addMessage(sessionId, message)` | `sessionCommands.appendMessage(id, {message, stampCollab: true})` | `app/collab/ingress.ts:142`、`room-runtime.ts:143`、`say-tool.ts:330`、`actors/runtime.ts:1442` |
| `patch.replyTo = …` / `patch.collabChainReset = true`(就地改 effects 消息) | COW:整条换新 + `replaceCollabV3EffectMessage` 同步换掉 `room:posted` 广播里那条 | `app/collab/actors/runtime.ts:896-905, 915-931` |

三条口径:

1. **`stampCollab: true` 一律带上,行为零变化**。老路 `store.addMessage` 无条件过
   `stampCollabAgentId`,所以四个写点都保留它。四处**都不需要读回**:盖章只对
   `role==='assistant' && !agentId` 生效,而 ingress 是 `user`、`postSystemLine` 是
   `system`、`say`/`applyCollabRoomSpeak` 写的 assistant 自带 `agentId` —— 盖章在这四处
   可证是恒等变换,所以调用方手里那条与库里那条仍是同一份内容(F11 在本区不成立)。
2. **`replaceAll{clear}` 吃掉了 `clearSessionMessages` 的全部行为**(前后两次强刷 + 留档 +
   索引计数归零),返回字段 `cleared/clearedCount` → `replaced/previousCount`,`room-config`
   的对外结果字段一字未改。
3. **`speak()` 的补写从就地改换成 COW,但必须两处一起换**:`applyCollabRoomPosted` 把
   `room:posted` verb 直接 `push` 进 `effects.broadcast`,而 verb 里装的就是
   `effects.messages` 里那条的**同一个引用**;只换一处会出现「存下来的带引用、播出去的
   不带」。新增的 `replaceCollabV3EffectMessage` 就是这条不变式的唯一所有者。

### 读面映射

| 旧读法 | 新读法 | 落点 |
|---|---|---|
| `session.messages?.find(id)` | `sessionReads.getMessage` | `collab/reactions.ts:57`、`mentions.ts:47`、`say-tool.ts:145`、`actors/runtime.ts:940,:1656`、`channel/outbound-reply-dispatcher.ts:103`、`usage/index.ts:78` |
| `(session.messages ?? []) as ChatMessage[]` | `sessionReads.listMessages(id).messages` | `collab/reply-quote.ts:54`、`agent-session.ts:127`、`digest-runner.ts:89`、`actors/worker-mind-port.ts:150,:161,:319`、`actors/engine-mind-port.ts:158,:265`、`actors/runtime.ts:1478,:1563,:1629`、`goals/index.ts:60`、`headless/backend.ts:464`、`channel/prompt-context.ts:63`、`permission/message-anchor.ts:45`、`tools/core/permission-policy.ts:192` |
| `[...messages].reverse().find(role===X)` | `sessionReads.lastMessageOfRole` | `plugins/sessions.ts:347`、`headless/backend.ts:277`、`tools/core/permission-policy.ts:50,:64` |
| 尾扫首个非空 assistant | `sessionReads.findMessage(pred,{from:'end'})` | `tasks/dispatch.ts:137` |
| `existing.messages?.length` | `sessionReads.countMessages` | `music/radio.ts:156` |
| `store.getSessionMessagesPage(...)` | `sessionReads.pageMessages` | `plugins/sessions.ts:374` |
| `fs.readFileSync(sessions/<id>/messages.jsonl)` | `sessionReads.readTranscriptBuffer` / `readTranscriptFile` | `collab/history-tool.ts:164`、`collab/actors/migrate.ts:438` |

### `reads.ts` 新增一个方法

`readTranscriptBuffer(sessionId): Uint8Array | undefined` —— `history` 工具要把抄本喂给
`scanJsonlLog`(收 `Uint8Array`)并按**盘上真实字节数**记单次跨房检索的读入上限。走
`readTranscriptFile` 再 `Buffer.from` 等于每间房多解码/编码一遍(5–20 间 × 200–350KB),
而字节数还会因非法 utf-8 的替换字符与盘上对不齐。语义与 `readTranscriptFile` 同族:
只读、不进 LRU、缺文件返回 `undefined`。

### 单测替身:`app/session/testing/facade-mock.ts`

迁移前这些单测只 mock 一个 `store.js` 假会话表;迁移后调用点走 `sessionCommands` /
`sessionReads`,而它们**静态**依赖真的 `app/stores/sessions.ts`(→ settings → paths →
整棵存储树),于是只想验一条协作规则的单测会被整个装配层拖垮(实测直接报
`No "getSettingsPath" export is defined`)。给这两扇门一个共用替身:

```ts
vi.mock('../../session/reads.js', () => import('../../session/testing/facade-mock.js'))
vi.mock('../../session/commands.js', () => import('../../session/testing/facade-mock.js'))
bindSessionFacadeMock((id: string) => mocks.sessions.get(id))
```

两个 mock 指向**同一个模块**,读写共享同一份假会话 —— 正是生产里的关系。需要断言
"这一次写确实发生了"的用例(reactions / mentions / reply-quote / ingress / room-config)
在 `sessionCommands` 那一侧再包一层 spy,把命令翻回它迁移前的那个 mutator 名字,断言
一行没改。替身不放 `__tests__/` 下:vitest 的 include 只收 `*.test.ts`,而它要被别的目录 import。

### 未动 / 待办

- `scheduler/agent-task-runner.ts:320-323` **不改**:它在**产品层**(`packages/onething-runtime/src/scheduler/`),
  按架构不许 import `@onething/app`;而且它读的是自己的注入端口类型
  `OnethingSchedulerAgentTaskSession`,类型不同,`session:check` 天然不命中(检查器确认 0 条)。
  真要收口得先把这个端口的形状收进读门面,属 P0.4 的白名单收尾。
- `music/radio.ts:187` 的 `isDjSessionOversized({messages?: unknown[]})` 是一个**鸭子类型的纯判据**
  (调用方自己传对象),不是会话读,同样不命中,不动。

## 9.4 P0.3 落地记录:apps/server(2026-08-19)

**范围**:`apps/server/src/runtime.ts`(唯一改动文件;`packages/**` 一行没动)。

**门**:`apps/server` 的 `session:check` **48 → 0**;全表本期开工时 73,减掉本期这 48 条
后 25(收尾时全表 13 —— 差额来自同期并行的区 ②/④)。
`session:gate` 绿(13 known,none new);`boundary:gate` 绿(13 known);
`typecheck` 只剩 `spaces/__tests__/provider-dials.test.ts` 的 3 条既有错;
`lint:ci` 335(与基线同数);`server:build` 成功(3.52MB 单文件);
`ONETHING_SESSION_FREEZE=1 bun run test` 10693 passed / 3 failed
(2 条既有 `ui-token-vars.test.ts`,1 条 `file-mutex-cross-process.test.ts`
是并发下的抖动 —— 单跑绿);`apps/server` 自己的 4 个测试文件 58 条全绿。

### 病根:server 有**两只**会话仓库,不是一只

改之前一直没写清楚的一件事:`ServerSessionStore` 有两个实现,背后是**两只互不相识的
仓库**——

| | `createAppBackedServerSessionStore` | `createLocalServerSessionStore` |
|---|---|---|
| 何时用 | `backend.persistsMessages === true`(真引擎) | echo / test 后端 |
| 仓库 | `@onething/app` 那只(引擎自己在写的) | server 自己 `createOnethingSessionRepository` 出来的一只 |
| 命令面 | `sessionCommands` 单例 | **本期新装**:同一个 `createSessionCommands` 工厂 + 同一个 `OnethingSessionMessageRuntime`,接在自己那只仓库上 |

所以"server 全部改走 `sessionCommands`"这句话只对一半:app 后端走那个单例,echo 后端
必须走**自己装的一份**——借单例用会把 echo 的消息写进另一份内存真相里去。两边共用的是
同一个 reducer(`applySessionCommand`),写计划 / COW / lazy 档的算法仍然只有那一份。

落地形状:`ServerSessionStore` 上多了三样,两个实现各给一份 ——
`getMessages(sessionId): readonly ChatMessage[]`(读口)、
`messages: SessionCommands`(写口)、
`saveSessionMeta(session)`(只盖 index 元数据,不重写会话体)。
runtime 内部的所有取数改成 `sessionStore.getMessages(...)`,所有写改成
`sessionStore.messages.<cmd>(...)`。

### SV 逐条

| # | 旧写法 | 新写法 |
|---|---|---|
| SV1 | `addSystemMessage`:`session.messages.push` + `refreshSessionMeta` + `persistSession` | `sessionStore.messages.appendMessage(id, {message})` + `settleMessageCommand(id)`(不带 `stampCollab`:老路也没盖章) |
| SV2 | `removeSystemMarkerMessage`:`findIndex(content.includes(marker))` + `splice` | 同一个谓词既用来取 `removedId` 也交给 `deleteMessage{matchMarker}`(命令内部取第一条匹配,与 `findIndex` 同义) |
| SV3 | `removeMessage`:`findIndex` + `splice` | `deleteMessage{messageId}`;返回 false ⟺ 消息不存在,`"Message not found"` 的口径不变 |
| SV4 | `message.thinkingTime =` | `patchMessage{patch:{thinkingTime}, hint:'settle'}` |
| SV5 | `session.messages = replaced.messages.map(...)`(MESSAGES_REPLACED) | `replaceAll{reason:'replaced'}`。`'replaced'` 分支里一个 `await` 都不走(只有 `'clear'` 要刷盘/留档),所以 `void` 掉 promise 不改变执行顺序 |
| SV6 | `session.messages.push({role:'error'})` | `appendMessage` |
| SV7 | `upsertMessage`:`messages[i] = {...old, ...new}` / `push` | `upsertServerMessage()` 先算好合并再交给命令 —— 命令面的 `upsertMessage` 是**整条替换**,而 server 这条投影一直是**合并**(事件只带 id/role/content,替换会把 isStreaming/model 抹掉)。合并留在调用方,行为一字不改 |
| SV8 | `Object.assign(message, updates)` + `message.contentParts =` | `patchMessage`,content→contentParts 的派生**算进同一份 patch**(不是改完再补一刀) |
| SV9 | `markStreamingComplete`:反转数组找最后一条 assistant 就地改 | 仍然是"最后一条 assistant"——`StreamCompleteEvent` / `StreamErrorEvent` **不带 messageId**(只有 `data`),按 messageId 定位无从谈起;改的只是取数走 `store.getMessages` + 写走 `patchMessage` |
| SV10 | `refreshSessionMeta(session)` 自己数 `session.messages` | `refreshSessionMeta(session, messages, options)`,消息由调用方从读口递进来;预览文本收敛成一个 `serverSessionPreviewText(messages)`(server 原来三份实现) |
| SV11 | 两只 store 的 `session.messages = Array.isArray(...) ? ... : []` | **删掉**(不是换成 `replaceAll{normalize}`)—— 见下面口径 2 |
| SV12 | 每次消息写都 `persistSession` → `saveSessionSnapshot` → 无 plan 全量重写 | 消息写只走命令(命令自己算写计划),收尾只 `saveSessionMeta` 盖 index;`saveSessionSnapshot` 在消息路径上**归零** |

顺带:`cloneBranchMessage` 从"深拷再逐字段改 + `delete`"改成 rest 解构 + 一次性字面量
(与区 ① 对 `history.ts` 的处理同因:改的是本地新对象,不是会话消息,但同样不留就地改);
`toMediaSession` / `getUserMarkers` / `getMessagePage` 的入参从 `session` / `ChatMessage[]`
改成 `readonly ChatMessage[]`。

### 口径裁定

1. **`settleMessageCommand`:消息命令之后不再整份重写会话体。**
   老路是"改内存 → `persistSession` 全量写"。迁移后如果保留 `persistSession`,一次
   `addSystemMessage` 会写两遍(命令的 append plan + 一次无 plan 的 structural 全量重写),
   比迁移前还差。所以收尾改成:重新解析会话(命令写的是仓库里那一份,手上那份可能已被
   LRU 换过)→ 刷新派生字段(`preserveUpdatedAt`,命令已经盖过 `updatedAt`)→
   只 `saveSessionMeta` 盖 index 元数据。**唯一还要整份写的情况是自动标题**:`name` 住在
   会话体里,改了才 `persistSession`。
   代价说清楚:`previewText` / `messageCount` 这两个派生字段在会话**体文件**里可能短暂落后
   一次(index 里是准的,会话列表只读 index)。下一次任何会话体写入就追平。

2. **`session.messages = Array.isArray(...) ? ... : []` 是死代码,直接删,不翻成 `replaceAll{normalize}`。**
   走到 `normalizeAppSession` / `normalizeStoredServerSession` 的会话都来自
   `repository.getSession` → `sanitizeSessionOnStartup` →
   `computeSessionRepairOnLoad(session, session.messages)` 里的 `currentMessages.map(...)`
   —— messages 不是数组的话在那里就已经 `TypeError` 了,轮不到这句兜底;
   `createSession` / `createBranchSession` 也恒建数组。
   翻成 `replaceAll{normalize}` 反而做不到:判「不是数组」本身就是一次 `session.messages` 读
   (规则 A),而命令面的 `replaceAll` 第一句就是 `session.messages.length`。

3. **`sessionReads.firstUserPreview` 没有采用。**
   §3 写的是"收 server 三重实现",但它的语义与 server 的 `content.slice(0,160)` 不一样:
   会 `trim()`、超长补 `…`、空串返回 `undefined`,默认长度还是 120。那是**会话列表上肉眼
   可见的变化**,按"行为裁定先问"的规矩不在本期顺手改;server 的三份实现收成了一个
   `serverSessionPreviewText`,统一到读门面留 P0.4 并附一句"预览文本要不要带省略号"给用户拍。

4. **`hint:'settle'` 而不是桌面端的 `'stream'`。**
   桌面的 `updateMessageThinkingTime` 走懒写档(5s),但 server 这条路迁移前是
   `persistSession` 立刻排 300ms 队列。这里按 **server 原来的时机**接。

5. **`getSessionRaw` vs `getSession` 的差别原样保留。**
   `backfillSessionIndexOwnership` 仍走 `repository.getSessionRaw`(不 sanitize、不入 LRU、
   不回写,注释里写的与桌面端 suffix 写竞态的理由仍然成立),没有并进任何读门面方法。

### 端到端核验(脚本级,可复跑)

`server:build` → 起 `dist/server/main.js`(临时 `ONETHING_STORE_PATH`)→
`POST /api/sessions` 建会话 → `POST /api/chat/add-system-message` ×2 →
停进程 → **换一个进程**用 `sessionReads.listMessages` 从 app store 读回来 → 核对
`sessions/index.json` 的 `messageCount`。结果:

```
[http] messages=2 [ 'first message', 'second message' ]
[app store sessionReads.listMessages] messages=2 [ 'first message', 'second message' ]
[index.json] messageCount=2
[messages.jsonl] lines=3
PASS
```

### 未动 / 待办(P0.4)

- **`saveSessionSnapshot` 后门还在**,但只剩**会话级字段**在用它(`persistSession` →
  `sessionStore.saveSession`):`name` / `isPinned` / `isArchived` / `archivedAt` /
  `workingDirectory(Roots)` / `variables` / `maxTokens` / `modelPinned` / owner 盖章。
  `@onething/app` 的 store 没有对应的通用会话补丁 API(只有 `updateSessionPin` /
  `updateSessionArchived` / … 这一串专用 updater,覆盖不全),要彻底摘掉这扇后门得先在
  `app/stores/sessions.ts` 上开一个会话级 patch 口 —— 那是 P0.4 的活(本期不许改
  `stores/sessions.ts`)。**消息路径上它已经是 0 处**。
- **`apps/server/src` 没有 `StoreLock.acquire('server')`**。CLAUDE.md 写的"Single-instance
  safety via StoreLock(`'desktop'` / `'daemon'` / `'server'`)"里的 `'server'` 那一档,在
  server 侧**根本没有调用点**(全仓 grep `StoreLock` 在 `apps/server/**` 命中 0)。
  两个 server 进程或 server + desktop 指向同一个 store 时没有任何互斥。属 L 线 / P0.4。
- **`main.ts` 的退出不保证落盘**:`shutdown()` 在 `server.close()` 回调里
  fire-and-forget 掉 `serverRuntime.shutdown()`(`await sessionStore.flushAll()` 在里面),
  紧接着就 `process.exit(0)`。所以 SIGTERM 之后 300ms 节流队列里的写可能整批丢。
  **这是迁移前就有的**(老路的 `persistSession` 也是排同一个节流队列),不是本期引入;
  上面的端到端脚本因此在杀进程前先等 1.5s。修它只要把 `shutdown` 改成
  `await serverRuntime.shutdown()` 再 `exit`,但那是可感知的行为变化(退出变慢),
  留给 P0.4 一并拍。

---

## 10. P0.4 收口落地记录(2026-08-19)

**门**:`session:check` 白名单外 **0**;基线重录为 0(`session:gate` 从棘轮变成硬闸,
任何一条新命中直接红);`boundary:gate` 绿(13 known,none new);`typecheck` 只剩
`spaces/__tests__/provider-dials.test.ts` 的 3 条既有错;`lint:ci` **334**(基线 335,
净 −1);`ONETHING_SESSION_FREEZE=1 bun run test` 10688 passed / 2 failed(两条既有
`ui-token-vars.test.ts`)+ 1 条既有 unhandled rejection(`AIProviderTab.interaction.test.ts`);
`server:build` 成功(3.53MB);`bun run build` 成功(`build:check` 卡在上面那 3 条既有
typecheck 错上,过不去 —— 那是既有状态,不是本期引入);P0.3 的端到端脚本**去掉 1.5s 等待**
后仍然 PASS(见下面 §10.4)。

### 10.1 13 条命中:逐条处置

| 文件:行 | 规则 | 处置 |
|---|---|---|
| `app/stores/sessions.ts:180` | access | **删**:`saveSessionSnapshot` 整个退役(§10.3) |
| `app/stores/sessions.ts:334` | access | **迁**:深冻结守卫搬进 `app/session/freeze.ts`(`guardFrozenSessionMessages`),入参是鸭子形状 `{messages?}`,既不是会话读也不必开白名单 |
| `app/stores/sessions.ts:657/700` | field-assign | **迁**:`stampCollabAgentId` 的新对象改成一次性字面量(`...message` + 两个条件展开),不再先建后逐字段改 |
| `app/stores/sessions.ts:801` | access | **迁**:`clearSessionMessages` 的计数改问 `sessionRepository.getSessionMessages(id)?.length` |
| `session-message-runtime.ts:491` | access | **迁**:`deleteMessageWhere` 直接派 `deleteMessage{matchMarker}` 命令(reducer 早就支持),不再自己先 `find`;两种形态收进同一个 `runDeleteMessage` 私有收尾 |
| `session-message-runtime.ts:546` | access | **迁**:单条消息的 sqlite seq 改取命令自己算出来的写计划(`writePlan.dirtySeq`),不再回头 `findIndex` |
| `session-message-runtime.ts:556` | access | **迁**:流式节流补同步改走仓库层新增的 `getCachedSessionMessages` 端口 |
| `session-repository.ts:522/545/567`(+ 新增的 `getCachedSessionMessages`) | access | **白名单**(见 §10.2) |
| `storage-driver.ts:200/233` | field-assign | **迁**:`encodeSuffix` 改成一次算准每行字节偏移(带 `startOffset` / 回 `endOffset`),不再 `offset: 0` 占位再逐行改 —— `JsonlLineRef` 恰好带 `id`/`role`,被形状判据当成消息,而"先建后改"在这里本来也没必要 |

### 10.2 白名单:最终五条 + 理由

`scripts/session-check.mjs` 的 `RULE_A_ALLOWED`(每条在脚本里都带一句理由):

| 文件 | 理由 |
|---|---|
| `packages/core/session/commands.ts` | 纯 reducer,12 命令唯一实现处(同时是规则 B 的唯一白名单) |
| `packages/onething-runtime/src/app/session/commands.ts` | §1 的写面 |
| `packages/onething-runtime/src/app/session/reads.ts` | §1 的读面 |
| `packages/onething-runtime/src/sessions/storage-driver.ts` | 存储形状:驱动看的是"盘上长什么样" |
| `packages/onething-runtime/src/sessions/session-dehydrate.ts` | 同上(脱水) |
| **`packages/onething-runtime/src/sessions/session-repository.ts`(P0.4 新增)** | 仓库层是读门面的底座:四处全是"jsonl/sqlite 都取不到时回落到内存权威副本"的取数原语(`getSessionMessages` / 分页 / marker / 缓存快照),下面没有别的层可以再问一次,不是业务读 |

`session-message-runtime.ts` 与 `app/stores/sessions.ts` **按派工没有进白名单**,命中全部迁掉了。

### 10.3 删了什么

**消息插入这条死路**(设计文档 §2 说的 0 调用点):`app/stores/sessions.ts` 的
`insertMessageAfter`、`OnethingSessionMessageRuntime.insertMessageAfter`、
`core/session/store-helpers.ts` 的 `insertSessionMessageAfter` /
`applySessionInsertMessageAfterWithAdapters`、`core/session/commands.ts` 的
`applyLegacyInsertMessageAfter`(全仓最后一个不走 `applySessionCommand` 的消息原语)。

**store-helpers 的整个消息原语家族**(rg 全仓:非测试调用点为 0,只剩单测与
`headless-boundary-check.ts` 的 forbidden-pattern 名单):`appendSessionMessage`、
`deleteSessionMessage`、`truncateSessionMessagesFrom`、`updateSessionMessageAndTruncateAfter`、
`patchSessionMessage`、`appendSessionMessageContentPart`、`addOrUpdateSessionMessageStep`、
`updateSessionMessageStep`、`updateSessionMessageStepsUsageByTurn`、`findSessionMessage`、
`findSessionStepById`,以及五个 `apply*WithAdapters`(append / delete / truncate /
updateAndTruncate / stepsUsageByTurn)。连同它们的 11 个只被自己用的 Options/Result 类型、
两个内部 shim(`runSessionCommand` / `runMessageCommand`)、`core/session/index.ts` 的
导出行、`core-session-store-helpers.test.ts` 里 9 个 it 块一起删。
`headless-boundary-check.ts` 的 forbidden-pattern 名单**保留**:那是"这些名字不许在
`@main` 里出现"的绊线,函数没了绊线也没有成本。

**搜索的 raw 回落**:`OnethingSearchSessionMessages` 与
`OnethingSearchProvidersAdapters.getSessionRaw?` 删掉,`iterateSessionMessages` 从可选
升为必填;`apps/server` 的搜索接线改成
`getSessionForContext(id, ctx) ? sessionStore.getMessages(id) : []`(归属判定原样保留)。

**`saveSessionSnapshot` 后门退役**。替代品是命令面第 13 个方法
`sessionCommands.patchSession(sessionId, {patch, mutateIndexMeta?})` →
`app/stores/sessions.ts` 的 `patchSessionFields` → 仓库新增的
`OnethingSessionRepository.patchSession(id, patch, mutateMeta?)`。
写计划的口径:**会话级字段一律 `{kind:'meta'}`**。理由是 jsonl 布局里
"除 `messages` 之外的一切"都住在 `meta.json`(驱动的 `buildMeta` 就是这么切的),
`name`/`variables` 也不例外 —— 所以本文原来设想的"body 字段要 structural"这一档
**在实际布局里不存在**。老后门走的是默认 `structural`,等于每次改个名字/置顶/归档
都把整份 `messages.jsonl` 重写一遍(SV12 病根的会话级余量),这一期一并消掉。
`patch` 里出现 `messages` 在类型上就被摘掉(`Omit<Partial<ChatSession>,'messages'>`),
运行时再丢一次兜底。

**仍然留着的包装,以及为什么**:`app/stores/sessions.ts` 与
`OnethingSessionMessageRuntime` 上的 `addMessage` / `deleteMessage` /
`deleteMessageAndTruncate` / `updateMessageAndTruncate` / `updateMessageContent` /
`updateMessageReasoning` / `updateMessageStreaming` / `updateMessageUsage` /
`updateMessageToolCalls` / `updateMessageContentParts` / `addMessageContentPart` /
`updateMessageThinkingTime` / `updateMessageSteps` / `updateMessageStep` /
`addMessageStep` / `updateStepsUsageByTurn` / `updateMessageReactions` /
`updateMessageReplyTo` / `updateMessageMentions` / `clearSessionMessages` —— 这些**不是**
死路径:它们是 core 引擎注入的 store 端口(`CoreStreamProcessorStore` /
`CoreAgentLoopContentPartStore` / `CoreAgentLoopToolExecutionStore` / event-only-emitter
的 step 端口)的实现,而 §6 明确"不改 core 引擎小接口的形状"。它们已经全部是
`applySessionCommand` 的薄壳,算法只有一份;要删得先改接口形状,那是 S 线的活。

### 10.4 server 退出落盘(既有数据丢失 bug,本期修)

`apps/server/src/main.ts` 老写法在 `server.close()` 回调里 fire-and-forget 掉
`serverRuntime.shutdown()`(`await sessionStore.flushAll()` 在它里面),紧接着
`process.exit(0)` —— 300ms 节流队列里那一批写整批丢。现在:`close` + `shutdown`
一起 `await`,外面罩 5s 超时(挂着的 SSE 连接会让 `close` 的回调迟迟不来,那种情况
也必须走到刷盘;超时就带非零码退出并把"没刷干净"打出来,不假装干净),重复信号直接硬退。
装配失败(最典型的是新加的 store 锁被占)不再糊一屏 unhandled rejection,改成一行
`[onething-server] FATAL: …`。

验收:P0.3 的端到端脚本删掉杀进程前那句 `await sleep(1500)` 后仍然
`PASS: 2 messages persisted, index.json messageCount matches`。

### 10.5 两条用户裁定(2026-08-19 拍板,本期落地)

**① 预览文本统一到桌面端口径。** `sessionReads.firstUserPreview` 的算法抽成纯函数
`sessionPreviewText(messages, maxLength = 120)`(住 `app/session/reads.ts`,`firstUserPreview`
转发给它);server 的 `serverSessionPreviewText`(`content.slice(0,160)`,空则 `''`)删掉,
三处调用点(`refreshSessionMeta` / `normalizeAppSession` / `normalizeStoredServerSession`)
全部改走它。**这是会话列表上肉眼可见的行为变化,已获批准**:trim、超 120 字补 `…`、
空串给 `undefined`(index.json 里那把 key 直接不写,而不是写空串)。
抽成纯函数是必需的 —— server 有两只互不相识的仓库(app 那只 / echo 自己那只),
按 sessionId 的 `firstUserPreview` 只认得前者。

**② server 取 store 单实例锁,dev 泳道给它独立 store。**
`StoreLockOwner` 一直有 `'server'` 这一档,但 `apps/server` 里从来没有调用点(P0.3 的
"未动"里点过名)。现在 `createRealServerBackend` 在 `createOnethingBackend` 之前
`StoreLock.acquire('server')`,`shutdown` 的 `finally` 里 `release()`;冲突走新增的
`formatServerLockConflict`(按持有者分三种说法)。**只有真引擎这条路取锁** ——
echo/test 后端不碰真存储,取了会把单测钉死在互斥上。

配套:`bun run dev` 是 electron + server 同时起的,两边指着同一个 `~/.onething` 的话
第二个必然抢不到锁。所以 dev 泳道给 server 一只独立 store,口径是
**在泳道 store 名字后面挂 `-server` 后缀**(`scripts/lib/dev-self.mjs` 的
`laneServerStorePath`,`scripts/dev-unified.mjs` 的 `startBackendLane` 用):

| 泳道 | Electron / 泳道 store | server store |
|---|---|---|
| 日常(A) | `~/.onething` | `~/.onething-server` |
| dev-self(B) | `~/.onething-dev` | `~/.onething-dev-server` |
| 显式 `ONETHING_STORE_PATH=/x/y` | `/x/y` | `/x/y-server` |

显式设了 `ONETHING_STORE_PATH` 也照挂后缀:那句话的意思是"这条泳道用这个 store",
不是"让 server 去抢 Electron 的锁"。`bun run server:start` 单跑**不经过**这里,
走默认 store —— 那是接近生产的那条路,它就该和桌面端互斥。

真机核验(没有动用户正在跑的 dev 泳道:直接用 dev 泳道会设的那套 env 起
`dist/server/main.js`):锁文件 `~/.onething-server/run/backend.lock` 内容
`{"pid":…,"owner":"server",…}`;第二个进程报
`FATAL: Cannot start onething-server: another server process is already serving …`;
SIGTERM 之后 `run/` 空(锁已释放)。单测见
`packages/onething-runtime/src/storage/__tests__/store-lock.test.ts` 的
"locks the store for the server owner in both directions"(两个方向都断言)。

### 10.6 交给后面几条线的既有问题(P0.4 未动)

- `agent-loop-executor.ts` 的 `emitAgentLoopFinalMessageUpdateWithAdapters` 与
  `tool-orchestration.ts` 的 `executeCoreToolAndUpdate` 里,`getMessage` 端口仍是**可选**
  (缺席回落 `getSession()?.messages.find`)。收它要改 core 引擎注入接口的形状,
  §6 明说 P0 不动 —— 留 S 线。检查器不命中(mock store 的类型上没有会话标记字段)。
- `scheduler/agent-task-runner.ts:320-323` 与 `music/radio.ts:187` 读的是各自注入端口的
  鸭子形状,类型上不是会话,检查器天然不命中;要收得先把那两个端口的形状收进读门面。
- `session-repository.ts` 进白名单之后,它内部新增的 `session.messages` 访问不再受棘轮
  监督。今天只有 4 处,都是取数原语;新增时要自觉。

### 10.7 追记(2026-08-19 稍后):server StoreLock 已按用户裁定**撤回**

用户复议后认为 server 锁没有必要,要求去掉。已回退:`createRealServerBackend` 不再 `acquire('server')`;`formatServerLockConflict`、`laneServerStorePath`、对应测试与 dev 泳道的独立 store 全部删除,`scripts/dev-unified.mjs`、`scripts/lib/dev-self.mjs`、`storage/store-lock.ts` 恢复到 P0 之前的字节。保留的部分:SIGTERM 时 await shutdown(与锁无关)。
**后果已向用户说明并被接受**:`bun run dev` 里 electron 与 server 共享 `~/.onething`,两套 LRU + 两条节流写队列写同一批文件,谁后写谁赢;S 线(事件日志唯一事实、seq 单调)开工前必须重新评估这一条(审查 B5)。CLAUDE.md 的 `StoreLock` 一句已改为如实描述。
