# 外壳布局收敛方案（2026-08-18）

> 范围：主窗三/四栏布局的**尺寸模型、降级顺序、持久化、组件归属**。
> 不改视觉风格、不改各栏内部内容；辅助窗口（设置/搜索/todo）不在范围内。
> 现状读码见本文 §1，问题清单见 §2，分期见 §3。

## 1. 现状

```
Splitter.app-shell
├─ SplitterPanel(px, 200–500)  Sidebar            ← 停靠态实例
└─ SplitterPanel(flex)          .app-content
   └─ Splitter.app-content-splitter
      ├─ SplitterPanel(%, min 52)     Container ─ PanelTree(ChatWindow×n) + ChatSidePanel(268px 定宽)
      └─ SplitterPanel(%, 22–48, ≥250px, collapsed)   RightWorkbenchPanel
+ .app-floating-sidebar-host   Sidebar            ← 浮层态第二实例（sidebarCollapsed 时 hover 左缘）
```

相关文件：

| 责任 | 文件 |
| --- | --- |
| 外壳三栏 + 尺寸/持久化/浮层 timer | `packages/renderer/App.vue`（1786 行） |
| 聊天区 + ChatSidePanel 开合 | `packages/renderer/components/ChatContainer.vue` |
| 大纲/System prompt/Todo/Variables 四段 | `packages/renderer/components/chat/ChatSidePanel.vue`（818 行） |
| 右栏 tab 双域（会话域 / 工作区域） | `packages/renderer/components/workbench/RightWorkbenchPanel.vue`（2030 行） |
| 分栏原语 | `packages/renderer/components/common/{Splitter,SplitterPanel}.vue` |
| 聊天面阅读列宽 | `packages/renderer/components/chat/ChatPanel.vue`（`--chat-measure-cap`）、`composer-width.ts` |

## 2. 问题清单

| # | 问题 | 证据 |
| --- | --- | --- |
| P1 | 四列各自 clamp，无总预算，无降级顺序 | 侧栏 200–500px、聊天 min 52%、大纲栏定宽 268、右栏 ≥250px 分别定义在 App.vue / ChatContainer.vue |
| P2 | `CHAT_SIDE_PANEL_MIN_WINDOW_WIDTH=1100` 是死阈值 | `sidePanelVisible = !room && (available \|\| !collapsed)`：未手动折叠时窄窗仍占 268px |
| P3 | 侧栏 px、右栏 % 两套尺寸模型 | 右栏因此需要 `contentSplitterWidth` ResizeObserver、读时重 clamp、`workbenchSlideStyle` 冻结宽 |
| P4 | 大纲栏与右栏职责重叠 | 房间面已把大纲并入右栏（ChatContainer.vue:180 注），聊天面仍留独立第四列 |
| P5 | Sidebar 双实例 | 停靠 + 浮层各一个 `<Sidebar>`，4 个 timer + cooldown 协调开合；`.sidebar-floating-backdrop` 是注释死码 |
| P6 | 布局偏好裸写 localStorage，5 个 key 散在两个文件 | `sidebarWidth` `sidebarCollapsed` `inspectorPanelSize` `INSPECTOR_OPEN_STORAGE_KEY` `chatSidePanelCollapsed` |
| P7 | 响应式基准用窗口宽 | `ChatPanel.vue:933` `Sidebar.vue:2689` 的 `@media (max-width:768px)`；聊天列真实宽度取决于左右栏 |
| P8 | App.vue 承担外壳 + 事件路由 + 空间切换 + 插件层 | 单文件 1786 行 |

## 3. 分期总览

| 期 | 名称 | 解决 | 产出 | 依赖 |
| --- | --- | --- | --- | --- |
| L0 | 布局偏好 store | P6 | `stores/layoutPrefs.ts`（一处读写 + 迁移旧 key） | — |
| L1 | 右栏 px 化 | P3 | 右栏 `size-unit="px"`，删换算/冻结 hack | L0 |
| L2 | 布局协调器 | P1 P2 | `composables/useShellLayout.ts`：预算 + 降级顺序 | L0 L1 |
| L3 | 大纲栏并入右栏 | P4 | ChatSidePanel 四段 → 右栏会话域 tab；第四列退役 | L2 |
| L4 | Sidebar 单实例 | P5 | 一个 `<Sidebar>` 切 docked/floating 模式 | L0 |
| L5 | 容器查询 + AppShell 抽离 | P7 P8 | `components/shell/AppShell.vue`；`@container` 替换 `@media` | L2 |

L0→L1→L2 一批提交（尺寸模型统一）；L3 单独一批（动右栏 tab 域）；L4/L5 各自独立，可并行。

**进度（2026-08-18）**：L0–L5 已全部落地未提交。落地时的偏离与补充：
- ~~`ShellLayout` 多一枚输出 `chatSideFits`~~ —— L3 随大纲栏一并删除：它只为顶栏那颗开合钮活着，而那颗钮现在的语义是"去右栏开 Contents 页签"。
- 右栏拖拽用本地 `workbenchPanelWidth` 活值，`resize-end` 才写 store（SplitterPanel 每次 emit 都会按 `size` prop 重 clamp，直连 store 会拖不动）；`--workbench-width` 也因此是每次提交写一次。
- 中栏 `flex` 面板也加了 `size-unit="px"`，否则 `:min="480"` 会被当成 480%。
- 常量：`MAX_WORKBENCH_WIDTH=600`、`DEFAULT_WORKBENCH_WIDTH=360`。
- `workbenchSlideAnimating` 定时器删除后，`layout-transitioning` 门在右栏 200ms 滑动期间不再置位（现为 `sidebarActionAnimating || inspectorResizing`）；MessageList 那 200ms 不再延迟测量。要恢复需 `transitionend` + 无过渡兜底 timer —— **待拍板**。

L3 的偏离与补充：
- 段落组件（`SystemPromptPanel` / `TodoProgressPanel` / `VariablesPanel`）随本期从 `components/chat/` 搬进 `components/workbench/` —— 它们只服务这一个宿主；`SessionSegmentList` 留在 `components/common/`（侧栏预览卡也在用）。
- 大纲轨宿主的新链路是**一枚模块级 ref**（`composables/useOutlineRail.ts`）：右栏 Contents 页签登记宿主，`ChatWindow` 按 `panelFocused` 决定这一格取不取得到它。判定留在聊天面 —— "哪一格聚焦"只有 `PanelTree` 那一层知道；宿主这侧只回答"右栏此刻有没有一块地方接它"。`ChatPanel` → `MessageList` 那两跳 prop 原样保留（那是一格面板内部的组装，不是跨子树透传）。
- 房面本来就**没有**同类大纲页签（房的固定组只有 线程/成员/看板/调度），所以"归并"落地为"新增的 `outline` 一条同时服务两种形态"，不存在两份要合。
- 顶栏那颗钮的语义从"开合第四列"收窄成"带我去 Contents 页签"：panel-event `toggleSidePanel` 改名 `openOutline`，`sidePanelAvailable` / `sidePanelCollapsed` 两枚 prop 连同 `layoutPrefs.chatSideCollapsed` 一起删除（旧 localStorage key 仍在迁移路径上被清理一次）。
- Todo 段只读：进度照画，段头多一个"去任务面板"的入口（走既有的 `workspacePanelWindowEvent('tasks')`），编辑仍归 Todo 窗 /「任务」页签。

L4 的偏离与补充：
- 单实例的落地形态是**左栏 SplitterPanel 常驻 DOM + `:collapsed`**，而不是 `v-if`。
  浮层态由 `.sidebar.floating` 的 `position: fixed` 画出去；链路上没有任何祖先带
  `transform` / `contain`（唯一那处 `contain: strict` 在被删的 `.sidebar-floating-backdrop`
  上），所以浮层的包含块仍是视口，`.splitter-panel` 的 `overflow: hidden` 裁不到它。
- 因此左栏的接缝线必须改写成 `:not(.is-collapsed)`（与右栏同款）—— 常驻 DOM 的
  0 宽面板加一条 `border-right`，就是窗口左缘上一条 1px 的竖线。
- `Splitter.vue` 补一条 `.splitter-resizer.is-disabled { pointer-events: none }`：
  面板常驻之后左缘多出一条 12px 的**停用**分隔条，正压在浮层侧栏的 hover 触发区上。
  停用的控件本就不该吃指针；这条对右栏收起时那条分隔条同样是修复。
- `useFloatingSidebar` 收的是**四个 timer + 冷却**，连 `sidebarActionAnimating` 一起
  （它与 toggle 冷却是同一个 340ms 窗口，拆开就得在两处各留一个 timer）。清场走
  `onScopeDispose`，App.vue 的 `onUnmounted` 里那四段 `clearTimeout` 删掉。
- `wallpaper.css` 的 `html.has-wallpaper .app-floating-sidebar-host` 一并删除：那棵
  壳外的兄弟树没了，浮层侧栏现在天然落在 `.app-shell` 那一条里。
- 验收：`components/__tests__/sidebar-single-instance.test.ts` —— `:collapsed` 来回翻
  时槽里的实例不重挂（`onUnmounted` spy + 内部 ref 存活），外加 App.vue 只剩一个
  `<Sidebar>` 的源级断言；`composables/__tests__/useFloatingSidebar.test.ts` 用假时钟
  钉住四段时序与"冷却窗内 hover 不勾浮层"。

L5 的偏离与补充：
- AppShell 多一个插槽 `content-overlays`（语音那两块窗内浮层）。它们 `position: fixed`，
  搬到 `.app-content` 外面在几何上没差别，但会掉出 `wallpaper.css` 以 `.app-content`
  为根的 C 级作用域 —— 留一个插槽比改壁纸分级表便宜。
- AppShell `defineExpose` 两个元素（`shellElement` / `contentElement`）：协调器那唯一
  一处量外壳宽的 ResizeObserver 与搜索窗锚点都还在 App.vue 手里，AppShell 不量宽度。
  App.vue 的 `contentSplitterRef` 随之删除 —— 首次展开右栏前那次强制 layout flush 改
  读 `.app-content` 的 `offsetWidth`（任何一次 layout 读都同样 flush）。
- `--workbench-width` 的计算（减 1px border-left）跟着 `.app-content` 进了 AppShell，
  由新 prop `workbenchSlideWidth` 灌入；拖拽活值仍是另一枚 `workbenchPanelWidth`。
- **容器查询的容器不能是 `.chat-panel` 自己**：`container-type` 只为**后代**建容器，
  而 `.chat-panel` 正是那两条规则的主语。所以容器落在宿主上并**具名** `chat-surface`：
  直聊是 `ChatWindow.vue` 的 `.tab-content`（与 `.chat-panel` 之间无 padding/border，
  两者同宽，断点逐像素等价），右栏线程是 `ThreadChatDetail.vue` 的 `.thread-chat-detail`
  （`.thread-chat-panel` 与 `.chat-panel` 是同一个元素，同样查不了自己）。具名而非匿名：
  匿名查询会落到"最近的祖先容器"上，谁在中间加一个都会把它偷走。顺带修好一件事：
  右栏那份聊天面宽 250–310px，旧的 `@media` 查窗口宽，它从来没进过 768 那一档。
- `.chat-panel` 内确认**没有**跨容器的 CSS counter：唯一那条 `tool-fig` 的 reset 与
  increment 都在 `.process-rail` 内部，而 `.process-rail` 本来就带 `container-type`
  （StepsPanel 的注释记着这件事）。因此外层新增容器不会把它切开；仍用 `inline-size`
  而不是 `size`。
- **`Sidebar.vue` 末尾那条 `@media (max-width: 768px)` 判删，不判容器化**。三条理由
  写在它原来的位置：(1) 它是第二条窄窗降级路，而唯一事实在 L2 的预算里
  （`sidebarFloatingByBudget` + `.sidebar.floating`）；(2) 它今天就是 bug —— 窗宽 768 +
  侧栏 200 时聊天列还有 568px，协调器判定继续停靠，而这条规则会把停靠态抽成 fixed，
  聊天区当场被压在侧栏底下；(3) 没有诚实的容器可承担 —— 主语是 `.sidebar` 自己
  （查不了自己），父级左栏 region 恒 ≤500px（查询永远为真），而把 `.app-shell` 变成
  容器要给它加 containment，会连带改掉壳内所有 `position: fixed` 浮层的包含块与层叠
  上下文。
- `docs/audit/ui-baseline-2026-08-13.txt` 里 App.vue 的 4 条 `surface-literal` 有 2 条
  随 `.app-shell` / `.app-content` 搬进 `components/shell/AppShell.vue`，基线按（文件，
  规则）口径改了这两行的文件名。总数仍是 81，**没有新增红，也没有治愈** —— 这是同一
  笔存量债换了个住址。
- 验收：`components/shell/__tests__/AppShell.test.ts` 挂载三栏做结构断言（插槽落位、
  收起态 `is-collapsed`、右栏挂载/折叠两段、冻结宽、两条独立的拖拽事件线、两个 expose
  的元素）；`App.container-layout.test.ts` 的断言按新归属拆成 App / AppShell 两份后
  保持通过。

每期验收门都是**代理可自证**（vitest 纯函数 + 真机 CDP 量宽），不排人肉走查。

---

## L0 布局偏好 store

**新文件** `packages/renderer/stores/layoutPrefs.ts`（Pinia）

```ts
interface LayoutPrefs {
  sidebarWidth: number          // px
  sidebarCollapsed: boolean
  workbenchWidth: number        // px（L1 前先存 %→px 换算结果）
  workbenchOpen: boolean
  chatSideCollapsed: boolean    // L3 后删除
}
```

- 单一 `localStorage` key `onething.layout.v1`（JSON）；首次读时迁移旧 5 个 key 并删除旧 key。
- clamp 只在 store 里做一次（`clampSidebarWidth` / `clampWorkbenchWidth` 从 App.vue 迁入）。
- App.vue / ChatContainer.vue 全部改读 store；`resolveInspectorDefaultOpen` 的默认值逻辑保留，只是落点改成 store。

验收：`stores/__tests__/layoutPrefs.test.ts` —— 旧 key 迁移、clamp、损坏 JSON 回默认。

## L1 右栏 px 化

- `App.vue` 右栏 `SplitterPanel` 改 `size-unit="px"`，`:min="250"`，`:max` 由 L2 协调器给（L1 阶段先 `min(600, contentWidth*0.48)`）。
- 删除：`contentSplitterWidth` ResizeObserver、`inspectorMinPanelSize` 百分比换算、`inspectorPanelSize` 读时重 clamp、`workbenchSlideStyle` 与 `workbenchSlideAnimating` 定时器。折叠动画改由 SplitterPanel `collapsed` + CSS `width` transition 承担，内容宽度用 `.workbench-slide { width: var(--workbench-width) }` 固定（变量由 store 写在 `.app-content` 上，一次而非每帧——沿用 08-18 拖拽三修的结论）。
- 需要确认 `Splitter.vue` px 模式对 `collapsed` 的支持与侧栏一致（侧栏已在 px 模式下工作，仅缺 collapsed 用例）；缺则补，不写第二套。

验收：CDP 拖右栏分隔条 → 记 `getBoundingClientRect().width`，与 store 值差 ≤1px；折叠/展开前后宽度不变。

## L2 布局协调器

**新文件** `packages/renderer/composables/useShellLayout.ts`

输入：窗口内容宽 `W`（`.app-shell` ResizeObserver，唯一一处）、store 偏好、`surface`（chat / room）。
输出：每列的**实际**宽度与可见性，纯函数 `resolveShellLayout(input): ShellLayout` 可测。

```
预算：W = sidebar + chat + chatSide(L3 前) + workbench
硬下限：chat ≥ 480px（阅读列 46rem 的下界 + 两侧留白）
降级顺序（从右往左收，用户偏好只在预算允许时兑现）：
  1. chatSide 折叠            （W 不足以同时放 chat≥480 + chatSide 268）
  2. workbench 收窄到 250     （再不够）
  3. workbench 折叠            （仍不够；store.workbenchOpen 保持 true，恢复窗宽自动回弹）
  4. sidebar 从停靠转浮层      （仍不够；同理不改 store.sidebarCollapsed）
```

- App.vue 里侧栏 `:max`、右栏 `:max`、`inspectorVisible`、ChatContainer 里 `sidePanelVisible` 全部改读协调器输出；`CHAT_SIDE_PANEL_MIN_WINDOW_WIDTH` 删除。
- 「用户折叠」与「预算折叠」分开记：前者写 store，后者只在协调器输出里；恢复窗宽时预算折叠自动撤销。

验收：`composables/__tests__/useShellLayout.test.ts` 覆盖 W ∈ {700, 900, 1100, 1400, 1800} × 各栏偏好组合的降级表；CDP 用 `window.resizeTo` 逐档量真机。

## L3 大纲栏并入右栏

- ChatSidePanel 的四段（Contents / System prompt / Todo / Variables）拆成右栏会话域的两个 tab：
  - `outline`（Contents：Topics/Message 双模式，含 `outlineTarget` 联动）
  - `context`（System prompt + Todo + Variables，三段可折叠）
  Todo 段若已与 Todo 窗重复（08-16 草稿纸并入 Todo 窗），此处只留入口不留编辑。
- 右栏 `tabOptions` 增两项，`categorySlot` 排在 files 前；房间面已有的 outline 归并到同一 tab 类型，不再两份。
- `ChatContainer.vue` 去掉 `Container` 的 `sidebar` 插槽、`chatSidePanelWidth`、ResizeObserver；`ChatSidePanel.vue` 退役（内容组件迁到 `components/workbench/`）。
- 触发路径：原大纲栏折叠按钮 → `openWorkbenchTab('outline')`。
- store 删 `chatSideCollapsed`；协调器降级表删第 1 步。

验收：右栏 outline tab 的 `jump-to-message` 走既有 `handleWorkbenchJumpToSource`；existing ChatSidePanel 测试迁移到新 tab 组件。

## L4 Sidebar 单实例

- 只保留 `SplitterPanel` 内那一个 `<Sidebar>`；浮层态改为该实例加 `.is-floating` 后 `position:fixed; left:0` 覆盖（宽度仍 `sidebarWidth`），`SplitterPanel` 在浮层态 `collapsed`。
- 4 个 timer + cooldown 收进 `composables/useFloatingSidebar.ts`（hover 进出、关闭延迟、防抖），App.vue 只拿 `floating` 布尔。
- 删注释死码 `.sidebar-floating-backdrop`。
- 交通灯 overhang 变量逻辑不变（仍由停靠宽度算）。

验收：Sidebar 内部 state（滚动位置、展开的分组）在浮层⇄停靠切换后保持（此前双实例做不到，是可观察的收益）。

落地记录见上方「L4 的偏离与补充」。

## L5 容器查询 + AppShell 抽离

- **新文件** `packages/renderer/components/shell/AppShell.vue`：只含 §1 那棵三栏树 + Splitter 事件；props = 协调器输出；slots = `sidebar` / `main` / `workbench`。App.vue 保留窗口模式分发、插件层、事件路由。
- `.chat-panel` 加 `container-type: inline-size`，`ChatPanel.vue:933/939` 两条 `@media` 改 `@container (max-width: 768px/480px)`；`Sidebar.vue:2689` 同理。注意 08-12 记录的 containment 会困住 CSS counter，`.chat-panel` 内没有 counter 依赖需先确认。

验收：`bun run ui:gate` 不新增红；vitest 快照 AppShell 三栏结构。

落地记录见上方「L5 的偏离与补充」—— `.chat-panel` 查不了自己，容器最终落在宿主
（`.tab-content` / `.thread-chat-detail`）并具名 `chat-surface`；Sidebar 那条 `@media`
判删而不是容器化。

## 4. 不做的事

- 不改 PanelTree 分屏语义（分屏内的最小宽度问题另议）。
- 不改右栏 tab 双域规则（会话域 | 工作区域），L3 只是往会话域加两个 tab。
- 不改视觉（宽度、间距、边框、圆角）——这是 Style Reference 的事。
