# React 壳响应链:焦点与键盘输入的统一规范(2026-09-02,v2 推翻式)

状态:**方案,待用户拍 §11 后开工**。执行序按仓规:Fable 拆分/审查,opus 执行,haiku 提交。
v1(同日上午)是给检索条补归还的止血案,用户否决("要根治不要亡羊补牢"),本版整体替换。

## 0. 一句话

壳里今天有 **13 个 keydown 监听、15 处 `.focus()`、6 处读 `activeElement`**,分属八套互不认识的
机制,各自回答"这一下输入归谁"。根治 = 立一棵**响应链**(responder chain,macOS 的叫法:窗口
任何时刻都记得"谁在接键盘",事件从它开始往外传),把八套机制全部变成这一棵树上的查询;
树之外**不许再有**任何 keydown 监听与焦点搬运,由棘轮归零执法。

## 1. 术语(第一次出现就地解释)

| 名词 | 意思 |
| --- | --- |
| 响应链 / 响应者树(responder chain) | 一棵与界面层叠同构的树,每个节点是一块"能接键盘的面"。任何时刻有一条**活动路径**(从根到最深那块面),输入沿它由深到浅找主人。 |
| 作用域(scope) | 树上的一个节点。查看器、输入面板、一扇浮窗、一个架子 tab、一张菜单,都是作用域。 |
| 第一响应者(first responder) | 活动路径最深的那个作用域。 |
| 落点(resting target) | 焦点进入一个作用域时落在哪个元素上:缺省是它的根(`tabIndex=-1`),输入面板是它的 textarea。 |
| 孤儿焦点(orphan focus) | DOM 焦点掉到 `<body>`。本仓所有"按键没反应"的病都长这儿。 |
| 模态(modal) | Tab 出不去的作用域(对话框、菜单)。 |

## 2. 病根:八套机制,没有一棵树

| # | 机制 | 落点 | 它在回答的问题 |
| --- | --- | --- | --- |
| 1 | 全局派发器 | `keymap/dispatch.ts:117` window 冒泡 | 全局命令归谁 |
| 2 | 面域局部键 | `viewer/useViewerKeymap.ts:108`、`FilesPanel.tsx:283` 挂在面域根 | 局部键归谁(靠 DOM 焦点在根里) |
| 3 | 浮层栈 `floatStack` | `ui/float.ts:30-81` + window 捕获 | 多层浮层时 Esc 归谁(DOM 包含 + 入栈序两条判据) |
| 4 | 外壳退层链 | `useEscapeChain.ts` window 冒泡 → `stage/transitions.escapeTargetOf` | 没浮层时 Esc 收哪块面(z 序) |
| 5 | 总览键盘 | `ExposeView.tsx:141` window 捕获,`live` 门 | 方向键 / Space / Enter / Esc 归不归总览 |
| 6 | 输入面板 | `useComposerKeys.ts:82` window 冒泡;`useEscStop` 读 `activeElement` | Esc 是拒答 / 关抽屉 / 两段停止 |
| 7 | 焦点陷阱 | `a11y/focus-trap.ts` document 捕获,自带锚点归还 | 模态 Tab 圈禁 + 关掉还焦点 |
| 8 | 单槽焦点口 | `composer/focus.ts` `registerComposerFocus` | 别处请输入框接管键盘 |

外加零散:`KeymapSettings` 录制态 window 捕获、`ZoomOverlay` window 冒泡、`WorkspacePalette` window 冒泡、
`Tooltip` document、`FileViewer` pointerdown 抢根焦点、`JumpBar` / `SearchPanel` / `DrawerModelPicker` 各自
`.focus()` 不归还、`FloatWindow.focusFloat` 只改 z 序不动焦点、`EdgeShelf` 切 tab 旧层 `inert` 把焦点挤成孤儿。

它们每一个单看都有道理,合起来就是:**"谁在接键盘"这个问题没有一个人持有答案**。
Esc 那段历史(08-30 microtask 失败 → 08-31 改相位 → 09-01 立浮层栈)是没有响应链时用 DOM 事件
顺序硬凑出来的;用户报的 ⌘F 只是同一病根在②号机制上的显形。

## 3. 目标与不变量

**目标**:壳里任何时刻恰有一条活动路径;所有键盘输入、Esc 退层、焦点进出,全部由这条路径决定。

不变量(gate 与单测钉死):

- I1 `document.activeElement` 永远不是 `body`(除了壳还没挂载那一瞬)。
- I2 全仓 `src/` 里 `window|document.addEventListener('keydown')` 只出现在 `src/focus/`。
- I3 全仓 `.focus()` 只出现在 `src/focus/` 与 `ui/a11y/roving.ts` / `list-selection.ts` / `ui/inline-edit.ts`(这三处是作用域**内部**的焦点移动,不跨作用域)。
- I4 每个 Placement 宿主层(舞台 / 浮窗 / 架子 tab 层 / 盖层)的根元素都带 `data-focus-scope`。
- I5 快捷键三层的语义不变:全局可改绑、局部先接、结构键不进表。只是"先"不再靠冒泡序,靠树的深度。

### 3.5 行为规范:焦点跟随动作(用户 09-02 口述模型,与 Apple HIG / WAI-ARIA APG「管理焦点」一致)

1. 任何时刻恰有一个第一响应者;应用启动时是主内容(有会话则是它的输入面板)。"启动时没有焦点"是错觉:焦点环只在键盘会话亮(08-28 判例)。
2. **打开什么,焦点进什么**:开会话 → 它的输入面板;从 Dock 开一块面 → 那块面。
3. **挪到哪,焦点跟到哪**:把面拼到舞台 / 钉到边 / 撕成浮窗,焦点跟着那块面走(宿主在落定后 `activate()`)。
4. **导航器里浏览不抢焦点,确认才抢**:文件树单击只显示、焦点留树;Enter / 双击焦点进查看器(VS Code / Finder 惯例)。
5. **关掉什么,焦点回打开它的地方**:结构性的(§4.5),不靠调用方记得。
6. 焦点永远不落在"没有东西"上(I1)。
7. Esc 从第一响应者开始往外退一层(§4.4)。

这七条是 §11 拍点的判据来源;拍点 1 = 规则 4,拍点 2/3 = 规则 2/7。

## 4. 模型

### 4.1 树怎么长出来

树 = React 上下文的嵌套。`<FocusScope>` 组件既是一个 Provider,又向父 Provider 登记自己。
于是父子关系来自**逻辑嵌套**而不是 DOM 位置:portal 到 body 的菜单在 DOM 上是对话框的兄弟,
在 React 树上是它的孩子 —— 这正是 `floatStack` 要用两条判据(DOM 包含 / 入栈序)去猜的那件事,
树里不用猜。09-01 反对"优先级表会与挂载序分叉"的理由在这里不成立:树本身就是挂载序。

节点种类(`kind`)决定它的缺省行为,不是决定它是什么组件:

| kind | 例 | Tab | Esc 缺省 | 进入落点 |
| --- | --- | --- | --- | --- |
| `root` | 整个壳,只有一个 | 自然 | 交给外壳退层链(§4.4) | — |
| `layer` | 舞台 / 一扇浮窗 / 架子一层 tab / 盖层 | 自然 | 无(由内容或退层链答) | 第一个可交互子作用域,否则根 |
| `region` | 查看器 / 文件树 / 输入面板 / 检索面板 / 总览 / 消息流 / 设置 / Dock | 自然 | 无 | 根或声明的 `restingTarget` |
| `float` | 跳转条 / 抽屉 / 缩放层 / Popover(非模态) | 自然 | **关掉自己** | 声明的 `restingTarget` |
| `modal` | Dialog / Menu / 工作区调色板 | **圈禁** | 关掉自己 | 容器或首项 |

**R0 落地时的名词修正(09-02)**:上表的 `kind` 是**行为档**(五格);§4.8 说的"kind 是声明"实为
**scope id**(`FocusScopeId`,21 格,`FOCUS_SCOPES[id] = { kind, labelKey, keys? }`)。组件 prop 叫
`scope`,实例 id 是 `scope@reactId`。下文凡说"按 kind 记表"读作"按 scope id 记表"。

**R1 落地时的四条修正(09-02,逐条有代码与用例)**:

1. **`popover` 归 `modal`,不是 `float`**。上表 `float` 行括号里的「非模态」说的是 **ARIA**
   (要不要 `aria-modal`、读屏能不能看见外面);行为档 `modal` 说的是 **Tab 走不走得出去**。
   `ui/Popover` 今天就在圈禁 Tab(它消费 `useFocusTrap`,文件头写着「圈禁与 aria-modal
   是两件事:附属浮层要前者不要后者」),归 float 会当场少掉圈禁 = 可感知的行为变化。
   所以按**它今天的行为**归档。
2. **Tab 圈禁不能只看活动路径**(`focus/transitions.ts` 的 `modalTrapNode` 两步判据)。
   `ui/a11y/focus-trap` 把监听挂在 document 而不是容器上的原话是「焦点万一已经跑到容器
   外面,挂容器就再也收不到这一下 Tab」。只按路径判等于丢掉那条判例:一次程序置焦、
   一次点在浮层背后,模态就再也圈不住键盘。所以第二步 = 树上仍在场的最深那个 modal。
3. **`activate()` 不把第一响应者从自己的后代那里拽回来**。React 的 effect **子先于父**跑,
   同一次提交里一起挂载的父子两层(对话框里一开始就带着一张菜单),父那一句
   `activate` 会把层序整个倒过来 —— 这正是 `floatStack` 当年要用判据①(DOM 包含)兜的
   那一形。
4. **§8 场景 2 与 §4.5 打架,留给 R2 拍**:场景 2 写「⌘P → Esc → 焦点在**开它之前的
   作用域**里」,而 §4.5 的结构归还是「路径缩回**父**」。开检索面之前的第一响应者是
   *另一扇浮窗*(兄弟),不是父 —— 树按 §4.5 答「回 root」,按 §8 答「回那扇浮窗」。
   后者要的是**兄弟间的 MRU**,而 §10 明说不做焦点历史。R1 按 §4.5 实现,gate 场景 2
   因此仍红;R2 决定是补「宿主在形态变化时 `activate()`」(拍点 2/3 的自然延伸)还是
   改场景 2 的判据。

**R1 必须补的一格(R0 审查)**:I1 的收回不能只挂 `focusin` —— 焦点掉到 body 不触发 `focusin`,
被聚焦元素从 DOM 移除时 Chrome 连 `focusout` 都不发。收回要三处:①`settle()`(卸载 / inert 路,
R0 已写);②`focusout` 且 `relatedTarget === null` → 微任务后查 `activeElement === body` 则收回;
③唯一派发器每次 keydown 开头:`activeElement === body` 先收回再路由(这条兜住所有静默移除)。

### 4.2 活动路径怎么定

三个来源,一条优先级,全部写在纯函数 `focus/transitions.ts` 里:

1. **DOM 焦点**(`focusin`):焦点落进哪个作用域的根里,那个作用域就成为第一响应者,路径 = 它到根。
2. **宿主激活**(`activate(scopeId, reason)`):打开一块面、切 tab、程序置顶浮窗时宿主调它;它把焦点送到该作用域的落点,于是回到来源 1。
3. **结构变化**:第一响应者被卸载或变为不可交互(`inert`)时,路径**缩到它最近的仍可交互的祖先**,焦点送到该祖先"上次焦点所在"的元素(仍连通)否则其落点。

DOM 焦点掉到 body(来源 1 报告"没有作用域")→ 路径**不变**,并在同一帧把焦点送回第一响应者的落点(I1)。
这不是可选的兜底,是模型的定义:第一响应者不会因为一个 DOM 节点消失而消失。

### 4.3 键盘输入怎么路由

**只有一个** window keydown 监听,在 `focus/dispatch.ts`。它做的事:

```
onKeyDown(e):
  if 输入面里的无修饰单键 → 放行(今天的 isTypingTarget 规则不变)
  for scope in activePath from leaf to root:
    if scope.keymap 命中 e → run, preventDefault, return
  if rootKeymap(KEYMAP_COMMANDS, overrides) 命中 → run, preventDefault
```

- 局部键表从各面的 element listener **迁入作用域声明**(`scopes.ts` 一张表,`FOCUS_SCOPES[kind].keys`),设置页读同一张表说"⌘I 已被文件行占着"。
- "局部先接、没接住放行全局"原样成立,由树深度保证而不是冒泡序。**用户报的 bug 在这一层就被根治**:⌘F 路由看的是"查看器在不在活动路径上",不是"DOM 事件经不经过它的根"。
- 结构键(方向键 / Enter / Space / Tab)**仍不进表**:方向键归 roving / list-selection(作用域内部);Tab 只在 `modal` 作用域被树圈禁;Esc 是唯一由树处理的结构键,因为"退一层"按定义就是树操作(§4.4)。

### 4.4 Esc 怎么退

沿活动路径由深到浅问 `onEscape()`,第一个答 `true` 的消费掉这一下:

- `float` / `modal` 缺省答 true 并关自己(今天 `useFloatDismiss` 的 Esc 半边、`floatStack` 整个、`Dialog/Menu/Popover` 各自的关)。
- `region` 可声明(输入面板:拒答 / 关抽屉 / 两段停止;总览:关 QuickLook / 收过滤;跳转条是 `float`,自然在输入面板之前)。
- `root` 的 `onEscape` = 今天的 `escapeTopmost()`(盖 → 舞台 → 最上浮窗,z 序),**作为最后一环**。
- 没人答 true → 不 `preventDefault`(输入法组字等后面的消费者照旧)。

三个相位、一个栈、一条链,收成一次循环。`useFloatDismiss` 只剩"点外关"与定位,签名去掉 `escape` 参数。

### 4.5 焦点归还是结构性的,不再有"借了要还"

v1 靠每个浮层记得调 `useFocusReturn`;那正是亡羊补牢。本版里**归还是 §4.2 来源 3 的自然结果**:
跳转条是查看器的子作用域,它卸载,路径缩回查看器,焦点回查看器上次所在的元素。
写检索条的人不需要知道有归还这回事;忘了也忘不掉,因为没有东西可忘。
`useFocusTrap` 的锚点半边随之退役,它只剩 Tab 圈禁,并成为 `modal` kind 的内置行为。

**R1 审查裁定(09-03,结清 §4.1 修正 4 的矛盾)**:"回打开它的地方"(规则 5)与"缩回父"不是一回事 ——
兄弟之间(⌘P 检索面 vs 之前的浮窗 / 输入面板)父链到不了。裁定:**树在一个节点首次接管焦点时,
记下上一任第一响应者**(`node.returnTo = { instanceId, element }`,由 `activate` / `focusin` 在
第一响应者**换人**的那一刻写,只写一次);卸载 / 变 inert 时 `returnTargetOf` 的顺序改为
① `returnTo`(仍在树上、可交互、元素连通)→ ② 父链的 lastFocused / 落点 / 根(原三格)。这是旧
`focus-trap` 锚点的结构化版本:记的人是树不是组件,所以仍然"没有东西可忘";§10 "不做焦点历史"
仍成立 —— 这是一格不是一条链,不暴露成命令。收回(I1)与 `pointerdown` 抢根这两种程序置焦**不算
换人**,不写 `returnTo`,免得把"开检索面之前在输入框"记成"在壳根"。场景 2 的判据不改。

### 4.6 指针怎么进作用域

`focus/registry.ts` 挂**一个** document `pointerdown`:目标不是可聚焦元素时,把最近作用域根的焦点拿过来
(`preventScroll`)。今天 `FileViewer` 自己写的那一手,升为所有作用域的公共行为。
点在空白处 = "我在看这块面",与 macOS 点窗口任何地方即成 key window 同理。

### 4.7 宿主的可交互性

`PanelVisibility.interactive` 不动(它还回答 NotificationsPanel "算不算被看见")。宿主层把 `inert` 打在
自己的 `<FocusScope kind="layer">` 上;注册表把 `closest('[inert]')` 非空的节点视为不可交互,
不会选它做第一响应者,它在路径上时路径缩回(§4.2 来源 3)。架子切 tab 后旧层的焦点不再变孤儿。

### 4.8 多实例

同一种面可以同时有多份(两扇浮窗各一个查看器;架子 keep-alive 各一份)。**kind 是声明,instance 是节点**:
`FOCUS_SCOPES` 按 kind 记标签与局部键表,树上每个 `<FocusScope>` 是一个实例,有自己的 id。
局部键路由看实例(活动路径上那一份),设置页看 kind。

## 5. 八套机制的去向

| 机制 | 去向 |
| --- | --- |
| 全局派发器 `keymap/dispatch.ts` | 监听器删除;`run()` 与 `lookupCommand` 保留,成为 root 作用域的 keymap。`keymap/` 域只剩命令表 + 改绑 + 设置页。 |
| 面域局部键 element listener(viewer / FilesPanel / TreeEntryRow ⌘I) | 删除;键表迁入 `FOCUS_SCOPES.viewer.keys` / `.files.keys`,处理函数由作用域实例注入。 |
| `floatStack` + `useFloatDismiss` Esc 半边 | 删除;Esc 由 §4.4 循环答。`useFloatDismiss(ref, onClose, active, {outside})` 只剩点外关与定位。 |
| `useEscapeChain` | 删除;`escapeTopmost` 成为 root 的 `onEscape`。 |
| `ExposeView` 捕获监听 | 方向键 / Space / Enter 保留但改挂在总览作用域根上(作用域内部键);Esc 迁 `onEscape`;`live` 门由 `inert` 替代。 |
| `useComposerKeys` window 监听 + `useEscStop` 读 `activeElement` | Esc 三分支迁输入面板 `onEscape`;ask 态 ←→ 挂作用域根;"焦点在面板里"改问"输入面板在活动路径上"。 |
| `useFocusTrap` | 锚点半边退役;圈禁半边成为 `modal` 内置。Dialog / Menu / Popover / Palette 改为 `<FocusScope kind="modal">`。 |
| `registerComposerFocus` / `focusComposer` | 删除;调用方改 `activate('composer')`。 |
| `KeymapSettings` 录制态捕获 | 保留为唯一例外(录制要吃**所有**键,含全局),但改为向注册表申请"独占"(`registry.capture(handler)`),仍不许自己挂 window。 |
| `Tooltip` document Esc | 迁 `float` kind(非模态、不抢焦点、Esc 关)。 |
| `ZoomOverlay` / `WorkspacePalette` / `DrawerModelPicker` / `JumpBar` / `SearchPanel` 各自 `.focus()` | 删除;各自成为 `float` / `modal` / `region` 作用域,进入落点由声明给。 |
| `FloatWindow.focusFloat` | z 序纯函数不动;宿主在程序置顶时补 `activate(该窗 layer)`;指针置顶不加动作(点击本身落焦)。 |
| `FileViewer` pointerdown 抢焦点 | 删除;§4.6 公共行为。 |

## 6. 对象与文件(`src/focus/` 新域,与 `keymap/` `stage/` 同级)

```
focus/
  types.ts         FocusScopeKind / FocusScopeSpec { id, kind, labelKey, keys? } / ScopeNode / ActivePath
  scopes.ts        FOCUS_SCOPES 封闭表(吸收 keymap/scopes.ts 的 KEY_SCOPES + SCOPED_KEYS)
  transitions.ts   纯函数:activePathOf(tree, focusedNode) / shrinkPath(tree, path, removed) /
                   routeKey(path, e) / routeEscape(path) / returnTargetOf(node)
  registry.ts      FocusTree 类(模块单例,同 floatStack 的生命周期与 HMR dispose):
                   register/unregister/activate/capture,focusin + pointerdown 两个 document 监听,
                   持有 activePath 与每节点 lastFocused,I1 的收回在这里
  dispatch.ts      唯一 window keydown:调 routeKey / routeEscape
  FocusScope.tsx   <FocusScope kind id? restingTarget? keys? onEscape? modal-inert>:
                   Provider + 登记 + 根元素 data-focus-scope/tabIndex=-1 + modal 圈禁
  useFocusScope.ts 拿当前作用域句柄(activate 自己、问自己在不在活动路径上)
  __tests__/
```

`FocusTree` 是唯一有状态的对象;`transitions.ts` 全是纯函数,活动路径怎么算、键怎么路由、Esc 怎么退、
卸载后回哪儿,四件事各一只函数,单测直接钉。组件层只是把树的答案落到 DOM 上。

## 7. 宿主与内容各自的义务

**宿主**(舞台 / 浮窗 / 架子 / 盖层 / 总览打开会话 / 树行打开文件 / Dock 瓦):
- 用 `<FocusScope kind="layer">` 包自己那一层;不可交互时打 `inert`。
- 用户用键盘或程序"打开 / 切到"一块面时调 `activate()`。指针操作不调(点击自己落焦)。

**内容**(查看器 / 文件树 / 输入面板 / 检索 / 总览 / 消息流 / 设置):
- 根上 `<FocusScope kind="region">`,声明 `restingTarget` 与 `keys`。
- 自己开的临时面用 `<FocusScope kind="float|modal">` 包,**不写任何 focus/keydown 代码**。

**谁都不许**:挂 window/document keydown;跨作用域 `.focus()`;读 `activeElement` 判"我是不是当前"
(改问 `useFocusScope().isActive`)。

## 8. 执法

- `scripts/ui-consume-check.mjs` 三条新规则,**基线零,不进 baseline**:`keydown-outside-focus`(I2)、
  `focus-outside-focus`(I3)、`active-element-read`(`document.activeElement` 只许在 `src/focus/` 与 `ui/a11y/`)。
  现有 `float-handwritten` 规则退役(被 I2 覆盖)。
- `keymap-scopes.test` 改为比对 `FOCUS_SCOPES[kind].keys` 与各作用域实例注入的处理器名单。
- `gate-focus.mjs`(真 Electron + CDP,隔离 `--user-data-dir`,照 gate-a11y 配方),场景矩阵:
  1. 树行 Enter 开文件 → ⌘F → Esc → ⌘F 再开(改前红,用户报的那条)。
  2. ⌘P → Esc → 焦点在开之前的作用域里。
  3. 架子两 tab 切换 → 焦点在新层内;旧层 `inert`。
  4. 对话框里开菜单 → Esc 只关菜单 → 再 Esc 关对话框 → 焦点回触发钮。
  5. 输入面板生成中 → Esc 两段停止,不收面板;浮窗开着时焦点在输入面板 → Esc 语义按 §11 拍点 3。
  6. 每个场景每一步后断言 I1;整机扫 I4。
- 交互时序类改动**必须真机对照**,jsdom 的绿不算数(08-30 判例)。

## 9. 分期(全貌;每期结束壳都能用)

| 期 | 内容 | 可感知变化 |
| --- | --- | --- |
| R0 树 | `src/focus/` 全部文件 + 纯函数单测;root 作用域挂在 AppShell;旧机制**全部保留**,树零消费者。`gate-focus` 先钉红。 | 无 |
| R1 层与 Esc | 四个 Placement 宿主 + Dialog/Menu/Popover/Palette/Tooltip 接树;`floatStack`、`useEscapeChain`、`useFocusTrap`(整只)、`useFloatDismiss` Esc 半边退役;唯一派发器上线,旧全局派发器监听删。**已落地(09-02)**:派发器是**两半相位**的过渡形(捕获半 = 浮层 Esc + 模态 Tab + 录制独占 + I1 收回,冒泡半 = 面的 Esc + 局部键 + 全局命令),分界就是今天那条相位线,好让还没接树的 ExposeView / composer / viewer / files 四家的相对次序一格不变;R2 把它们接进树之后两半合一。Tooltip 走**瞬态口**(`registerTransient`)而不是作用域 —— 它没有一个包着触发元素的根。 | Esc 层叠语义与今天逐条相同(gate 场景 4/5 守,真机矩阵逐条同);孤儿焦点消失(gate I1 由 3 红转全绿)。 |
| R2 内容面 | viewer / files / composer / search / expose / chat / settings / dock 接树;局部键表迁入;八处 element/window 监听删;`registerComposerFocus` 退役;宿主补 `activate()`。 | ⌘F 根治;切 tab / 开面 / 程序置顶后键盘立刻可用。 |
| R3 执法 | 三条棘轮归零;`gate-focus` 进 verify;设置页快捷键区读合并表;dev `__focus.dump()`。 | 无 |

R1 与 R2 各一批,不合并(R1 守的是"行为不变",R2 才带可感知变化,分开才查得清)。

## 10. 不做的

- 不接 Electron 窗口 `focus`/`blur`:Chromium 自己恢复 `activeElement`,今天没有消费者。多窗口时一窗一树,留到那时。
- 不把方向键 / Enter / Space 进表:它们是作用域内部的语法,roving / list-selection 两族判例不动。
- 不做"焦点历史回退"(⌘[ 之类):MRU 只用于卸载后回落,不暴露成命令。

## 11. 拍点(**09-02 用户已全部拍定,开工**):1(a) 单击留树 Enter/双击进查看器;2 进内容;3 按树;4 接受;5 静默;6 保留独占口例外。原题如下留档。

1. **从文件树打开文件,焦点去哪**。(a) 单击留在树、Enter / 双击进查看器(VS Code 惯例);(b) 一律进查看器。建议 (a)。
2. **架子切 tab(鼠标点 tab 条)后焦点进不进新 tab 内容**。建议进。
3. **焦点在输入面板、旁边开着浮窗时按 Esc**。今天:z 序说了算,先收浮窗。树的自然答案:输入面板先答(生成中→停止;否则不答)→ 才轮到 root 收浮窗。两者只在"输入面板正在生成"时不同。建议按树。
4. **点在空白处进作用域**(§4.6)是否接受。焦点环只在键盘会话亮(08-28 判例),所以零视觉变化;但 `pointerdown` 抢焦点会让正在编辑的输入框失焦 —— 今天点空白同样失焦,行为一致。建议接受。
5. **⌘F 在活动路径上没有查看器时**:静默(建议)/ 送给最近用过的查看器 / 升为全局命令。
6. **录制态独占**(§5 KeymapSettings 行)保留为唯一例外,还是也改成 `modal` 作用域声明 keys 吃全键。建议独占口,因为它要吃的键集合不可枚举。

## 12. 证据索引(勘察 09-02)

- 13 个 keydown 监听位置:`keymap/dispatch.ts:117` `ui/a11y/roving.ts:146` `ui/Tooltip.tsx:111` `ui/a11y/focus-trap.ts:137` `ui/float.ts:169` `components/useEscapeChain.ts:44` `expose/components/ExposeView.tsx:141` `workspace/components/WorkspacePalette.tsx:109` `composer/useComposerKeys.ts:82` `content/KeymapSettings.tsx:83` `content/FilesPanel.tsx:283` `content/viewer/useViewerKeymap.ts:108` `content/blocks/shell/ZoomOverlay.tsx:33`。
- 15 个 `.focus()` 文件、6 个 `activeElement` 读者:见 §2 表下段。
- 三层立法原文:`keymap/scopes.ts:5-41`;冒泡序裁决:`dispatch.ts:108`。
- 浮层栈两条判据与三轮分叉史:`ui/float.ts:1-81`。
- 检索条只用散场不归还:`viewer/JumpBar.tsx:94-123`;查看器 pointerdown 抢根:`viewer/FileViewer.tsx:274-285`。
- 架子 keep-alive `inert`:`components/EdgeShelf.tsx:100-106`;宿主声明:`content/visibility.ts`。
- 测试绕开焦点前提:`content/__tests__/file-viewer.test.tsx:779`。
- 主进程一扇窗、无 globalShortcut、无 focus/blur:`electron/main.ts:309-343`。
