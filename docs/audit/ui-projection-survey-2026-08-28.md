# §17.7 #9(U1/U2 + B 期)勘察底账

**2026-08-28,opus 勘察,零代码改动、真机只读。** 这份是给细案用的现状底账 ——
不含方案、不含排期、不做裁定。六问逐条,证据全部带 `file:line`。

前情(已落地):U0 双发 + runId 上提(`f16721da`)、渲染锚点自合成 S3w-0
(`8682d980`)+ 按轮就位修复(`3e6de773`)、`synthesizeToolAnchors` 已是 core
`render-anchors` 的一行代理、事件写入单门(`478e7f33`)、账本产地印章(`a53a666f`)。

---

## 一、渲染侧数据管道全图

### 1.1 四站

| 站 | 文件 | 行数 | 职责 |
|---|---|---|---|
| ① 订阅口 | `packages/renderer/platform/types.ts:96-97`(`onSessionEvent` / `onSessionStream`) | — | 桌面走 preload,web 走 SSE(`platform/web.ts:248` 起 5 处 `session:event`) |
| ② 路由 | `packages/renderer/services/ipc-hub.ts`(`initializeIPCHub` at :59) | 634 | **45 条 `case SESSION_EVENT_TYPES.*`**(:74–:308)+ **3 条 chunk case**(:347 `text-delta` / :351 `reasoning-delta` / :355 `tool-input-delta`)。它自己几乎不算派生,只分发给两个 store |
| ③ 拼装 | `packages/renderer/stores/chat.ts` | **3151** | `handleStreamChunk` at :1432;`message:updated` 回填约定 at :3016 |
| ④ 渲染 | `components/chat/MessageList.vue` 3141 + `MessageItem.vue` 1809 | 4950 | 滚动/分组/锚定 |

helpers 层(`stores/helpers/*.ts`,13 件 **2913 行**):
`tool-step-view` 824 / `tool-preview` 380 / `content-parts` 327 / `tool-activity-view` 291 /
`tool-display` 228 / `tool-ui-registry` 184 / `provider-model` 172 / `work-group` 162 /
`generation-status` 109 / `tool-calls` 87 / `expansion-intent` 58 / `steps-panel-runs` 47 /
`tool-status` 44。

### 1.2 「第三份手写推导」完整清单

| # | 派生物 | 落点 | 与 core 同源? |
|---|---|---|---|
| 1 | **part 边界 / 合并** `appendOrMergeText/Reasoning` | `chat.ts` 的 `handleStreamChunk`(:1432 起) | ✗ 手写(按"最后一个 part 的类型 + turnIndex"位置推断) |
| 2 | **reasoning placement** | `chat.ts:1507`:`chunk.placement ?? (message.content ? "inline" : "top")` | ✗ 手写 —— 引擎规则的第二份拷贝(core 侧同一规则在 `projection/reducer.ts` 的 `topReasoningPartIndexes`) |
| 3 | **tool ↔ step 连线** `linkStepsToToolCalls` | `chat.ts` **11 处**:`:624 :988 :1085 :1228 :1266 :1527 :1862 :1904 :1944 :1975`(+ import `:49`) | ✗ 手写 |
| 4 | **tool 渲染状态** | `helpers/tool-status.ts`(`getToolRenderStatus`)+ `tool-step-view.ts`(824 行) | 半同源:`tool-step-view.ts:10` 已 import `@onething/core/engine/streaming-args` |
| 5 | **瞬态 part**(waiting / image-loading / plugin-status) | 插进 `contentParts` 再在 settle 扫掉:`chat.ts:536`(查 waiting)`:1599 :1620`(插/换)`:2557`(收尾清理) | ✗ 手写;core 侧对应的是 `events/ephemeral-policy.ts` 的策略表 |
| 6 | **work group 分界**(Working/Worked ↔ tail) | `helpers/work-group.ts`(纯函数,162 行) | ✗ renderer 独有规则(不在 core 词汇里) |
| 7 | **渲染锚点** `data-steps` | `helpers/content-parts.ts:13` → `@onething/core/session/render-anchors` | ✔ **已同源**(c4-b/S3w-0) |
| 8 | **等待 / 生成读数** | `helpers/generation-status.ts`(`derivePhase` / `estimateTokens`),消费点 `chat.ts:2742` | ✗ 手写(见第五节) |
| 9 | **steps 面板 run 分组** | `helpers/steps-panel-runs.ts` | ✗ 手写 |
| 10 | **滚动跟随 / 锚定 / hold-top** | `MessageList.vue`(`useFollowScroll` :704、`overflow-anchor:none` :724-731、RO 同步 scrollTop :772、regenerate hold :963-988、send hold-top :910-931) | — 纯 UI 关切,不属投影 |

**另记一件**:`composables/useSessionEvents.ts`(194 行)是 phase-4a 的实验件,
文件头自称"Not yet integrated";**全仓零消费者**(grep 除自身外 0 命中)。
它要么是 U1 的种子,要么该删 —— 两条路都得在细案里说一句。

---

## 二、U-a / U-b 的落差

### 2.1 词汇差

- **renderer 今天吃**:`SESSION_EVENT_TYPES` 的 45 型(ipc-hub :74–:308)+ 三条裸
  delta(`text-delta` / `reasoning-delta` / `tool-input-delta`,ipc-hub :347/:351/:355)。
- **core 投影 reducer 吃**:`SessionLogEventRecord` 词表(`core/session/events/types.ts`)
  —— `user/message` `system/message` `message/imported|patched|deleted`
  `user/message-edited` `session/created|cleared|compacted|*-changed`
  `run/start|end` `request/*` `assistant/chunks|part-end|first-token`
  `tool/call|annotate|result|audit` `context/turn-update` `permission/*`
  `skill/activated` `plugin/status`。
- **U0 已经把桥搭了一半**:采集点每盖一次章发一条 `assistant/delta`,coalescer 攒成
  `assistant/chunks`(词汇与 `events.jsonl` 同名同形)。开关
  `ONETHING_UI_STREAM=legacy(默认)|events`,单点在
  `packages/backend/events/ui-stream.ts` —— **legacy 下 UI 事件根本不出生**。
- 已知两处 U0 偏差(原文记在 `ui-event-stream-2026-08.md` §4.1):UI 流**不带
  `placement`**(读侧 reducer 自己复刻规则)、旧三条裸 delta **没有回填**
  `partIndex`/`kind`。

### 2.2 浏览器侧 import 障碍(实测,不是推测)

对每个入口做了传递闭包扫描(解析相对 import,`.js`→`.ts`,含 `index.ts`):

| 入口 | 闭包文件数 | 闭包里带 `node:` 的文件 |
|---|---|---|
| `core/session/render-anchors.ts` | 1 | **无** ✔(renderer 今天已在用) |
| `core/session/events/index.ts` | 6 | **无** ✔(U-a 词汇可直接 import) |
| `core/session/projection/canonical.ts` | 3 | **无** ✔(ui-shadow 的法官可直接 import) |
| `core/session/projection/reducer.ts` | 41 | ✗ `permission/{index,capability-registry,permission-grants}.ts` |
| `core/session/projection/chat-messages.ts` | 48 | ✗ 上面三件 + `agent-loop/tool-names.ts` |
| `core/session/projection/index.ts` | 54 | ✗ 同上 |
| `core/session/index.ts`(**桶**) | 81 | ✗ 同上 + `session/storage/json-message-page.ts` |

三条边,每条都短:

1. `projection/reducer.ts` → `tools/tool-result.ts` → `permission/index.ts`
   (`capability-registry.ts:1-2` `node:os`/`node:path`;`permission-grants.ts:1-2`
   `node:crypto`/`node:path`)
2. `projection/chat-messages.ts` → `engine/context-compact.ts` → `engine/history.ts`
   → `agent-loop/tool-names.ts:1` `node:crypto`
3. 桶 `session/index.ts:47-48` 之外还导出 `storage/index.js`,而
   `storage/index.ts:45` 再导出 `json-message-page.js`,那一件 `:1` 是 `node:fs`

**仓内已有同款判例与走法**:`platform/plugins-client.ts:27-30` 明文写着"叶子路径,
不走桶:`@onething/core/plugins` 的 index 会把 loader(`node:url`…)拖进来";
`helpers/content-parts.ts:13` 就是按叶子路径 import 的。所以 U-b 不是"能不能",
是"要不要顺手把这三条边掐断"(把 `tool-result` 对 permission 的依赖、
`history` 对 `tool-names` 的依赖各降一层)—— 细案要拍的就是这个。

`tsconfig.web.json` 已有 core 路径(`services/log.ts:34` 直接 import
`@onething/core/logging`),包边界层面没有额外障碍。

---

## 三、ui-shadow 门的可比面

- **法官**:`core/session/projection/canonical.ts` 的 `canonicalChatMessage` ——
  3 文件闭包、零 node import,renderer 可直接 import。它是全线唯一那把尺(纪律 10)。
- **可比什么**:canonical 之后的 `ChatMessage[]`。`contentParts` 的**顺序**是正文、
  **不丢**(`canonical.ts:43`);数组在 `:234-240` 重建时丢掉策略表登记的短命 part。
- **已知豁免怎么处理**(两条,必须在门里说清):
  1. **`data-steps` 渲染锚点**(G4)—— canonical 明文丢弃。而 renderer 那边锚点是
     **合成出来的**(`content-parts.ts:13` 的 `synthesizeCoreToolAnchors`)。所以
     ui-shadow 要么比**合成之前**的那一份,要么两侧都过同一个 core 函数;比错层
     会得到一条恒红。
  2. **已结算 `plugin-status`** —— §17.7.2 四-2 刚查明它**写侧没有采集点**
     (全仓零生产者),`content-part-guard.ts` 对它判红是**公开缺口**而非豁免。
     renderer 折叠折不出它,旧路却有它 ⇒ **ui-shadow 会稳定报这一格**。细案必须
     先决定:门里具名排除,还是等 #10 拍板补产地。
- **在哪比**:U1 原设计是"每次 settle 之后 canonical 比较,失配记
  `renderer.ui-shadow`"。renderer 已有 logger hub(`services/log.ts`),
  `getLogger('renderer.ui-shadow')` 零新增设施。

---

## 四、消息列表虚拟化现状

- `MessageList.vue` **3141 行**,消息是 plain `v-for`(`:49`),两处注释明写"never
  virtualized"(`:452` / `:866`);CLAUDE.md 也写死"The message list is NOT virtualized"。
- 仓内唯一虚拟化件 `components/common/virtual-table/useVirtualAxis.ts`,**只服务表格**。
- 虚拟化要动的面(逐条给现场):

| 面 | 现场 | 风险 |
|---|---|---|
| 跟底(tail-following) | `useFollowScroll` `:704`,`isFollowing` `:711`,RO 回调里同步写 `scrollTop`(`:772`,"一帧都不漏") | 行高未知 ⇒ 估高 + 观测,跟底判据要重写 |
| 浏览器原生锚定 | `.message-list-row { overflow-anchor: none }`(`:724-731`,注释:coordinator 与原生锚定"历史上打过架") | 虚拟化会重新引入高度跳变 |
| 发送 hold-top | `:910-931`(新问题按住顶部,一次连续滚动而不是硬跳) | 依赖真实 DOM 高度 |
| regenerate hold | `:963-988`(hold **先于**截断量,注释记着浏览器自己 re-adjust `scrollTop` 的实测) | 同上 |
| 跳转 / 导航 | `scrollToMessage`(`:317-321`)、导航不许瞄一个已卸载的行(`:496`)、`@jump-to-message`(`:83`) | 目标行可能不在窗口内 ⇒ 必须先滚到再高亮 |
| 按 index 的旁挂 | `goalSummariesByIndex`(`:97`)、`selectionToolbarAnchor`(`:131`) | index 语义在虚拟化后要换成 id |
| work-group 展开 | `helpers/work-group.ts` + 已知判例:展开卡顿根因是"逐消息全树 `querySelector`",已换 Map 缓存(记忆:工作组重分组簇) | 展开会改变行高 ⇒ 与估高互相作用 |

已知判例三条(细案必须引用,别重犯):messagelist 整改簇的"可见性门"、
"拖滚动条不脱跟底"的真 bug 修复、work-group 展开卡顿的 Map 缓存。

---

## 五、等待指示现状

- **数据源是消息自己的状态,不是流**:`helpers/generation-status.ts` 的
  `derivePhase(message)` 读 `message.contentParts / steps / toolCalls`,产出
  `waiting | thinking | responding | tool | approval`(文件头:"read off its own state")。
  消费点 `chat.ts:2742`:`const derived = message ? derivePhase(message) : { phase: "waiting" }`。
- `waiting` 这一格**同时是 contentParts 里的一个 part**:`chat.ts:536` 查它、
  `:1599 :1620` 插/换、`:2557` 收尾清理("continuation 早发的 waiting 落在一条随后
  被 finalize 的回合消息上"那个坑的注释就在这里)。
- token 读数:`estimateTokens`(按字符估:CJK≈1/字,其余≈4 字符/token),每次
  `stream:usage` 的回合边界把它**snap 成真数**(`GenerationStatus.outputTokensExact`)。
- **用户报过的两件事都落在这条链上**:"waiting 没了"(瞬态 part 被扫早了/落错消息)
  与"20 倍延迟"错觉(§15.15 已定性为 grok reasoning 爆发 + refold 顿,SSE 实测
  19ms/delta 零漂移)。
- U 线换管之后它的数据源**应当是折叠状态**(设计 §2 已写:"由 reducer 状态派生:
  如 run 活跃且无未闭合 part → waiting"),瞬态 part 从 `contentParts` 移出、变渲染
  装饰。细案要点名:`estimateTokens` 是**读数不是账**,换管之后仍需要一个 snap 源。

---

## 六、规模底数与碰撞面

**要动的面**(行数量级):

| 区 | 行数 |
|---|---|
| `stores/chat.ts` | 3151 |
| `stores/helpers/*.ts`(13 件) | 2913 |
| `services/ipc-hub.ts` | 634 |
| `components/chat/MessageList.vue` | 3141 |
| `components/chat/MessageItem.vue` | 1809 |
| `composables/useSessionEvents.ts`(零消费者) | 194 |
| **合计核心面** | **≈ 11.8k** |

**既有测试覆盖**:`stores/__tests__` + `components/chat/__tests__` 合计 **104 个测试
文件**(其中 chat 组件 55 个)。与 U 线直接相关的:`chat.test.ts`、
`chat-stream-finalize.test.ts`、`chat-reasoning.test.ts`、`content-parts.test.ts`、
`rebuild-content-parts.test.ts`、`plugin-status-parts.test.ts`、`ProcessRail.test.ts`、
`MessageList.*.test.ts`(room / say / typography)。

**与其他会话在途改动的碰撞面**(`git status`,2026-08-28):
`App.vue`、`composables/useShellLayout.ts`(+测试)、`stores/layoutPrefs.ts`(+测试)、
`components/editor/EditorWorkbench.vue`、`components/terminal/TerminalView.vue`、
新件 `composables/useShellResizeFreeze.ts`(+测试)、`components/terminal/__tests__/`。

**结论:零重叠** —— 那一批全在**外壳布局 / 终端 / 编辑器**,U 线要动的是
**聊天数据链 + 消息列表**。唯一要注意的是
`components/__tests__/App.container-layout.test.ts` 当前因那批改动而红(已实证与
本线无关),U 线开工时别把它当成自己的回归。
