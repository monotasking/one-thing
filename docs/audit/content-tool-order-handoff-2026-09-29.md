# 交接：一条回复里「正文」和「工具」的先后顺序会被画错（2026-09-29）

这份文档是交接给另一个会话的，只交代现状、证据和两条修法，还没有动任何代码。
动手之前请先读完「约束」一节。

## 1. 用户看到的现象

用户录屏 `/Users/yitiansong/Pictures/ss/CleanShot 2026-09-29 at 14.52.20.mp4`，时长 8.8 秒。
场景：在 Claude Code 会话（走 ACP）里问「最近在做什么？」。

Claude Code 实际的执行顺序：

1. 调用 Bash 跑 `git log`，耗时 1.7 秒；
2. 思考约 10 秒；
3. 写出一大段总结。

屏幕上画出来的顺序是：用户问题、总结正文、Bash 卡片。
**Bash 卡片被画到了总结下面**，而它实际上发生在总结之前。

另外一件无关的事：总结是一下子整段冒出来的，不是逐字流出。这个已经查清，与本任务无关，
见第 7 节，不要混进这次改动。

## 2. 一条助手回复现在是怎么存的

投影出来的消息结构见 `packages/core/session/projection/types.ts:193` 的 `ProjectedChatMessage`。
正文和工具分装在两个容器里，我们叫它「两条车道」：

- **正文车道** `contentParts`：只有 `text` 和 `reasoning` 段。每一段带一个 `turnIndex`，
  含义是「这一段是本次执行里第几次请求模型时产生的」，从 1 起。
- **工具车道** `steps`（以及更老的 `toolCalls`）：每个工具调用带参数、结果、状态、耗时，
  也带 `turnIndex`。它另一个主要用户是给模型重建历史：API 要求 `tool_use` 和 `tool_result`
  成对出现并按请求分组，所以它天然按轮分组。

**两条车道之间谁先谁后，没有任何字段记录。** 事件账本 `events.jsonl` 里每条事件本来是有序的，
但折叠成消息时这层顺序没有保留下来。

这样分装是历史上逐层长出来的，并不是一个有意的设计：

- `content` 字符串是最早的形状；
- `toolCalls` / `steps` 来自 Vercel AI SDK 时代，那个 SDK 早已删除，但形状留了下来；
- `contentParts` 是后来专为「文字和工具交错显示」加的，git 历史里大约出现在 2025-12。

## 3. 画的时候怎么把两条车道合成一条

两条车道之间靠「渲染锚点」缝合。锚点是一个不带内容的 part，形如
`{ type: 'data-steps', turnIndex }`，意思是「第 t 轮的工具画在这里」。

锚点**故意不进账本、不进投影**。依据是 canonical G4，见
`packages/core/session/projection/canonical.ts:33` 和 `:101`。
所以锚点的位置每次都要现算，有两个产地，它们必须算出同一个结果：

1. **流式期间，由写手那一侧落锚点。**
   - `packages/core/engine/agent-loop-executor.ts:1407`、`:1426`–`:1431`：
     一轮结束时把 `data-steps` 追加在这一轮 `orderedParts` 的末尾。
   - `packages/backend/wiring/engine/stream/agent-loop-executor.ts:587` 附近的注释也在讲这件事。
2. **重放或刷新时，由折叠产物现算。**
   - 唯一合成器：`packages/core/session/render-anchors.ts`，
     `synthesizeCoreToolAnchors` → `insertDataStepsByTurn`。
   - 消费方：壳侧 `apps/desktop-react/src/content/assemble/anchor.ts`，
     以及主进程的 settle 推送。

`insertDataStepsByTurn` 手里只有轮次号，它的规则是：**第 t 轮的工具锚点，插在第 t 轮最后一段正文
之后、第 t+1 轮的第一段正文之前。** 流式那一侧同样是「本轮正文在前，本轮锚点追加在后」。

这条规则隐含一个假设：**一轮 = 一次模型回复 = 先说话，再调用工具。** 对我们自己跑的 provider，
这个假设成立：工具由我们执行，执行完我们再请求模型，轮次号加一，后面的正文自然排在工具下面。

壳侧 tail 那一侧也依赖轮次号来定落点，见 `apps/desktop-react/src/data/chat-fold.ts`
第 71–85 行 `TailSegment.turnIndex` 的注释，以及 `appendTail` 第 3 条「跨轮不合并」。

## 4. ACP 为什么会画错

- 在 ACP 里，工具是 agent 在它自己的进程里执行的。对我们的引擎来说，一整条
  `session/prompt` 只算一次模型请求。
- `packages/onething-runtime/src/external-agents/acp-connector.ts:233` 把 `request.turn`
  原样传给 `translateACPPromptStream`，见 `packages/onething-runtime/src/acp/translate.ts`
  第 415 行起。这一轮里所有的 `text-delta` 和 `tool-*` 事件都盖同一个 `turn`。
- 引擎给 part 盖的 `turnIndex` 取自执行器自己的计数器 `state.turnIndex`，不读事件上的 `turn`。
  执行器只在自己发起下一次模型请求时才加一，而 ACP 一轮里从头到尾不会有第二次请求。
- 结果是 Bash 和它后面的总结同属一轮。规则判定「同轮里正文在前、锚点在后」，
  于是总结被画到了 Bash 上面。真实的到达顺序是 Bash 先、总结后，这个信息在分装进两条车道时就丢了。

同一个病同样会打到**任何在一次回复里「先工具、后文字」的来源**，不只是 ACP。
比如 Anthropic 一次回复里文字块和工具块交替出现的情况，目前这一点只是推断，没有复现过。

## 5. 两条修法

### 修法 A：止血，只改 ACP 翻译层

改 `translate.ts`：同一个 prompt 流里，只要已经出现过 `tool_call`，之后再来 `agent_message_chunk`
或 `agent_thought_chunk`，就视为 agent 开了一条新消息，把轮次号加一。

难点在于执行器现在不读事件上的 `turn`。所以还要让执行器接受 provider 在事件上声明的更大轮次号，
并据此推进 `state.turnIndex`。涉及文件：
- `packages/core/engine/agent-loop-executor.ts`
- `packages/backend/wiring/engine/stream/agent-loop-executor.ts`
- `packages/backend/wiring/engine/stream/session-event-recorder.ts`：它在镜像引擎的回合号，
  见第 317 行附近。

这样做需要回答几个问题：
- 用量是按轮记的，见 `reducer.ts:1578` 的 `usageByTurn.get(tool.turnIndex)`，这一轮的用量算到哪一轮？
- `model-history`（给模型重建历史）对外部 agent 会话是否会因为多出几轮而受影响？
  外部 agent 不走我们的历史重建，但需要确认。

优点是改动小。缺点是只治 ACP，而且「轮次号兼管画在哪」这个根还在。

### 修法 B：根治，保留先后顺序（推荐方向）

不再用轮次号推测位置，改为在投影里保留「正文段与工具调用的相对顺序」。事件账本里信息是现成的，
事件本身有序。两种形状二选一：

- **B1（小一些）**：同一轮里，工具出现之后再来的正文另开一段，不和前一段合并。每一段记下
  「排在哪个工具之后」，锚点合成按这个位置插入，不再按轮次号猜。
- **B2（彻底）**：一条消息只有一条有序列表，工具调用本身就是其中一个 part，与 text、reasoning
  并排，按事件顺序排列。这就是 Anthropic API content blocks 的形状。`steps` 退化成一个派生出来的
  索引，只用于按请求分组和重建模型历史，不再决定摆放位置。这样锚点、合成器和轮次推测这一整套
  都可以去掉。

主要落点：
- `packages/core/session/projection/reducer.ts`：`materializeContentParts` 在第 1962 行，
  part 的轮次号逻辑在第 1105–1115 行和第 1195 行附近。
- `packages/core/session/render-anchors.ts`
- `packages/core/engine/agent-loop-executor.ts`：流式那一侧怎么落锚点。
- `packages/core/session/projection/canonical.ts`：G4 的口径要跟着改。
- 壳侧 `apps/desktop-react/src/data/{chat-fold,chat-materialize}.ts`
  和 `src/content/assemble/anchor.ts`。

## 6. 约束（动手前必读）

- **流式画面与重放画面必须逐字同算。** 这是 `render-anchors.ts` 放在 core 并且只准有一份实现
  的原因，文件头第 10–14 行写着。任何修法都要同时改流式与重放两个产地，并证明两者一致。
- **账本是唯一真相**，见根 CLAUDE.md「Session event sourcing」一节。如果要往事件里加字段，
  或改变折叠规则，refold 闸门 `backend/session/shadow.ts` 与 `sessions:shadow-battery` 都得保持绿，
  并且统一在 `canonical.ts` 这一个判官里扩展，不许加局部豁免。
- **老会话要能照旧打开。** 老账本里的 part 没有新字段，缺席时必须退回今天的轮次号规则，
  画面要和今天逐字相同。
- **G4 目前规定锚点不进账本。** 如果 B2 让工具调用成为正文列表里的一项，需要重新论证 G4 的
  那一行，并在 `canonical.ts` 里改写口径，而不是绕开它。
- 根 CLAUDE.md 的「加功能不许改骨架」一条：修完之后，新接一个 agent 来源不应该再需要动锚点代码。

## 7. 与本任务无关、已查清的事：正文整段冒出来

录屏里「已 10.5s 没有新内容」之后正文一次性全部出现，这不是我们这边的问题。

实测数据，探针脚本在上一个会话的 scratchpad 里，已经不在了，要复测需要重写：

| 场景 | 直接跑 `claude -p … --output-format stream-json --include-partial-messages` | 经 `claude-agent-acp` 0.81.1 |
|---|---|---|
| 纯文字 | 87 个 `text_delta`，分布在 4.3 秒里 | 80 个片段，分布约 4 秒，相邻中位间隔 49ms |
| 先跑工具、再回答 | 工具之后静默约 6 秒，80 个 delta 在 10ms 内一次性到齐 | 工具之后静默约 5 秒，76 个片段在 13ms 内一次性到齐 |

也就是说，CLI 的原始流在工具之后就是整段到达的，适配器和我们的通路都没有攒批。
「工具之后」这一行 CLI 只测到一次，用户自己贴的一份 stream-json 日志可以作为旁证。

如果要改善观感，只能在壳上把那段静默显示成明确的「思考中」，这与本任务无关。

## 8. 验收建议

- 用录屏里同一个问题在真机复现：Bash 卡片在上，总结在下；刷新后从账本重算，顺序不变。
- 在 core 层补单测，覆盖三种组合，每种都断言流式与重放两条产地的结果一致：
  - 同轮内「工具 → 文字」；
  - 同轮内「文字 → 工具 → 文字」；
  - 跨轮的常规情况。
- 老会话抽样打开，画面与改动前逐字相同。
- 跑 `sessions:shadow-battery`、`sessions:hydration-contract`，以及 `apps/desktop-react` 的 `gate-acp-shell`。
