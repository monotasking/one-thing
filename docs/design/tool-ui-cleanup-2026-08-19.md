# 工具调用 UI 收敛 — 排期(2026-08-19)

背景:`docs/design/chat-message-anatomy.md` 的 work group 重构落地后,对工具调用渲染链做了一次结构调查。
本文记录调查结论与清理排期。**所有批次的可见行为保持逐字节不变**(文案、时长口径、折叠默认态);
唯一的可见变化是 A0 已修的 legacy 双渲染 bug。

## 0. 结构(现状)

```
MessageList → MessageItem → MessageBubble ─┬ ProcessRail(Working/Worked 头,ThoughtHeader 文法)
                                           ├ InlineThought / ContentPartView
                                           └ StepsPanel(flat)
StepsPanel ─ 行头:ToolIcon + LiveToolDuration
           └ 展开:ToolActivityDetails → ToolStepDetails ─ ToolArgsDraft / ToolContentPreview / DiffView
                                                         └ ToolResultRenderer → WebSearchResultRenderer
数据:Step → buildToolActivityView(行头) → buildToolStepView(includeDetails)(展开)
```

## 1. 已做(A0)

- 删 `MessageItem.vue` 的 legacy StepsPanel 挂载点。`chat.ts rebuildContentParts` 加载老消息时已补
  `tool-call` part,MessageBubble 据此渲染;legacy 判定只看"无 data-steps",老消息实际被**双份渲染**。

## 2. 排期(每批一个 opus 代理串行执行,Fable 逐批 review;门=vitest 相关目录 + vue-tsc web + ui:gate + lint)

| 批 | 内容 | 涉及文件 | 风险 |
|---|---|---|---|
| **A 删死码/并层** | ① `FartCallItem.vue`(665 行)整删——`fart` 工具 08-18 已退役,toolkit 中不存在;连带 `StepsPanel` 的 `isFartTimelineItem` 两处分支、`tool-step-view.ts`/`tool-activity-view.ts` 的 `isFart` 字段、相关测试。② `ToolActivityDetails.vue`(75 行透传壳)并入 `StepsPanel` 展开区:StepsPanel 直接算 `buildDetailedToolStepView` 交给 `ToolStepDetails`,「检查」轨迹入口随之搬到 StepsPanel。 | StepsPanel、ToolStepDetails、tool-step-view、tool-activity-view、tests | 零 |
| **B 抽纯函数 + 归一** | ① `MessageBubble.workRender`(:371-447)抽成 `stores/helpers/work-group.ts` 纯函数 `buildWorkRender(entries, stepByToolCallId, getStepsForTurn, hasThinking, role)`,`work-group.test.ts` 直接测纯函数,MessageBubble 只保留 computed 包装。② 时长格式化三份(`tool-activity-view.formatToolDuration` / `MessageBubble.formatWorkDuration` / `useGenerationStatus.formatElapsed`)合成 `utils/format-duration.ts` 一份实现;先把三份现有输出用测试钉死,再替换,输出逐字节相同。③ 折叠状态合成(用户 intent > deferred > auto)从 ProcessRail:132 与 StepsPanel 各自的实现收进 `useDeferredAutoCollapse` 返回已解析态。 | MessageBubble、ProcessRail、StepsPanel、useDeferredAutoCollapse、useGenerationStatus、tool-activity-view、tests | 低 |
| **C 权限状态归一** | `StepsPanel.vue:672-679` 行内 awaiting/queued/Rejected 文案与 `PermissionLedger` 的判定/文案,统一从 `tool-status.ts getToolRenderStatus` + `tool-ui-registry.ts getStatusLabel` 取;两处不再各写字符串。 | StepsPanel、PermissionLedger、tool-status、tool-ui-registry、tests | 低 |
| **D 工具占位归一(渲染层)** | 存储/引擎格式不动(`tool-call` part 仍在 `@shared` 联合里,引擎 `tool-orchestration.ts` 仍用)。渲染层入口加**一个**归一器:加载(`rebuildContentParts`)与流式(`content-parts.ts` 的 `appendToolCallPlaceholder`/`upsertToolCall`)都把工具落到 `message.steps`(缺 step 用 `stepFromToolCall` 合成)+ `data-steps` 占位;`work-group.ts` 删 `tool-call` 分支与 `claimed` 去重。`generation-status.ts:98` 的 `tool-call` case 同步。 | chat.ts、content-parts.ts、work-group.ts、generation-status、tests | 中(先跑 stream-end-stability + work-group + chat-* 全部测试) |
| **E 补测试** | `ContentPartView`、`InlineThought`、`LiveToolDuration`、`DiffView`(组件级,不止 diff-hunks)各一份专属测试;A 并层后 ToolActivityDetails 不再需要。 | `__tests__/` | 零 |

顺序 A → B → C → D → E;A/B/C 互相独立但都碰 StepsPanel,串行避免冲突。

## 2.1 执行记录

- **A** ✅ 净删 767 行:`FartCallItem` 全链(组件/StepsPanel 分支/registry/display/runs/tests)、`ToolActivityDetails` 并入 StepsPanel(WeakMap 复现原 computed 缓存语义)。
- **B** ✅ `stores/helpers/work-group.ts`(`buildWorkRender` / `buildWorkSummary`,13 条纯函数测试);`utils/format-duration.ts` 三口径以 `style` 选项保留(`tool` 100ms 地板一位小数 `2m05.3s` / `work` <1s 空串、<10s 一位小数、`m:ss` / `elapsed` 整秒 `m:ss`),23 边界值×3 钉死;`useDeferredAutoCollapse` 新增 `resolveDeferredExpanded(Keys)`,ProcessRail 与 StepsPanel 共用——两处真实差异(ProcessRail 用户票绝对优先 vs StepsPanel base 已折叠 intent)保留并注释,实际因 toggle 先 `cancel(key)` 不可达。
- **C** ✅ `tool-ui-registry.ts` 唯一状态徽标表 `getToolStatusBadgeText(status, {permissionQueued})`,删无消费者的 `STATUS_LABELS`/`getStatusLabel` 与死字段 `ToolActivityView.statusLabel`;`findRespondableToolCall` 抽一份供 `permission-ledger.ts` 与 `MessageList` 共用;PermissionLedger 复查无重复。
- **D → D-lite**:查明引擎持久化只用 `data-steps` 锚(`core/engine/agent-loop-executor.ts:1230-1255`),`tool-call` part 是渲染层专属活构造;但 `tool_input_start` 事件不带 turnIndex(`ipc-hub.ts:127`),流式期合成 step 无法落轮次——全量 D 需要 store 增加当前轮次追踪,中风险换 ~25 行分支,**本轮只做加载路径**(`rebuildContentParts` 有 steps 时补 `data-steps` 而非 `tool-call`),流式路径与 `work-group.ts` 的 `tool-call` 分支保留。
- **D-lite** ✅ `content-parts.ts rebuildLoadedContentParts` 纯函数(steps 非空 → 按 turnIndex 补 `data-steps`;仅无 steps 有 toolCalls 才留 `tool-call` 兜底),8 条测试含与 `buildWorkRender` 的等价性。真机扫描 `~/.onething/sessions` 4474 条 assistant 消息:976 条走该函数,其中 33 条有 steps 且每条只有 1 个 turn(切分与旧路完全一致),0 条命中 `tool-call` 兜底。
- **E** ✅ ContentPartView(7)/ InlineThought(7)/ LiveToolDuration(7)/ DiffView(8,含行号非 sticky 回归守卫)。
- 门(终态):vitest renderer 338 文件 / 3427 用例,仅 `styles/__tests__/ui-token-vars.test.ts` 2 红为 HEAD 既有;vue-tsc web 干净;ui:gate 81 无新增;lint 所碰文件 0 error。

## 3. 不做 / 待拍板

- 全量 D(流式期 tool-call → steps+data-steps):需先给 `tool_input_start` 事件带 turnIndex(引擎侧)或 store 追踪当前轮次;之后 `work-group.ts` 的 `tool-call` 分支与 `claimed` 去重可删。
- `InlineThought.expanded?: boolean` 是 Boolean prop:调用方**省略**该 prop 时 Vue 强制为 `false`(恒收起),只有显式绑定 `undefined` 才是"非受控";生产路径 `MessageBubble:91` 是显式绑定所以没事,但注释对调用方是陷阱。建议改成 `{ type: Boolean, default: undefined }`。
- `content-parts.ts:41 isTurnTextPart` 未使用(HEAD 既有死代码)。
- 既有丑值,本轮按"不改口径"原样钉住,待拍板:`tool` 时长 `59_999→'60.0s'`、`119_999→'1m60.0s'`(toFixed 进位);StepsPanel 失败徽标为中文 `失败`,其余状态英文。

- toolCalls / steps 双存的存储层根治(引擎侧)不在本轮;D 只是渲染层收成单入口。
- 任何文案/口径变化。
