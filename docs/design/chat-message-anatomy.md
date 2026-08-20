# ChatMessage 解剖 —— 聊天记录的形态、存储与生命周期

> 说的是 UI 上那条「用户 ↔ AI 的对话记录」：它在内存里长什么样、在盘上怎么躺、
> 从按下回车到重启后重新显示中间经过哪些手。
>
> 相关但不重复的文档：
> [session-storage-jsonl.md](./session-storage-jsonl.md)（盘上格式的完整规格）、
> [long-session-storage-and-rendering.md](./long-session-storage-and-rendering.md)（长会话分页）、
> [streaming-markdown-rendering.md](./streaming-markdown-rendering.md)（正文渲染）、
> [history-rebuild.md](./history-rebuild.md)（同一批消息怎么变成给模型的请求）、
> [multi-agent-collab-im.md](./multi-agent-collab-im.md)（房/私聊那一棵呈现树）。

---

## 0. 一句话

**全链路只有一个形状**：`ChatMessage`（`packages/shared/ipc/chat.ts:350`）。
主进程内存里的对象、`messages.jsonl` 的每一行、IPC/SSE 送给渲染层的 payload、
Pinia `sessionMessages` 里的元素 —— 是同一份类型，没有 DTO 转换层。

全链路只有**两处**加工，都很薄，都可枚举：

| 加工 | 位置 | 做什么 |
| --- | --- | --- |
| 落盘脱水 / 读盘复水 | `sessions/session-dehydrate.ts` | 去重复 payload、剥内联二进制；读回时还原 |
| 出 IPC 前净化 | `sessions/renderer-sanitizer.ts` | 滤掉 `provider-data` 这类模型专用、UI 不该见的 part |

> 旁支提醒：`packages/shared/ipc/ui-message.ts` 里那套 AI-SDK 风味的 `UIMessage` /
> `UIMessagePart` **不是**聊天记录的主线。渲染层只是把类型 re-export 了一遍
> （`packages/renderer/types/index.ts:190`），没有任何组件消费它；活着的消费者只有
> provider 侧一条转换路径（`app/providers/index.ts:250 streamChatWithUIMessages`）。
> 同文件里的 `TokenUsage` / `SessionTokenUsage` 是真在用的。看代码时别把两套混起来。

---

## 1. 数据结构：`ChatMessage`

`packages/shared/ipc/chat.ts:350`。按职责分组看（字段本身的注释在源码里，这里给的是**分组语义**）：

### 1.1 身份与位置

| 字段 | 说明 |
| --- | --- |
| `id` | 消息唯一 id |
| `seq?` | 会话时间线里的 1 起序号，**只有走分页加载时才有** |
| `sessionId?` | 归属会话；渲染层在 `setSessionMessages` 里统一补写（`stores/chat.ts:919`） |
| `role` | `'user' \| 'assistant' \| 'error' \| 'system'`。**`error` 和 `system` 是纯展示态，不落后端** |
| `timestamp` | 创建时刻 |

### 1.2 内容 —— 四份表示并存（这是最容易迷路的地方，见 §2）

| 字段 | 类型 | 角色 |
| --- | --- | --- |
| `content` | `string` | 扁平全文。搜索、预览、复制、送模型都读它 |
| `contentParts` | `ContentPart[]` | **有序展示流**，UI 的真正数据源 |
| `toolCalls` | `ToolCall[]` | 本条消息全部工具调用的**规范表** |
| `steps` | `Step[]` | 过程账（思考/工具/读写文件…），可回链 `toolCallId` |
| `reasoning` | `string` | **顶部** thinking（正文开始之前的那一段）；行内 reasoning 走 `contentParts` |
| `attachments` | `MessageAttachment[]` | 图片/文档/音视频 |

### 1.3 流式与状态

`isStreaming`、`isThinking`、`thinkingTime` / `thinkingStartTime`（切会话后还能接着显示计时）、
`errorDetails`（assistant 半途出错时的行内错误）、`steered`（插话标记）。

### 1.4 出处与计量

`model` / `provider`（assistant 消息自动盖章）、`skillUsed`、`source`（`text|voice|api|…`）、
`voice`、`origin`（渠道身份）、`usage`（本条的 token 账）、`contextUpdate`
（发送时抓的易变变量快照，进模型请求的 `<context-update>` 块，**不是正文**但 UI 可展开看）。

### 1.5 协作（房 / 私聊）专属

`agentId`（谁说的）、`replyTo`（引用快照）、`mentions`（id 化的 @）、`reactions`（表情）、
`collabSourceMessageId`（重启幂等用）、`collabChainReset`（外部注入，链长清零）。
这些在普通 chat 会话上全部缺席 —— 缺省即老语义，旧转录零迁移。

### 1.6 `ContentPart` —— 展示流的原子

`packages/shared/ipc/chat.ts:48`：

```
text | prompt-ref | skill-ref | reasoning | tool-call
waiting | loading-memory | image-loading      ← 瞬态指示器
data-steps                                     ← steps 面板的占位锚
provider-data                                  ← 模型专用，出 IPC 前被滤掉
```

`waiting / loading-memory / image-loading` 由 `isTransientPart()` 标记：真内容一到，
reducer 会把尾部这几个弹掉（`stores/helpers/content-parts.ts:19 popTrailingTransient`）。

---

## 2. 为什么内容有四份 —— 它们的关系

这不是冗余失控，是四个不同的问题各要一份答案：

```
content        "这条消息说了什么"        → 搜索 / 预览 / 复制 / 喂模型
contentParts   "屏幕上按什么顺序画"      → 正文、思考、工具卡的交错次序
toolCalls      "这条消息调了哪些工具"     → 权限、状态机、diff、计时的唯一真值
steps          "过程中发生过什么"        → 过程账/工具面板
```

**关键不变量：`contentParts` 里的 `tool-call` part 持有的是 `message.toolCalls`
里那个对象的引用，不是副本。** 写入走
`upsertMessageToolCall`（`stores/helpers/tool-calls.ts:41`）拿到 canonical 对象，
再交给 `upsertToolCall(parts, canonical)` —— 于是一次状态更新两个消费者同时看见，
不需要手工镜像写。

读盘时这条引用会断（JSON 反序列化出来是两个独立对象），所以加载路径上必须先跑
`linkStepsToToolCalls(message)` 重新接上，这正是 `rebuildContentParts`
（`stores/chat.ts:889`）做的第一件事。它的第二件事是：老消息若没有 `contentParts`，
就用 `content` + `toolCalls` 合成一份最简版本，让老转录也能进新渲染树。

---

## 3. 形态：屏幕上它可能长成什么样

### 3.1 先分树：两棵壳，永不同时挂载

```
ChatWindow
├── kind === 'room'  → RoomSurface → SayChatFlow → SayMessageRow   （IM 面：房/私聊）
└── 其它             → ChatPanel   → MessageList → MessageItem      （工作台面：普通会话）
```

分流点是 `ChatWindow.vue:240 roomSurfaceActive`（`currentSession.kind === 'room'`），
全库唯一一处。房面**不是** ChatPanel 的一个分支：没有 TabBar、没有侧栏、没有大纲导航轨、
没有行内工具卡；组件级复用照旧，壳级复用禁止（`RoomSurface.vue` 顶注）。

### 3.2 `MessageItem` 的形态分支（按模板里的判定顺序）

| # | 条件 | 渲染成 |
| --- | --- | --- |
| 1 | `role === 'error'` | `MessageError` 错误卡 |
| 2 | 房内系统通知 | `RoomNoticeLine` 一条细线（房里这些是记账不是公告） |
| 3 | `role === 'system'` | `MessageSystem` 系统卡 |
| 4 | `/goal` 声明 | `GoalSetMessage` 目标框 |
| 5 | 引擎注入的目标续推 | `GoalContinuationLine` 蓝图刻度线 |
| 6 | 协调器 drive | `.collab-drive-line`，折成一行「谁被激活、为什么」 |
| 7 | 房内思考记录 | `CollabThinkingTrace`，折成细线，可展开整个回合 |
| 8 | 协作 pass | `.collab-pass-line`：`XX 选择不发言`（流式保持窗内是 `…`） |
| 9 | 以上皆非 | **正常 user/assistant 行**（下面这一节） |

### 3.3 正常一行的解剖（自上而下）

```
[房内] 头像列（一组只画一次，点头像下钻 agent 空间）
└ message-content-wrapper
  ├ 署名行        头像 · 名字 · 头衔 · 时间（dm 模式下省掉整行）
  ├ (MessageThinking 顶部 reasoning 由 MessageBubble 的 #thinking 插槽摆放，见 §3.4)
  ├ 附件区        图片走 figure + AttachmentThumb，文件走 FileChip
  ├ 引用块        replyTo 快照：作者 + ≤120 字摘录，点击回跳
  ├ MessageBubble ★ 正文主体，见 §3.4
  ├ 表情条        reactions 聚合成 chip，Popover 展示归属
  ├ 插话行        steered：「插话」标记；仍在队列时显示「待送达」+ 撤回
  ├ context-update 折叠块（仅 user 消息且有该字段）
  ├ ErrorNote     assistant 半途失败的行内错误
  ├ StepsPanel    ⚠︎ 仅老消息（没有 contentParts 的）才走这条兜底
  └ footer        时间 + MessageActions
```

`MessageActions` 能发出的动作：`copy / reply / react / edit / regenerate / branch /
goToBranch / downvote`，外加 TTS 朗读。房内消息 `mutations-disabled`。

### 3.4 `MessageBubble` 内部：工作组与答案（2026-08-19 改）

一条 assistant 回复在**最后一轮工具调用**处一分为二（`MessageBubble.vue workRender`）：

- **工作组（work group）** —— 顶部思考（`message.reasoning`，由 MessageItem 经
  `#thinking` 插槽交进来）、行内 `reasoning`、每一轮 `tool-call` / `data-steps`、
  以及夹在工具轮之间的过渡叙述 `text` —— 整段收进一条 `ProcessRail`：一行头
  「Working · 12s · bash ×3」（在跑）/「Worked · 41s · 思考 9 步 · read ×4 · bash ×3」
  （已结束）。
  **整个回合保持展开，回合结束才自动折叠一次**（2026-08-19 用户拍板，方案 B）：
  框子的票是**整条流是否还在进行**（`MessageBubble.isTurnLive` = `isStreaming` ∧
  有工作组），不是工作组自己那面来回翻的旗。`Working/Worked` 这一票（`isWorkLive`）
  在一个回合里会翻好几次（工具在跑真 → 答案流出假 → 又调一轮工具 / 又开始思考真），
  头上的文案与用时跟着翻，**框子一次都不许跟着抖** —— 否则一条几百 px 的 rail 一开
  一合，贴底的消息列表整屏上下弹，用户读到一半的字被卷回组里；七轮的回合弹七次。
  回合真正结束时自动收起一次（可见性门照旧：用户正看着它就先挂起）。用户手点即
  intent，一锤定音 —— 后续轮次与回合结束都不再改它。
  两票分别喂给 `ProcessRail` 的 `streaming`（框子）和 `workLive`（头；不传就跟
  `streaming` 同一票）。
  组内思考与工具**各自成行**（`InlineThought` / `StepsPanel`），不再按连续段合并
  成一条摘要 rail。
- **尾部（tail）** —— 最后一轮工具之后的 `text` / `prompt-ref` / `skill-ref` /
  指示器（`ContentPartView`），正文列全量直出；收起后页面上只剩它。

「Working」的判定（**只管头，不管框**）：消息在流、且组内有工具在跑或最新 part 仍是
过程（思考 / 待调工具）；一旦尾部出现可见内容就翻成「Worked」，即使消息整体还在流。
框子此刻不动（见上）。用时：活着时从
`startedAt`（消息 timestamp）走秒，翻 settled 那一刻冻结；历史消息按「最后一个工具的
endTime − startedAt」推算。

`ProcessRail` 对 assistant 消息**恒挂载**：没有工具行时走 `solo`（无头无框），
第一条工具行出现时只是长出头和框，顶部思考等已在场的内容不重挂。分组 key 沿用
part 的锚点序号 —— 流式期间 `contentParts` 只追加，延长工作组不会让已渲染内容重挂；
唯一会搬家的是「先说了话再调工具」那段开场文本（从尾部搬进组里），一次。

用户消息没有工作组：所有 part 都在尾部。

### 3.5 房面的 `SayMessageRow`

房里一条消息只有 `say` 出来的部分算「发言」，工具与思考不进流。行的形态由上层
（`SayChatFlow`）判定后以 prop 交下来，行本身只画：
`head/tail`（连发分组的头尾）、`addressed`（@我）、`dmMode` / `pairDmMode`（一对一 / 旁观）、
`quoteMissing` / `quoteSuppressed`（引用降级与连发去重）、`threadEntry`（展开执行 →）、
已读水位（晚于水位的「@我」才是那枚橘色 pill）。

---

## 4. 存储

### 4.1 盘上布局（默认 jsonl）

```
~/.onething/sessions/
├── <sessionId>/
│   ├── meta.json          会话级字段（ChatSession 去掉 messages）+ {formatVersion, log:{messageCount,lastSeq}}
│   └── messages.jsonl     第 1 行 header，其后一行一条消息
└── <sessionId>.json       ← legacy 整文件格式，仍可读，惰性迁移（原件留 legacy-backup/）
```

`messages.jsonl` 行格式（`packages/core/session/storage/jsonl/codec.ts`）：

```
{"t":"h","v":2,"sessionId":"…"}
{"t":"m","seq":1,"m":{ …一整条 ChatMessage… }}
{"t":"m","seq":2,"m":{ … }}
```

不变量：行序 = seq 序（1 起连续），一条消息只出现一次（最终版本）。
恢复语义：尾部截断行静默丢弃；seq 断序视为损坏点，其后全丢，只保留合法前缀。

格式**跟随数据**：盘上是什么就用什么读写；只有「新建会话」看
`settings.storage.sessionFormat`（默认 `jsonl`，设 `legacy-json` 即回滚）。

### 4.2 写入分级 —— 为什么流式不会每个 token 重写整个文件

`SessionWritePlan`（`sessions/storage-driver.ts:38`）三档：

| kind | 动作 | 用在 |
| --- | --- | --- |
| `meta` | 只重写 `meta.json` | 改名、置顶、变量… |
| `message` | **后缀重写**：从最低脏 seq 的字节偏移 truncate 后重追加 | 流式热路径，O(当前消息) |
| `structural` | 全量重写 | 删除/插入/截断/分支等低频结构改动 |

再叠一层 300ms 异步节流（`app/stores/sessions.ts:48` 起的注释）：更新内存缓存后
把脏 session 异步写盘，同一 session 的多次写入在 promise 链上串行化（防旧写盖新数据）；
finalize / delete / 退出等关键时刻强制 `flushSessionSave`。

### 4.3 脱水 / 复水（`sessions/session-dehydrate.ts`）

一条跑完的消息曾经把同一份工具 payload 存三遍。落盘前 `dehydrateSessionForStorage`：

- `step.toolCall` 若能靠 `toolCallId` 回链 `message.toolCalls`，**整份丢掉**，只留 id；
- `step.partialResult` 已定型（`partialResultIsPartial === false`）的丢掉；进行中的保留但剥二进制；
- 任何嵌套值里超过 2000 字符的 `content` / `data` 字符串换成
  `[Image: image/png data omitted: N chars]` 这样的占位；
- `toolCall.changes.originalContent`（老会话内联的整份改前文件）丢掉，回滚走 `auditPath`。

读回时 `rehydrateSessionFromStorage` 反向补齐：按 `toolCallId` 把 `step.toolCall` 接回来，
终态 step 的 `partialResult` 从 `toolCall.result` 重建。**存储层之外没人感知这层差别** ——
唯一有损的是图片二进制：`path` 活着，内联 base64 不再回来。

### 4.4 出 IPC 前的净化

`sanitizeOnethingMessagesForRenderer`（`sessions/renderer-sanitizer.ts`）滤掉
`provider-data` part（provider 的加密 reasoning 之类，模型上下文要、UI 不该见）。
写成「没有就原样返回同一个引用」，所以绝大多数消息零拷贝。

### 4.5 读取：分页而非整会话

`getMessagesPage`（驱动层直接在 jsonl 上按字节偏移取，不加载整会话）+
`getUserMessageMarkers`（用户消息的 seq/时间/80 字预览，导航轨用）。
渲染层对应 `loadInitialMessagePage` / `loadOlderMessages` / `loadNewerMessages` /
`loadMessagesAround`（`stores/chat.ts:1937` 起），页状态记在
`sessionMessagePages`：`nextCursor / backwardsCursor / hasMoreBefore / hasMoreAfter / totalCount`。

---

## 5. 生命周期：从回车到重启后重现

```
① 发送
   InputBox → chatStore.sendMessage
   → platformApi.emitCommand(sessionId, {type:'command:send-message', …})
   桌面：preload → ipcRenderer.invoke('session:command') → main/ipc/handlers.ts
   Web ：POST /api/sessions/:id/commands（整条命令原样转发）

② 引擎
   EventBus → StreamEngine.handleSendMessage
   → 落 user 消息 → 建 assistant 消息（'assistant-created' 事件）
   → 边生成边发 chunk + step/tool 事件

③ 合流
   SessionStreamCoalescer（app/events/stream-coalescer.ts）
   text / reasoning / tool-input 增量按 16ms 有序缓冲，
   给每个 chunk 盖上当前流的 messageId；任何 session 事件发出前先 flush 掉待发增量。
   桌面走 IPCBridge('session:stream')，Web 走 /api/events SSE（同名事件，?after= 从环形缓冲重放）。

④ 渲染层归约   ★ 核心在 stores/chat.ts:1293 handleStreamChunk
   text            → content 追加 + appendOrMergeText(parts)
   reasoning       → placement 'top' 进 message.reasoning，'inline' 进 parts
   tool_input_start→ 建 status:'input-streaming' 占位 toolCall + 占位 part
   tool_input_delta→ 攒进缓冲，一帧一刷（flushToolInputDeltas；任何别的 chunk 到达前强制先刷）
   tool_call/result/input_end → upsertMessageToolCall 拿 canonical → upsertToolCall(parts)
   continuation    → 还有活着的工具就记 pending，否则推 waiting 指示器
   content_part    → 收尾用的定型 part（text 兜底、data-steps 锚、image-loading…）
   replace         → 整条重置
   收尾统一 messages[i] = {...message} + setSessionMessages（shallowRef + triggerRef 手动触发）

   ⚠︎ chunk 可能先于 assistant-created 到达（HMR / 重放 / 时序紧）：
      找不到目标消息就进 pendingStreamChunks 排队，消息一出现立即回放。

⑤ 完成 / 出错
   handleStreamComplete（:1504）：停流、结算 usage、收尾残留工具活
   handleStreamError（:1600）：写 errorDetails，必要时保留已生成内容

⑥ 落盘  —— §4.2 的三档 + 300ms 节流

⑦ 重开会话
   分页拉回 → 每条过 rebuildContentParts（:889）
   → linkStepsToToolCalls 重接引用；缺 contentParts 的老消息就地合成
```

**过程账（steps）走的是另一条事件线**，不在 chunk 里：
`handleStepAdded` / `handleStepUpdated` / `handleToolExecutionStart|Update|End` /
`handleSkillActivated`（`stores/chat.ts:1671` 起），落到 `message.steps`；
`contentParts` 里只有一个 `data-steps` 锚点标记它该出现在哪一段。

---

## 6. 容易踩的地方

1. **`content` 与 `contentParts` 不是同一份真值的两个视图**，是两份都要维护的表示。
   只改一个 = 屏幕和搜索/复制/模型请求对不上。
2. **`toolCalls` 的引用共享是刻意的**，读盘后必须 `linkStepsToToolCalls` 重接。
   任何「从 JSON 造 ChatMessage」的新路径都得走 `rebuildContentParts`。
3. **`role: 'error' | 'system'` 不落后端** —— 别指望它们重启还在。
4. **`StepsPanel` 在 MessageItem 里那处是老消息兜底**（`showLegacyStepsPanel`）；
   新消息的 steps 由 `MessageBubble` 的 `data-steps` part 在 `ProcessRail` 内渲染。
   在错的那处改样式会看不到效果。
5. **脱水是有损的**：图片内联 base64 落盘即丢，只剩 `path`。要复现完整请求体
   得看 provider-requests dump，不能靠重读会话文件。
6. **房会话到不了 `MessageList`**（R3 已拆掉旧门），改房里的显示只有 `say/` 那棵树。
7. **`message` 档写盘是后缀重写**：任何会改动"更早某条消息"的操作必须报
   `structural`，否则只重写尾巴，早处的改动不落盘。

---

## 7. 文件索引

**类型**
- `packages/shared/ipc/chat.ts` — `ChatMessage:350` / `ContentPart:48` / `Step:70` / `MessageAttachment:103` / `ChatSession:499`
- `packages/shared/ipc/tools.ts:100` — `ToolCall`
- `packages/shared/events/stream-chunks.ts` → `packages/core/events` — `StreamChunk`
- `packages/shared/ipc/ui-message.ts` — 旁支的 UIMessage 模型 + 在用的 `TokenUsage`

**渲染层**
- `stores/chat.ts` — 状态、reducer、分页、权限镜像（`handleStreamChunk:1293`、`rebuildContentParts:889`）
- `stores/helpers/content-parts.ts` · `tool-calls.ts` — parts 与 toolCall 的归约原语
- `components/chat/MessageList.vue` · `MessageItem.vue` — 工作台面
- `components/chat/message/MessageBubble.vue` — 正文/过程分列（`partGroups:371`）
- `components/chat/message/` — `MessageThinking` / `ProcessRail` / `StepsPanel` / `MessageActions` / `DiffView` / `Streaming*` …
- `components/chat/room/RoomSurface.vue` · `say/SayChatFlow.vue` · `say/SayMessageRow.vue` — IM 面
- `components/chat/ChatWindow.vue:240` — 唯一的分树点

**后端**
- `packages/onething-runtime/src/app/engine/stream-engine.ts` — 流生命周期唯一持有者
- `packages/onething-runtime/src/app/events/stream-coalescer.ts` — 16ms 合流，桌面/Web 共用
- `packages/onething-runtime/src/app/stores/sessions.ts` — 节流落盘装配
- `packages/onething-runtime/src/sessions/` — `storage-driver.ts`（混合驱动/写入分级）、`session-repository.ts`、`session-dehydrate.ts`、`renderer-sanitizer.ts`
- `packages/core/session/storage/jsonl/` — `codec.ts`（行编解码/恢复扫描）、`pager.ts`（分页）
