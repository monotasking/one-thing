# Compact 能力归位(2026-08)

前置:`docs/design/context-compact-fix-2026-08.md`(P0-P3 已落地)。本文回答"compact 能力应该放在哪里",并**取代**前文的 P4 拍板范围。

## 0. 困惑的根源:compact 不是一个能力

"把 compact 放在哪"之所以难回答,是因为 compact 其实是四件性质不同的事,各有自然归属;现状是它们互相纠缠、各自复制:

| 件 | 问题 | 性质 | 自然归属 | 现状 |
| --- | --- | --- | --- | --- |
| **判定** | 现在需要压吗?保留多少? | 纯函数:(用量, 预算) → 决定 | core 纯逻辑 | ✅ 已在 core(`getContextCompactReason`/`buildContextUsageSnapshot`/`planAgentLoopContextCompactPass`),但被两个触发点**各抄一份调用编排**(快照→mismatch→递减循环) |
| **执行** | 怎么压 | 副作用:LLM 摘要 + 写 store + 改消息 | app 层(store 与 provider 所在地) | ✅ 唯一:`app/engine/context-compact.ts` 的 `compactSessionContext`,三条路共用 |
| **协调** | 互斥、生命周期事件、requestId | 跨调用方的状态 | core(两个调用方都在 core) | ⚠️ 在 `CoreStreamEngine.runContextCompact` 里,**路 3 绕过它**(无 gate、无 started 事件) |
| **触发** | 什么时候查 | 时机点,天然多个 | 各时机点,但必须**薄** | ⚠️ 路 2/路 3 是"厚触发":自带判定编排;溢出反应触发**缺失**(retry.ts 注释已声明归属 compaction 层,无人接) |

一句话答案:**河口可以有多个,发电站只能有一座**。时机(触发点)天然是复数的——用户命令、开流前、loop 轮间、(将来)turn 结束后、溢出兜底;但判定逻辑、执行机制、协调状态各只该有一份。修复方向不是消灭触发点,是把每个触发点削薄到一行:"叫协调器"。

## 1. 目标形态

```
触发点(薄,只декlar时机)              协调器(core,唯一)         执行(app,唯一)
┌ 手动 /compact ────────────┐
├ 开流前(turn 1)  ──────────┤      CompactionCoordinator      compactSessionContext
├ loop 轮间(turn ≥2) ───────┼──►  gate/互斥/started/completed  ──►  选切点/LLM摘要/写store/
├ (C4) turn 结束后空闲压 ────┤      requestId/触发来源标注            标记消息/进度
└ (C3) 溢出错误反应 ────────┘              │
                                          └── 判定:planAgentLoopContextCompactPass(core 纯函数,唯一)
```

不变量:
- **执行入口唯一**:`compactSessionContext` 只被协调器调用;任何新触发点接协调器,结构上不可能再出现"绕过 gate/事件"这类洞。
- **判定唯一**:用量快照→mismatch 跳过→阈值/hard-limit→递减(或预算折半)这套编排只存在于一处;触发点不携带任何判定知识。
- **触发点只声明时机与来源**(`trigger: 'manual' | 'pre-turn' | 'mid-turn' | 'post-turn' | 'overflow'`),来源进 started/completed 事件,UI 与 events.jsonl 可辨。

## 1.5 业务面:压缩管哪些会话形态

`SessionKind = 'chat' | 'room' | 'work' | 'agent'`(`packages/shared/ipc/chat.ts:205`)。压缩不是对所有形态都成立的:

| 形态 | 自动压缩(pre-turn/mid-turn) | 手动 /compact | 裁定 |
| --- | --- | --- | --- |
| `chat` 普通会话 | ✅ 主业务 | ✅ | 全量适用 |
| `work` 派工会话 | ✅(产品上就是普通会话,chat.ts:211) | ✅ | 同 chat |
| `agent` 执行会话(房回合真正跑的地方,W18) | ✅ **真实会发生**——长跑的 agent 会话就是普通流式会话 | ✅ | 适用;有一个锚点边角(下述) |
| `room` 群聊房本体 | 事实上永不触发:W18 后 ingress 把房内用户消息挡在流式之外,房本体不跑模型回合(`message-helpers.ts:181` 冻结注记) | ⚠️ **今天没挡**,能压 | **应封禁**(C0 加守卫) |
| 外部 agent 会话(Claude Code / ACP) | 已豁免(`coreProviderOwnsItsContextWindow`,E0 能力查询) | ⚠️ **今天没挡**,会白压 | **应封禁**(C0 加守卫) |
| 网关会话(WeChat/Telegram) | ✅ 就是 chat,走 handleSendMessage(channel≠ipc) | 仅 App UI 可发 | 同 chat |

两条裁定的理由:

- **room 本体的上下文管理是另一套机制**:视野窗口(`room.context` 的 `historyDays` / `historyTailCount` / `unreadMax`),在 drive 投影(`walkCollabRoomProjection` → `buildCollabDriveRoomContext`)时裁剪,**不读 `session.summary`**。对房手动 /compact = 写一份没人读的 summary + 往所有成员可见的房账里插一张 compact 卡片——纯困惑。封禁文案:"群聊房不需要压缩,房间上下文由视野窗口管理"。
- **外部 agent 自管上下文窗口**:自动路已按能力查询豁免,但 `handleCompactContext` 没有同款检查——手动压会用外部 agent 的 provider 跑 `generateChatResponse`(未必支持),写下的 summary 它也永远不读。封禁文案对齐 E0 口径。

**锚点边角**(agent/chat 共有,随 C 线修):`summaryUpToMessageId` 的消失风险。历史构建在投影**之后**按 id 找锚(`history.ts:680`),而 `collapseSupersededGoalDrives` 会折叠被取代的 goal-drive 消息、房投影会合并消息并只保留首条 id——锚点若恰好是被折叠/合并的那条,`findIndex` 落空 → `onMissingSummaryAnchor` → **summary 被整个静默弃用、全量历史回灌**(上下文重新膨胀,压缩白做)。修法:锚点解析从"精确 id"放宽为"id 或其之前最近一条存活消息"(核对 `onMissingSummaryAnchor` 现有消费者后并入 C1)。

## 2. 分期总览

| 期 | 内容 | 解决 | 依赖 |
| --- | --- | --- | --- |
| C0 | `CompactionCoordinator` 收口:gate/事件/registration 从 CoreStreamEngine 抽成 core 协调器,三条现有路全部改接 | 路 3 绕过 gate/started 的遗留缺口;协调状态唯一化 | 无(在已落地的 P0-P3 之上) |
| C1 | 判定合一:删 `maybeCompactBeforeSend` 的私有编排,pre-turn 触发点改用与 loop 同一份 `planAgentLoopContextCompactPass` | 路 2/路 3 的判定重复 | C0 |
| C2 | 错误类型化:`AgentProviderError { kind, status, providerId, raw }`,五家 provider 在各自 throw 点映射;retry.ts 改为先认 kind、正则降级为未映射兜底 | 错误面进抽象;溢出识别不再靠猜文案 | 无,可与 C0/C1 并行 |
| C3 | 海口兜底:runner 捕获 `kind === 'context-overflow'` → 协调器(`trigger: 'overflow'`)→ 压缩 → 重建历史重试本轮(限 2 次/轮,失败升 hard-limit 错误) | retry.ts 注释里"owned by the compaction layer"的空头支票;预估失手时不再死轮 | C0 + C2 |
| C4 | 空闲期压缩与切点升级(原 P4):post-turn 触发点(一行接协调器)、`contextCompactRetainTokens` 预算切点(默认 ≈20k,替代 6 轮)、摘要独立模型档位(内部能力不进设置页) | 发送零等待;保留量有界 | C0-C1 |

C0-C1 是结构主线;C2-C3 是错误面补全;C4 是体验升级。P5(composer 状态呈现、折叠线)不变,仍单独拍板。

## 3. 各期细化

### C0 CompactionCoordinator

**位置**:`packages/core/engine/compaction-coordinator.ts`(core——因为两个程序性调用方 `CoreStreamEngine` 与 `agent-loop-runtime` 都在 core;app 层通过引擎持有)。

**持有**(从 `CoreStreamEngine` 迁入):`activeCompactions`、`compactionGates`、`waitForCompactionIdle`、started/completed 事件发射(emitter 注入,复用 event-only-emitter 模式)、`CONTEXT_COMPACT_TOTAL_BUDGET_MS`。

**接口**:
```ts
coordinator.run({
  sessionId,
  trigger: 'manual' | 'pre-turn' | 'mid-turn' | 'post-turn' | 'overflow',
  requestId?,          // manual 带
  compactOptions,      // 透传给注入的 compactSessionContext 适配器
}): Promise<TCompactResult>
coordinator.waitForIdle(sessionId): Promise<void>
coordinator.isCompacting(sessionId): boolean
```
`run` 内部:同步 registration(TOCTOU 已闭合的语义原样保留)→ emit started(带 trigger)→ 执行 → emit completed → finally 释放。`started/completed` 事件增加可选 `trigger` 字段(shared/events 类型同步,ipc-hub 不需要改逻辑)。

**改接**:
- `handleCompactContext`:早退检查(activeStreams/重复压缩/provider 未配置)保留在引擎(它们要 requestId 定制文案),**新增两道守卫**(§1.5):`kind === 'room'` 与 `coreProviderOwnsItsContextWindow(providerId)` 各自以 skipped + 说明文案早退;真正执行改 `coordinator.run({trigger:'manual'})`。
- `maybeCompactBeforeSend` 的执行段 → `coordinator.run({trigger:'pre-turn'})`(判定段 C1 处理)。
- **路 3**:`app/engine/stream/agent-loop-runtime.ts:108,190` 的 adapters,`compactSessionContext` 适配器改为经引擎注入的 `coordinator.run({trigger:'mid-turn'})` 绑定——遗留缺口就此闭合,mid-turn 压缩从此有 gate、有 started 事件(P1 的 `compactingSessions` 状态对它不再瞎)。
- 四个命令入口的 `waitForCompactionIdle` 改调 `coordinator.waitForIdle`。

**测试**:P2 的 `context-compact-gate.test.ts` 全量迁移到协调器语义;新增"mid-turn 路径发 started/completed(trigger: 'mid-turn')且登记 gate"。

### C1 判定合一

- 删 `maybeCompactBeforeSend` 内私有的快照→mismatch→阈值→递减编排(约 `core-stream-engine.ts:1242-1362`),pre-turn 触发点改为调用与 loop 相同的判定循环(`planAgentLoopContextCompactPass` + `createAgentLoopCompactState`,它们已经封装了 pass/递减/hard-limit 状态机)。
- `shouldStartAgentLoopContextCompact` 的 `turn <= 1` 让路条件**保留**——pre-turn 触发点继续存在于开流前(assistant 占位消息之前),维持现有事件次序与 hard-limit 早退 UX;合的是**逻辑**,不是调用点(河口保留,电站合一)。
- hard-limit 最终失败文案(`buildAgentLoopContextHardLimitError`)两路共用,删引擎里的重复拼接。
- `context:size-updated` 的 pre-send 发射逻辑并入判定循环(loop 版已有,引擎版删除)。

**测试**:同一 session 状态下 pre-turn 与 mid-turn 判定结果一致(表驱动);hard-limit 早退行为与现状快照一致。

### C2 错误类型化

- `packages/core/agent-loop/errors.ts` 增加:
```ts
export class AgentProviderError extends Error {
  kind: 'context-overflow' | 'rate-limit' | 'overloaded' | 'auth' | 'quota' | 'server' | 'network' | 'unknown'
  status?: number
  providerId: string
  raw?: string        // 原始响应体(截断),进日志不进 UI
  isRetryable?: boolean
}
```
- 五家 provider(`onething-runtime/src/agent-loop/providers/{claude,codex,deepseek,gemini,openai-compatible}.ts`)在各自 throw 点做映射:每家最了解自家溢出/限流的错误形态(HTTP status + error.type/code 字段优先,文案匹配其次)。ACP/external-agent 路径不动(上下文自管,E0 能力查询已豁免)。
- `retry.ts`:先认 `instanceof AgentProviderError` 的 kind;裸 Error 走既有正则(降级兜底,不删)。`FATAL_PATTERNS` 中溢出三条保留——它们现在是安全网而不是唯一手段。
- 现有 codex `isRetryable` 预分类收编进同一类型。

**测试**:每家 provider 一组错误映射用例(真实响应体样本入 fixture);retry 判定表驱动(typed 优先、regex 兜底)。

### C3 海口兜底(溢出反应式压缩)

- `packages/core/agent-loop/runner.ts` turn 级错误处理:`kind === 'context-overflow'` 时不再直接 fatal——调 `coordinator.run({trigger:'overflow', keepRecentTurns: 当前状态递减值})` → 成功且未 skipped → 复用路 3 现成的 `{kind:'rebuild'}` 历史重建 → 重试本轮。
- 刹车:每轮最多 2 次溢出压缩重试(计入既有 compact state 的 pass 计数,不另设计数器);压缩 skipped/失败或重试后仍溢出 → 升级为 hard-limit 错误报出(现有文案)。
- 该路径天然覆盖"预估失手"与"provider 静默改口径"两类漏网;C4 之后,预判触发(pre-turn/mid-turn)退化为省钱优化,正确性由这里保证。

**测试**:mock provider 首次抛 overflow、压缩后成功 → 本轮最终完成且用户无感(只多一张 compact 卡);连续溢出 → 2 次后报 hard-limit;`contextCompactEnabled=false` 时溢出兜底**仍然生效**(它是正确性路径,不受自动压缩开关管——开关只管预判触发)。

### C4 空闲期与切点(原 P4,细案随实施再拆)

- **post-turn 触发点**:turn 正常收尾后(`app/engine/triggers/` 后处理链)一行接 `coordinator.run({trigger:'post-turn'})`,判定不达标即 no-op。用户空闲期完成,下次发送零等待;pre-turn 触发保留为兜底。
- **保留 token 预算切点**:`selectCompactPlan` 换 `contextCompactRetainTokens`(默认 ≈20k,pi 对齐),从尾部按 `estimateTextTokens` 累计,切点仍落用户轮边界;hard-limit 循环改预算折半。`contextCompactKeepRecentTurns` 设置保留读取、内部换算,不新增设置项曝光。
- **摘要模型档位**:`summarizeInChunks` 接受 provider/model 覆盖,内部能力,默认沿用会话模型。

### C5 摘要形态对齐 pi(2026-08-14 拍板,先于 C0-C4 单独实施)

对照结论(pi 源码 `packages/coding-agent/src/core/compaction/{compaction,utils}.ts` + `messages.ts` @476102):两家都把序列化转录塞进单条 user message,差异在五处,全部采纳(2026-08-14 拍板后**无保留偏差** —— 第 5 项的假握手也一并删):

1. **确定性文件清单**:不再让 LLM 在摘要里"回忆"文件路径。从 `messagesToSummarize` 的 toolCalls 参数确定性提取 read/modified 两张清单,以 `<read-files>` / `<modified-files>` 标签附加在摘要文本之后(pi 同款)。工具名→路径参数的分类表放 app 层(core 不识产品工具名)。UPDATE 模式下与上一份摘要尾部的既有标签做并集去重后重附。
2. **指令后置**:`compact.md` 改为转录在前(`<conversation>` 标签包裹)+ `<previous-summary>` 标签 + 指令在最后(recency 位置);system prompt 加 "Do NOT continue the conversation / Do NOT respond to any questions" 双护栏。
3. **Markdown 固定标题替代 JSON**:输出改 pi 六节式——`## Goal` / `## Constraints & Preferences` / `## Progress`(Done/In Progress/Blocked 复选框)/ `## Key Decisions` / `## Next Steps` / `## Critical Context`。`normalizeContextSummaryOutput` 从 JSON 解析改为标题校验(缺 `## Goal` 视为不合格,返回裁剪原文兜底);旧会话的 JSON summary 作为 previousSummary 传入 UPDATE prompt 时由模型自然转换,无迁移。
4. **独立 UPDATE prompt**:新增 `content/compact-update.md`(PRESERVE 全部旧信息 / In Progress→Done 挪动规则 / 按成果更新 Next Steps),有 previousSummary 时选它。
5. **注入形态**:`history.ts:686` 的注入文案改 pi 式 "The conversation history before this point was compacted into the following summary:\n<summary>…</summary>",**假握手 assistant 一并删除**(2026-08-14 用户拍板,推翻此前"保留偏差"的裁定)。连续两条 user 的交替风险改由 provider 层兜底:严格交替的 provider(DeepSeek 系)若已有相邻同角色消息合并逻辑则复用,没有则在该 provider 适配层补合并;不得为此在 history 层保留伪造消息。

### C6 compact 状态条(与 C5 同批)

- **新事件** `context:compact-progress { chunk, totalChunks }`(shared/events):`compactSessionContext` 增加 `onProgress` 回调,由三个调用方接线转发到 eventBus(engine 手动/自动路 + agent-loop mid-turn 路的 adapters)。单块摘要不发。
- **store**:ipc-hub 消费 progress 事件 → chatStore `compactProgress: Map<sessionId, {chunk,totalChunks} | null>`;`compact-started` 清零,`compact-completed` 清除。
- **呈现**:遵循"组件化而不是创建新组件"——优先并入既有 `components/chat/BackgroundJobsStatusBar.vue` 状态条(compacting 时显示一行 "Compacting context… 2/5",无分块时不带计数;completed 即隐,失败由消息卡片负责呈现,状态条不做错误态)。文案语言与该组件既有文案一致;过 `bun run ui:gate`。

## 4. 迁移与风险

- C0 是纯搬家+改接,行为等价(除路 3 补上 gate/事件——这是修洞不是变更);P0-P3 的全部测试应在 C0 后原样通过。
- C1 删引擎私有判定时,注意两份编排的细微差异要先做一次对拍(引擎版 `latestSession.contextSize !== usage.visibleInputTokens` 的 size-updated 去重条件、loop 版 `historyMessages` 的传入条件),以 loop 版为准、差异写进测试。
- C2 的 raw 字段只进日志:错误文案给用户的通道仍走 `error-details.ts` 的人话化,不把响应体泼到 UI。
- C3 的重试与 turn 级 auto-retry(`MAX_TURN_RETRIES`)是两个独立计数,溢出压缩重试不占用瞬时错误的 3 次配额;实现时在 runner 里分支清楚,测试锁死。
- 全程不动 renderer(C0 的 trigger 字段对 ipc-hub 是可选新字段);P5 呈现届时直接受益(started 事件带 trigger,可区分"手动压缩中"与"自动整理中"文案)。

### C7 分块策略与并行(2026-08-21 裁定,先于 C0-C4 单独实施)

真机上多块压缩又慢又容易超时,拆开是三件事叠在一起:单块时限太短、块被写死切太碎、多块串行把墙钟时间乘上块数。三条一并裁定。

1. **单块超时 120s → 300s,且可配**。`CONTEXT_COMPACT_CHUNK_TIMEOUT_MS` 默认值改 300_000,新增设置项 `settings.chat.contextCompactChunkTimeoutSeconds`(General → Chat,范围 30–1800s,越界夹住)。运行时一律经 `resolveContextCompactChunkTimeoutMs` 取值,常量只是默认。引擎总预算闸同源计算(`resolveContextCompactTotalBudgetMs` = 单块超时 × 5),不再有第二处写死的墙钟。

2. **块大小随模型窗口走**。`MAX_CHUNK_CHARS`(80k)降级为**窗口未知时的回退值**;真正的块大小由 core 的纯函数 `resolveCompactChunkChars({ transcript, modelContextLength, reservedOutputTokens })` 算:

   ```
   usableTokens = modelContextLength − reservedOutputTokens − COMPACT_PROMPT_OVERHEAD_TOKENS(4_000)
   usableTokens <= 0 或窗口未知 → MAX_CHUNK_CHARS
   ratio       = transcript.length / estimateTextTokens(transcript)      // 实测,空转录取 4
   chars       = floor(usableTokens × ratio × COMPACT_CHUNK_FILL_RATIO(0.8))
   下限 MIN_CHUNK_CHARS(20_000),**不设上限**
   ```

   ratio 必须实测而不能写死 4:中英混排的 chars/token 比能差一倍,写死会让中文块超窗口。不设上限是明确取舍 —— 块越少,分块摘要的信息损耗越少;那一头的护栏是可配的单块超时,不是一个凭空的字符数。app 层 `summarizeInChunks` 从 `modelRegistry.getModelContextLength` 取窗口(失败 → undefined + `log.warn`,退回 80k),`reservedOutputTokens` 用摘要请求的 `maxTokens`(未知取 8_192)。效果:200k 窗口下块 ≈ 600k 字符,**多数会话就此退回单块**。

3. **多块从串行滚动改 map-reduce 并行**。旧算法第 k 块带着第 k−1 块的摘要再请求,墙钟 = N 块之和,而且越靠后的块越容易被越滚越长的那份摘要挤掉细节。新算法:

   - **map**:N 块**互不相干地并发**(`CONTEXT_COMPACT_MAX_CONCURRENCY = 4`)各出一份部分摘要,结果保持块顺序;`previousSummary` **不喂给部分摘要**(N 份摘要各自去改写同一份旧摘要没有意义)。每块的请求带 `<part index="k" total="N">` 一行,告诉模型它只看到了一段 —— 否则它会把中途截断的转录当成完整对话。
   - **reduce**:一次 `kind:'merge'` 请求,把按序装进 `<partial-summaries>` 的 N 份部分摘要合成一份独立成立的摘要;指令正文在 `content/compact-merge.md`(六节模板照抄 compact.md,加"后面的部分反映更晚的状态、冲突时以它为准"和同一事项只留一次的规则)。有 `previousSummary` 时合并指令里额外套用 compact-update.md 的 PRESERVE / 移动 / 重写 Next Steps 规则。
   - **进度是 N + 1 步**:`context:compact-progress { chunk, totalChunks }` 的字段名和消费者都不动,`totalChunks` 变成"块数 + 1 次合并",最后一步是合并完成。
   - **fail-fast + 批中止**:任一块失败立即抛出、不再派发新块(core 侧 `mapWithConcurrency`),app 侧一个批级 `AbortController` 把在途的其余块一起掐掉 —— 剩下的块已无用武之地,跑完只是白烧 token。超时与批中止**必须分清**:用 `timedOut` 标志位判断,被别的块拖垮的块报成"超时"是在说谎,用户会去调一个不相干的设置。
   - **单块路径逐字不变**:一次请求、不带 `part`、不报进度、提示词字节与从前完全相同。

`## Goal` 的格式校验仍只校最终摘要(部分摘要不合格由 merge 兜);`billCompactUsage` 每次 provider 调用照记,merge 也算一次。
