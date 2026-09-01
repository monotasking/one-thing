# CLAUDE.md — React 壳(apps/desktop-react)施工规范

对本目录动手前必读。这里沉淀的是**真机踩过的坑立成的法**,每条都有事故背书;违反即不过审。

## 验收四轴(每批交付必须自证,缺轴打回)

1. **Token 纪律**:组件文件零字面色值/px/ms,一切量入 `src/styles/tokens.css` 对应节(唯一例外:`--fb-*` 品牌色数据节,官方色是数据);状态色只上图标/点,永不换底;焦点一律走全局 `:focus-visible` 环(outline 形,`--focus-ring-w`+`--accent-ring`),**禁裸删 outline**。
2. **无障碍**(规范:`docs/design/react-shell-a11y-2026-08.md`):jsx-a11y 零违例;新 surface 必须追加进 `scripts/gate-a11y.mjs` 扫描屏;行为件用 `src/ui/a11y/`(focus-trap/roving/live-region),照 WAI-ARIA APG 写,不引库。
3. **交互稳定性四律**(规范:`docs/design/react-shell-2026-08.md` §8;根治原语在 `src/data/kernel/`,落地前的手写异步须注释标「临时手写」):
   - 写操作**就地更新**,重拉后台对账,禁「清空→骨架→重灌」;
   - 重拉期间**旧内容保留在屏**,骨架只许首载(`phase==='initial'`)画;
   - 异步动作**必有进行中反馈**(按钮自身变文字+disabled;有 kernel 后走 `mutation.pending`/AsyncButton);
   - 列表 key 稳定,禁整树重挂(零重挂断言:前后是同一个 DOM 节点)。
   - 病型速查:A=重拉清屏骨架闪;B=全局忙布尔把整面禁灰(粒度病);C=整份写回换行身份;E=过快往返的无意义图标闪。诊断工单见提交 495e5146。
4. **状态完备性**:交互组件过状态清单——rest/hover/focus/pending/success/error/empty/**超量**(数据 10×/100× 的形与导航后果:削量、粘头、回顶)。设计稿沉默的状态**照组件规格补齐**,「设计文档里没有」不是 pass 理由。报告带状态清单勾选表。

## 具体禁令与拍板(均有判例)

- **Spinner 只许出现在按钮内或状态栏**;列表/卡的加载态用文字或骨架。
- **复制类反馈就地**(按钮变「已复制」`COPY_FEEDBACK_MS` 后还原 + `announce()` 播报),零 Toast 零通知。
- **禁 native `title=`**,提示一律 `src/ui/Tooltip`;组件库有的件对应交互必须消费(组件消费义务)。
- **禁无上下文缩写**(「Caps/V/T/R」判例):能力类用图标+Tooltip 全名。
- 计数禁令:tab/列表/组头不挂计数徽;文字读数(「已选 2/5」)可以。
- 挤压纪律(`docs/design/react-shell-squeeze-rules-2026-08.md`):一行一个弯腰件、结构行只截断不换行、声明最小宽度下零重叠;表头与数据行 **grid 模板单产地**。
- 浮层/抽屉列表必有最大高度约束 + 选中项 scrollIntoView。
- i18n 双语成对(zh/en 同批),写字典前**现读全文精确锚点插**(多批并行);风险类警告文案(会造成扣钱的)当数据不进字典。
- 动效:`@keyframes` 唯一产地 `src/styles/motion.css`(经 `--kf-*` 表引用);JS 时长唯一镜像 `src/components/motion.ts`;手势/读认窗口(ESC_STOP/COPY_FEEDBACK)不属动画,动效档不清零。
- 树/面常驻铁律:打开查看、切换文件、开关浮层不得卸载重挂兄弟区(文件树判例)。
- **动作单产地=右键上下文菜单**(09-01 判例):一个条目(文件/会话/瓦)的全部动作收进同一张右键菜单,树行与查看区右键同一张表;头部檐只放身份(名+状态丸)与关闭,标题截断须配 Tooltip 全名;设置类(如打开方式)只在菜单一处,禁散落头部下拉。反例:查看器头挤 copy/编辑/Reveal/落点下拉四件,标题被截成 kimi-sli…。
- **禁双击作为动作触发**:macOS 触控板双指点按以双击形态到达、与右键语义打架;打开=单击/回车,动作=右键菜单,详情不设双击入口。
- **图标按钮必须消费 ui 库件**(hover/focus/active 配方随件走),业务面禁手写图标钮样式——hover 不合规范屡犯的病根即各面自绘。
- **hover ≠ active:键盘选择列表的两态纪律(09-01 用户裁定)**——凡有键盘控制选择的列表(@ 文件/ 命令/模型抽屉、快切面板、检索、跳转条…),**active(键盘位)与 hover(鼠标位)是两个状态,两条产地**:改 active 的只有键盘(↑↓/Home/End)与**显式点击**;`mousemove`/`mouseenter`/`mouseover` 一个字都不许改它。**↵ 永远落在 active 上**,不是鼠标底下那一行。hover 是**纯视觉、不进 JS**:由 CSS `:hover` 画(`--st-hover`),与 active 的 `--st-sel` 可同屏,叠在同一行用 `--st-sel-hover`。
  - **二次污染判例(这条法立案的直接起因)**:键盘 ↑↓ → active 变 → `scrollIntoView` 把列表滚一段 → **鼠标一动没动**却换了脚下的行 → 浏览器补一发合成 `mouseenter` → 若 mouseenter 写 active,键盘位当场被拽走(表现为「按一下 ↓ 跳两行 / 跳回去」)。修法**不是**给 mouseenter 加「鼠标真动过吗」的判据(要维护、有边界:首次加载没动过、触屏、缩放),而是**让这条链根本不存在**——mouseenter 不写 active。
  - 唯一原语 `src/ui/a11y/list-selection`(`useListSelection`:受控/自持、走法、夹范围、`rowRef` 滚入视野;键表与 `a11y/roving` 同源)。焦点**真的落在项上**的那一族(菜单/tab 条/分段器)照旧用 `a11y/roving`——它的当前项就是 `document.activeElement`,压根没有第二个下标可被污染。
  - 执法:`npm run ui:consume` 的 `kbd-select-hover` / `kbd-select-handwritten` 两条;反证测试见 `src/ui/__tests__/list-selection.test.tsx`(mouseenter 后 active 不变、scrollIntoView 后 active 不跳),消费面各自还有一份(`palette.test.tsx` / `Composer.test.tsx`)。
- **裸 `<button>` 三类判**(`ui:consume` 的 `bare-button-*`):①文字动作钮→`ui/Button`·`AsyncButton`;②图标钮→`ui/IconButton`;③结构性交互件(瓦/卡/行/琴键/选项,视觉本该定制)→**不违例但不许裸着**,消费 `ui/ButtonBase`(只清 UA、`:where()` 压零特异性,一个像素都不画,焦点环仍走全局)。

## 快捷键三层(09-01 立法,报障「快捷键要分清局部和全局」)

一个键属于哪一层,由**它需不需要一个目标**决定,不由它好不好按决定。

1. **全局档** —— `keymap/transitions.ts` 的 `KEYMAP_COMMANDS`。焦点在哪儿都响,**可改绑**,
   `keymap/dispatch.ts` 是唯一派发器。语义:呼出一块面 / 做一件全局的事。
   **加全局键 = 表里加一行**;改既有键位是用户的拍点,不许顺手动。
2. **面域局部键** —— `keymap/scopes.ts` 的 `SCOPED_KEYS`(声明)+ 那块面自己根元素上的
   监听(落点)。焦点落在**那块面的根里**才响。今天两格:查看器 `⌘S/⌘L/⌘F`、
   文件行 `⌘I/⌘↵`。两处会不会分叉由 `keymap/__tests__/keymap-scopes.test.ts` 逐条钉着。
3. **行内结构键** —— 方向键 / ↵ / Space / Tab / Esc 的 DOM 焦点语义。**不进任何表**
   (理由见 `keymap/types.ts` 顶部:它们是这套形态语法本身,可配置就等于不一致)。

**撞键裁决:局部先接,没接住放行全局。** 机制只有一条、不需要调度器 —— 局部监听挂在
面域根上(先于 window 收到),**接住了才 `preventDefault()`**;全局派发器开头一句
`if (e.defaultPrevented) return`。判例:F1 时 `⌘I` 长在文件行上却不在任何表里,
用户一旦把某条全局命令改绑到 `⌘I`,两者会同时响(F1 已记为留账,09-01 结清)。

## 施工纪律

- **状态先行(09-01 用户令:「实现我给你的设计方案之前,先把组件的生命周期、UI 生命状态、UI 交互状态思考清楚,再进行实现」)**:实现任何设计稿/方案前,先产出该组件的**三张状态表**并对着它施工——①生命周期(挂载/首载/换宿主/卸载,含它在每种落点形态下的形:面板内/浮窗/舞台/盖/架子——**换一种宿主就是一次生命周期事件**,檐怎么合、滚动谁管、尺寸谁定都要在表里回答);②UI 生命状态(empty/loading/ready/error/超量);③UI 交互状态(rest/hover/focus/active/pending/disabled)。表随交卷报。判例:查看器接进浮窗落点时没想过「浮窗檐+查看器檐」的合并与「浮窗内滚动谁管」,产出双檐叠加、内容截断、无滚动条。
- **基础件先行(09-01 立法,起因:新壳里键盘选择列表各写各的被用户痛斥)**:动手写任何交互行为(键盘导航/选中态/悬浮层/拖杆/异步反馈/提示……)之前,先查 `src/ui/` 有无对应件或原语——有则必须消费;没有则**先立件入库再消费**,禁止在业务面就地手写。行为出处受 `ui:consume` 门(棘轮)执法:业务面出现 ui/ 已有职责的手写实现即违例,基线只减不增。派工令必须携带本条。
- **组件收敛战役纪律(09-01 用户令)**:存量手写 UI 迁库件时,**迁移=等价替换**——每面迁移前后真机逐态截图对照(rest/hover/focus/pending/empty/error 各态),像素差必须为零或是**列明的规范修正**(修正逐条报,意外漂移=打回);库件本身的规格必须写全并测全三类状态:**生命状态**(挂载/首载延迟/卸载时序,如 AsyncButton 的 SKELETON_DELAY、Toast 寿命)、**交互状态**(rest/hover/focus/active/disabled/pending)、**页面与数据状态**(empty/loading/error/超量)。缺一类不许入库。

- 多批并行时开工先 `git status` 圈避让区,别批的脏文件一个字不碰;提交由编排者派 haiku 按清单逐个 add,禁 `-A`。
- 同名的门有两半就跑两半:真机门(`gate:squeeze`)与静态棘轮(`squeeze-gate`)判的不是一件事——真机量重叠,棘轮抓源码违例;只跑一半的判例:Dock 批真机绿却把存量豁免块抄进新文件,棘轮红留给了合树收账才发现。
- 反证纪律:每条守卫断言至少真跑一次「拆掉即红」;回滚反证用备份文件,禁 `git checkout`(冲旁改判例)。
- 闪烁/手感类报障禁纸上诊断:真机复现、量出读数(录屏抽帧 diff 是标准手法),修后同法自证。
- **模块级副作用必须配 HMR dispose(09-01 立法,起因:性能调查在同一帧里抓到两个不同 `?t=` 版本的 `chat-source` 各自的 rAF 回调 —— 热更后旧模块的订阅与推屏环没退役,两台折叠器同时活着各自推屏)**:凡在模块作用域里起的东西——推送订阅、`rAF`/`setInterval`/`setTimeout` 环、事件监听、单例注册(如 `registerBlock`)、跨渲染留存的可变状态——都要在同文件末尾配一段 `if (import.meta.hot) import.meta.hot.dispose(() => …)` 把它们退役。**退役必须复用该模块已有的那一口拆卸**(`reset()` 之类),不许写第二套:两套拆卸迟早漏一格。dispose 自身要幂等;生产构建里 `import.meta.hot` 是 undefined,整段被 tree-shake。判据一句话:**这东西的寿命是不是「这个模块实例」**——是,就要 dispose。
- 读样式表源文本的门先剥注释(病历文本会让断言自红)。
- 验证不改用户状态:真机走查用隔离 store(照 gate 脚本起法),绝不连 `~/.onething`。
- 真机 harness 退出必须收尸:自己起的 vite/electron/server/录屏进程在 `finally` 里逐个杀掉,脚本结尾自查残留(判例:08-31 各批门跑完留下 vite:5199 与孤儿 server 挂到次日,用户在任务列表里数出 11 个)。
- **真机输入探针禁抢用户的机器(09-01 判例:系统级合成输入干扰用户用电脑,用户被迫杀掉全部任务)**:手势/键盘探针一律优先 CDP `Input.dispatch*`(只进目标窗口,不动真光标不抢焦点);系统级 CGEvent 仅拖拽区验证这类非它不可的场合允许,且须收拢成尽量短的一段并在回报里标明「本段会动真鼠标」。窗口起在后台/不抢前台焦点的档位优先。

## 设计协作闭环

- 设计系统经 design-sync 同步(config 在 `.design-sync/`);**本文件的规范摘要同步进设计系统的 conventions**,让 claude design 出稿时自带状态/交互要求——设计稿仍沉默的状态,按第 4 轴在实现侧补齐并回灌 conventions。
- 设计稿与壳既有定稿冲突时(如引用块画左线 vs quote-C 大引号定稿),**以壳的已拍定稿为准**,出入记档回报。
