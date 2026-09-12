import type { Locale, MessageKey } from '../i18n'

/**
 * 形态机的形状。这里只有数据,没有 React、没有 DOM。
 *
 * W1 起形态不再是三态枚举,而是 **Placement** —— 一个 item 当下落在哪儿:
 * dock(收在坞里,缺省)/ stage(舞台,全系统至多一个)/ float(浮窗)/ edge(停在某条边的架子上)。
 * 这四个是互斥的:placements 表是唯一事实源,一个 id 在表里只有一条记录,
 * 「它在钉栏还是在浮窗」不再靠两个数组各说各话。
 */
export type ShelfSide = 'left' | 'right' | 'top' | 'bottom'

export type Placement =
  | { kind: 'dock' }
  | { kind: 'stage' }
  | { kind: 'float' }
  | { kind: 'edge'; side: ShelfSide }

/*
 * ── 「盖」(`{ kind: 'cover' }`)W2 退役 ──────────────────────────────────
 * 拍点 ②(09-04 用户已拍):**扔掉** —— 盖想成为的东西就是真全屏(设计 §4)。
 * 全屏因此**不是**一种 Placement:它是拼贴台的一格瞬态
 * (`workbench.full = { ref, from }`,设计 §1.3),树一个字不动、只把那片叶的
 * 活动 tab 投影到最上面那一层。所以这条联合里没有它,而下面的
 * `PlacementMemory` 里有 —— 记忆记的是「上次是怎么打开的」,不是「它住在哪」。
 */

/** 形态的名字 = Placement 的 kind。组件想分支时读它,别自己拼条件。 */
export type StageForm = Placement['kind']

/**
 * 「放得下东西」的那三种落点。dock 不在其中 —— dock 是**缺席**,不是一个地方,
 * 所以「把它放到 dock」和「记得它在 dock」这两句话都没有意义。
 */
export type MemorablePlacement = Exclude<Placement, { kind: 'dock' }>

/**
 * **一次落定说得出口的全部去处**(W2)= 四种住处(含「回 Dock」)+ 全屏那格瞬态。
 * 它是 `stage/store.openAs` 与 `stage/placement.placeAs` 收的那个参数。
 *
 * 全屏在这里而不在 `Placement` 里:它不是一个住处(树里没有它的位子),但它**是**
 * 一种「我想怎么打开这块面」的表态。落地时由 `stage/placement.placeAs` 的 full 那一支
 * 把这件事说给 store 听,再由 store 派给拼贴台的 `enterFull` —— 形态机自己一格都不写。
 */
export type PlacementTarget = Placement | { kind: 'full' }

/**
 * **「打开方式」那张菜单说得出口的那几档** = 上面那张表去掉「回 Dock」。
 * 与 `MemorablePlacement` 的关系一句话:多一个 `full`。
 */
export type OpenPlacement = Exclude<PlacementTarget, { kind: 'dock' }>

/**
 * 一块瓦的**位置记忆**:你把它放在哪,它就记得哪。
 *
 * 它不是配置 —— 配置是你事先声明的意图,记忆是你事后留下的事实。
 * 所以它没有「跟随默认」这一档:一条记忆要么说得出具体落点,要么根本不存在。
 *
 * 与 Placement 的差别正好是「重开时还需要知道什么」:
 *  - float 要 rect,不然回来的窗子身量和位置都得重猜(恢复时仍过一次视口钳制);
 *  - edge  要 index,不然回到那条边只能排到末尾,而它当时是排在中间的。
 * 架子厚度**不在**这里:厚度是架子的属性,归架子 —— 一条边只有一个厚度,
 * 让每块瓦都记一份,就等于让最后关掉的那块瓦说了算。
 */
export type PlacementMemory =
  | { kind: 'stage' }
  /**
   * 浮窗。**矩形是可选的**(W7-p 修一轮裁定 1):`rect` 缺席 = 「这块面记得自己
   * 上次是浮着的,但没人量过它多大」——从没被亲手摆过的那一格就是这样。开的时候
   * 由 `stage/placement.placeAs` 的唯一产地 `transitions.freshFloatRect` 现算
   * (锚在中央区右上角 + 按已开窗数层叠)。写成必填的代价是每一条造记忆的路都得
   * 当场编一个矩形出来,而那正是「点瓦开出来的四扇窗叠成一摞」的病根。
   */
  | { kind: 'float'; rect?: FloatRect }
  /*
   * **全屏**(W2)。它在这条联合里而不在 `Placement` 里,是这一批最容易读错的
   * 一格:记忆说的是「上次我是怎么把它打开的」,而 `Placement` 说的是「它此刻
   * 住在哪棵树里」—— 全屏不占住处(树没动过),所以它只能出现在这一头。
   * 存量档案里的 `{ kind: 'cover' }` 由 persist v10 原地翻成这一档。
   */
  | { kind: 'full' }
  | { kind: 'edge'; side: ShelfSide; index: number }

export type BadgeTone = 'danger' | 'ok'

/** 徽标是「内容的状态」,不是形态的一部分,所以它挂在 item 上而不是 state 上。 */
export interface StageBadge {
  count?: number
  text?: string
  tone: BadgeTone
}

export interface StageItemSpec {
  id: string
  /** 瓷砖名是界面文案,所以 item 只持有 key —— 和 icon 只持有名字同一个理由。 */
  titleKey: MessageKey
  /**
   * **这块瓦记在哪一本账上**(S1,正本 `apps/desktop-react/docs/dock-scope-2026-09.md`
   * §2.2)。`space` = 每个工作区各一套(今天全部瓦的行为);`app` = 跨工作区,
   * 换空间它连位置一起跟着人走。
   *
   * ── 它是 `scope: 'session' | 'global'` 改名来的,而那一格从来没有行为 ────────
   * 旧那一格(`stage/types.ts`,W1 起)**没有注释、没有消费者**,唯一读它的是
   * `Dock` 把两组排开中间画一条线 —— 名字被占了,语义是空的。S1 要的正是这个词,
   * 所以它归位:**作用域这一轴由这一格说**,而分隔线那件纯视觉的事改由下面的
   * `dockGroup` 说(拍点 1:分组一字不变)。两件事从此两个字段,不再同名。
   *
   * 谁读它:`content/kinds/panel.tsx` 的 `level` 自述转问这里,于是
   * `workbench/tree` 的携带、`workbench/store` 与 `stage/store` 的两处 `carry`
   * 一律经 `kinds.residencyLevelOf` 问 —— 它们里面一个瓦名都不出现。
   */
  level: 'app' | 'space'
  /**
   * **Dock 上的视觉分组**(拍点 1,09-10 按缺省定:**保持今天的分组**)。
   * 唯一的消费者是 `components/Dock.tsx` 那条分隔线的落点。
   *
   * 它**不与 `level` 同名、也不与它同值**,这是有意的:照 `level` 画的话分组会从
   * 「files diff terminal ｜ 其余」变成「其余 ｜ notifications workspace settings apps」,
   * 那是一次用户可感知的变化,而缺省 = 保持旧行为。哪天要让分隔线说真话
   * (「左边的随空间、右边的随人」),改的是 `Dock` 读哪一格,这张表一个字不动。
   */
  dockGroup: 'session' | 'global'
  /** lucide 图标名 */
  icon: string
  badge?: StageBadge
  /**
   * 这块瓦**天生**该落在哪儿。缺席 = 没有天生落点,听全局默认档的。
   *
   * 它插在解析序的**第三层**(记忆 > 天生 > 全局默认档),所以它既不是配置
   * 也不是记忆:用户亲手放过一次,记忆就永远压过它 —— 「这块面适合怎么开」
   * 是它自己的性质,而「我想怎么开」永远是用户说了算。
   *
   * 今天唯一的用户是「所有应用」(full):一张铺满的应用清单塞进 880×520 的
   * 浮窗里就得滚动,而它恰恰是那种「看一眼、点一下、就走」的整屏内容。
   */
  defaultPlacement?: OpenPlacement
  /**
   * 这块瓦允不允许从 Dock 上藏起来。缺席 = 允许。
   *
   * 只有「所有应用」是 false —— 它是**恢复入口**:把恢复入口自己藏掉,
   * 用户就再也找不到把别的瓦放回来的门了(留一个回家的门)。
   */
  alwaysInDock?: boolean
  /**
   * **这块面摆成浮窗时至少要多大**(W7-d 裁定 1)。缺席 = 听全体默认身量的
   * (`FLOAT_DEFAULT_W × FLOAT_DEFAULT_H`)。
   *
   * ── 它为什么长在这张表上 ──────────────────────────────────────────────
   * `FLOAT_DEFAULT_W` 那一格的判词早就把这条路写好了:「拿最宽那块面的需求去定
   * 全体的默认值,代价是每一扇窗一开就吃掉大半个屏……修法是**那块面自述一个最小
   * 身量**(形态机今天没有这一口)」。这就是那一口。
   *
   * 判据与 `defaultPlacement` 同族:**内容自述、壳读表**。形态机那只纯函数
   * (`transitions.freshFloatRect`)只收一对数,它里面一个瓦名都没有;读表的是
   * 壳那一侧(`stage/placement.ts` / `workbench/drop-commit.ts` 经
   * `items.floatMinOfItem`)。
   *
   * 两轴各自可缺:只在乎宽的面(会话总览)就只写 `w`。装不下时不硬撑 ——
   * 缩到中央区那么大并贴中央区左上(判词在 `transitions.floatRectAt` 上)。
   */
  floatMin?: FloatMinSize
}

/**
 * 一块面自述的浮窗最小身量。两轴各自可缺(缺席 = 这一轴没有意见)。
 *
 * 它**不是** `FLOAT_MIN_W / FLOAT_MIN_H`:那两格是「窗子最小能被拖多小」的硬界
 * (手势那把尺),这一格是「它一开出来至少该多大」的出厂下限。用户之后照旧
 * 拖得比它小 —— 自述说的是开窗那一刻,不是永久约束。
 */
export interface FloatMinSize {
  w?: number
  h?: number
}

/** 浮窗矩形。按 item 记忆,所以收回 Dock 再开还在老位置。 */
export interface FloatRect {
  x: number
  y: number
  w: number
  h: number
}

/** 视口尺寸。钳制要用它,而纯函数不许读 window —— 所以由调用方递进来。 */
export interface Viewport {
  w: number
  h: number
}

/**
 * 视口坐标里的一个点(指针)。吸附判定、撕离判定、Dock 边缘带都吃它 ——
 * 纯函数不认识 PointerEvent,宿主量一次 clientX/clientY 递进来。
 */
export interface Point {
  x: number
  y: number
}

/**
 * 一条边上的架子。四条边各有一份(本批只有 right 有真 UI,另三条 W2 接管),
 * thickness 是「厚度」而不是宽度 —— 竖边量宽、横边量高,同一个数换个轴读。
 */
export interface ShelfState {
  /**
   * **投影,不是存下来的**(W4)。这条边那棵树(`workbench.regions['edge:<side>']`)
   * 里的瓦 id,按阅读序。真相在树上,这一格由 `stage/residency.ts` 的投影器算、
   * 由 `stage/store.ts` 那**唯一**一条订阅写,**不落盘**(v9 迁移把它搬走了)。
   * 缺席读作空 —— 换工作区那一拍,几何先摊开、投影随后补上。
   */
  tabs?: string[]
  /** 投影:第一片叶此刻活动的那块瓦(单叶架子上这就是全部真相)。 */
  activeId?: string | null
  /**
   * 投影:此刻**显形**的那些瓦 —— 每片叶各一格活动 tab。
   * W4 起一条架子可以分屏,「露脸的那一个」于是不再只有一个;
   * 缺席读作 `[activeId]`(单叶那一形,与 W4 之前逐字相同)。
   */
  visible?: string[]
  thickness: number
  collapsed: boolean
  /**
   * **这条架子是被谁收起来的**(W7-d 裁定 2)。缺席 = 用户自己收的(或压根没收)。
   *
   * ── 病历 ──────────────────────────────────────────────────────────────
   * `transitions.reclampShelves`(W7-p 裁定 3)在共同预算摆不下时把架子收成细梁,
   * **而没有反向的一句**:窗子缩到 320 再拉回 1280,右架子留在细梁上,用户什么
   * 都没做却丢了一条架子。W7-c 只能在 `gate:squeeze` 的夹具里手动还原它。
   *
   * ── 为什么要记一格,而不是「宽了就全展开」 ────────────────────────────
   * 因为**用户自己收起来的那条不许被展开**。「收着」这一态有两个来源,而反向那
   * 一句只该撤销其中一个:预算收的,预算回来就还;用户收的,只有用户能开。
   * 一个布尔说不清这件事,所以记的是**谁**而不是「是不是自动的」——将来第三个
   * 来源(比如某种专注模式)加一格值即可,反向那一句照旧只认得自己那一格。
   *
   * 写的只有两处:`reclampShelves` 收成细梁时写 `'budget'`、预算回来时清掉;
   * 用户那条路(`setShelfCollapsed`,收展两向)一律清掉 —— 手动动过一次,
   * 这条架子就归用户管了。
   */
  collapsedBy?: 'budget'
}

export interface StageState {
  /**
   * id → 它当下在哪。缺席 = dock(所以初始表是空的,不是全量表)。
   *
   * ── W4 起它是**投影** ────────────────────────────────────────────────
   * 事实住在拼贴树里(`workbench.regions`):一块瓦在哪棵树里,它就在哪个区域。
   * 这一格由 `stage/residency.ts` 的 `projectResidency` 算出来,**唯一的写者**
   * 是 `stage/store.ts` 里那条订阅。理由写在 `residency.ts` 的文件头:
   * 一条架子上装的已经不只是瓦了(文件也能钉到边上),两份事实必然分叉。
   *
   * 舞台那个瞬态不在树里,它由下面 `stageId` 一格供,投影时盖在树那一份上面。
   * 「至多一个」于是由**类型**保证,不再靠不变式。
   *
   * **全屏不在这张表里**(W2):它不是一个住处,树一个字没动 ——
   * 那一格瞬态住在拼贴台自己那本账上(`workbench.full`)。
   */
  placements: Record<string, Placement>
  /** 舞台上那一块(至多一个)。**瞬态**,不落盘。 */
  stageId: string | null
  /** 浮窗矩形按窗 id 记忆 —— 收回 Dock 不擦,再开还在老位置。 */
  floats: Record<string, FloatRect>
  /**
   * 浮窗置顶序,末位最上。**投影**(W4):只留还有树的那些窗,新长出来的排末位。
   * 「翻到最上面」(`focusFloat`)仍然是直接写它 —— 那是次序,不是住处。
   */
  floatOrder: string[]
  shelves: Record<ShelfSide, ShelfState>
  /**
   * **四条边的钉边先后**,先钉的在前(W7-p 裁定 3)。**投影**,与 `shelves[side].tabs`
   * 同一条订阅算出来(`stage/residency.projectResidency`),所以它没有第二个产地。
   *
   * 它只有一个消费者:视口重钳(`transitions.reclampShelves`)——「共同预算不够时
   * 谁先让」这个问题必须有一个确定的答案,而「后钉的那条先钳」是那个答案。
   *
   * **不落盘**(不在 `STAGE_FURNITURE_KEYS` 里):它是从树上现算的,存一份就是
   * 第二份事实。重启后第一次投影会一次看见全部占着的边,那时按 `SHELF_SIDES` 的
   * 固定次序排 —— 冷启动本来就没有「先后」可言,确定即可。
   */
  shelfNailOrder: ShelfSide[]
  /**
   * 位置记忆:id → 它**该**在哪(而 placements 说的是它**正**在哪)。
   * 关闭是归档不是删除,所以收回 Dock 时当下的落点先折进这里再摘活表;
   * 每一次落定(菜单点名 / 拖拽吸附 / 撕出 / 移动缩放)也同步写这里。
   * 缺席 = 这块瓦从没被放过,那才轮到全局默认档说话。
   */
  memory: Record<string, PlacementMemory>
  /** 递增计数,触发架子闪烁 */
  flashPinned: number
  /**
   * 该闪的是**哪一条**架子。W2 四边都有 UI 之后,光有一个计数会让四条边一起闪 ——
   * 闪烁是「你要的东西在这儿」,所以它必须指得出那个「这儿」。
   */
  flashSide: ShelfSide | null
}

/**
 * 全局默认档:一块**从没被放过**的瓦点开时落在哪。
 * 它只有这一个职责了 —— 每瓦的「打开方式」配置已并入位置记忆(G 批),
 * 所以这里不再有 'default'(「不表态」)那一档:全局档自己就是最后一层,没有下家可推。
 * 'pinned' 的语义 = edge:right;值不改名是为了旧档案兼容,翻译收在 placementForOpen 一处。
 *
 * ── 'stage' 退出打开档(08-30 用户拍板)────────────────────────────────
 * 「点开」的形态统一成悬浮窗:popup(舞台)与浮窗两种打开结果并成一种,用户
 * 不再需要在两套心智间切换。舞台**形态本身没有退役** —— 它降级为浮窗的
 * 「放大」目标(FloatWindow 标题栏双击 / 放大钮、Dock 右键点名),只是任何
 * 「点一下打开」的路径都不再产出它。存量档案里的 'stage' 值在 persist 迁移
 * 与 resolveOpen 读取处各钳一次,写入侧不清洗。
 */
export type ResolvedOpen = 'float' | 'pinned'

/**
 * 设置层:不参与形态推导,只参与「点一下该去哪」的解析。
 * 与 StageState 分开,是因为它跨会话持久,而形态是当下的。
 */
export interface StageSettings {
  /** 只服务「从没被放过、也没有记忆」的瓦 —— 有记忆的一律听记忆的。 */
  defaultOpen: ResolvedOpen
  /** 界面语言。'system' = 问浏览器;解析在 i18n/resolveLang,不在这里。 */
  locale: Locale
  /** 停靠哪条边。 */
  dockEdge: DockEdge
  /** 沿边方向的三档定位 —— 「沿边」是相对的:横边是左右,竖边是上下。 */
  dockAlign: DockAlign
  /** 瓦的大小档。 */
  dockSize: DockSize
  /**
   * 磁性放大开不开(对齐 macOS 「Dock 与菜单栏 · 放大」那枚开关)。
   * 关掉不是「放大成 0」,是**这条链根本不跑**:指针滑过条时一格几何都不写、
   * 镜头开关不挂,条与瓦纹丝不动(gate:dock 的 ⑨ 钉着这一条)。
   */
  dockMagnify: boolean
  /** 放大幅度三档(对齐 macOS 那条「放大」滑杆,收敛成三格)。 */
  dockMagnifyLevel: DockMagnifyLevel
  /**
   * 画不画「正开着」那颗运行点(对齐 macOS 「在 Dock 中显示打开应用的指示灯」)。
   * 关掉只是不画那颗点,瓦的运行状态本身照旧(点是**指示**不是状态)。
   */
  dockRunningDot: boolean
  /**
   * **不在 Dock 上露面**的那些瓦(存 id)。存「藏起来的」而不是「露面的」,
   * 是为了让新加的瓦默认露面 —— 反过来存一张白名单,以后每加一块瓦都得记得
   * 往每个人的档案里补一行,漏了就是「新功能上线了但没人看得见」。
   *
   * 它是**配置**不是记忆:与「这块瓦上次放在哪」无关,藏起来的瓦照样能被
   * ⌘P / 「所有应用」打开,打开之后照样按它的记忆落点。藏的是**入口**,
   * 不是这块面本身。
   */
  hiddenItems: string[]
}

export type DockDisplay = 'always' | 'autohide'

/**
 * **收起来的架子还画不画那条细梁把手**(2026-09-12 用户拍)。一格**全局**偏好,
 * 四条边共用 —— 它说的是「收起之后屏幕上留不留一条可点的边」这件审美,而那件事
 * 在四条边上是同一个答案;做成每边一格会让「我把把手关了」变成要点四次的设置。
 *
 * `'hidden'` 下收起的架子**零厚度、不画把手**(连那条 1px 的分隔线也归零)——
 * 取回的路一条没少:快捷键召唤(`reveal` 的 `shelf-expand`)与点 Dock 那块瓦
 * 照旧展开它。所以这一格藏的是**那条把手**,不是那条架子本身(与 `hiddenItems`
 * 藏的是入口而不是面,同一条判词)。
 *
 * 它是**偏好**不是家具:不进 `STAGE_FURNITURE_KEYS`,跨工作区共享。
 */
export type ShelfRail = 'shown' | 'hidden'

/** 四条边。Dock 永远是浮层,所以「停靠」只决定贴哪儿,不决定谁让位。 */
export type DockEdge = 'bottom' | 'top' | 'left' | 'right'

/** 沿边方向的位置。start/end 指的是那条边自己的起点/终点,不是屏幕的上下左右。 */
export type DockAlign = 'start' | 'center' | 'end'

export type DockSize = 'sm' | 'md' | 'lg'

/**
 * 放大幅度三档。macOS 那里是一根连续滑杆,这里收敛成三格 —— 「设置极简」那条法:
 * 技术参数走默认值,调参收敛成档位。三个数住在 tokens.css 的 --dock-lens-max-* 里,
 * 这里只有档名(CSS 认档,JS 不认那三个数)。
 */
export type DockMagnifyLevel = 'sm' | 'md' | 'lg'

/**
 * 边 → 条的主轴。横边(上/下)排成一行走 x,竖边(左/右)排成一列走 y。
 * 磁性放大按哪个轴量、沿边定位改哪个坐标,都只问这一张表。
 */
export const DOCK_AXIS: Record<DockEdge, 'x' | 'y'> = {
  bottom: 'x',
  top: 'x',
  left: 'y',
  right: 'y',
}

/**
 * 「钉到边」的四个选项。舞台头和浮窗头各摆一次同一个菜单,
 * 所以这张「值 → 文案键」的表只该有一份 —— 与 DOCK_AXIS 同一个理由住在这里。
 * 文案复用 Dock 那四个边键:同一句话不该有第二个键。
 */
export const SHELF_SIDE_CHOICES: Array<{ value: ShelfSide; labelKey: MessageKey }> = [
  { value: 'right', labelKey: 'dock.edgeRight' },
  { value: 'left', labelKey: 'dock.edgeLeft' },
  { value: 'top', labelKey: 'dock.edgeTop' },
  { value: 'bottom', labelKey: 'dock.edgeBottom' },
]

/**
 * 右键菜单那排落点。它与 SHELF_SIDE_CHOICES 同一个理由住在这里:
 * 一张「值 → 文案键」的表只该有一份,四条边那四行直接由上面那张表长出来。
 *
 * 注意它给的是 **Placement 而不是 PlacementMemory**:菜单说得出「放到哪儿」,
 * 说不出「浮窗多大」「排在第几个」—— 那两件事是落定的产物,由形态机在落定时自己记。
 * `pin` 只是排版记号:从这一行起是「钉到边」那一组。
 */
export const OPEN_PLACEMENT_CHOICES: Array<{
  key: string
  placement: OpenPlacement
  labelKey: MessageKey
  pin?: boolean
}> = [
  { key: 'stage', placement: { kind: 'stage' }, labelKey: 'dock.openStage' },
  { key: 'float', placement: { kind: 'float' }, labelKey: 'dock.openFloat' },
  // 第三行从「盖满」改成「全屏」(W2 拍点 ②):同一个位子,换的是它真正做到的事。
  { key: 'full', placement: { kind: 'full' }, labelKey: 'dock.openFull' },
  ...SHELF_SIDE_CHOICES.map((c) => ({
    key: `edge:${c.value}`,
    placement: { kind: 'edge' as const, side: c.value },
    labelKey: c.labelKey,
    pin: true,
  })),
]
