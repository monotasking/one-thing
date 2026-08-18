# Composer 手势、生成读数与消息列表连续性（2026-08-17）

六项一起落地，按实施顺序 F → A → C → E → D → B。每项都先在真 Chromium（apps/web
泳道 + scratch store）里量到病根再改，量法与数字记在各节。

## F. 引擎忙时闸门（一个会话同一时刻只有一条流）

- 病根：`core-stream-engine.handleSendMessage` 从不看 `activeStreams`；第二条
  `command:send-message` 走到 `registerController` 把第一条流掐掉（"Superseded"）
  再起一条 —— 同一轮对话里冒出多条半截回复。"生成中不能直发"这条规则以前只活在
  InputBox 组件（本地队列）里，草稿纸窗（`TodoPlanPanel.sendScratchpadPending`）、
  草稿纸「仅回复中」自动推送、deeplink、`chatStore.sendMessage` 全绕得过去。
- 修：`core/engine/core-stream-engine.ts` `handleSendMessage` 入口：`activeStreams`
  有该会话 → 纯文本降级为 `steerMessage`（进 steering 队列、`steering:queued`
  照发、可撤回）；带附件 → `stream:error`（steering / follow-up 都只带文本，
  不悄悄丢文件）；`persistOnly`（房间 ingress、插件 handled）不受闸门管。
- 测试：`core/engine/__tests__/send-message-busy-gate.test.ts`。

## A. Esc / Ctrl+C 语义

| 输入框状态 | Esc 第 1 下 | Esc 第 2 下（2s 内） |
|---|---|---|
| 有内容 | 提示 "esc again to clear" | 清空草稿 |
| 空 + 本会话有可撤回 steer | 撤回，原文回框（`steeredDrafts` 按发出内容匹配找回未展开原文） | — |
| 空 + 生成中 | 提示 "esc again to stop" | 打断 |

生成中发纯文本 = 直接 steer（`Steering · esc to take it back`）；带附件仍进本地队列。
Ctrl+C（无选区）清空草稿文本；Cmd+C / 有选区不动。**手势提示只走占位符**（`placeholderHint`）；
有草稿时占位符不可见，清空手势的 arm 态**不另画**任何角标（2026-08-17 拍板：帧右角不放
手势提示，"esc esc stop" 也撤了）。命令 / 工具 / 语音的结果提示改走全局 `useToast`
（`ToastHost`，与系统其余通知同一个组件），InputBox 自带的 `command-feedback` 小条与
`useCommandFeedback` 删除。测试：`InputBox.messenger.test.ts` "composer gestures"。

## C. Thinking 流式抖动

- 病根 1：`StreamingHtmlSegment` 把正在写的段落逐字包成 `.stream-word` 且
  `display: inline-block`；每到 `\n\n`（`parseStreamingMarkdown.ts:110`）稳定前缀被
  切成 `complete: true` 段并**拆掉 span** 重渲染。inline-block 给 `Foo.vue`、`a/b`、
  URL 之类文本多出断行机会，包/拆两种排版**行数不同**。playwright 起真 Chromium
  跑 105 组（5 段中英混排 × 7 宽度 × 3 长度）：**10/105 行数不同**；改 `display:
  inline` 后 **0/105**。
- 病根 2：`p:last-child { margin-bottom: 0 }` 按每个 `display: contents` 的
  `.md-segment` 算，稳定段/尾段的末段都是 0 边距，新段一开始上一段多出一个段距。
  三处（`styles/markdown.css`、`MessageBubble .content`、`ThoughtHeader .thought-body`）
  加 `.md-segment:not(:last-of-type) > p:last-child` 恢复段距。
- 病根 3（结尾一缩）：思考面板 `auto-expanded = isStreaming` 在**流结束**折叠，
  把整段回答往上拽一截。最终拍板（2026-08-17）：**取消全部自动态** —— 思考中不自动
  展开、结束后不自动折叠，只认用户点击；流式中的 reasoning 在**折叠行里**流过
  （`ThoughtHeader detail-tail`：RTL 盒 + `<bdi>`，左侧省略、最新文字贴右）。
  `.thought-body` 去边框。测试：`MessageThinking.test.ts`。

## E. regenerate 锚定

- 量到：对一条 444px 高的中段回复 regenerate，引擎 `deleteMessageAndTruncate` →
  `messages:replaced` 把目标及其后全部删掉，scrollHeight 1090→654，scrollTop 被
  钳到 0，用户的问题从 y=598 跳到 315；随后内容比视口短、`isFollowing` 几何判定翻
  true，新回复流式时把问题一路顶出视口。渲染层没有对 regenerate 做任何锚定。
- 修：`MessageList` **hold-top** 机制（见 D），`ChatPanel.handleRegenerate` 在命令
  发出前调 `holdForRegenerate(messageId)`：读者视口顶行在目标之上 → 原地锚住；否则
  把目标所属的问题钉到视口顶。真机：截断帧 scrollTop 7→7 不变，问题行 y=60 全程
  不动，spacer 随回答生长递减。

## D. 发送丝滑（D1：问题钉在视口上 1/3，回答往下长）

> 2026-08-17 追加拍板：钉到视口**顶**读起来像翻页（刚看完的上一条回答一下子没了），
> 改为钉在视口上 **1/3**（`SEND_HOLD_VIEWPORT_FRACTION`），上一条回答的尾巴还留在视野里；
> 尾部 spacer 的滚动上限同步按这个位置钳。

- 量到（25fps 录像 + 逐帧采样）：回车一帧内三件不连续的事同时发生 ——
  `setTail()` 硬跳 228px、composer 4 行→1 行塌回（视口 +66 → 浏览器钳 scrollTop
  −66）、新气泡 fadeIn translateY。`ChatPanel` 曾注释"不要 smooth，会先滑再跳"：
  平滑滚动被 tail 模式的瞬时 `pinTail()` 掐断。
- 修（`MessageList.vue`）：
  - **hold-top**：`holdMessageAtTop(id, offset, {behavior})` = `follow.isFollowing=false`
    + 尾部 `.message-list-tail-spacer`（`需要 = 行顶 + offset + 视口高 − 真实内容高`，
    用 `.message-list-content.offsetHeight` 量，不用会被 clientHeight 钳住的
    scrollHeight）+ `scrollCoordinator.setAnchor(..., 10min, {behavior:'smooth'})`。
    spacer 在每次 nudge 与 ResizeObserver 里重算，回答长进去时总高不变；`needed ≤ 0`
    且 hold 已 `armed`（spacer 曾 > 0）→ 原地交给 tail 跟随；用户滚动清掉 anchor →
    hold 结束、spacer 冻结。
  - `useMessageScrollCoordinator`：`setAnchor` 接 `writeOptions`；`restoreAnchorNow`
    在动画进行中 **retarget** 而不是瞬时写掐断；`animateScrollTop` 同目标不重启、
    从上一次自写值续跑、`progress` 钳 ≥0（rAF 时间戳可早于 `startedAt`，ease-out
    会为负 → 第一帧倒退）。
  - `prepareForSend()`（ChatPanel 发送前调）+ `absorbComposerCollapseForSend()`
    （composer RO 同帧、paint 前）：视口长高多少，spacer 先补多少并写回原 scrollTop，
    塌回那一帧不动。
  - hold 期间 `.scrollbar-viewport { overflow-anchor: none }`（量到浏览器自己的
    scroll anchoring 会在新行落地那帧补 +66）。
  - `.message` fadeIn 只留 opacity；「Load earlier messages」按钮不再因 `totalCount`
    滞后一拍消失（那是每次发送前 42px 的上移）。
- 真机：发送 scrollTop 0→517 单调、~250ms 缓出，无跳变。

## B. 生成状态读数搬进 InputBox

- store（`stores/chat.ts` + `stores/helpers/generation-status.ts`）：非响应式
  `generationStats`（startedAt / 收到字符 / 估算 token / 精确 token）；`derivePhase`
  从活动消息派生 waiting / thinking / responding / tool / approval（复用
  `getToolRenderStatus`）；`getGenerationStatus(sid)` 出快照。估算：CJK 1 字≈1 tok，
  其余 4 字符≈1 tok，带 `≈`。
- **B-4**：`stream:usage` 会话事件（`shared/events/session-events.ts`），在
  `agent-loop-executor.syncLastTurnUsage` 每个 turn 结束发（本 turn + 累计），
  渲染层把估算钉到真实值（`≈` 消失）。
- UI：`useGenerationStatus`（唯一一口 100ms 钟）→ InputBox 顶沿帧标签
  `WAITING 1.2s` / `THINKING 4.8s · ≈420 tok` / `RUNNING bash 3.0s` / `APPROVAL …`，
  帧右角不放手势角标。消息侧：`MessageThinking` 删 Waiting 行、
  Thinking 头不再显示秒数（完成后 "Thought · 用时" 保留，`thinkingTime` 仍写回）；
  `MessageBubble` rail 的 `generation-waiting` 零渲染。

## 验证脚本

playwright 逐帧采样脚本（scrollTop / scrollHeight / spacer / 帧标签）与 105 组
断行对照脚本在本次会话 scratchpad，未入库；复现方法：起一个 `ONETHING_STORE_PATH`
指向临时目录（复制 settings.json）的 `dist/server/main.js` + `vite --port 5175`，
`chromium.launch()` 里 rAF 采样。

## G. 追加（2026-08-18）：发送时主进程卡顿

dev.log 逐时间戳量到，大会话（268 条消息、5MB 历史载荷）一次发送的主进程时间线：
`command:send-message` 32.256 → `message:user-created` 32.296 → `buildHistoryMessages`
×2（各印 ~800–1600 行 util.inspect：`rows` 与 `retainedMessages` 逐条清单）→
`stream:start` 32.757。**约 0.5s 主线程被 console.log 吃掉**，渲染进程的 IPC 在这段
时间全部排队，composer 感觉"卡"；API 秒回错误（当时是 deepseek 402 Insufficient
Balance）时整段交互只剩这一下停顿，最显眼。修：`app/engine/stream/chat-logger.ts`
`logMessageBodyShape` 默认只印汇总（行数 / 角色计数 / 总量），逐条清单改为
`ONETHING_DEBUG_HISTORY_SHAPE=1` 才印。
