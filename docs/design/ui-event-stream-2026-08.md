# UI 事件流:renderer 成为投影消费者(2026-08-20)

> 起因:影子真机首日抓到 reasoning 双落点投影 bug 后,用户点出方向——"contentParts 是给 UI 传数据的,能否让它成为一个**稳定的 token 吐出器**"。本文把它落成设计。
> 一句话:**UI 收的不再是"数组快照 + 裸 delta"两条流,而是与 events.jsonl 同一套事件词汇的实时投影流;renderer 的消息状态 = core 投影 reducer 的输出**。dsh 的"chat 与 trajectory 是同一事件窗口的两次装配"在我们这里的落地。
> 关系:不依赖 S2b(引擎活事件已在发);与 one-core B 期(renderer 去特权 → HTTP/SSE)天然合拍——本文定"流里装什么",B 期定"流走哪条管"。分期编号 U 线。

---

## 0. 今天的病(对着代码说)

UI 侧现在有**两条真相来源、三层各自为政的拼装**:

1. **裸 delta 流**:core 引擎发 `text-delta/reasoning-delta/tool-input-delta`(`packages/core/events/stream-chunks.ts`),coalescer 16ms 合帧并补 `messageId`(`app/events/stream-coalescer.ts`——引擎的 chunk 甚至不带 messageId,靠"当前活跃流"推)。到 renderer 变成 `text/reasoning/tool_call/tool_result/tool_input_start|end/continuation/replace/content_part` 一族(shared 层又一套词汇)。
2. **快照流**:`message:updated` 整条 `ChatMessage`(含整个 contentParts 数组)——"回填约定"(`chat.ts:2987`),非流式字段全靠它。
3. **renderer 拼装层**(`stores/chat.ts` handleStreamChunk ~200 行 + helpers):`appendOrMergeText/Reasoning(parts, turnIndex)` 按"最后一个 part 的类型 + turnIndex"猜边界;reasoning 落点在 chunk 不带 placement 时**由 renderer 自己推**(`chunk.placement ?? (message.content ? "inline" : "top")`,`chat.ts:1494`)——和引擎规则的第二份拷贝,正是昨天投影 bug 的同一类病根;toolCall 整对象反复 upsert + `linkStepsToToolCalls` 重连;早到的 chunk 排 pending 队列;瞬态 part(waiting/placeholder/data-steps)插进 contentParts 数组再在 settle 时清理。

后果(全是踩过的坑):part 身份是**位置推断**不是稳定 id → 索引平移类 bug;两条真相合并 → stream-end 稳定性、拖滚动条脱跟、regenerate 锚定、审批卡绑定丢失(tool/step 事件曾不带 messageId);web 端 SSE 重连后 delta 流不可重放(事件有 `?after=` 环形缓冲重放,chunk 没有)。

而引擎侧**已经有了标准答案**:S1a 的 recorder 给每个 part 分配了稳定 `partIndex`(kind 一切换就开新槽、永不复用),`assistant/chunks`/`part-end`/`run/*`/`tool/*` 就是一套完整、有 seq、可重放的流词汇;core 的投影 reducer(`(state, event) → state`)已被影子在真机上证明与引擎行为等价;renderer 已经在 import `@onething/core`(L3 日志内核),`tsconfig.web` 有 core 路径。

## 1. 目标形态

```
engine(唯一装配点,delta 在源头就带 partIndex/kind/messageId)
   │
   ├─ 落盘:assistant/chunks 打包(2s/64,S1a 既有)────────→ events.jsonl
   └─ UI:同一词汇、16ms 小批(coalescer 改造)──IPC/SSE──→ renderer
                                                            │
                                            core 投影 reducer(同一份代码)
                                                            │
                                              ChatMessage[](Pinia 只存 reducer 状态)
                                                            │
                                              渲染层:瞬态占位是**装饰**,不进状态
```

三条规则:
1. **一套词汇**:UI 流 = `run/start`、`assistant/chunks`(小批:`{messageId, partIndex, kind, placement?, toolCallId?, text[]}`)、`assistant/part-end`、`tool/call|result|audit`、`permission/*`、`run/end`——与 events.jsonl 同名同形,只是投递节奏不同(16ms vs 2s)。落盘打包器与 UI 批发器共用同一个 part 边界判定(recorder 单点),**边界只判一次**。
2. **一份 reducer**:renderer 的消息装配 = `@onething/core` 的 `reduceSessionProjection`(同一模块),Pinia 只持有 reducer 状态与派生 `ChatMessage[]`。placement、part 边界、toolCall↔step 关联的推断规则从 renderer **删除**——它们只活在引擎(写侧)与 reducer(读侧)各一份,且被影子持续对账。
3. **一个恢复语义**:每条 UI 事件带会话内 `eventSeq`(与落盘同源)。断线/切会话回来 = 拉快照(现有分页读)+ 按 `?after=eventSeq` 重放增量——web 重连、桌面窗口重建、多窗口同视,全走这一条路;pending 队列、`resolveMessageId` 兜底大幅缩水。

`message:updated` 快照保留两个用途:非流式字段变更(编辑、reactions、collab 字段)与重连兜底;不再承担流中回填。

## 2. 与既有件的关系

| 件 | 变化 |
|---|---|
| core 引擎 delta(`stream-chunks.ts`) | 源头加 `messageId/partIndex/kind/placement`(recorder 已算,提到发射点共享);shared 层那套 `text/reasoning/…` 词汇退役 |
| coalescer | 保留 16ms 合帧与 flush-before-event,输出从"合并裸 delta"变"打小批 `assistant/chunks`";与 S1a 落盘打包器共享 part 状态机 |
| renderer `handleStreamChunk` + `appendOrMerge*` + placement 推断 + `linkStepsToToolCalls` + pending 队列 | U2 删除,由 reducer 状态取代 |
| 瞬态 part(waiting/placeholder/data-steps) | 移出 contentParts 数组,变渲染层装饰(由 reducer 状态派生:如"run 活跃且无未闭合 part → waiting") |
| `SessionStreamCoalescer` 消费者(ipc-bridge / SSE) | 不变(还是那两条管;B 期换管不换词汇) |
| 轨迹面板 | 已经吃事件(S3),自然同源 |
| 影子(S1b) | 继续跑;U 线上线后 UI 断言可加第三道(reducer 状态 vs message:updated 快照)但非必须 |

## 3. 分期(U 线)

| 期 | 交付 | 门 |
|---|---|---|
| **U0 源头标注 + 双发** | 引擎 delta 源头带 `partIndex/kind/placement/messageId`(recorder 的边界状态机上提为共享件);coalescer 增加"UI 事件小批"输出,**与旧 chunk 流并行双发**(开关 `ONETHING_UI_STREAM=legacy(默认)\|events`);落盘路径回归不变(events.jsonl 字节与 U0 前相同) | 单测:同一 delta 序列,落盘打包与 UI 小批的 part 边界一致;真机:events.jsonl 与 U0 前逐字节同;双发下旧 UI 全绿 |
| **U1 renderer fold + 影子** | `stores/chat-projection.ts`:订阅 UI 事件流,跑 core reducer,产出 `ChatMessage[]`;**dev 模式并行装配**:reducer 结果 vs 旧拼装结果每次 settle 后 canonical 比较,失配记 renderer logger(`renderer.ui-shadow`);默认仍走旧路渲染 | 真机(playwright):N 轮含工具/reasoning/abort/regenerate 会话,ui-shadow 零失配;16ms 节奏不变;重渲染次数 ≤ 旧路(CDP 量) |
| **U2 切换 + 删旧** | 默认 `events`;删 handleStreamChunk 拼装分支/appendOrMerge*/placement 推断/pending 队列/linkSteps;瞬态 part 改装饰;重连走 `?after=eventSeq` | stream-end 稳定性测试、messagelist 测试全绿;web 断线重连脚本(杀 SSE → 重连 → 消息完整);删除行数报告 |
| **U3(可选)** | token 级回放(打字机重现,吃 `dt[]`)、TTFT 读数从流内派生 | — |

排期建议:U0 可先行(纯引擎侧,双发无风险);U1/U2 与 one-core B 期合成一个 renderer 改造窗口(B 换管、U 换词,一次动一遍 renderer);全线在 S2b 之后开工。

## 4. 拍板点

| # | 问题 | 选项(推荐加粗) |
|---|---|---|
| U-a | UI 流词汇 | ①**直接用事件词汇(assistant/chunks 等,与落盘同名同形)**②另设 part-open/delta/close 专用词汇(多一套映射,无收益) |
| U-b | reducer 复用 | ①**renderer 直接 import core 投影 reducer**(已可行,L3 先例)②在 shared 镜像一份(双份漂移,违背本设计初衷) |
| U-c | 时机 | ①**S2b 后、与 B 期同窗**②立即(与 S2b 争 renderer 回归带宽) |

## 5. 不做
- 不改 provider 层;不动 events.jsonl 格式;不动 S 线影子。
- 不做多窗口协同编辑类的双向流——UI 流是单向投影。
- `message:updated` 不删,降级为非流式字段通道 + 重连兜底。
