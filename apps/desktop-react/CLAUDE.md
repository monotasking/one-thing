# CLAUDE.md — React 壳(apps/desktop-react)施工规范

对本目录动手前必读。这里沉淀的是**真机踩过的坑立成的法**,每条都有事故背书;违反即不过审。

## 验收五轴(每批交付必须自证,缺轴打回)

1. **Token 纪律**:组件文件零字面色值/px/ms,一切量入 `src/styles/tokens.css` 对应节(唯一例外:`--fb-*` 品牌色数据节,官方色是数据);状态色只上图标/点,永不换底;焦点环**配方与载体分家**(09-13 收口,正本 `docs/focus-ring-2026-09.md`):样子只有 `tokens.css` 四格 `--focus-ring-{w,color,offset,edge}`(换样式 = 换这四格,零选择器改动;`--accent-ring` 从此只是**染色**不是环),什么时候亮由 `global.css` 一组载体规则说,消费方只在 JSX 那一行自述角色 —— 缺省什么都不写,其余四种 `data-focus-ring="within|active|text|none"`;配方还有一格**上下文** `data-focus-ring-tone`:底就是强调色的那几件(primary 钮 / 选中的勾选框、单选、开关 / 发送键)挂 `"on-accent"`(同色画同色等于没有环,09-13 真机 6 倍放大挖出来的),填错的输入框挂 `"danger"`(text 载体那条带 `:has` 的选择器 0,6,0,会把消费方的红边压掉)。**禁在任何 CSS Module 里写环**(样子 / 亮法 / `outline: none` 三样都算),执法 `npm run ui:consume` 的 `focus-ring-handwritten`(零基线硬闸)。
2. **无障碍**(规范:`docs/design/react-shell-a11y-2026-08.md`):jsx-a11y 零违例;新 surface 必须追加进 `scripts/gate-a11y.mjs` 扫描屏——**唯一的例外是「那一屏在 `gate-a11y` 里根本等不到」**(09-12 判例,T2 `e6fd12ab` / B3-a `b2d46373`):`gate-a11y` 起的是 **server 宿主**,而终端要 `hasTerminalHost()`、浏览器要主进程的 `browser:` 提供者,两样都只在桌面宿主上存在,加进去只会等一片永不出现的叶。所以这两屏的 axe 长在各自的真机门上——`gate:terminal` ⑧ 与 `gate:browser` ⑪,**同一套标签、同一个 legacy 模式**,理由逐字写在两只门的文件头。搬家不是豁免:新面照样要有一屏 axe,只是它住哪由「谁装得出这块面」决定。B3-a 还立了一条顺序法——查找 / 权限卡 / 下载行三件跑在 ⑪ **之前**,让 axe 那一扫顺带扫到它们(卡得先站在屏上才扫得到)。行为件用 `src/ui/a11y/`(roving/list-selection/live-region),照 WAI-ARIA APG 写,不引库。**焦点归属整体归 `src/focus/`**:`ui/a11y/focus-trap` 已删(09-02 R1),模态圈禁的判据现在是 `src/focus/tab-trap.ts`,由那唯一的派发器调用。**新面接树 = 三件声明**:它的 scope id(`focus/scopes.ts` 里加一行)、落点(`restingTarget`,不声明就是根)、认不认 Esc(`onEscape`)—— 除此之外一行焦点代码都不该写。
3. **交互稳定性四律**(规范:`docs/design/react-shell-2026-08.md` §8;根治原语在 `src/data/kernel/`,落地前的手写异步须注释标「临时手写」):
   - 写操作**就地更新**,重拉后台对账,禁「清空→骨架→重灌」;
   - 重拉期间**旧内容保留在屏**,骨架只许首载(`phase==='initial'`)画;
   - 异步动作**必有进行中反馈**(按钮自身变文字+disabled;有 kernel 后走 `mutation.pending`/AsyncButton);
   - 列表 key 稳定,禁整树重挂(零重挂断言:前后是同一个 DOM 节点)。
   - 病型速查:A=重拉清屏骨架闪;B=全局忙布尔把整面禁灰(粒度病);C=整份写回换行身份;E=过快往返的无意义图标闪。诊断工单见提交 495e5146。
4. **状态完备性**:交互组件过状态清单——rest/hover/focus/pending/success/error/empty/**超量**(数据 10×/100× 的形与导航后果:削量、粘头、回顶)。设计稿沉默的状态**照组件规格补齐**,「设计文档里没有」不是 pass 理由。报告带状态清单勾选表。
5. **交互预算(09-10 立法,起因:会话切换在用户真店规模上是 1–2s 的同步阻塞,列表高亮、标题、内容在最后一帧一起换;C1 到 C3 每一单都答对了自己那道题,没有一单被要求回答「点击之后第一帧发生什么」,而每一道门都用几百 KB 的自种账本验收,规范里的「超量」态勾了却没有一个数字)**:凡走会话 / 文件 / 检索这类**按数据规模计价**的路径,交付必须在**真店规模夹具**(`scripts/lib/seed-large-ledger.mjs`,≥50MB 账本 / 400 条消息 / 900 张工具卡,与 2026-09-10 用户真会话同量)上量出下面五个数并进 `gate:chat-layout`:点击后**第一帧**有可见变化 ≤ 16ms;池命中内容上屏 ≤ 100ms;冷载首屏 ≤ 300ms;来回切 ≤ 50ms;流式期间零 ≥50ms 长帧。三条铁律随之成法:①**点击当帧必须有可见响应**——一次交互对应一个长任务(同步阻塞式切换,全有或全无)是结构性违例,不是性能债;内容切换标 transition、按屏进、空闲补,壳与高亮走紧急更新;②**「不重载 / 不卡 / 已治」类结论必须附端到端毫秒数**,没有数字的报告打回,只说「没发网络请求」不算;③**派工单必须带「超量」一格**(夹具名 + 目标数),不填不派。dev 与 prod 两种渲染层都要出数——用户跑的是 `electron:dev`,生产构建上量出的数对它不成立(09-10 判例:prod 215ms 的池命中路在 dev 上是它的数倍)。**这张表 09-12 长出两行**(T2 `e6fd12ab` 定档,两档各一列):**终端**——`seq 1 20000` 喷流期间零 ≥50ms 长帧(就是第五格那句话换了主语,实测最长帧 dev 23–32 / prod 23–27,直接进 `gate-terminal.mjs` 的 `BUDGET`,`TRANSITIONAL` 是**空的**——没有一格今天达不到,空着比填一行宽的数诚实);**浏览器**——一格 tab 切过去 ≤ 50ms(`tabSwitchMs`,吃第 5 轴原数不给过渡值)、逐格切换那一段零 ≥50ms 长帧,以及这条线自己的第三格「遮挡换图」,`BUDGET` 是 100ms 而今天两档都达不到,于是 `gate-browser.mjs` 的 `TRANSITIONAL` 里挂着 dev 320 / prod 300,**退场判据写在那一行上**(壳侧收 `snapshot` → `img.decode()` → 留一帧那条换图链治进 100ms 就删行)。过渡值的体例与 `gate-chat-layout` 逐字同源:**抬 `BUDGET` 是改法,让它恒红只会被人加 `|| true`**。

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
- **收起 ≠ 关闭(09-12 用户拍,上一条的第二格)**:架子收起(快捷键 / 召唤第四格 / 檐上钮 / 预算重钳,四条入口同一只 `toggleShelfCollapsed`)只把树身翻成 `.bodyHidden`(`content-visibility: hidden`)+ `inert` + 宿主自述 `{visible:false, interactive:false}`,**树身保挂载**;只有关闭(`closeShelf` / `closeToDock`,那棵树从 `regions` 里没了)才卸载。判据是「收起→展开前后 `[data-shelf-body]` 是同一个 DOM 节点」。形态的取件口是 `data-shelf-collapsed`,**不许再拿「查不查得到 `data-shelf-body`」当收起**(那是拿挂载当形态读,今天会说谎)。收起后那条细梁把手可以整台藏起来:全局偏好 `shelfRail`(四条边共用),三处入口(细梁右键 / 架子 ⋯ 菜单 / 设置页 Dock 节)写同一格,藏了之后收起的架子零厚度、零边框,取回仍走快捷键召唤与点 Dock 瓦。
- **Dock 只有一个形:一枚独立悬浮的玻璃药丸;两档的差别只有让位(09-13 晚用户拍板,推翻同日早些的「整边浮栏」)**:**常驻 = 药丸 + 让位带**(主区朝那条边让出一截,药丸摆在带里),**自动隐藏 = 药丸 + 零让位**(它平时不在屏上,让了白让)。条的长度**恒为瓦之和**——「该多长就多长」,不随档位、不随边、不占满;皮(玻璃 `--glass` + `--dock-blur` + `--line-1` + `--sh-2` + `--r-dock`)、瓦的大小 / 缝 / 内距 / 磁性放大两档逐字相同,所以 `Dock.tsx` **不订阅 `dockDisplay`**、`Dock.module.css` 里一个字都不必知道此刻是哪一档。**让位带不设任何底色**:这一单里一条 `background` 都没加,`.main` / `.shell` / 各块面的底与 0aa2a0026 之前**逐字相同**——带子露的就是 `.shell` 本来那层 `--surface-0`,底下换哪一页都一样(报障那件「不同页露出不同颜色」是**落点从内衬形换成平移形**治好的,不是靠给带子上色治好的)。判词一句话:**Dock 只占自己那点地方,不改任何人的 background**;推论是**没有 `--dock-ground` 这类 token**,凭空多一格颜色就是凭空多一层。——**历史**:09-13 早些拍过「常驻 = 主区已让出一条带,那条带就是 Dock 自己 → 贴满整条边」(0aa2a0026,样例页 `docs/dock-always-bar-proposal-2026-09-13.html`,页顶已标「已被推翻,留档」),同日晚被用户两句话推翻:「dock 的长度不要默认占满,他应该该多长就多长」「我要的效果是,他不影响其他 element 元素的 background,不需要自己设置,他就是一个独立的悬浮的块」。`.bar` / `.align{Start,Center,End}` / `data-dock-form` / `BAR_ALIGN_CLASS` 随之全删。**那一单留住三件**:①**让位四条边统一成平移形**,落点 `.main` 的四向 padding(打在 `.shell` 上会把架子整体推走、在面板下缘断出异色带,那是 7823cff9 修掉的病;打在 `.center` / `[data-panel-layer]` 上是内衬形,带子的颜色变成底下那块面的,`.composerDock` 那条 `bottom` 覆写也随内衬形一起删——`.center` 整格已经在让位线以上,留着就是让位算两遍);②**让位量 = 条厚 + 两侧各 `--sp-3`**,`--dock-thick = 瓦 + --dock-pad-y × 2 + --bw-1 × 2`——**厚度这一维恒吃 `--dock-pad-y`**(横排钉高、竖排钉宽,两条式子写的都是它;`--dock-pad-x` 是「长的那一维」的内距),09-13 之前 `--dock-reserve-v` 拿 `--dock-pad-x` 且两条都漏了边框,真机量到条外留白 16 / 11 而不是 12;③**容器不进顶栏那一带**。第三件今天的形是:常驻档下 `.dock` 这个 fixed 容器**跨整条让位带**(横边 `left/right: var(--sp-3)`;竖边 `top: calc(var(--topbar-h) + var(--sp-3))` / `bottom: var(--sp-3)`,`--dock-align-*` 归零覆盖沿边那两条 50% 定位),身份是**摆放药丸的 flex 容器**——横边 `row`、竖边 `column`,沿边三档落成 `justify-content`(`.shell[data-dock-reserve='bottom'] .dock.alignXStart` 那一族,横边吃 `.alignX*`、竖边吃 `.alignY*`;特异性 (0,3,0) > (0,1,0));**容器自己不画任何东西**(无 background / 无边 / 无投影),是一块透明的地。判据是 `[data-dock-reserve]` **在不在**,与「让位」同一个事实,不新开一格属性。自动隐藏档一个字不改——仍是那两条「百分比 + 反向 translate」的沿边定位与 `.hidden` 的推出屏外。④**顶栏是这扇窗的顶带,容器永远从顶带之下起(09-13 用户裁定,保留)**:上 / 左 / 右三条带的上端是 `calc(var(--topbar-h) + var(--sp-3))`(= 56),不是 `--sp-3`;底边不动。**「让位把顶栏一起推下去」不成立**——红绿灯与顶栏同一行、必须从 y=0 起(09-01 裁定)。病历是整边浮栏那一单真机量出来的(CDP `elementFromPoint` 3×3 采样):从 y=12 起时 `top` 档整条压在顶栏那一行上(顶栏 y 0–44,带 y 12–74),标签「New session」与 Agent chip **各 9/9 采样点被盖**,`right` 档 Agent chip **3/9**;`left` 档功能上不盖谁,但带顶顶在 macOS 合成的红绿灯底下(x 8–70 / y 10–30),是视觉事故,同一条判据一起治。改后三档**各 0/9**,容器上端 y = 56.00。药丸形下容器透明,盖不盖得住要看药丸落在哪一头(左边 `start` 档就正对着红绿灯),所以这一条照旧。**没有一道门量顶栏**——`gate:squeeze` 的两处预留检查量的是 composer 与侧架子,这一条今天靠判词与这行读数守着。
- **侧栏对齐律(09-13,用户三次拿真机截图画线裁定;正本 `docs/sessions-sidebar-2026-09.md` §8)**:①侧栏里唯一的对齐参照是左侧红灯的中心 `trafficLightPosition.x` + 灯半径 = 22(token `--content-lead-left`,它说的是"这条线在哪",不是任何盒边或墨的起点;无红灯宿主取 24);②每一行都有一格 16px 图标列,**列的中心落在线上**(14–30),普通聊天也画图标(淡灰对话气泡),不预留空列、不省列——判据是中心对中心,与 macOS 侧栏同一规矩;③整块面只许一条文字起笔线:导航行与会话标题都从图标列右边一格起(38);④节名从图标列左缘(14)起,条目靠缩进分层级,不靠字重灰度;⑤悬停 / 选中底色左右各探出同样的距离(线左 16 = 6),行内边距 8 把图标列送回线两侧;⑥檐上标签的图标同样以线为中心;⑦容器左内边距只许写 `calc(var(--content-lead-left) - var(--expose-glyph-w) / 2 - var(--sp-2))`,6 / 14 / 38 这些数一个都不许写成字面量——红灯位置一变整块面跟着走;⑧`gate:sessions` ① 量三件:导航图标与会话行图标的中心 = 线、最左一笔墨 = 线 − 8、盒最左 = 线 − 16。三次错法记着:盒边对线(A1)、墨左缘对线(7174fefd)、图标左缘对线(472593c2),每一次都被截图画线打回——**对齐要先问"对的是哪个点",再动手**。
- **动作单产地=右键上下文菜单**(09-01 判例):一个条目(文件/会话/瓦)的全部动作收进同一张右键菜单,树行与查看区右键同一张表;头部檐只放身份(名+状态丸)与关闭,标题截断须配 Tooltip 全名;设置类(如打开方式)只在菜单一处,禁散落头部下拉。反例:查看器头挤 copy/编辑/Reveal/落点下拉四件,标题被截成 kimi-sli…。
- **禁双击作为动作触发**:macOS 触控板双指点按以双击形态到达、与右键语义打架;打开=单击/回车,动作=右键菜单,详情不设双击入口。
- **图标按钮必须消费 ui 库件**(hover/focus/active 配方随件走),业务面禁手写图标钮样式——hover 不合规范屡犯的病根即各面自绘。
- **hover ≠ active:键盘选择列表的两态纪律(09-01 用户裁定)**——凡有键盘控制选择的列表(@ 文件/ 命令/模型抽屉、快切面板、检索、跳转条…),**active(键盘位)与 hover(鼠标位)是两个状态,两条产地**:改 active 的只有键盘(↑↓/Home/End)与**显式点击**;`mousemove`/`mouseenter`/`mouseover` 一个字都不许改它。**↵ 永远落在 active 上**,不是鼠标底下那一行。hover 是**纯视觉、不进 JS**:由 CSS `:hover` 画(`--st-hover`),与 active 的 `--st-sel` 可同屏,叠在同一行用 `--st-sel-hover`。
  - **二次污染判例(这条法立案的直接起因)**:键盘 ↑↓ → active 变 → `scrollIntoView` 把列表滚一段 → **鼠标一动没动**却换了脚下的行 → 浏览器补一发合成 `mouseenter` → 若 mouseenter 写 active,键盘位当场被拽走(表现为「按一下 ↓ 跳两行 / 跳回去」)。修法**不是**给 mouseenter 加「鼠标真动过吗」的判据(要维护、有边界:首次加载没动过、触屏、缩放),而是**让这条链根本不存在**——mouseenter 不写 active。
  - 唯一原语 `src/ui/a11y/list-selection`(`useListSelection`:受控/自持、走法、夹范围、`rowRef` 滚入视野;键表与 `a11y/roving` 同源)。焦点**真的落在项上**的那一族(菜单/tab 条/分段器)照旧用 `a11y/roving`——它的当前项就是 `document.activeElement`,压根没有第二个下标可被污染。
  - 执法:`npm run ui:consume` 的 `kbd-select-hover` / `kbd-select-handwritten` 两条;反证测试见 `src/ui/__tests__/list-selection.test.tsx`(mouseenter 后 active 不变、scrollIntoView 后 active 不跳),消费面各自还有一份(`palette.test.tsx` / `Composer.test.tsx`)。
- **裸 `<button>` 三类判**(`ui:consume` 的 `bare-button-*`):①文字动作钮→`ui/Button`·`AsyncButton`;②图标钮→`ui/IconButton`;③结构性交互件(瓦/卡/行/琴键/选项,视觉本该定制)→**不违例但不许裸着**,消费 `ui/ButtonBase`(只清 UA、`:where()` 压零特异性,一个像素都不画,焦点环仍走全局)。**①/③ 边界(09-02 批 6 细化)**:带文字不等于①——**行内微型文字动作**(fs-micro、无边无底、与正文同行的重试/展开/丢弃/消息脚注动作)是③,走 ButtonBase 保本地皮肤;换成 28px 描边的 `ui/Button` 是改版不是等价迁移。判据是「它有没有自己的按钮形」:有边或底、独立成钮的文字动作才是①。
- **库件 API 两种风格,判据是集合开不开放(09-01 库自审立法)**:选项是**封闭集合、行形态统一**的件走数据表驱动(`options`/`items` 数组 —— Select/Segmented/Tabs);项里装什么**由消费方决定、形态开放**的件走复合 children(Menu 族/RadioGroup)。新库件先答「项的内容谁说了算」再定 API 形状;两种混用(既收表又收 children)禁止。
- **浮层行为单产地 = `ui/float`(09-01 库自审立法,09-02 R1 收窄一格)**:点外关、定位与跟随只许经 `useFloatDismiss`/`useFloatPosition`,库件与业务面一律禁止手写(判例:Menu 与 Popover 曾各抄一份,产地越多越漂)。**Esc 那一件已经不在这里** —— 它归响应链:浮层声明 `onEscape`(`float`/`modal` 档缺省就是「关自己」),由唯一那个派发器沿活动路径由深到浅问(见下「响应链」节)。「Esc 该由谁认领」那条判例修过三轮(microtask → 改相位 → 浮层栈),三轮都是在没有树的情况下拿 DOM 事件顺序硬凑,`useFloatDismiss` 的 `escape` 参数与整只浮层栈随 R1 一起退役。定位两档的裁定:**矩锚跟滚**(rect 档,贴着元素的浮层 —— Select 面板/Tooltip —— 滚动/resize 时跟随锚点重定位),**点锚不跟滚**(point 档,光标坐标开出的右键菜单滚动时维持原位,变更此裁定须再拍板);两档都在 resize 时重 clamp 进视口。
- **原生视图三条(09-12 立法,B0 `69219d30` 深查 §9 + B2 `76d98911` 落地;占位格 `content/native-view/NativeViewSlot.tsx`,通道词汇表 `electron/native-view-protocol.ts`)**。这三条是**为所有原生视图立的**,不是浏览器的家规——`NativeViewSlot` 里没有一个 tab / url / 导航的字,第二种原生视图(方案 §7 演练乙点名的 PDF 阅读器)不会长出第二只占位格,也不会长出第二条 IPC,只会多几个 id。
  - **① 原生视图永远压在 DOM 之上,所以「盖上去」必须走「遮挡 = 快照」。** 那一格 DOM 这一侧永远是空的,CSS 的 z-index 对它一个字都不管用:任何浮层盖上来,不发 `occlude` 就是**盖不住**。判据三支(**之一命中即 `occlude`,全不命中才 `unocclude`**):①压在这片地**上面**的浮窗与它相交——「上面」是硬的,要比 `floatOrder` 的名次,不比名次的话一片长在浮窗里的视图会拿自己那扇窗把自己永远遮住,而且矩形要从 `[data-float-body]` 上**现读**(拖窗那一段 store 里的矩形是落后的);②`focus/registry` 上挂着 `kind: 'float' | 'modal'` 的活作用域(菜单 / 弹层 / 命令面板);③拖拽中。撤图要**晚一帧**(`unocclude` 发出去之后主进程还要一拍才把视图放回来,当场撤图会露一帧底色),铺图要等 `img.decode()` 之后那一帧。**`visible` 与「被遮」是两格不许并**:主进程 `layout.ts` 的 `applyVisibility` 本来就是 `visible && !occluded`,并起来等于同一个判据算两遍,更要命的是惰性视图——一格「生下来就被遮」的 tab 会永远 materialize 不出来,于是永远拍不到快照,人看见的是一块底色而不是一张图。
  - **② 原生视图拿着焦点时,渲染进程的派发器是失明的——键位表要**下沉**,不是在壳里再加一个监听。** 页面里按的键根本不经过壳的 window,所以:`content/native-view/keymap-downlink.ts` 把**保留表**(判据见上一节 ⑦:`reserve` ∧ 真绑着 ∧「`app` ∨ 在场作用域答得出」− `claims`;在场的是那片视图自己那一格 ∪ `NATIVE_VIEW_HOST_SCOPES`)整壳一份、引用计数地推给主进程 `keymap-bridge.ts`,主进程 `before-input-event` 截住保留键 `preventDefault` 并推回,壳收到后经 `focus/dispatch.ts` 的 `dispatchSyntheticKey` 合成一个事件交给**那唯一的派发器**——**不许挂第二个 keydown 监听**(I2 一个字没松)。推论是这条法最值钱的一半:**新增一条命令、或往 `FOCUS_SCOPES.browser.answers` 加一格,自动就在下沉表里,不用手加第二处**(B3-a 把 ⌘F 加进浏览器那一族时「键位下沉表自然带上」,零改 downlink)。焦点是**双向**的:树把焦点交给这块地 → 发 `focus` 动词 → 主进程 `webContents.focus()`;主进程推 `focus` → `activateScope`;推 `blur` → **什么都不做**(焦点去哪由那一边决定,抢回来只会打架)。
  - **③ 禁拿页面侧 `document.hasFocus()` 当判据。** B0 实测:壳这一侧与原生视图那一侧对「谁有焦点」的回答不一致,拿它当判据是拿一个会说谎的读数做分支。焦点归属只认 `focus/` 那棵树与这条通道上的 `focus` / `blur` 事实。
- **设置页 = 一张页表,左导航 + 右页(2026-09-13 用户拍「把模型设置移到设置中去;设置增加 theme 选择」)**:页表唯一产地 `content/settings/pages.tsx`(`SETTINGS_PAGES`,`layout: 'form' | 'fill'` 是页自述的一格数据),外壳 `content/SettingsMock.tsx` 里**没有一个页名**,导航与内容读同一张表 —— **加一页 = 表上一行**;当前页落盘 `content/settings/store.ts`(`onething.settings-nav`,水合按形状归一不看版本号),深链口 `openSettingsPage(id)`(`reveal` 档,开着不收)。「分区不分页」那条旧判词随模型服务并入而作废:它是一块要吃满高度的两栏面,单列表单只能得到嵌套滚动,所以它是唯一的 `fill` 页。**模型服务瓦退役**(`stage/items.ts` 常量 `PROVIDERS_ITEM_ID` 只剩 v11 迁移在用):stage persist 10→11 用泛化的 `stripRetiredItem` 清痕迹,拼贴树里残留的 `panel:providers` 不靠版本号 —— `ContentKind.exists?(ref)`(种类自述「这一个实例今天还认得出吗」,`panel` 答 `findItem`),`workbench/store` 的 `sanitize` / `normalizeHidden` 改问 `isKnownContent(ref)`,每次水合都跑。**主题选择**住外观页「主题」节(`content/settings/ThemeSettings.tsx`):三行即点即生效,写的是后端已有的 `settings.theme` 与 `general.{light,dark}ThemeId`,数据层 `data/theme-settings-{port,model,source}.ts` 逐条照 browser-settings 那三件的形(端口 = 平台调用面子集、整份写回「当场读一份新的 → 合一格 → 整份写回」、成功后 `refreshThemeFromSettings()` 立刻重贴);accent(`general.colorTheme`)没做,用户没要。真机门 `gate:a11y` 第五屏改成逐页点导航再扫(第一遍就挖出存量 `heading-order`:h1 之下直接 h3,修法是页里一句只念不看的 `<h2>`);`gate:layout` 的夹具瓦从 `providers` 换成 `notifications`(场景 ① 用 `search`,因为 A9 的前提是 `notifications` 之前没人碰过)。
- **检索面的正本是 `docs/search-panel-2026-09.md`**(2026-09-06 十步落地;规矩 R1–R12、三张状态表、分页状态机、十步表逐行带 sha)。改 `src/search/**` 之前读它,别照 `SearchPanel.tsx` 的注释猜 —— 那张文件头的表与代码不符地活过两个月,正是 09-05 报障的一半。
- **分页四条不变量(检索面立的,凡「一页一页往下加」的列表都算)**:同一把键(`limit` / 页码 / cursor **不进**查询键,翻页是对同一格 `patch` 追加)、页在格内累加、加载时旧行一像素不动、**行集增长绝不触发滚动**(滚动只随「选中换了」变,而且落位那一下 `by==='reconcile'` 不滚)。第四条的反证要数**滚动指令的次数**,不是量 `scrollTop` —— 落位恰好在视野内时 `scrollIntoView` 是恒等操作,量位移会让反证空过(⑦ 真踩过,⑨ 补的 `SearchList.scroll.test.tsx` 是补票)。

## 快捷键:一张命令表、响应者认领(09-01 立法「三层」,09-12/13 K0–K5 重铸;正本 `docs/keymap-responder-2026-09.md`)

09-01 那条判据一个字没变:**一个键属于哪一层,由它需不需要一个「由焦点决定的目标」决定**,不由它好不好按决定。
变的是它靠什么成立。从前这句话散在五个产地(全局表、七块面各自的 `keys`、终端礼让表、Electron 默认菜单、
以及「没人认领所以掉给页面」这一档),于是**没有一个人持有「⌘T 是什么」这句话** —— 起因就是用户报的
「焦点在浏览器里按 ⌘T,该开的是一格新浏览器标签,不是一条新会话」。K0–K5 把那五处合成一张表。

**① 命令表是唯一产地(`src/keymap/commands.ts`)。** 一条命令一行,`app`(应用层有没有兜底)与
`nativeView`(焦点在原生视图里时要不要先于页面截下来)两格是**数据** —— 派发器、菜单投影、保留表
一行都不读命令名。从前的「全局档」原样进表成了 `app: true` 那一族,从前七块面的局部键原样进表成了 `app: false` 那一族
(K2 / K3 后来新长出来的标签族与内容族也在后者里):**「没有应用层兜底」正是「它要一个由焦点决定的
目标」那句判据的另一种说法**。**一条命令多个键面是一等形状**
(`defaultCombos: readonly Combo[]`):`files.detail` 的 ⌘I 与 ⌘↵、`tab.next` 的 ⌘⇧] 与 ⌃Tab 各是
**一行两键**而不是两行两义 —— 说得出「谁占着 ⌃Tab」的是冲突规则(按组合找命令),不是表的行数。
两格声明纪律随之立住:`Combo.offHand` = 「按住**另一枚**修饰键、主修饰键没按」(mac 上是 ⌃、
Win / Linux 上是 Win 键),与 `meta` / `ctrl` 互斥,补的正是 T1 立法时说不出口的「我要的就是 Ctrl 那一枚」;
而当一行在两台机器上**本来就是两档**时(召唤终端要的是「两台都按 Ctrl」——mac 上那是另一枚、别处恰是
主修饰键),走**出厂表**的 `byPlatform` 分档,**不给 `Combo` 再开一根轴**:加一根轴等于
`matchCombo` / `sameCombo` / `formatCombo` / `chordOfCombo` 四处各多一支,而这件事的真名是
「**表的这一行**在两台机器上不一样」。

**② 谁答得出由作用域自述,命令表里一个作用域的名字都没有。** 声明这一头是 `focus/scopes.ts` 的
`FOCUS_SCOPES[id].answers: ScopeAnswer[]`(「这种面**可能**答哪些命令」,每格可带一个 `labelKey` 覆盖
命令的通名 —— 查找的通名是「查找」,终端说「在这块屏幕里查找」、浏览器说「在这一页里查找」、查看器说
「在这份文件里检索」:三句话仍然是三句,只是挂在**响应者**上,不再各绑一次键)。实例那一头是
`FocusScope` 的 `commands={{ 'view.find': fn }}` —— 键是**命令 id**,不是各面自造的 action 名 ——
而且是**动态**的:叶没有活动 tab 时 `tab.close` 是 `undefined`,浏览器刚开那一格没有历史时 `nav.back`
是 `undefined`。「声明里有」与「此刻交得出」是两件事,派发器问的永远是后者。`ScopedKey` / `keyHandlers` /
`scopedCollisionsOf` 三个名字**已退役**,别照旧文档写。

**③ 认领(`claims`)是「接住并放行」,与 `answers` 方向相反。** 作用域声明 `claims: Combo[]` =
「这几个键归里面那台程序,壳别碰」;派发器命中时**不跑任何东西、不 `preventDefault`、不再往外问**,
事件照常落到 xterm / 页面手里。今天只有 `terminal` 一格有(Win / Linux 上 PTY 要的那五个 Ctrl+字母,
判词整段在 `content/terminal/key-courtesy.ts`);实例侧一格开关 `claiming`(终端的查找框开着、光标在
里面时整族让开),与 `commands[id]` 缺席同一个形。它**不是命令** —— 不进改绑表、不进原生视图保留表
(页面本来就该拿到它)。从前它被塞进「局部键 + 一个把控制字节写回 PTY 的 action」的形里,那是两类东西
挤在一个壳里:让开之后 xterm 收到原生 keydown 自己写 `\x10`,**少一次翻译也就少一份「哪个字母对哪个
字节」的第二真相**。

**④ 派发器仍是那唯一一条(`focus/dispatch.ts`),`routeKey` 五问。** 候选集(`lookupCommands` 回这个键上
绑着的**全部**命令)→ 沿活动路径由深到浅,先问 `claims`(命中即 `target:'claim'`,让开)→ 再问
`node.commands[c]`(命中即那格响应者做)→ 都没有才轮到候选里 `app: true` 那一条 → 否则**放行**,
不 `preventDefault`,页面 / PTY / 系统菜单接着走。「局部先接、没接住放行全局」这条 09-01 的裁定一个字
没变,它由**活动路径的深度**保证,不靠冒泡序。菜单栏点一项走的是 `routeCommand`:**与 `routeKey`
同一条判据**,少了「按键」那一半(`nodeAnswers` + `findCommand(...).app` 是抽出来共用的,单测钉
「两只对同一棵树逐字相等」),所以**菜单画灰与按键不响永远是同一件事**;它不问 `claims` —— 那是
「别截这个键」,不是「别做这件事」。

**⑤ 冲突规则一条,出厂表自己也要过(`comboConflictBetween`)。** 一个键上的多条命令:`app: true` 的
**至多一条**(应用层兜底没有「谁先」可言,两条就一定有一条永远轮不到);其余每两条的 `answers` 作用域
集合**两两不交**(不同时在场才许共键)。⌘L 上 `browser.address` 与 `viewer.gotoLine` 合法;一条 app 级
与一条跟焦点的共键合法 —— 那正是三层那句裁定。`bindCombo` 拒绝用户改绑时说得出**撞的是谁、按哪一条
规则撞**:撞车不是错误,但不许**静默**。判例:从前那张「撞车表」把本该是**设计**的东西当**事故**列给
设置页(「查找在每块面里都是 ⌘F」不该是三行恰好相同的巧合),它随 K0 退役;而出厂表从前**没有**冲突
检查,08-31 的 ⌘⇧O 撞车正是长在那块土壤上,今天全表过规则由用例钉着,三个内置键位组各跑一遍同一条。

**⑥ 有效键三层:用户逐格覆盖 ▷ 当前键位组 ▷ 出厂表(`effectiveCombos`,K5)。** 缺席往下落,
**显式 `null` = 解绑**且赢过下一层(所以问的是 `in`,不是真值)。内置三组 `default` / `vscode` /
`jetbrains`(`keymap/profiles.ts`),只映射**有对应物**的命令,没有的留空往下落到出厂表;用户组 id 一律
`user:` 打头,**导入即多一组**、不覆盖内置组,导出的是**当下那张有效表**。认不出的组名落回出厂组 ——
一个认不出的组名最坏的后果应该是「键位回到出厂」,不是整台壳一个快捷键都没有。改表形要迁移
(`KEYMAP_PERSIST_VERSION` 今天是 5:K0 把旧的单个 `Combo` 包成 `[Combo]`,K2 把退役的 `session.new`
覆盖项丢掉)。

**⑦ 原生视图保留表从命令表派生,不是第二张表(`content/native-view/keymap-downlink.ts` 的
`boundChordsFor`)。** 判据写成了数据:`nativeView === 'reserve'` ∧ **此刻真绑着键** ∧
(`app` ∨ 这几格在场的作用域里有人答得出)− 在场作用域的 `claims`。第三条是「⌘S 不该被推下去」的判据
(只有查看器答得出,而查看器与那片原生视图不会同时在场,推下去只会让页面自己的 ⌘S 变成一个哑键);
减 claims 是因为那几个键页面本来就该拿到。在场集合除了那片视图自己报的那一格(`browser` / 将来的
`pdf`),还要加上 `NATIVE_VIEW_HOST_SCOPES = ['leaf']` —— **一片原生视图永远住在一格 tab 里**是这条
下沉链的**结构前提**,不是浏览器的属性,所以 ⌘T / ⌘W / ⌘⇧T / ⌘⇧[ ⌘⇧] / ⌃Tab / ⌘1–9 在网页焦点下
也到得了壳(Chrome / Safari 对自己那几个键就是这么做的)。推论仍是这条法最值钱的一半:**加一条命令、
或给某块面的 `answers` 加一格,自动就在下沉表里,不用手加第二处**。

**⑧ 应用菜单是壳自己设的,而且它是命令表的投影**(`electron/app-menu.ts` + `app-menu-install.ts` +
`src/keymap/menu-projection.ts`)。起因量在 K1 开工第一步:Electron 在没人设菜单时会**自动装一张没人
审过的键表**(File→Close ⌘W、View→Reload ⌘R / Force Reload ⇧⌘R / Toggle DevTools ⌥⌘I / ⌘0 / ⌘+ /
⌘−、Window→Minimize ⌘M…),而它的目标永远是**整台壳**:焦点在网页里按 ⌘R,页面不处理 → 默认菜单的
`reload` 角色 → `BrowserWindow.reload()` → **重载整台壳**(终端全 detach、拼贴树重建、在飞的流丢 UI
状态,`electron/terminal-reload.ts` 就是给这件事收尸的)。所以三条:①壳自己 `setApplicationMenu`,
prod 档 reload / forceReload / zoom* / toggleDevTools / close **一个都不放**,Edit 那八个角色
(undo/redo/cut/copy/paste/pasteAndMatchStyle/delete/selectAll)**必须留** —— 没有它们 macOS 上输入框里
⌘C/⌘V 不工作(这一条真机门证不了,靠单测);②`KEYS_RESERVED_FOR_CONTENT`(⌘R / ⌘W / ⌘T / ⌘N / ⌘+ /
⌘− / ⌘0)是「还给内容层的键」的**唯一产地** —— 菜单这一侧要能单独证明「我没占着别人的键」,而那个
证明只有对着同一张表做才算数;③K4 起菜单栏那几节由 `projectAppMenu` **纯函数**画出来(`menuFamilyOf`
按 id 的**形状**分命令 / 标签 / 内容 / 面板四节,不列名单;i18n 与「此刻谁答得出」都是参数),骑
`keymap` 那条下沉动词(`{chords, menu}`)过去,点击 `{kind:'command', id}` 推回壳走 `dispatchHostCommand`
→ 那唯一的派发器,**不合成假按键、不挂第二个监听**。**每一项 `registerAccelerator: false`** ——
菜单只是投影,真正的派发仍是壳这一条;注册了就是同一个键响两次。

**⑨ 出厂键一览与 09-12 的四条裁定。** 跟焦点的:⌘N `content.new`(新建**这一种**内容)、⌘T `tab.new`
(同类再开一格)、⌘W 关这一格、⌘⇧T 重开、⌘⇧[ ⌘⇧] 与 ⌃Tab ⌃⇧Tab 换格、⌘1–9 第 n 格(第 9 条是
「最后一格」)、⌘F 查找、⌘S 保存、⌘L 地址栏 / 跳到某行、⌘I 与 ⌘↵ 详情、⌘[ ⌘] 后退 / 前进、
⌘R 重载**这块内容**、⌘= ⌘− ⌘0 页面缩放。应用级的:⌘⇧F 检索面、⌘, 设置、⌃\` 召唤终端(两档写出来是
同一个手势)、⌘E 会话总览、⌘J agent、⌘⇧O 目录、⌘⇧W 工作区面板、⌘⇧↵ 真全屏、⌘⌥⇧← → 标签换序、
⌘⌥← → ↓ ↑ 四条架子(方向即语义)。**四条裁定**(09-12 用户口述,三条推荐全部被否):
①**⌘N 不是全局键** —— 原话「我正在看浏览器,点了 ⌘N,后面新建了一条会话,怎么个事」:`session.new`
这条全局命令**退役**,⌘N 跟焦点走,焦点不在任何内容里就**不响**;「不响」是裁定的直接推论,
真机用下来觉得空就补一个**响应者**(Dock 答「新会话」),**不许加回全局兜底**。②**⌘1–9 不给工作区
槽位**(原话「非常讨厌这个设计」,推翻 08-31):`workspace.slot:*` 命令留着、**出厂解绑**,想要的人自己
绑一个。③**⌘P 不给检索面** —— ⌘P 在全世界的浏览器里是「打印这一页」,而保留表会把它截在页面前面,
那不是决定是副作用:检索面出厂改 ⌘⇧F(VS Code / JetBrains 两家「全局搜索」的同一个键),⌘P 出厂不绑。
④**键位组与导入**是用户当场提的新需求,落在 K5。**改既有键位是用户的拍点,不许顺手动。**

**行内结构键仍不进任何表**:方向键 / ↵ / Space / Tab / Esc 的 DOM 焦点语义(理由在 `keymap/types.ts`
顶部:它们是这套形态语法本身,可配置就等于不一致)。Esc 那一件归下面的响应链。

**键位内核:`matchCombo` 按下侧分平台,`platform` 必填(09-12 立法,T1 `d6e31abb`)。**
起因是终端进壳当天真机挖出来的:内核把 **⌘ 与 Ctrl 当同一位**,于是 mac 上打字打一半
按 Ctrl+W(readline 的删词)命中了 `⌘W`,把跑着的 shell 连叶一起关掉。修法是把
「主修饰键」拆成两侧:**声明侧** `primaryOf` 不动(`sameCombo` / 冲突规则照旧按抽象的
「主键」说话),**按下侧** `primaryPressedIn(e, platform)` 认真键——**mac = `meta && !ctrl`,
其余 = `ctrl && !meta`**;再加一句 `offHandPressed`:那枚修饰键按着
就不是这一条(否则 mac 上 Ctrl+⌥X 会命中 `{alt,x}`)。`matchCombo` / `lookupCommands` /
`routeKey` 的 `platform` 因此是**必填参数**,`focus/dispatch.ts` 量一次递进去——
新写一条判键的路,拿不到 `platform` 就编译不过,这是有意的。
**T1 留的那两条账 K2 已结清**(别再当成开着的):`offHand` 让声明侧说得出「就是另一枚」,
`formatCombo` 在 mac 上把它画成 ⌃、别处画 Win;`toggle:terminal` 走出厂表分档,
不再读作「主修饰键 + 反引号」。

**陌生能力演练(仓根 09-02 法)。** 加**一条命令** = `keymap/commands.ts` 一行 + 那块面 `commands` 里
一格(设置页、冲突检查、原生视图保留表、菜单栏自动带上)。加**一块面** = `focus/scopes.ts` 一行
`answers`(要礼让就再一格 `claims`)+ `focus/types.ts` 一格 id + i18n 一句;`keymap/commands.ts` /
`focus/dispatch.ts` / `KeymapSettings.tsx` / `keymap-downlink.ts` / 主进程**零改动**,设置页自动多出
「也在:这块面」。加**一种内容** = `workbench/kinds.ts` 那份 manifest 里的 `spawn` / `snapshot` /
`restore` 三格 —— **叶是这些能力的唯一读者**(`tab.new` 问活动 tab 的种类有没有 `spawn`,没有就答不了、
让出去),派发器与命令表里**不出现任何种类的名字**。三条的答案都是「能力自己的模块 + 一行登记」,
所以这根骨架抽到位了。

## 响应链(09-02/03 立法,设计 `docs/design/react-shell-focus-2026-09.md`)

壳里任何时刻恰有一条**活动路径**(从根到最深那块能接键盘的面);所有键盘输入、Esc 退层、
焦点进出全部由这条路径决定。立法起因:从前 13 个 keydown 监听、22 处 `.focus()`、
6 处读 `activeElement` 分属八套互不认识的机制,「谁在接键盘」没有一个人持有答案 ——
用户报的「⌘F → Esc → ⌘F 再也开不出来」只是病根显形。

**五条不变量**(每条都有门或单测钉着):

- **I1** `document.activeElement` 永远不是 `<body>`(壳还没挂载那一瞬除外)。三处收回:卸载 / inert 路的 `settle()`、`focusout` 且 `relatedTarget === null` 的微任务复查、派发器每次 keydown 开头。
- **I2** `keydown` 监听只许住在 `src/focus/` —— 全仓就那一条(`focus/dispatch.ts` 的 window 捕获)。唯一的例外是 `ui/a11y/roving.ts` 的容器级方向键,理由写在它自己的命中处(容器级、只接结构键、只在作用域内部移动)。
- **I3** `.focus()` 只许出现在 `src/focus/` 与 `ui/a11y/roving.ts` / `ui/a11y/list-selection.ts` / `ui/inline-edit.ts` —— 后三处是作用域**内部**的移动,不跨作用域;跨作用域搬焦点一律走 `activateScope()`。
- **I4** 每个 Placement 宿主层(舞台 / 浮窗 / 架子 tab 层 / 盖层)的根元素都带 `data-focus-scope`。
- **I5** 快捷键那条判据不变,只是产地合一(K0–K5,见上一节):**一张命令表**(`keymap/commands.ts`)、
  响应者沿活动路径由深到浅认领、应用层兜底只给 `app: true` 那一族、结构键不进表。「局部先接、没接住
  放行全局」靠的是**活动路径的深度**,不是冒泡序;菜单栏点一项走 `routeCommand`,与按键同一条判据。

**七条行为规则**(用户 09-02 口述模型,与 Apple HIG / WAI-ARIA APG「管理焦点」一致):

1. 任何时刻恰有一个第一响应者;应用启动时是主内容(有会话则是它的输入面板)。「启动时没有焦点」是错觉 —— 焦点环只在键盘会话亮(08-28 判例)。
2. **打开什么,焦点进什么**:开会话 → 它的输入面板;从 Dock 开一块面 → 那块面。**落焦的形是「开的人点名、被开的那一格挂载时自己取走」,不是开完当场 `focus()`**(09-12 判例,T1 `d6e31abb`,与 `stage/summon.requestFocusOnOpen` 同族):启动瓦开出一格内容,`placeRef` 之后那一拍**树上只有叶、没有内容那一格**,`focusIntoRefAfterCommit` 当场落空——焦点送不进新开的终端就是这么来的。对应的另一半是:把宿主 DOM 挂上去要走 **ref 回调而不是 effect**(子 effect 先于父跑,落焦那一刻 xterm 的 textarea 还不在文档里)。**留账**:目录那块瓦有同一个焦点缺口未修(`stage/focus-follow` 判的是 `placements[瓦 id]`)。
3. **挪到哪,焦点跟到哪**:拼舞台 / 钉到边 / 撕成浮窗,焦点跟着那块面走 —— 宿主在**落定之后**`activate()`,而那一句必须排在 React 提交之后(判据留在纯函数 `stage/focus-follow.ts`,写在 store 的写点上真机当场证伪:那一刻宿主层还没挂上来)。
4. **导航器里浏览不抢焦点,确认才抢**:文件树单击只显示、焦点留树;↵ 焦点进查看器(本台禁双击作动作,所以没有双击那一格)。
5. **关掉什么,焦点回打开它的地方**:**结构性的**,不靠调用方记得 —— 树在第一响应者换人那一刻记一格 `returnTo`,卸载时 `returnTo` → 父链依次回落。写浮层的人不需要知道有归还这回事。
6. 焦点永远不落在「没有东西」上(= I1)。
7. **Esc 从第一响应者开始往外退一层**:沿活动路径由深到浅问 `onEscape()`,第一个答 `true` 的消费掉;`root` 的 `escapeTopmost()` 是最后一环;没人答 true 就**不** `preventDefault`(输入法组字等后面的消费者照旧)。

**执法**:`npm run ui:consume` 的三条**零基线硬闸** `keydown-outside-focus` / `focus-outside-focus` / `active-element-read`(不进 baseline 文件,一条新命中直接红;确实该留的在命中处上方 8 行内写 `ui-consume-allow: <规则> — <理由>`),加真机门 `npm run gate:focus`(十二个场景,已进 `npm run verify`)。交互时序类改动**必须真机对照**,jsdom 的绿不算数(08-30 判例)。

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
- **量会移出屏的元素,目标坐标必须取自它「在位时」的矩形**(09-01 判例:回身窗口假红——探针读了 Dock 藏起后的 live 矩形 y=903 已在视口外,指针到不了,误报产品回归并空耗一轮排查;产品侧对应的法是 settledDockRect「停稳位由身量算」,探针要遵守同一条)。
- **离屏档从 09-12 起有两种,选错那一档量的是节流器不是产品(B0 `69219d30`-④ 实测,`main.ts` 落地在 B2 `76d98911`)**:老那一档 `ONETHING_GATE_HEADLESS`(`show:false`、不 focus、不进 Dock)下,Chromium 把**整扇窗节流到 1Hz**——心跳从 16ms 掉到中位 1000ms(藏起来的原生视图同理,放出即恢复)。所以**凡与页面时间有关的量项**(多少毫秒上屏 / 长帧几个),门必须走 `ONETHING_GATE_OFFSCREEN`:窗口改 `showInactive` 起**在屏外**(macOS 会把它钳到 `[0,33]`,不抢焦点),`main.ts` 里那一行 `show()` 一个字没动——它是 headless 那一档的**细化**,不是另一条路;实在要留在 headless 档就得在门里 `setBackgroundThrottling(false)`。今天走屏外档的是 `gate:browser`。**「真机门不许抢用户前台」那条法一点没松**——这一档同样不上前台、不动真光标,换的只是「被节流」这一件。
- **门的读数不许把门自己的时间算进产品,取样窗口要跟着被量的那一段走(09-12 判例,T2 `e6fd12ab` 把 B2 的一个假红判掉)**:两条同时踩上了。①`PerformanceObserver` 的 `buffered: true` 会把**整道门跑到此刻为止的历史帧**一次性交过来,于是「逐格切 8 格」那一段收到的长帧其实是开壳、装配、首屏留下的——逐格切换这类**分段**量法必须**切窗口取样**(那一段开始时开、结束时关),不能一只 observer 从头开到尾。②门自己 `delay()` 的睡眠**不是产品的时间**:B2 报的「8 格逐格切换 688–712ms / 每格 85ms」里 **640ms 是 `delay(80)×8` 睡的**,产品那一侧每格 `activate` 往返 prod 1–5 / dev 2–8ms,零 ≥50ms 长帧。判词一句话:**报一个数之前先问「这段时间里有多少是门自己花的」**——真值量出来之后 `tabSwitchMs` 直接吃了第 5 轴原数 50ms,余量一个数量级,而假值差点变成一行永久的过渡阈值。
- **真机输入探针禁抢用户的机器(09-01 判例:系统级合成输入干扰用户用电脑,用户被迫杀掉全部任务)**:手势/键盘探针一律优先 CDP `Input.dispatch*`(只进目标窗口,不动真光标不抢焦点);系统级 CGEvent 仅拖拽区验证这类非它不可的场合允许,且须收拢成尽量短的一段并在回报里标明「本段会动真鼠标」。窗口起在后台/不抢前台焦点的档位优先。

## 设计协作闭环

- 设计系统经 design-sync 同步(config 在 `.design-sync/`);**本文件的规范摘要同步进设计系统的 conventions**,让 claude design 出稿时自带状态/交互要求——设计稿仍沉默的状态,按第 4 轴在实现侧补齐并回灌 conventions。
- 设计稿与壳既有定稿冲突时(如引用块画左线 vs quote-C 大引号定稿),**以壳的已拍定稿为准**,出入记档回报。
