# 焦点环收口:一处配方、载体自述(2026-09-13)

比稿页:`docs/focus-ring-proposal-2026-09-13.html`(甲柔光环 / 乙硬线环 / 丙内嵌描边,顶栏切换,「全部点亮」一眼看完)。
用户拍板:**丙 · 内嵌描边**,并要求「统一到一个地方,下次想改样式非常容易改」。

## 0. 今天为什么不好改

环的样子今天写在 28 个文件、40 处:26 处 `outline: var(--focus-ring-w) solid var(--accent-ring)`,6 处 `box-shadow: 0 0 0 … var(--accent-ring)`;另有 16 处 `outline: none`、24 处各自判「什么时候亮」的 `:focus-within` / `:has(…:focus)`。token 只统一了粗细与颜色,没统一**画在哪个属性上**与**什么时候亮**。想换一种环 = 改 28 个文件。

三件事在同一个 token 上混住:

- `--accent-ring` 既是焦点环的颜色,也被 5 处借去当**染色**用(`SnapHint` 的边、`PaneLeaf` 当前格的内嵌线、`BrowserLeaf` 的底、`Settings` 键位槽的边、`WorkspaceOverview` 当前卡的外圈)。环改成实线强调色之后这 5 处不该跟着变。
- 26 处 `X:focus-visible { outline: … }` 与 `global.css` 的全局兜底**逐字相同**——它们不是定制,是 A2 立全局规则之前留下的复述。
- `Slider` / `Splitter` 两处已经在自己把环往里收(`outline-offset: -w`):扁的杆、6px 的抓手,环画外面会压住邻居。丙正是它们早就想要的形。

## 1. 设计:两个对象

**配方(recipe)**:环长什么样。唯一产地 `styles/tokens.css`,四格:

| token | 丙的值 | 说的是 |
| --- | --- | --- |
| `--focus-ring-w` | `var(--bw-3)`(2px) | 粗细 |
| `--focus-ring-color` | `var(--accent)` | 颜色(**新 token**;`--accent-ring` 从此只是染色,不再是环) |
| `--focus-ring-offset` | `calc(-1 * var(--focus-ring-w))` | 离盒边多远,负数 = 画在盒里 |
| `--focus-ring-edge` | `var(--accent)` | 文本输入类落焦时边线的颜色(不想动边线就等于 `--line-1`) |

换样式 = 换这四格;比稿页的甲乙丙就是这四格的三组值。

**载体(carrier)**:哪个元素、在什么时候把环画在自己身上。元素只**自述角色**,不知道配方。五种亮法,全部住 `styles/global.css` 一组选择器里:

| 亮法 | 元素怎么说 | 判据 | 谁 |
| --- | --- | --- | --- |
| 自己(缺省) | 什么都不写 | `:focus-visible` | 按钮、行、标签、分段、可聚焦的块 —— 全局兜底,今天就有 |
| 盒内(within) | `data-focus-ring="within"` | `:has(:focus-visible)` | 勾选框的 `.box`、单选的 `.dot`:焦点在看不见的原生控件上,环画在盒上 |
| 文本(text) | `data-focus-ring="text"` | `:has(:focus)`(鼠标点进去也亮)+ `border-color: var(--focus-ring-edge)` | `ui/Input` 的 `.field`、Composer 的 `.panel` / `.modelSearch` / `.askBar` |
| 代理(proxy) | 子元素 `data-focus-ring="proxy"` | `:focus-visible [data-focus-ring="proxy"]` 画环,`:focus-visible:has([data-focus-ring="proxy"])` 自己不画 | 焦点在容器上、环要画在里面某一件上(今天没有消费方,给「环画在抓手上」这一族留的口;Slider / Splitter 按丙其实直接走缺省即可) |
| 活动位(active) | `data-focus-ring="active"` | `[data-active="true"]` | `aria-activedescendant` 那一族:会话行、会话节头 —— 项**永远不是** `document.activeElement`,`:focus-visible` 一辈子匹配不上它(**批 1 施工时补的第五种**,见第 7 节施工账 ②) |
| 不画(none) | `data-focus-ring="none"` | `outline: none` | 拿焦点只为让键盘落进来的**面的根**:Dialog / Palette 的 `.panel`、ZoomOverlay 画布、NativeViewSlot、SessionTree、CodeMirror 编辑面(插入符就是指示)、`[data-focus-scope][tabindex=-1]`(focus-scope.css 那条并进来) |

`text` 载体里的原生 `<input>` / `<textarea>` 由同一组规则统一 `outline: none`(替代品就是载体那圈),消费方不再各写一句。

**配方的第五格是个「上下文格」**(批 1 施工时补的,见第 7 节施工账 ③):
`data-focus-ring-tone` —— `"on-accent"` 把 `--focus-ring-color` 换成 `--on-accent`,
`"danger"` 把 `--focus-ring-edge` 换成 `--danger`。
它换的是四格里的**一格值**,不是环的画法 —— 元素照旧不知道环是实线还是柔光、画在里还是外,
所以对象仍然是「配方 / 载体」两个,没有第三个。消费方是**底就是强调色**的那几件
(勾选框选中 / 单选选中 / 开关打开 / `ui/Button` 的 primary / composer 发送键 / ask 记号选中):
同色画同色 = 屏幕上一个像素的环都没有,而那不是「环细」,是 WCAG 2.4.7 意义上的没有焦点指示。
`danger` 那一格的消费方只有 `ui/Input` 的 `.field`(填错时):text 载体那条选择器带
`:has()` + `:not(:has())`,特异性 0,6,0,把消费方 `.invalid:focus-within`(0,2,0)的红边压掉了。

**不做的**:淡入淡出。环要在落焦当帧可见,这是无障碍的硬要求;瞬时出现、瞬时消失,与今天的全局兜底一致。`text` 载体的边线过渡照旧(`border-color var(--dur)`)。

**为什么还是 outline**:global.css 里那段「为什么画 outline 而不是 box-shadow」的理由整段成立且更强了——现在连 Input 那一族也上 outline,仓里**不再有第二种环**;`gate:a11y` 的判据从「outline 或 box-shadow 之一」收紧成「只认 outline」。

**丙的两条已知代价,写在这里**:①2px 内环吃掉载体 2px 内边距,16px 的勾选盒里剩 12px,比稿页看过,可接受;②带 1px 边的输入框落焦后是「边线升色 + 2px 内环」叠成一道 2px 的强调边,这是丙的形,不是 bug。

## 2. 三张状态表

**生命周期**:配方与规则随 `global.css` / `tokens.css` 在 `main.tsx` 第一个进,先于任何 CSS Module;主题换色只换 `--accent`,`--focus-ring-color` 跟着走,零 JS。载体属性写在 JSX 上,随组件挂卸,无状态。

**UI 生命状态**:不适用(纯样式,无数据)。

**交互状态**(每种载体逐态,真机截图对照):

| | rest | hover | focus(键盘) | focus(鼠标点) | active | disabled |
| --- | --- | --- | --- | --- | --- | --- |
| 自己 | 无环 | 组件自己的 hover | 内环 | **无环**(`:focus-visible` 的语义) | 组件自己的 | 无环(不可聚焦) |
| within | 无环 | 组件自己的 | 盒上内环 | 无环 | — | 无环 |
| text | 无环 | 边线升一档 | 边线 accent + 内环 | **同键盘**(文本输入是例外) | — | 无环,`.disabled` 透明度 |
| none | 无环 | — | 无环 | 无环 | — | — |

## 3. 改动清单(逐文件)

### 批 0 · 骨架与门(先立规矩,存量原样)

1. `styles/tokens.css`:焦点节改成四格(上表),`--focus-ring-w` 从 `--bw-ring` 3px 改指 `--bw-3`(2px,状态标记那一档);`--bw-ring` 删(唯一读者就是它)。`theme-bridge.css` / `palette.css` 的 `--accent-ring` **不动**,注释改成「染色,不是环」。
2. `styles/global.css`:那条 `:focus-visible` 改读四格 token;紧接着加 within / text / proxy / none 四组选择器 + `text` 内原生控件 `outline: none`。文件头那段判词改写:载体契约表搬进来。
3. `focus/focus-scope.css`:整文件删,那条规则并进 global.css 的 `none` 组(判词保留,那是 08-28 判例)。作用域根不加属性:`[data-focus-scope][tabindex="-1"]` 这一格判据本身就是「树送焦点用的那种根」,保留原选择器,只是搬家。
4. `scripts/gate-a11y.mjs` 的 `ringProbeSource`:期望色从 `--accent-ring` 改读 `--focus-ring-color`;只认 `outline` 载体,`box-shadow` 那支删。
5. `scripts/ui-consume-check.mjs` 新规则 `focus-ring-handwritten`:`src/**/*.css`(除 `styles/global.css` / `styles/tokens.css`)里任何一条 ①`outline:` 声明里出现 `--focus-ring-*` 或 `--accent-ring`,②`box-shadow:` 里出现 `--accent-ring` 且选择器含 `:focus`,③`outline: none`,④选择器含 `:focus` 且块内有 `outline` —— 都是命中。**基线 = 批 0 当天的存量数**(约 45),decrease-only;批 1 归零后改硬闸。
6. 反证:拆掉 global.css 的 `text` 组跑 `gate:a11y` 第一屏(Composer 落焦)必红。

### 批 1 · 消费方迁移(棘轮归零)

**A. 纯删(与全局兜底逐字相同,删了照样有环)**——19 处 / 15 文件:
`content/FilesPanel`(3 选择器一组)、`content/SegmentView` `.thought`、`content/ChatStream` `.pendingAction`、`content/blocks/shell/BlockShell` `.action` / `.expand`、`content/research/Research` `.head` / `.sourceFace` / `.footPill`、`content/tools/ToolCard` `.row`、`content/settings/Settings` `.keySlot` / `.keyAdd`、`content/message/MessageChrome` `.ghost`、`content/seam/Seam` `.seamLabelFold` / `.seamFoot`、`content/viewer/FileViewer`(3 选择器一组)、`components/ErrorBoundary` `.summary`、`expose/SessionRow`、`expose/SectionHead`、`dev/PerfHud` `.rowBtn`、`ui/Popover` `.pop`、`ui/Switch` `.track`。
每删一处,`gate:a11y` 对应屏必须仍绿;**红了就说明那个元素身上有别的规则在压 outline,修那条规则,不许把复述加回来**。

**B. 换成载体属性**——6 处:
- `ui/Checkbox` `.box:has(.native:focus-visible)` → 删规则,`Checkbox.tsx` 的盒加 `data-focus-ring="within"`;`ui/Radio` `.dot` 同。
- `ui/Input` `.field:focus-within`(边线 + box-shadow)与 `.input { outline: none }` → 删,`Input.tsx` 的 `.field` 加 `data-focus-ring="text"`。`SecretInput` 复用 Input,零改。
- `composer/Composer.module.css` 三处(`.panel:has(.input:focus)` 含 `--sh-1` 叠加、`.modelSearch:has(…)` 的 inset+外圈、`.askBar:has(.askFree:focus)`)与三处 `outline: none` → 删,三个元素加 `data-focus-ring="text"`。`.panel` 的 `--sh-1` 投影留在 rest 规则里不动(改走 outline 之后不必再合成一条 box-shadow,这正是当初「为什么不用 box-shadow」①的实证)。

**C. 已经在做内缩的,随丙成为缺省**——2 处纯删:`ui/Slider` `.slider:focus-visible { outline-offset… }`(`border-radius` 那一句留)、`ui/Splitter` `.bar:focus-visible`。

**D. 不画的,换成同一个口**——7 处:`ui/Dialog` `.panel:focus`、`workspace/WorkspacePalette` `.panel:focus` 与 `.input`(后者是 text 载体里的原生控件,给它的外壳加 `text` 即可)、`content/blocks/shell/ZoomOverlay` `.canvas:focus`、`content/native-view/NativeViewSlot` `.slot`、`expose/SessionTree`、`content/viewer/FileViewer` `.editor` → 删规则,元素加 `data-focus-ring="none"`,**JSX 那一行上方保留原来的一句理由**(「拿焦点只为让键盘落进来」)。`ui:consume` 不给 none 单独开规则:它是属性不是 CSS,棘轮抓的是 CSS 手写。

**E. 借 `--accent-ring` 当染色的**——5 处不改值,只改语义:`SnapHint` / `PaneLeaf` / `BrowserLeaf` / `Settings` `.keySlot` border / `WorkspaceOverview` `.cardCurrent`。`WorkspaceOverview:75` 那句 `0 0 0 3px` 是字面量,改成 `var(--bw-3)`:它说的是「当前卡的外圈」,与环无关,所以不读 `--focus-ring-w`。

**F. 动效两处不动**:`ui/Tabs` 的 `tabLand`(`--bw-3` 实线、offset `-bw-1`)与 `ChatStream` 的 `turnFlash` 都是「闪一圈」的 outline-color 动画,不是焦点;它们与焦点环同属性,同一元素同时落焦又落定的那一帧谁赢由 `animation` 压 —— 今天如此,不改。

**G. 注释与文档**:`ui/ButtonBase.css` / `IconButton` / `OpenDot` / `PermissionCard` / `ChangesPanel` / `BrowserFindBar` / `BrowserStartPage` / `Rail` 八处注释「焦点环走全局 :focus-visible」仍然成立,不动。`docs/design/react-shell-a11y-2026-08.md` §5「焦点样式纪律」改写:「同一处配替代品」升级为「替代品是载体属性,写在 JSX 那一行」;`apps/desktop-react/CLAUDE.md` 第 1 轴那句「焦点一律走全局 `:focus-visible` 环(outline 形,`--focus-ring-w`+`--accent-ring`)」改成「配方 tokens 四格、载体 `data-focus-ring` 四种、禁在 CSS Module 里写环」。

### 批 2 · 验收

- `npm run ui:consume`:`focus-ring-handwritten` 归零,改硬闸(进三条硬闸那一族)。
- `gate:a11y` 十四屏 + 设置八页:每个落焦元素的 `outlineColor` = `--focus-ring-color` 计算值,`outlineOffset` = −2px;`gate:focus` 22 场景不动;`gate:terminal` ⑧ / `gate:browser` ⑪ 那两屏同判据。
- 真机逐态截图(第 2 节那张表 × 四种载体),对照比稿页丙;像素差只许是「柔光→内环」这一条列明的修正。
- squeeze / motion 棘轮不动(环不占布局,无新动效)。
- 提交:批 0 与批 1 各一笔;批 1 的 A/B/C/D/E 分文件 add,禁 `-A`。

## 4. 陌生能力演练(仓根 09-02 法)

- **新长一种载体**(比如笔记的 contenteditable 富文本、或某块原生视图的占位格要亮环):元素上一个属性,零 CSS。
- **换样式**(甲 / 乙 / 将来的第四种):`tokens.css` 四格,零选择器改动;比稿页的三组值就是三次演练。
- **新增第六种亮法**:`global.css` 一组选择器。这是唯一的枚举点,而它就住在配方自己的模块里——合法。
- **主题换强调色**:`--accent` 一动环跟着动,零改。

## 5. 留账

- `proxy` 载体今天零消费方,批 1 落地时若仍无人用就**不写**这一组(留口不留码),这里记着它的形即可。
- `Tabs` 的 `tabLand` 与 `ChatStream` 的 `turnFlash` 用的粗细与环同为 `--bw-3`,但它们不读环的 token,是两件事;若将来想让「闪一圈」与「落焦」同形,把它们改读 `--focus-ring-*` 是一行的事,不在本单。
- 比稿页里「环永远在只是透明、落焦淡变」那一手没有采纳(见第 1 节「不做的」);要做,是给载体常驻一圈透明 outline,另单拍。

## 6. 同一套法能收的其他状态(2026-09-13 用户问「还有哪些值得统一」,量过的候选)

判据一句话:**属性收的是「状态」,组件收的是「形态」**。一个元素进入某个状态(落焦 / 禁用 / 被选 / 被拖入 / 被看着)时宿主给它涂的那一层,才适合「tokens 一格配方 + 元素一个属性」;按钮、卡片、浮层各自的 hover 皮是形态,归 `ui/` 组件与 `ui:consume` 的消费义务,不归属性。

| 状态 | 今天的复述 | 一致性 | 收法 | 建议 |
| --- | --- | --- | --- | --- |
| 焦点环 | 40 处 / 28 文件 | 一种形 | 本文 | 做(在办) |
| 禁用 | 29 块 / 23 文件,其中 17 处逐字 `opacity: var(--btn-disabled-o)` + `cursor: default` | 两种形:整件变淡 / 只字变灰(FilterChip) | global `:disabled, [aria-disabled="true"]` 一条;只字变灰的那几处改自述 `data-disabled-look="text"` | 做,第二单,零风险 |
| 行态三色(hover / 选中 / 选中且 hover) | `--st-hover` 62 处 / 34 文件、`--st-sel` 31 处 / 18 文件 | 色已统一,属性都是 background,判据各写各的 | `[data-row]:hover` / `[data-row][aria-selected="true"]` / `[data-row][data-active="true"]` 三条;与 09-01「hover 是纯 CSS、active 只由键盘与点击写」同一条法 | 做,第三单,收益最大、工作量中 |
| 幽灵现身(hover 才露出) | `opacity: 0` 40 处 / 16 文件(其中多少是现身、多少是动画起点待数) | 已有先例 `ui/Reveal` = `[data-reveal-scope]` + `.reveal` | 把 `.reveal` 改成属性 `data-reveal`,加棘轮 `reveal-handwritten` | 做,第四单,先数清 |
| 拖入态 | 7 处 / 7 文件(虚线 accent 边) | 一种形 | `[data-drop="over"]` 一条,`ui/drag` 的 `DragSession` 负责写属性 | 做,顺手 |
| 截断 | `text-overflow: ellipsis` 104 处 / 49 文件,42 处三件套成组 | 一种形 + 多行变体 | `[data-truncate]` / `[data-truncate="2"]`(line-clamp);它不是状态,是排版工具,但用属性省一次 module 引入 | 做,机械 |
| 过渡 `var(--dur) var(--ease)` | 78 处 | 时长与曲线已是 token,**过渡哪个属性**是各件自己的事 | 无 | 不做 |
| 入场动画 | `var(--kf-*)` 45 处 | 单产地已立(motion.css) | 无 | 已完成 |
| 浮层皮(面 + 边 + 投影) | `--sh-2/3` 20 处 | 走 Popover / Menu / Dialog 组件,`float-handwritten` 已管 | 无 | 已由组件收 |
| 危险色 / 弱化文字 | `--danger` 47、`--text-3/4` 243 | 是颜色 token,不是状态 | 无 | 不做 |

**顺手量到的一笔账**:CSS Module 里字面 `px` 442 处 / 63 文件(`styles/` 之外),绝大多数是 `1px solid var(--line-1)`;第 1 轴写着「零字面 px」,却没有一条门在管。它与本单无关,但该立一条棘轮(`--bw-1` 早就有)。

**住处**:配方全部进 `tokens.css` 新开的「状态配方」节;规则全部进 `global.css` 的「状态语法」节,一个状态一组选择器;棘轮在 `ui:consume` 里一族规则 `state-handwritten:<state>`,每收一个状态加一行、基线从存量起 decrease-only,归零改硬闸。

## 7. 施工账(2026-09-13,批 0 + 批 1 一次交卷)

在 worktree `focus-ring`(基线 main 592103be9)施工。批 0 与批 1 同一批做完,所以
`focus-ring-handwritten` **没有走「先记 41 条基线、再归零」那条分期路**:立规则那天就是
硬闸,基线文件里一条都没有(体例与响应链三条逐字相同,判词补在 `ui-consume-gate.mjs` 头上)。

### 读数

| 门 | 结果 |
| --- | --- |
| `npm run typecheck` | 0 |
| `npm run lint` | 0(`--max-warnings 0`) |
| `npx vitest run` | 332 文件 / 5497 例 全绿(9 条 `SearchPanel.dom-parity` 快照更新 —— 差异**只有** `ui/Input` 的 `.field` 多了一个 `data-focus-ring="text"`,逐行核过) |
| `npm run ui:consume` | 32 条全在基线内;响应链三条 0;**焦点环手写 0**(存量 41 → 0) |
| `npm run squeeze-gate` | 3(基线 3) |
| `npm run motion-gate` | 0(基线 0) |
| `npm run gate:a11y` | 九屏 axe 零违例 + 键盘走查全绿;Tab 40 站全部画着环(载体:outline),`outline-offset = -2px` = `--focus-ring-offset`(Fable 复审改宽后重跑) |
| `npm run gate:focus` | **2 条红 / 154 条断言 —— 存量**:场景 4「架子两 tab 切换 → 焦点在新层内;旧层 inert」。同一台机器上把整棵工作树还原到 HEAD(`git show HEAD:<path>` 逐份写回)重跑,**逐字同样的两条红**,与本单无关 |

① 执行者按清单里的 `var(--bw-2)` 做成了 1.5px;Fable 复审时改回 `var(--bw-3)` = **2px**——用户在比稿页上拍的是 2px,而 `--bw-2` 那一档的名字是「控件描边」,环是「状态标记」,本来就该读 `--bw-3`。改的只有 tokens.css 那一格,零选择器改动——这正是这套配方要证明的事。下面的读数是改宽后重跑的。

### 真机逐态(离屏窗 + CDP 补焦点,照 `gate-a11y` 的起法;脚本在 scratchpad,不入库)

| 载体 | rest | focus(键盘) | focus(鼠标) |
| --- | --- | --- | --- |
| 自己(composer 发送键) | 无环 | 内环 2px / offset −2 / 色 = `--on-accent`(它自述 `tone="on-accent"`) | **无环**(`:focus-visible` 的语义,截图与 rest 逐像素同) |
| 盒内(勾选框 / 单选点) | 无环 | 盒上内环,勾选盒 16px 里剩 13px | **无环**(鼠标点原生控件不进 `:focus-visible`) |
| 文本(composer 面板 / `ui/Input`) | 无环 | 边线升 accent + 内环(环在**第 4 跳**的面板上,输入本体自己不画) | **同键盘** |
| 活动位(会话行) | 无环 | `[data-active]` 一挂就有环(合成探针:两格齐全 → `solid 2px accent offset -2px`;缺任一格 → `none`) | — |
| 不画(Dialog 面板根) | 无环 | 无环 | 无环 |

### 三处偏离 / 补充(都在这里说清楚,别去代码里猜)

① **`SegmentView .thought` 与 `ErrorBoundary .summary` 的 `border-radius` 没跟着删**:
那两句原本写在 `:focus-visible` 块里,而圆角是**那颗钮自己的形**(环沿着它拐弯),
不是焦点态才有的东西 —— 照 Slider「`border-radius` 那一句留」的同一条判据,搬进 rest 规则。

② **第五种载体 `active` 是施工时长出来的,不在原清单里**。原 A 表把
`expose/SessionRow` 与 `expose/SectionHead` 归进「纯删(与全局兜底逐字相同)」,
但那两条的判据是 `[data-active='true']` 而**不是** `:focus-visible` —— 那一族列表的焦点在
**容器**上,项靠 `aria-activedescendant` 指,项自己永远不是 `activeElement`。照原样删掉,
键盘位的环就没了,而 `gate:a11y` 照样绿(它只走 Tab 序,量不到一个永远不落焦的元素)。
所以改成载体的第五种:CSS Module 里的配方照删,判据搬进 `global.css` 一组选择器,
两块面从此共用一条 —— 那正是它们注释里原话「同一种『键盘位』的语言不该在两块面里长成两个样」。

③ **配方多了一格上下文:`data-focus-ring-tone`**(两个值,两条判例)。真机逐态截图(6 倍放大)当场
挖出来的:一颗**打了勾**又落着焦的勾选框,与没落焦的那颗**逐像素相同** —— 丙的环是实线
强调色画在盒里,而选中态的盒底**就是**强调色。同病的还有选中的单选点、打开的开关、
`ui/Button` 的 primary、composer 发送键、ask 那枚选中的记号。修在配方这一层:元素自述
「我这一格此刻是强调色实心底」,配方答一句「那就用 `--on-accent`」。**门也跟着改**:
`ringProbeSource` 的期望值探针从「挂在 body 上算一次」改成「挂在被问的那个元素下面现算」,
否则它会在一个正确的实现上判红。

**同一格的第二条判例是层叠**:text 载体那条选择器带 `:has()` 与 `:not(:has())`,Chrome 按
「`:has()` 取其最具体的那个参数」算,总特异性是 **(0,6,0)** —— 于是它把 `ui/Input` 那句
`.invalid:focus-within { border-color: var(--danger) }`(0,2,0)压掉了:**一个填错的输入框
一落焦,红边变回强调色边**。真机层叠探针量出来的(手搭一格同形的 field:不挂 tone 时
`borderColor` 读 accent,挂上 `tone="danger"` 读 --danger,环仍是 accent)。所以 `.field`
在 `invalid` 时自述 `tone="danger"`,模块里那句 `:focus-within` 变体删掉 —— 屏幕上一模一样。

④ **`ChatStream` 的 `turnFlash` 从 `--focus-ring-w` 改读 `--bw-3`**(F 表说这两处动效「不动」,
但不动的前提是它不读环的 token)。`--focus-ring-w` 这一批从 3px 变成 2px,不改的话
那圈「落定闪一下」会跟着**悄悄变细** —— 它与焦点无关,与 `ui/Tabs` 的 `tabLand` 才是一族,
而那边一直就是 `--bw-3`。

⑤ **`WorkspacePalette` 的头一行成了 `text` 载体**(按清单 D 做的)。副作用要说清楚:
命令面板开着时焦点恒在那个输入框里,于是那一行**常驻一圈环**。从前它是「`outline: none`
且没有替代品」——真按新法它就该有环。看着嫌吵的话,一句话可退(那一行改 `none`),但
那是拿回一处裸删,得单独拍。

⑥ **两条反证都做了**(备份还原,零 `git checkout`):
- 拆掉 `global.css` 的 `text` 组 → `gate:a11y` 第一屏**红**:`文本输入的环画在**外框**上
  (text 载体),不是它自己顶一圈;自己顶的:div[composer-input]`。
  **第一次拆的时候它是绿的** —— 因为消费方那一侧的 `outline: none` 也在同一批里删干净了,
  输入本体落回缺省载体自己顶了一圈环:「有环」成立、「环在该在的地方」不成立,而门只问了
  前半句。于是给这道门补了那半句(`carrierHop > 0`),再拆才红。**这是这一批里唯一一次
  「反证跑出来的是门的洞,不是实现的洞」,记在这儿**。
- 往 `ui/Switch.module.css` 塞回一句 `outline: var(--focus-ring-w) solid var(--accent-ring)`
  → `ui:consume` **红**:`focus-ring-handwritten src/ui/Switch.module.css:37 手写环的样子`。

### 留账

- `ui/Slider` 的 `.fill` 是强调色:滑杆推到高值时,内环压在填充段上那一截会看不清。
  它不是「底就是强调色」的整块,给整根杆挂 `over="accent"` 会让另一半看不清 —— 留着,
  等真有人报障再拍(两色环那一手不在本单)。
- `gate:focus` 场景 4 的两条红是**存量**(已在 HEAD 上复现),不在本单范围。
- `proxy` 载体仍然零消费方、仍然不写(留口不留码)。
- 第 6 节那张「其他值得统一的状态」表一格没动:禁用 / 行态三色 / 幽灵现身 / 拖入态 / 截断
  五单照旧排在后面。
