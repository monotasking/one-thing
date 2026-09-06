import type {
  DockEdge,
  FloatRect,
  MemorablePlacement,
  OpenPlacement,
  Placement,
  PlacementMemory,
  Point,
  ResolvedOpen,
  ShelfSide,
  ShelfState,
  StageForm,
  StageSettings,
  StageState,
  Viewport,
} from './types'
import { DOCK_WAKE_DWELL_MS } from '../components/motion'
/*
 * v8 迁移要清掉存量档案里那块退役的「查看器」瓦。名字从 `stage/items` 取 ——
 * 那只文件运行期**不 import 任何东西**(它对 `./types` 是 `import type`,编译后
 * 整条边消失),所以这条边不会碰到 stage 那圈已知的 import 环。
 */
import { VIEWER_ITEM_ID } from './items'
import { foldFlatIntoDefaultSpace } from '../workspace/per-space'
import type { PerSpaceState, SpaceLedger } from '../workspace/per-space'
import { DEFAULT_SPACE_ID } from '../workspace/types'

/**
 * 架子厚度的两条界。下界是绝对值(--shelf-min 同一事实),上界是比例 ——
 * 「架子最多吃掉视口的多少」是相对的,写死一个 px 在小屏上会把主区挤没。
 */
export const SHELF_MIN_THICKNESS = 240
export const SHELF_MAX_RATIO = 0.55
export const SHELF_DEFAULT_THICKNESS = 400

/**
 * **中央区的最小身量**(W7-p 裁定 3,审计 A 的 A3/A4)。
 *
 * ── 病历 ──────────────────────────────────────────────────────────────────
 * 四条边各钉 400 上去,真机量到中央区 **h = 0**:输入框浮在上架子的内容上,聊天区
 * 一个像素都不剩。病根是 `clampShelfThickness` **逐边**算上界(`视口 × 0.55`)——
 * 上下两条各拿走 55%,加起来 110%,而没有任何一处问过「那对边加起来还给中央
 * 留没留下地方」。窗口变小时更糟:`clampShelfThickness` 从来不在 resize 那条路上,
 * 右架子直接探出屏幕 204px。
 *
 * 所以这里立一个**中央区最小身量**,与 `SHELF_MIN_THICKNESS` 同一张表:一条边的
 * 厚度上界从此是**共同预算**(见 `shelfThicknessBudget`),竖边与横边各算各的轴。
 * 它是 JS 几何不是 CSS 间距(与 `FLOAT_MARGIN` 同一条判据),所以住在这里。
 */
export const CENTER_MIN_W = 480
export const CENTER_MIN_H = 320

/**
 * 收起来的架子还占着的那条细梁。**`tokens.css` 的 `--shelf-rail` 是同一格事实** ——
 * 那边画,这边算预算。两个数写在两处是必然要分叉的,但纯函数读不到 CSS
 * (`FLOAT_MIN_W` 一族同一条理由),所以只能靠这句话把它们钉在一起。
 */
export const SHELF_RAIL = 12

/**
 * **顶栏那条带**(`--topbar-h`)。同一条理由、同一张对账表:纯函数读不到 CSS,
 * 所以两个数写在两处,由 `transitions.test.ts` 的「与 JS 常量同源」那一组钉住。
 *
 * ── 它为什么进得了「中央区」这道算式(W7-p 裁定 5 的修正)──────────────────
 * `centerRectOf` 答的是「新窗开在哪」的参考系,而那个参考系必须是**用户眼里的
 * 主区**。顶栏不是主区:标签条就长在它上面(`workbench/TopBarTabs`),红绿灯与拖窗
 * 区也在。第一版只切了四条架子、把顶栏留在里面,于是新窗锚在 y = 24 —— 真机上
 * 它盖住标签条的右半截,`gate:drag` 场景①③当场红(指针按在「最右那格标签」上,
 * 落到的是那扇窗)。四条边的厚度从**顶栏之下**起算(判词见 `thicknessFromPointer`
 * 那句「顶架子的外缘不是 0」),所以这一格与它们相加,不是相减。
 */
export const TOP_CHROME = 44

/** 浮窗的四条硬约束:最小身量、必须留在视口内的那一截、新窗默认身量。 */
export const FLOAT_MIN_W = 280
export const FLOAT_MIN_H = 200
export const FLOAT_KEEP = 40
/**
 * 浮窗与视口边缘之间那道**气口**(09-04 §4)。
 *
 * 它与 FLOAT_KEEP 是两条相反的界,别混:KEEP 说的是「最少露多少出来」(允许
 * 出界),MARGIN 说的是「最多贴多近」(不许出界)。两条界各服务一把尺 ——
 * 手势与落定认 KEEP(`clampFloatRect`),视口重钳认 MARGIN(`fitFloatRect`),
 * 那张分工表在「浮窗几何」那一节的开头。身量上界(vp - 2*MARGIN)两把尺共用。
 *
 * 它是 **JS 几何**不是 CSS 间距,所以住在这里而不是 tokens.css:纯函数不读 CSS,
 * 而 FLOAT_MIN_W / FLOAT_KEEP / FLOAT_DEFAULT_W 这一族本来就都在这一处。
 */
export const FLOAT_MARGIN = 16
/*
 * 新窗默认宽度 08-31 由 720 加宽一档到 880。
 *
 * 这是一次**全体瓦**的默认值改动(不是给某一块面开的特例:一块瓦不该知道
 * 自己该多宽,那是形态机的事),记在这里而不是散在别处。
 *
 * 起因是模型服务那块面的真机报障:它是两栏面(左名册 --pv-rail-w 268 定宽 +
 * 右详情),而右详情里那张七列模型表最窄一档也要 508px 才排得下。
 *   720 − 268(名册) − 48(详情列左右各 --sp-5) = 404  → 排不下,列头压到邻列上
 *   880 − 268 − 48                              = 564  → 最窄一档(五列)排得下
 * 换句话说 720 这个默认值对**任何**两栏面都偏窄,只是模型服务是第一块把它
 * 撞出来的。表格那一侧的阈值账另修(见 ModelCatalog.module.css),两边都改了
 * 才算修完:只加宽窗是把病往后推,只改阈值则默认一开还是挤的。
 * 高度没动 —— 报障说的是「挤」,而详情列这一批已经改成页级滚动,高度不是瓶颈。
 */
/*
 * **W7-p 裁定 5 把它改回 640×480**(审计 A 的 A6)。
 *
 * 上面那段 08-31 的账仍然成立 —— 模型服务那块两栏面在 640 里排不下七列表。它与
 * 这一次的裁定是**两件事**:那一次问的是「一块特定的面要多宽」,这一次问的是
 * 「一扇新窗该多大、开在哪」,而拿最宽那块面的需求去定全体的默认值,代价是每一扇
 * 窗一开就吃掉大半个屏。**账留在这里**:模型服务在 640 里会重新变挤,修法是那块面
 * 自述一个最小身量(形态机今天没有这一口),不是把全体默认值再抬回去。
 */
export const FLOAT_DEFAULT_W = 640
export const FLOAT_DEFAULT_H = 480

/**
 * 纯函数不许读 window,所以视口由调用方递进来;测试里给定值,store 里给真视口。
 * 这个兜底只在「谁都没给」时用,存在的意义是让签名可选而不是让它有第二套真相。
 */
export const FALLBACK_VIEWPORT: Viewport = { w: 1280, h: 800 }

export const SHELF_SIDES: ShelfSide[] = ['left', 'right', 'top', 'bottom']

/**
 * 拖着一扇浮窗靠近视口边缘多少像素算「要钉上去」。
 * 撕离用的是同一个数(24):进这么多算吸,出这么多算撕,一进一出对称。
 */
export const SNAP_BAND = 24
export const TEAR_OFF_DISTANCE = 24

/**
 * ── 自动隐藏的两个语义,两个数(09-01 拍板)────────────────────────────────
 *
 * **唤醒要克制,留驻要宽容** —— 这是两句话,所以是两个常量、两个判据,
 * 由 `shouldShowDock` 按「此刻出来了没有」分岔,谁都不许再把它们并成一个。
 *
 * 病历:09-01 用户报「dock 自动出现范围太大了,我想输入都没法输入了」。
 * 真因不是哪个数调大了,而是宿主把两个语义写成了**一句** ——
 * `withinDockEdgeBand(…) || withinDockHoldZone(…)`,而 `settledDockRect` 是
 * 按**身量**算停稳位的(translate 不改尺寸),藏着的时候照样算得出来。
 * 于是「已经出来了才该讲的宽容」在还没出来时就生效了,留驻区整块变成了唤醒区。
 *
 * 真机读数(1280×828,底边、md、居中):停稳 top 754 / bottom 816,
 * 唤醒热区因此高 12(inset) + 62(身量) + 24(pad) = **98px**、宽 707px,
 * 而 composer 输入区是 y 775…799 —— **整条输入区 100% 落在唤醒区里**,
 * 指针放到输入框上 Dock 就弹出来,正是用户报的那件事。
 *
 * ── 09-03 追补:唤醒从「碰到」改成「停留」,于是这里是**两个语义、三个数** ──
 *
 * 病历:用户报「dock 的出现太敏感」。09-01 那一批把唤醒收窄到 8px 之后,唤醒
 * 判据仍然是「离边 ≤8px 立刻为真」—— **零停留、零出窗判断**。macOS 的屏幕边是
 * 一堵墙(指针顶住会自然停在那里),而我们的窗口边不是:去点系统 Dock、去别的
 * 窗口、去拖窗口边,都要**穿过**这 8px,穿一次唤醒一次。
 *
 * 修法不是把带宽再调小(它只能往小调,而再小就瞄不准了 —— 见 DOCK_WAKE_BAND),
 * 而是给这一跳加一道**意图门槛**:进带之后要连续停满 DOCK_WAKE_DWELL_MS 才唤醒。
 * 穿越在自然速度下只在带内待 1–2 帧,一次都留不住;想叫它的手停一下就出来。
 *
 * 与之配套的另一半在**宿主**里(AppShell 的「唤醒生命周期」一节):指针出了窗
 * (pointerleave / mouseout 无 relatedTarget / 坐标越出视口 / window blur /
 * 页面转入后台)必须当场清掉那张表 —— 出窗之后 pointermove 就停发了,
 * 计时器会以为手还老老实实停在边上,于是「去点系统 Dock,我们的也弹出来」。
 * 这一件只能在宿主判(纯函数看不见「事件不来了」),所以它不在这个文件里。
 *
 * **留驻语义一个字没动**:24 的余量、停稳位判据、300ms 收回宽限、08-31 那 12 组
 * 手势,全部原样 —— 报障出在「怎么叫得出来」,不在「出来之后怎么留住」。
 */

/**
 * **唤醒**:指针离那条边多近才把藏着的 Dock 叫出来。贴边窄带,与 --dock-wake-band 同一事实。
 *
 * 它必须窄到碰不到任何可交互的东西:同一次真机量到,最低的那件(composer 输入区 /
 * 发送键)下缘离视口底 29px,8 留出 21px 余地。底边挂了架子时那一截还会更薄,
 * 所以这个数只该往小调,不该往大调 —— 想让 Dock 更好叫出来,调的是别处。
 *
 * 09-03「太敏感」那一批**一个字没动它**:带宽不是病根(见 DOCK_WAKE_DWELL_MS 的病历),
 * 而这个数往哪个方向调都会踩到上面那句 —— 调大就碰输入区,调小就更难瞄准。
 */
export const DOCK_WAKE_BAND = 8

/**
 * **停留**:进了窄带之后要在带内连续停满多久才唤醒(与 --dur-dock-wake 同一事实,
 * JS 侧的产地是 components/motion.ts —— 时长只许有一处镜像)。
 *
 * 病历(09-03,用户报「dock 的出现太敏感」):修前唤醒是「离边 ≤8px 立刻为真」,
 * **零停留、零出窗判断**。macOS 的屏幕边是一堵墙,指针顶上去停在那儿是物理结果;
 * 我们的窗口边不是墙 —— 去点系统 Dock、去别的窗口、去拖窗口边,每一次都要
 * **穿过**这 8px。一次穿越在自然速度(6px/帧)下只占带内 1–2 帧(20–30ms),
 * 却每次都唤醒一次,这就是「太敏感」的字面机制。
 *
 * 所以门槛换成**意图**:穿过去的手一次都留不住,想叫它的手停一下就出来。
 * 这一格只挡「藏着 → 出来」那一跳,出来之后的留驻语义一个字不动(见 shouldShowDock)。
 */
export { DOCK_WAKE_DWELL_MS }

/**
 * **留驻**:Dock 已经出来之后,在本体四周放多少余量仍算「手还在这儿」
 * (与 --dock-hold-pad 同一事实)。
 *
 * 08-31 由 8 放宽到 24。8 是「刚好不碰到就算走了」,而真手不是这么动的:
 * 唤醒 Dock 的手势本身就是「往那条边压一下,再抬起来去点某一块瓦」,抬的
 * 那一下路径必然从本体外缘擦过。真机量出的修前判据是**离 Dock 上缘 8px
 * 就开始计收回**,这就是用户报的「唤醒后轻微上移秒消失」的一半。
 * 另一半是拿飞行中的矩形去判——那一半由 settledDockRect 修。
 *
 * 09-01 这个数**一个字没动**:它伺候的是留驻语义,而报障出在唤醒语义 ——
 * 把它调小会同时修翻 08-31 刚修好的那 12 组手势。
 */
export const DOCK_HOLD_PAD = 24

/** 浮窗标题栏高度,与 --float-header-h 同一事实(从架子上撕下来时要按它对准指针)。 */
export const FLOAT_HEADER_H = 40

/** persist 档案版本。改这个数就必须在 migrateStagePersisted 里加一段,两者同生共死。 */
export const STAGE_PERSIST_VERSION = 10

const DOCK: Placement = { kind: 'dock' }

function emptyShelf(): ShelfState {
  /*
   * `tabs` / `activeId` / `visible` **不在这里造**(W4):它们是树的投影,
   * 产地是 `stage/residency.ts`。出厂那一份只说几何 —— 一条空架子多厚、收没收起来。
   */
  return { thickness: SHELF_DEFAULT_THICKNESS, collapsed: false }
}

export function emptyShelves(): Record<ShelfSide, ShelfState> {
  return { left: emptyShelf(), right: emptyShelf(), top: emptyShelf(), bottom: emptyShelf() }
}

export const initialStageState: StageState = {
  placements: {},
  stageId: null,
  floats: {},
  floatOrder: [],
  shelves: emptyShelves(),
  shelfNailOrder: [],
  memory: {},
  flashPinned: 0,
  flashSide: null,
}

/**
 * **跟着工作区走的那五格**(T-W1)。这张表是「什么算家具」在 stage 这一侧的
 * 单产地 —— 存盘(`partialize`)、换装(`bindPerSpace`)、迁移(v6)三处都读它,
 * 少写一处就会出现「存的时候多摘一格、换的时候少摊一格」那类只在切回去时才
 * 露面的 bug。
 *
 * 不在表里的(dockEdge/dockAlign/dockSize/dockDisplay/hiddenItems/defaultOpen/
 * locale)是**这台机器的偏好**,跨空间共享:换个工作区不该把 Dock 挪到另一条边、
 * 更不该换界面语言。判据写在 `workspace/per-space.ts` 文件头。
 *
 * `flashPinned` / `flashSide` 也不在表里:它们是**一次动画的瞬时值**,本来就不
 * 落盘,换装时跟着新空间从零开始正是对的。
 */
/**
 * **v6 那一刻**「什么算家具」的五格。它是一条**历史记录**,不许跟着今天那张表走:
 * v6 迁移要把当年扁平档案里的这五格原样折进默认空间,而 W4 之后 `placements`
 * 已经不是家具了(它降格成树的投影)—— 拿今天的表去折,存量档案里那一格
 * 就会留在扁平层,再也没人捡它。
 */
const V6_FURNITURE_KEYS = ['placements', 'floats', 'floatOrder', 'shelves', 'memory'] as const

export const STAGE_FURNITURE_KEYS = [
  'floats',
  'floatOrder',
  'shelves',
  'memory',
] as const

/** stage 那一份家具的形。 */
export interface StageFurniture {
  floats: StageState['floats']
  floatOrder: StageState['floatOrder']
  shelves: StageState['shelves']
  memory: StageState['memory']
}

/** 出厂布局 —— 首次进入某个空间摊开的就是它。 */
export function factoryStageFurniture(): StageFurniture {
  return {
    floats: {},
    floatOrder: [],
    shelves: emptyShelves(),
    memory: {},
  }
}

/**
 * 从活状态里摘出家具。**存盘那一条纪律在这里也成立**:舞台那条 placement
 * 存盘前要摘掉(它是「此刻开着」,不是「用户摆好的」),所以换装收账时同样摘 ——
 * 否则切走再切回来会凭空恢复一块舞台,而它本来就不该活过一次刷新。
 */
export function pickStageFurniture(state: StageState): StageFurniture {
  return {
    floats: state.floats,
    floatOrder: state.floatOrder,
    /*
     * 只带**几何**那一半走(W4):`tabs` / `activeId` / `visible` 是树的投影,
     * 事实已经跟着 `onething.workbench` 那本账按空间各存一份了 —— 这里再带一份
     * 就是第二个产地,而它们会在「换空间之后再刷新」那一刻对不上。
     */
    shelves: mapShelves(state.shelves, (shelf) => ({
      thickness: shelf.thickness,
      collapsed: shelf.collapsed,
    })),
    memory: state.memory,
  }
}

/** 四条边逐条过一遍同一个函数。**唯一一处**「按边循环」的写法。 */
function mapShelves(
  shelves: Record<ShelfSide, ShelfState>,
  fn: (shelf: ShelfState, side: ShelfSide) => ShelfState,
): Record<ShelfSide, ShelfState> {
  const out = {} as Record<ShelfSide, ShelfState>
  for (const side of SHELF_SIDES) out[side] = fn(shelves[side] ?? emptyShelf(), side)
  return out
}

export const initialStageSettings: StageSettings = {
  defaultOpen: 'float',
  locale: 'system',
  dockEdge: 'bottom',
  dockAlign: 'center',
  dockSize: 'md',
  // 三格缺省 = 09-02 之前的行为逐字不变:放大开着、幅度是那时唯一的那一档、运行点画着。
  dockMagnify: true,
  dockMagnifyLevel: 'md',
  dockRunningDot: true,
  hiddenItems: [],
}

/**
 * **至多一个**的那几种形态。舞台盖住整个视口 —— 两块叠在同一处,下面那块永远
 * 见不到光,所以它只许有一个。
 *
 * 写成一张表而不是一段 if:再多一种独占形态时,这里加一个字面量就够了,
 * 落点那一族(`stage/placement.ts`)里那段不变式一个字都不用改。
 * 浮窗与架子不在表里 —— 它们生来就是可以有好几个的。
 *
 * **W4 起它同时是「哪几种形态不住在树里」那张表**:舞台是瞬态(设计 §1.3),
 * 它占 stage 自己一格(`stageId`),不进 `workbench.regions`。
 *
 * **W2 起表里只剩一格**:「盖」退役,而接替它的全屏根本不是一种 Placement ——
 * 它是拼贴台的一格瞬态(`workbench.full`),树一个字不动,所以它既不进这张表,
 * 也不进 `placements`。
 */
export const EXCLUSIVE_FORMS: StageForm[] = ['stage']

/* ── 派生 ──────────────────────────────────────────────────────────────────── */

/**
 * 形态是「派生」的,不是存的:一个 id 的落点完全由 placements 决定。
 * 组件只能读这个函数,不许自己拼条件。
 * 注意:架子上的非活动 tab 也是 edge —— 形态说的是「它在哪」,不是「它可见吗」。
 */
export function placementOf(state: StageState, id: string): Placement {
  return state.placements[id] ?? DOCK
}

export function formOf(state: StageState, id: string): StageForm {
  return formIn(state.placements, id)
}

/**
 * 只拿到 placements 表时的形态查询。规则与 formOf 逐字相同(缺席 = dock)——
 * 存在的理由是投影层(Dock)只订阅了那张表,不该为了问一句形态去订阅整个 state。
 */
export function formIn(placements: Record<string, Placement>, id: string): StageForm {
  return (placements[id] ?? DOCK).kind
}

/** 独占形态至多一个,所以「谁在舞台上」是查询而不是字段。 */
function idInForm(state: StageState, form: StageForm): string | null {
  for (const [id, p] of Object.entries(state.placements)) {
    if (p.kind === form) return id
  }
  return null
}

export function stageIdOf(state: StageState): string | null {
  return idInForm(state, 'stage')
}

/**
 * **架子上的这一格此刻露不露脸**。收成一只函数是因为它有两个读者(Dock 点瓦的
 * 「再点一次收起来 vs 先把它露出来」,与下面那只 `isItemVisible`),而两处抄
 * 一遍迟早分叉 —— `activeId === id && !collapsed` 这句话只该有一个产地。
 *
 * 它只回答**架子内部**那一格,不问上面压着什么(盖 / 舞台由 `isItemVisible` 合并)。
 */
export function isShelfTabVisible(shelf: ShelfState, id: string): boolean {
  if (shelf.collapsed) return false
  /*
   * W4 起一条架子可以分屏,于是「露脸的那一个」不再只有一个 —— 每片叶各有一格
   * 活动 tab。`visible` 是投影出来的那张名单;**缺席读作 `[activeId]`**,
   * 也就是 W4 之前那条判据逐字保留(单叶架子上两者恒等)。
   */
  return shelf.visible ? shelf.visible.includes(id) : shelf.activeId === id
}

/**
 * **谁压在这块面上面**(答 null = 没人压着)。判据是 tokens 里那张 z 序表,
 * 不是猜的:`--z-float 200 < --z-overlay(舞台 scrim)500 < --z-full 550`。
 *
 *  · **舞台**的 scrim 铺满视口,所以它开着时**除它自己以外**的一切内容形都被压住。
 *
 * ── 全屏(550)为什么不在这张表里(W2)────────────────────────────────────
 * 「盖」那一行随 `--z-cover` 一起退役了,而接替它的全屏**在层序上压得过一切内容形**
 * (浮窗 200 与 overlay 500 都在它之下)—— 可它不是一种 Placement:被它盖住的那些面
 * 在形态机眼里一格都没变。这张表回答的是「形态机里谁压着谁」,所以它照旧只认舞台;
 * 「全屏盖住了什么」由拼贴台那一格瞬态自己说(`workbench.occludedByFull`),
 * 两处各答各的那一句,不混成一句。**留账**:因此 `summonItem` 在全屏期间不会报
 * `blocked` —— 召唤一块被全屏盖住的面会照常把它露出来(在看不见的地方)。
 *
 * 收在这里而不是各面自己判:「看不看得见」是形态机的事实,组件与召唤共用它。
 */
export function occluderOf(state: StageState, id: string): 'stage' | null {
  const placement = placementOf(state, id)
  if (placement.kind === 'dock') return null
  const stage = stageIdOf(state)
  if (stage !== null && stage !== id) return 'stage'
  return null
}

/**
 * **这块面此刻看不看得见** —— 全壳唯一那一句(设计 §14「看得见的判据只有一个产地」)。
 *
 * 四档逐条:
 *  · `dock`   —— 根本没开,不是「看不见」而是「不在场」,一律 false;
 *  · `stage`  —— 舞台至多一个、又压在最上面,所以它自己永远看得见;
 *  · `float`  —— **只有最上面那一扇算看得见**:`floatOrder` 末位最上,底下那几扇
 *    被压着(这正是设计 §14 说的「浮窗被压在下面」)。两扇窗**几何上**叠不叠
 *    这里不问 —— 纯函数不认识矩形交并,而「把它翻到最上面」对任何一扇被压的窗
 *    都是对的动作(与 `clickDockIcon` 对浮窗那一支同一句话);
 *  · `edge`   —— 架子内部露脸(`isShelfTabVisible`)且上面没压着盖 / 舞台。
 */
export function isItemVisible(state: StageState, id: string): boolean {
  const placement = placementOf(state, id)
  if (placement.kind === 'dock') return false
  if (occluderOf(state, id) !== null) return false
  if (placement.kind === 'float') {
    return state.floatOrder[state.floatOrder.length - 1] === id
  }
  if (placement.kind === 'edge') {
    return isShelfTabVisible(state.shelves[placement.side], id)
  }
  return true
}

/**
 * 退层链上那一站的**目标**。两种:退出全屏,或收掉某一块面。
 *
 * 它是可辨识联合而不是一个 `string | 'full'`:全屏不是一块「面」,它没有 item id
 * —— 它是拼贴台的一格瞬态,收它的动作也是另一台 store 的
 * (`workbench.exitFull()`)。用一个魔法字符串混在 id 里,第一个踩的人就是
 * `closeToDock('full')`。
 */
export type EscapeTarget = { kind: 'full' } | { kind: 'item'; id: string }

/**
 * Esc 该退掉哪一层 —— **唯一**回答这句话的地方(08-31 修「Esc 关不掉浮窗」)。
 *
 * 退层次序 = 视觉上压在最上面的那一块先退,与 z 序逐条对应:
 *   ① 全屏(--z-full 550,W2;它压得过浮窗与 overlay,所以排第一)
 *   ② 舞台(--z-overlay 500,scrim 铺满视口)
 *   ③ 最上面那扇浮窗(--z-float 200,floatOrder 末位最上)
 *
 * **`fullOpen` 是参数而不是从 `state` 里读的**:全屏那一格瞬态住在拼贴台那本账上
 * (`workbench.full`),而这只文件是形态机的纯函数半边 —— 它不认识另一台 store。
 * 递一个布尔进来,判据仍然全在这里,次序也仍然只有一个产地。
 *
 * **架子不在链里,这是有意的**:钉在边上是**常驻形**——用户把它当家具摆好了,
 * 一下 Esc 就把家具搬走不是「退一层」而是「拆一件」。同一条判据在
 * expose/transitions.enterSession 里已经立过一次(瞬态形收、常驻形留),
 * 两处说的是同一句话。想收架子有它自己的口:⌘\ / 栏头那颗收起钮。
 *
 * 返回 null = 这一下 Esc 没有面可退,交给别人(或者什么都不做)。
 *
 * ── 为什么这条链修的是「浮窗按 Esc 没反应」──────────────────────────────
 * 08-31 真机复现:Dock 点开会话总览(默认档就是浮窗)→ 按 Esc → placements
 * 一个字节都不变,窗还在。真因不是判据写错,而是**根本没有人听**:那时全仓
 * 只有 StageOverlay 挂了一条 Esc,而它只在有舞台时才挂载。浮窗与盖各自也去挂
 * 一条的话,三处就会各写一遍「谁该先退」——所以链收在这一个纯函数里,
 * 宿主只剩一条 window 监听(components/useEscapeChain)。
 */
export function escapeTargetOf(state: StageState, fullOpen: boolean): EscapeTarget | null {
  if (fullOpen) return { kind: 'full' }
  const id = stageIdOf(state) ?? (state.floatOrder[state.floatOrder.length - 1] ?? null)
  return id === null ? null : { kind: 'item', id }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/* ── 位置记忆 ──────────────────────────────────────────────────────────────── */

/**
 * 把 id **此刻的落点**折成一条记忆。收在 Dock 里 = 没有落点可折,所以是 null。
 * 「折」是这一批的核心动词:活表(placements / floats / shelves)散在三处,
 * 记忆把它们压成一条能独立复原的记录 —— 关闭之后活表就问不出来了。
 */
export function memoryOf(state: StageState, id: string): PlacementMemory | null {
  const p = placementOf(state, id)
  if (p.kind === 'dock') return null
  if (p.kind === 'stage') return { kind: 'stage' }
  if (p.kind === 'float') {
    // **没有矩形就是没有**(W7-p 修一轮裁定 1):这里不造。开的时候由
    // `placement.placeAs` 的那一只唯一产地(`freshFloatRect`)补,带上锚与层叠。
    return { kind: 'float', rect: state.floats[id] }
  }
  const tabs = state.shelves[p.side].tabs ?? []
  const at = tabs.indexOf(id)
  return { kind: 'edge', side: p.side, index: at < 0 ? tabs.length : at }
}

/** 写一条记忆。null = 无可记(在 Dock 里),此时是恒等变换 —— 归档不擦旧记忆。 */
function remember(state: StageState, id: string, m: PlacementMemory | null): StageState {
  if (!m) return state
  return { ...state, memory: { ...state.memory, [id]: m } }
}

/**
 * 记忆与菜单里那一行说的是不是同一个落点。
 * 浮窗矩形与边内次序**不参与**比对:菜单问的是「放在哪」,不是「放在哪儿的第几个」。
 */
export function memoryIsAt(m: PlacementMemory | undefined, placement: OpenPlacement): boolean {
  if (!m || m.kind !== placement.kind) return false
  if (m.kind === 'edge' && placement.kind === 'edge') return m.side === placement.side
  return true
}

/* ── 打开方式 → 落点 ───────────────────────────────────────────────────────── */

/**
 * 档值的运行时钳制。类型上 ResolvedOpen 已无 'stage',但**迁移会被在飞实例的写盘
 * 绕过**:v5 上线时开着的窗口,内存里还是旧值,任何一次状态写盘都会把旧值连同
 * 新版本号一起写回 —— 之后 migrate 看版本号≥5 就不再跑,残值永久落户
 * (08-30 用户报障「弹出后再开又钉回右边」的真因)。所以除了迁移段,
 * 读取处与 persist merge 各钳一次,共用这一个函数:只认 'pinned',
 * 其余一律浮窗(与打开统一拍板同一句话)。
 */
export function clampDefaultOpen(value: unknown): ResolvedOpen {
  return value === 'pinned' ? 'pinned' : 'float'
}

export function placementForOpen(open: ResolvedOpen): Exclude<MemorablePlacement, { kind: 'stage' }> {
  if (clampDefaultOpen(open) === 'pinned') return { kind: 'edge', side: 'right' }
  return { kind: 'float' }
}

/**
 * 把一个「说得出去哪儿」的落点补成一条完整记忆 —— 缺的那件事按「就当它没来过」补:
 * 钉边排到那条边的末尾,舞台与全屏本来就没有第二个参数。
 *
 * **浮窗那一档一个字都不补**(W7-p 修一轮裁定 1):记忆里没有矩形**就是没有**,
 * 而不是「先随便给一个」。从前这里当场造一个 `defaultFloatRect(viewport)`(没有
 * 中央区参考系、cascade 恒 0),它随后被 `openFromMemory` 写进 `floats[id]`,
 * 于是 `placeAs` 认为矩形已经有了、跳过唯一那只产地 —— 点瓦开出来的窗永远叠成
 * 一摞。判词整段在 `freshFloatRect` 上。
 *
 * 两个调用方共用它(全局默认档 / item 天生落点),所以「补什么」只写一次。
 */
export function completeMemory(state: StageState, placement: OpenPlacement): PlacementMemory {
  if (placement.kind === 'float') return { kind: 'float' }
  if (placement.kind === 'edge') {
    return { kind: 'edge', side: placement.side, index: (state.shelves[placement.side].tabs ?? []).length }
  }
  return placement
}

/**
 * 全局默认档补成一条完整记忆。
 *
 * **不再收视口**(W7-p 修一轮裁定 1):这一族从前收它只为了给浮窗那一档造一个
 * 默认矩形,而那件事整个搬去了 `freshFloatRect`(唯一产地)。收着一个用不上的
 * 视口就是留着一个「下一个人拿它再造一个矩形」的位子。
 */
export function defaultOpenMemory(state: StageState, open: ResolvedOpen): PlacementMemory {
  return completeMemory(state, placementForOpen(open))
}

/**
 * 打开的解析序是四层:**显式手势 > 记忆 > item 天生落点 > 全局默认档**。
 * 头一层不经过这个函数 —— 手势自己就说得出落点(它直接调 openAs),根本不必问;
 * 这里回答的是剩下那句「没人点名时,它该回哪儿」,所以只剩后三层。
 *
 * 第三层(`itemDefault`,08-31 随「盖」一起加)插在记忆**之下**、全局档**之上**:
 * 「这块面适合怎么开」是它自己的性质(所有应用是一张铺满的清单,天生该盖),
 * 而「我想怎么开」永远由用户说了算 —— 所以用户亲手放过一次之后,记忆压过它。
 * 参数由调用方(store)从 items 表上取,纯函数不认识那张表。
 */
export function resolveOpen(
  state: StageState,
  id: string,
  defaultOpen: ResolvedOpen,
  itemDefault?: OpenPlacement,
): PlacementMemory {
  /*
   * ── 记忆语义的定案(08-30 晚,用户逐字给出流程后第三版,前两版是误解)──────
   *
   * **记忆 = 最后一次显式落点;打开 = 还原记忆;无记忆才用默认档(浮窗)。**
   *
   * 用户的流程逐字:初始打开 → 浮窗;把它钉到右边 → 记忆=右;关掉再点开 →
   * 出现在右;在右边把它**弹出来** → 这个手势本身把记忆改写成浮窗(openAs
   * 落定即写,写侧从来是对的);关掉再开 → 浮窗。
   *
   * 前两版为什么错:一版只钳舞台、二版「档定形态记忆只补参数」—— 都是把
   * 「打开统一浮窗」误读成了「打开永远浮窗」。用户要统一的是**无记忆时的默认形**
   * (popup/浮窗二选一的那次拍板),不是要抹掉「我亲手钉过它」这件事实。
   * 于是二版把 pin→关→开 变成了浮窗,用户第三次报障后才说清。教训:行为模型
   * 没对齐前,补丁越勤越糟 —— 先复述流程再动手。
   *
   * 舞台记忆同样还原(它也是显式落点:浮窗放大钮/双击写下的);v5 迁移清过一次
   * 存量 stage 记忆属于当时二版语义的一次性动作,不再重复。档的残值钳制
   * (clampDefaultOpen)只作用于**默认档**,与记忆无关。
   */
  if (state.memory[id]) return state.memory[id]
  if (itemDefault) return completeMemory(state, itemDefault)
  return defaultOpenMemory(state, defaultOpen)
}

/* ── 浮窗几何(纯算术,与 state 无关,所以能单独测) ────────────────────────── */

/*
 * ── **两把尺,各服务一条路**(09-04 §4,用户判例「行为裁定须先问、缺省保旧」)──
 *
 * 同一份矩形在两种时刻被钳,两种时刻要的手感不一样,所以是两个函数而不是一个:
 *
 *  | 尺 | 谁在用 | 位置口径 |
 *  | --- | --- | --- |
 *  | `clampFloatRect` | **手势与落定**:拖移 / 缩放(`moveFloat`/`resizeFloat`/`FloatWindow` 的逐帧预览)、开窗(`defaultFloatRect`)、按记忆还原(`openFromMemory`/`floatRectForGrab`) | **旧口径一字不动**:允许出界,只保证至少 FLOAT_KEEP=40 那么一截留在视口里(纵向下界 0) |
 *  | `fitFloatRect`   | **重钳**:视口变了 / 档案是别的尺寸的窗存下的(`reclampAll` → store 的 `reclampFloats` 与 persist 的 `merge`) | **整扇拉回视口内**,两端各留 FLOAT_MARGIN;塞不下才退回上面那条 KEEP |
 *
 * 两把尺**共用身量那一格**(`clampFloatSize`):`w ∈ [FLOAT_MIN_W, vp.w - 2*MARGIN]`,
 * 高同理 —— 这是本批唯一加在手势那条路上的新约束(从前 w 只有下界,于是 1400 宽的窗里
 * 拉出来的 1300 宽浮窗换到 1100 的窗里怎么钳都出界)。
 *
 * **留账:拖拽是否也改认 MARGIN(即拖窗不再能推出屏幕边缘)待用户拍板。** 本批按
 * 「缺省保旧」只让重钳这条路认 MARGIN;要统一成一把尺的话,删掉 clampFloatRect 里
 * 的 KEEP 分支、让它直接调 fitFloatRect 即可,四条既有用例会当场红出差异。
 */

/**
 * 身量钳制:两把尺共用的那一格。上界是 09-04 §4 新加的 —— 只有下界的话,
 * 从宽屏存下来的身量在窄窗里无论怎么摆都出界(报障现场:1100 宽的窗里躺着 w=879)。
 */
function clampFloatSize(rect: FloatRect, viewport: Viewport): { w: number; h: number } {
  return {
    w: clamp(Math.round(rect.w), FLOAT_MIN_W, viewport.w - 2 * FLOAT_MARGIN),
    h: clamp(Math.round(rect.h), FLOAT_MIN_H, viewport.h - 2 * FLOAT_MARGIN),
  }
}

/**
 * **手势与落定那把尺**(位置口径 09-04 之前一字不动):身量不小于最小档、不大于
 * 视口减两道气口,且至少 FLOAT_KEEP 那么一截留在视口里。
 * 纵向下界是 0 而不是「露出 40px」—— 标题栏被推出屏顶就再也拖不回来了。
 */
export function clampFloatRect(rect: FloatRect, viewport: Viewport): FloatRect {
  const { w, h } = clampFloatSize(rect, viewport)
  return {
    w,
    h,
    x: clamp(Math.round(rect.x), FLOAT_KEEP - w, viewport.w - FLOAT_KEEP),
    y: clamp(Math.round(rect.y), 0, viewport.h - FLOAT_KEEP),
  }
}

/**
 * **重钳那把尺**:**先尺寸后位置,整扇拉回视口内**。
 *
 * 先后次序是判据的一部分 —— 反过来算的话右边缘用的是还没钳过的宽度,钳完位置窗子
 * 照样探出去(09-04 报障就是这一格:x=260 / w=879 落进 1100 宽的窗,只钳位置时 x
 * 合法而 x+w=1139 > 1100,右缘被切)。
 *
 * 位置:放得下就 `x ∈ [MARGIN, vp.w - MARGIN - w]`(整扇在内);**放不下才退回
 * `clampFloatRect` 那条 KEEP 老规矩** —— 「放不下」= 视口比 `FLOAT_MIN_W + 2*MARGIN`
 * 还窄,那是最小档窗子都塞不进去的视口,「整扇留在里面」根本无解,只能保「还看得见、
 * 还抓得住」。
 */
export function fitFloatRect(rect: FloatRect, viewport: Viewport): FloatRect {
  const { w, h } = clampFloatSize(rect, viewport)
  const keep = clampFloatRect(rect, viewport)
  return {
    w,
    h,
    x: fitFloatAxis(Math.round(rect.x), w, viewport.w, keep.x),
    y: fitFloatAxis(Math.round(rect.y), h, viewport.h, keep.y),
  }
}

/** 一条轴:放得下认 MARGIN(整扇在内),放不下就交回 KEEP 那把尺已经算好的值。 */
function fitFloatAxis(pos: number, size: number, extent: number, fallback: number): number {
  const inside = extent - FLOAT_MARGIN - size
  return inside >= FLOAT_MARGIN ? clamp(pos, FLOAT_MARGIN, inside) : fallback
}

/**
 * **中央区此刻的矩形**(W7-p 裁定 5)。四条架子各占一截,剩下的就是它。
 *
 * 它是新浮窗那个锚点的参考系 —— 「贴视口右上角」在钉了右架子的时候会开在架子
 * **底下**,而用户看到的「右上角」从来是主区的右上角。**顶栏那条带也切掉**
 * (`TOP_CHROME`,判词写在那格常量上):标签条就长在顶栏里,不切的话新窗一开
 * 就盖住它的右半截。
 */
export function centerRectOf(state: Pick<StageState, 'shelves'>, viewport: Viewport): Rect {
  const left = shelfExtentOf(state.shelves.left)
  const right = shelfExtentOf(state.shelves.right)
  const top = shelfExtentOf(state.shelves.top)
  const bottom = shelfExtentOf(state.shelves.bottom)
  // 竖轴的可用高度从**顶栏之下**起算 —— 与 `usableExtent` 是同一句话,判词写在那儿。
  const topEdge = viewport.h - usableExtent('top', viewport) + top
  return {
    left,
    top: topEdge,
    right: Math.max(left, viewport.w - right),
    bottom: Math.max(topEdge, viewport.h - bottom),
  }
}

/** 新窗锚在中央区右上角往里缩这么多;第 n 扇往左下层叠这么多(W7-p 裁定 5)。 */
export const FLOAT_SPAWN_INSET = 24
export const FLOAT_CASCADE_STEP = 28

/**
 * **一扇新窗的矩形怎么算**(W7-p 裁定 5,审计 A 的 A6;W7-p 修一轮把它收成内部件)。
 *
 * ── 病历 ──────────────────────────────────────────────────────────────────
 * 从前是**恒定居中**:①那个矩形正压着聊天区正中与输入框,一扇窗开出来就把用户
 * 正在读的东西盖掉;②连开四扇,四扇一模一样地叠在一起 —— 屏幕上看起来只有一扇,
 * 前三扇要靠拖才找得到。
 *
 * ── 今天:锚 + 层叠 + 回绕 ────────────────────────────────────────────────
 * 锚在**中央区右上角**往里缩 24px:右上角是这台壳上最空的一块地(输入框在下、
 * 正文靠左),而「往里缩」让它一眼看得出是浮在上面而不是钉在边上。已经有 n 扇
 * 未关的窗时整体往**左下**挪 n×28 —— 左下是远离锚点的方向,于是每一扇的**标题栏
 * 左上角**都露在外面,拿得住。挪到出了中央区就**回绕到起点**:层叠是为了都看得见,
 * 而挪出屏幕正好相反。
 *
 * **它是算术,不是产地**:谁该拿到什么参考系由 `freshFloatRect`(唯一的产地)
 * 与 `defaultFloatRect`(只要身量的那两个存量调用点)各自说,判词见它们各自的头上。
 */
function floatRectAt(viewport: Viewport, center: Rect, cascade: number): FloatRect {
  // 身量先过一次那把尺(视口比默认还小的时候 640 会被压到 `视口 − 两道气口`),
  // **锚点才拿得到真身量** —— 拿没钳过的宽去算右上角,窄视口下会算出负的 x。
  const size = clampFloatSize(
    { x: 0, y: 0, w: Math.min(FLOAT_DEFAULT_W, viewport.w), h: Math.min(FLOAT_DEFAULT_H, viewport.h) },
    viewport,
  )
  const { w, h } = size
  const anchorX = center.right - FLOAT_SPAWN_INSET - w
  const anchorY = center.top + FLOAT_SPAWN_INSET
  // 还能往左下挪几步(挪到锚点左边/下边出了中央区就不算一步)。
  const stepsX = Math.floor(Math.max(0, anchorX - center.left) / FLOAT_CASCADE_STEP)
  const stepsY = Math.floor(Math.max(0, center.bottom - anchorY - h) / FLOAT_CASCADE_STEP)
  const steps = Math.max(0, Math.min(stepsX, stepsY))
  // 回绕:第 steps+1 扇回到起点(steps = 0 时每一扇都在锚点上,那是「实在挪不动」)。
  const at = steps === 0 ? 0 : Math.max(0, Math.trunc(cascade)) % (steps + 1)
  return clampFloatRect(
    { w, h, x: anchorX - at * FLOAT_CASCADE_STEP, y: anchorY + at * FLOAT_CASCADE_STEP },
    viewport,
  )
}

/**
 * **开一扇新窗要的那两个读数**(W7-p 修一轮裁定 1)。
 *
 * 从前这两句(`{ center: centerRectOf(st, vp), cascade: floatOrder.length }`)在
 * `stage/placement.ts` 与 `stage/store.ts` 里**各写了一遍** —— 两处算同一件事、
 * 而下一个人只会改其中一处。收成一只之后「新窗的参考系是什么」只有这一个答案。
 */
export function floatSpawnContext(
  state: Pick<StageState, 'shelves' | 'floatOrder'>,
  viewport: Viewport,
): { center: Rect; cascade: number } {
  return { center: centerRectOf(state, viewport), cascade: state.floatOrder.length }
}

/**
 * **一扇新窗的矩形 —— 全壳唯一的产地**(W7-p 修一轮裁定 1)。
 *
 * ── 病历(修一轮拆出来的那条 blocking)────────────────────────────────────
 * 裁定 5 落地时锚与层叠只接在**这一只**上,而最常走的那条路(点 Dock 瓦 / 快捷键
 * 第一态「开」)根本不经过它:`resolveOpen` 无记忆时由 `completeMemory` **当场造**
 * 一个 `defaultFloatRect(viewport)` —— 没有中央区参考系、`cascade` 恒 0 —— 塞进
 * 那条「记忆」里;`openFromMemory` 先把它写进 `floats[id]`,`placeAs` 于是看到
 * 「已经有矩形了」直接跳过这一只。真机后果:连开四扇窗,四扇一模一样地叠在一起,
 * 而裁定 5 的门只量右键菜单那条路,量不到。
 *
 * ── 今天:**记忆里没有矩形就是没有** ─────────────────────────────────────
 * `completeMemory` 不再造矩形(`PlacementMemory` 的 float 那一档 `rect?` 因此是可选的),
 * 缺矩形一律落到这一只 —— 于是「新窗开在哪」这句话只有一个答案,而不是「看它是从
 * 哪条路开的」。
 */
export function freshFloatRect(
  state: Pick<StageState, 'shelves' | 'floatOrder'>,
  viewport: Viewport,
): FloatRect {
  const ctx = floatSpawnContext(state, viewport)
  return floatRectAt(viewport, ctx.center, ctx.cascade)
}

/**
 * **只要身量的那条兜底**:视口右上角、不层叠、不问架子。
 *
 * 它**不是**「新窗开在哪」的答案(那一只是 `freshFloatRect`),留着只为两个
 * 存量调用点,而它们要的都只是**多大**:`workbench/drop-commit` 的
 * 「这扇窗还没有矩形时先按默认身量落」与 `workbench/useContentDrag` 的
 * 「从指针位置反推撕出来那扇窗的矩形」(位置由指针给,不由锚点给)。
 */
export function defaultFloatRect(viewport: Viewport): FloatRect {
  return floatRectAt(viewport, { left: 0, top: 0, right: viewport.w, bottom: viewport.h }, 0)
}

/**
 * **视口变了之后把每一格浮窗矩形重钳一遍**(09-04 §4)。
 *
 * 它治的是「钳制只发生在手势那一刻」这条老毛病:窗子放大时存下来的 880 宽浮窗,
 * 换到 1100 宽的窗里既没人量也没人钳,于是右缘被切在屏幕外 —— 而拖它一下就好了,
 * 正说明少的不是判据(clampFloatRect 一直在),是**触发时机**。
 *
 * 钳的是**活位置**,而且只有活位置(W7-p 裁定 4 收窄:`memory` 从此只由手势与落定
 * 写,判词整段在 `reclampFloatMap` 上):
 *  · `floats` —— 此刻开着的那些窗,源头取它们各自的**记忆**;
 *  · `shelves` —— 四条架子按共同预算重钳(裁定 3,见 `reclampShelves`);
 *  · `byWorkspace` 每个空间那一格家具里的 `floats` —— 别的空间切回来时同样在这扇窗里。
 * 关着的窗不必在这里钳:`openFromMemory` 开出来的第一件事就是过一次
 * `clampFloatRect`,那是同一条界的另一个时刻。
 *
 * 用的是**重钳那把尺** `fitFloatRect`(整扇拉回视口内),不是手势那把 —— 两把尺的
 * 分工见上面那张表。
 *
 * **不变即恒等**:一格都没动就交回**同一个对象**,于是 store 的 `set` 认得出
 * (zustand 对 `Object.is(next, state)` 直接不通知),一次 resize 不会白推一轮渲染。
 */
export function reclampAll<S extends StageState & Partial<PerSpaceState<StageFurniture>>>(
  state: S,
  viewport: Viewport,
): S {
  /*
   * **架子也重钳**(W7-p 裁定 3/裁定 4)。它只作用在**活状态**上:账上别的空间那
   * 几格家具没有 `tabs`(那是投影,不落盘),所以「这条边此刻占了多厚」在那儿根本
   * 问不出来 —— 切回那个空间时投影一响、这只函数再跑一遍,那才是它该被钳的时刻。
   */
  const live = reclampShelves(reclampFloatGeometry(state, viewport), viewport)
  const ledger = state.byWorkspace
  if (!ledger) return live
  let nextLedger: SpaceLedger<StageFurniture> | null = null
  for (const [spaceId, furniture] of Object.entries(ledger)) {
    const reclamped = reclampFloatGeometry(furniture, viewport)
    if (reclamped === furniture) continue
    nextLedger ??= { ...ledger }
    nextLedger[spaceId] = reclamped
  }
  if (!nextLedger) return live
  return { ...live, byWorkspace: nextLedger }
}

/**
 * 一份「有 floats 与 memory 的东西」里的全部浮窗矩形重钳。活状态与账上某个空间的
 * 那一格家具形状相同(两者都是 `Pick<StageState, 'floats' | 'memory'>` 的超集),
 * 所以这一句只写一遍 —— 两处各写一遍正是「存的时候多钳一格、摊的时候少钳一格」的来源。
 */
function reclampFloatGeometry<T extends Pick<StageState, 'floats' | 'memory'>>(
  source: T,
  viewport: Viewport,
): T {
  const floats = reclampFloatMap(source.floats, source.memory, viewport)
  if (floats === source.floats) return source
  return { ...source, floats }
}

/**
 * **重钳只改活位置,而且它是从记忆里算出来的**(W7-p 裁定 4,审计 A 的 A5)。
 *
 * ── 病历 ──────────────────────────────────────────────────────────────────
 * 从前这一遍**同时**改 `floats` 与 `memory`:窗口缩窄一次,那扇 880 宽的浮窗被
 * 钳成 640 并**写进记忆**,窗口再拉回来时源头已经是 640 —— 一次临时的窄屏永久
 * 改写了用户摆好的身量,而用户什么都没做。
 *
 * ── 修法:两格分工写清楚 ──────────────────────────────────────────────────
 *  · `memory[id].rect` = **用户的意图**,只由手势与落定写(`withFloatRect` /
 *    `rememberLanding`),重钳一个字都不碰;
 *  · `floats[id]`      = 那份意图**在此刻这扇窗里**的样子 = `fitFloatRect(记忆, 视口)`。
 * 于是「变窄再变宽」是纯函数的恒等:两次都从同一份记忆算,宽回去就逐字回去。
 * 拿活矩形当源头算不出这件事 —— 那是「在已经钳过的结果上再钳一次」,信息已经丢了。
 *
 * 没有记忆的(此刻不是浮窗、或还没落定过一次)退回活矩形当源头:那时它就是唯一
 * 的事实,而「不钳」比「拿别人的记忆钳」诚实。
 */
function reclampFloatMap(
  floats: StageState['floats'],
  memory: StageState['memory'],
  viewport: Viewport,
): StageState['floats'] {
  let next: StageState['floats'] | null = null
  for (const [id, rect] of Object.entries(floats)) {
    const remembered = memory[id]
    // 记忆里的浮窗矩形是**可选的**(W7-p 修一轮裁定 1)——「记得自己浮着但没人
    // 量过多大」的那一格没有源头可言,退回活矩形,与「没有记忆」逐字同一档。
    const source = (remembered?.kind === 'float' ? remembered.rect : undefined) ?? rect
    const clamped = fitFloatRect(source, viewport)
    if (sameRect(clamped, rect)) continue
    next ??= { ...floats }
    next[id] = clamped
  }
  return next ?? floats
}

/** 逐格相等 —— 「有没有变」是这一族恒等语义的判据,不能靠引用(钳制每次都造新对象)。 */
function sameRect(a: FloatRect, b: FloatRect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}

export type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/**
 * 从一个把手拖出 (dx, dy) 之后的矩形。拖北/西两边时最小档卡住的是**身量**,
 * 坐标要跟着回推,否则窗子会一边缩到最小一边继续往外跑。
 */
export function resizeFrom(rect: FloatRect, dir: ResizeDir, dx: number, dy: number): FloatRect {
  let { x, y, w, h } = rect
  if (dir.includes('e')) w = Math.max(FLOAT_MIN_W, rect.w + dx)
  if (dir.includes('s')) h = Math.max(FLOAT_MIN_H, rect.h + dy)
  if (dir.includes('w')) {
    w = Math.max(FLOAT_MIN_W, rect.w - dx)
    x = rect.x + rect.w - w
  }
  if (dir.includes('n')) {
    h = Math.max(FLOAT_MIN_H, rect.h - dy)
    y = rect.y + rect.h - h
  }
  return { x, y, w, h }
}

/* ── 住处的写口整段搬走了(W4)────────────────────────────────────────────
 *
 * 从前这里有一族纯函数 —— `detach` / `openAs` / `closeToDock` / `clickDockIcon` /
 * `closeStage` / `closeCover` / `escapeTopmost` / `stageToFloat` / `stageToEdge` /
 * `floatToEdge` / `edgeToFloat` / `closeShelf` / `activateShelfTab` /
 * `openFromMemory` / `withoutTransientPlacements` —— 它们改的是 `placements` 与
 * `shelves[side].tabs`,也就是**一块瓦此刻住在哪儿**。
 *
 * W4 把架子与浮窗的身子换成了拼贴树之后,那两格降格成投影(见 `./residency.ts`
 * 与 `types.ts` 上的判词),真相住在 `workbench.regions` 里。于是这些函数写的
 * 已经不是事实,而是事实的影子 —— 留着就是第二个产地。
 *
 * 它们整族搬进了 **`stage/placement.ts`**:同样的判据、同样的次序、同样的
 * 「落定即写记忆」,只是落笔处从 `StageState` 换成了那棵树。
 * 这只文件从此只剩两件事:**读**(形态查询)与**几何**(矩形 / 厚度 / 吸附 /
 * Dock 唤醒 / 退层链的判据),它们一个字都没动。
 */


/* ── 浮窗 ──────────────────────────────────────────────────────────────────── */

/** 置顶:挪到 floatOrder 末位。不是浮窗、或已经在末位,都是恒等变换。 */
export function focusFloat(state: StageState, id: string): StageState {
  const order = state.floatOrder
  const at = order.indexOf(id)
  if (at < 0 || at === order.length - 1) return state
  return { ...state, floatOrder: [...order.filter((x) => x !== id), id] }
}

/**
 * 落定一个浮窗矩形。活位置写 floats,**同一下**写进记忆 ——
 * 「拖到哪就记到哪」不该是组件在松手时另外记得做的第二件事。
 *
 * 只有此刻真是浮窗才写记忆:floats 是一张不擦的表(收回 Dock 也留着),
 * 拿一条陈年矩形去盖掉它现在的钉边记忆,就等于用过去否掉现在。
 */
function withFloatRect(state: StageState, id: string, rect: FloatRect): StageState {
  const next = { ...state, floats: { ...state.floats, [id]: rect } }
  if (placementOf(state, id).kind !== 'float') return next
  return remember(next, id, { kind: 'float', rect })
}

export function moveFloat(
  state: StageState,
  id: string,
  x: number,
  y: number,
  viewport: Viewport = FALLBACK_VIEWPORT,
): StageState {
  const rect = state.floats[id]
  if (!rect) return state
  return withFloatRect(state, id, clampFloatRect({ ...rect, x, y }, viewport))
}

export function resizeFloat(
  state: StageState,
  id: string,
  rect: FloatRect,
  viewport: Viewport = FALLBACK_VIEWPORT,
): StageState {
  if (!state.floats[id]) return state
  return withFloatRect(state, id, clampFloatRect(rect, viewport))
}

/* ── 架子 ──────────────────────────────────────────────────────────────────── */

function setShelfCollapsed(state: StageState, side: ShelfSide, collapsed: boolean): StageState {
  const shelf = state.shelves[side]
  if (shelf.collapsed === collapsed) return state
  return { ...state, shelves: { ...state.shelves, [side]: { ...shelf, collapsed } } }
}

/** 收/展整条架子。tab 次序与活动 tab 一个都不动 —— 收起的是栏,不是内容。 */
export function toggleShelfCollapsed(state: StageState, side: ShelfSide): StageState {
  return setShelfCollapsed(state, side, !state.shelves[side].collapsed)
}

/**
 * 「厚度」换个轴读的唯一一处:竖边(左/右)量宽,横边(上/下)量高。
 * 钳制、拖拽反推、CSS 写哪个维度,三处都问这一个函数,不各判各的。
 */
export function shelfViewportExtent(side: ShelfSide, viewport: Viewport): number {
  return side === 'left' || side === 'right' ? viewport.w : viewport.h
}

/** 对面那条边。四条边只在这一张表里配对,别处不许再写 `side === 'left' ? …`。 */
export const OPPOSITE_SHELF: Record<ShelfSide, ShelfSide> = {
  left: 'right',
  right: 'left',
  top: 'bottom',
  bottom: 'top',
}

/** 这条轴上中央区至少要留多少(竖边吃宽,横边吃高)。与 `shelfViewportExtent` 同一把尺。 */
export function centerMinOn(side: ShelfSide): number {
  return side === 'left' || side === 'right' ? CENTER_MIN_W : CENTER_MIN_H
}

/**
 * **这条轴上「架子与中央区一起分」的那块地**(W7-p 修一轮裁定 6)。
 *
 * ── 病历 ──────────────────────────────────────────────────────────────────
 * `shelfThicknessBudget` 从前直接减 `viewport.h`,而 `centerRectOf` 与架子的排布
 * **都从顶栏之下起算** —— 两把尺差了一条 44px 的顶栏。真机后果:860 高的窗上
 * 「上架子 300 + 下架子 240」被判为装得下(860 − 320 − 300 = 240 ≥ 240),而屏幕上
 * 中央区实高只有 860 − 44 − 300 − 240 = 276 < 320。**同一件事只该有一把尺**,
 * 所以预算与 `centerRectOf` 从今天起都问这一只。
 *
 * 横轴没有对应的一条(左右两侧顶到视口边),所以它就是视口宽。
 */
export function usableExtent(side: ShelfSide, viewport: Viewport): number {
  return side === 'left' || side === 'right' ? viewport.w : viewport.h - TOP_CHROME
}

/**
 * 这条边**此刻真占了多厚**。三档,判据是「屏幕上能量到什么」而不是「档案里存了什么」:
 * 空架子自己 `return null` 不进布局 = 0;收起来的只剩一条细梁;展开的才是厚度。
 */
export function shelfExtentOf(shelf: ShelfState): number {
  if ((shelf.tabs ?? []).length === 0) return 0
  return shelf.collapsed ? SHELF_RAIL : shelf.thickness
}

/**
 * **一条边的共同预算**(W7-p 裁定 3):`该轴可用长度 − 中央最小 − 对边此刻厚度`。
 *
 * 「可用长度」是 `usableExtent`,不是视口 —— 竖轴上顶栏那 44px 不参与分地
 * (W7-p 修一轮裁定 6,判词与病历写在那只函数上)。
 *
 * 它可以答出比 `SHELF_MIN_THICKNESS` 还小的数,甚至负数 —— 那不是「钳到多少」,
 * 那是「这条边此刻**摆不下**」,由 `canNailShelf` 读同一个数答出来。把两件事写成
 * 一个函数两种读法,是为了不出现「钉的时候用一把尺、拖杆的时候用另一把」。
 */
export function shelfThicknessBudget(
  state: Pick<StageState, 'shelves'>,
  side: ShelfSide,
  viewport: Viewport,
): number {
  const opposite = state.shelves[OPPOSITE_SHELF[side]]
  return (
    usableExtent(side, viewport) -
    centerMinOn(side) -
    (opposite ? shelfExtentOf(opposite) : 0)
  )
}

/**
 * **这份预算摆得下一条架子吗**。`canNailShelf`(钉一条新的)与 `reclampShelves`
 * (视口变小之后重钳)读同一句话 —— 一个答「拒绝」,一个答「收成细梁」,而
 * 「装不装得下」只有这一处判据。
 */
export function shelfFitsBudget(budget: number): boolean {
  return budget >= SHELF_MIN_THICKNESS
}

/**
 * **这条边现在钉得上吗**(W7-p 裁定 3)。
 *
 * 已经有东西在这条边上 = 永远钉得上:再插一格 tab 不改几何,而「拒绝往一条已经
 * 开着的架子上再放一格」对用户是纯粹的莫名其妙。空着的那条才问预算 —— 摆不下就
 * **拒绝并保持原样**,不许把中央区压成 0(那是 A3 的原始病)。
 */
export function canNailShelf(
  state: Pick<StageState, 'shelves'>,
  side: ShelfSide,
  viewport: Viewport,
): boolean {
  if ((state.shelves[side]?.tabs ?? []).length > 0) return true
  return shelfFitsBudget(shelfThicknessBudget(state, side, viewport))
}

/**
 * 架子厚度钳到 `[240, min(视口 × 55%, 共同预算)]`;两条上界打架时**小的赢**,
 * 而下界 240 永远赢(clamp 要求 min ≤ max,所以上界先被抬到不低于下界)。
 * 上界取整:厚度最终是一个 px,55% 算出来的浮点尾巴不该被存进档案。
 *
 * `budget` 缺省 = 不设预算 —— 留给「只有一条边、对面空着」那类调用与存量单测;
 * 真正的两条路(拖杆 `setShelfThickness`、resize 重钳 `reclampShelves`)都递。
 */
export function clampShelfThickness(
  thickness: number,
  viewportExtent: number,
  budget: number = Number.POSITIVE_INFINITY,
): number {
  const ceiling = Math.min(Math.round(viewportExtent * SHELF_MAX_RATIO), Math.round(budget))
  return clamp(Math.round(thickness), SHELF_MIN_THICKNESS, Math.max(SHELF_MIN_THICKNESS, ceiling))
}

/**
 * 拖把手时从指针位置反推厚度。量的是「外缘 → 指针」那一段:
 * 外缘(架子贴着视口的那一侧)在整个拖拽期间不动,所以宿主只需在按下时测一次。
 */
export function thicknessFromPointer(side: ShelfSide, pointer: Point, outerEdge: number): number {
  if (side === 'left') return pointer.x - outerEdge
  if (side === 'right') return outerEdge - pointer.x
  if (side === 'top') return pointer.y - outerEdge
  return outerEdge - pointer.y
}

/**
 * 拖杆落定。**上界走共同预算**(W7-p 裁定 3)—— 拖到底也只到「对边与中央都还
 * 站得住」的那一格,而不是从前那条各算各的 55%。
 */
export function setShelfThickness(
  state: StageState,
  side: ShelfSide,
  thickness: number,
  viewport: Viewport,
): StageState {
  const shelf = state.shelves[side]
  const next = clampShelfThickness(
    thickness,
    shelfViewportExtent(side, viewport),
    shelfThicknessBudget(state, side, viewport),
  )
  if (next === shelf.thickness) return state
  return { ...state, shelves: { ...state.shelves, [side]: { ...shelf, thickness: next } } }
}

/**
 * **视口变了之后把四条架子按同一把尺重钳**(W7-p 裁定 3,审计 A 的 A4)。
 *
 * 次序即语义:**后钉的那条先钳**。预算是两条对边分的一块地,先钳谁谁就先让 ——
 * 让**后来的**让,是因为用户先摆好的那条是他的既有布局,新来的那条才是这一次
 * 挤不下的原因。「哪条是后钉的」由 `shelfNailOrder` 说(投影现算,见
 * `residency.projectResidency`);账上没有的(冷启动第一帧,四条边同时出现)
 * 退到 `SHELF_SIDES` 那个固定次序 —— 确定、可复现,而且此刻本来就没有先后可言。
 *
 * ── **中央区最小身量优先**(W7-p 修一轮裁定 6 的第二半)────────────────────
 * `clampShelfThickness` 的下界 240 永远赢,所以从前预算算出 96 也照样停在 240 ——
 * 两条对边都钉着再把窗缩到 700×500,真机量到中央区 220×216(裁定 3 立的
 * 480×320 当场失效)。裁定:**中央区的最小身量优先于架子的最小厚度**;预算装不下
 * 时那条架子**收成细梁**(`SHELF_RAIL` 12px,它仍旧在、仍旧点得开),而不是停在
 * 240 把中央区挤没。
 *
 * 谁让位:**后钉的先让** —— 与钳的次序是同一条(先处理的那条就是最后钉的),
 * 所以「让位的那条是最后钉的」不是另一条规则,是这一条的直接结果。收成细梁之后
 * 它只占 12px,对边接着算预算时看到的就是这个数,于是让位一条常常就够了。
 *
 * **不变即恒等**:一条都没动就交回同一个对象(与 `reclampAll` 逐字同一条纪律)。
 */
export function reclampShelves<S extends StageState>(state: S, viewport: Viewport): S {
  const order = [...SHELF_SIDES].sort(
    (a, b) => nailRank(state, b) - nailRank(state, a),
  )
  let shelves: Record<ShelfSide, ShelfState> | null = null
  const read = (side: ShelfSide): ShelfState => (shelves ?? state.shelves)[side]
  for (const side of order) {
    const shelf = read(side)
    if (shelfExtentOf(shelf) === 0) continue
    const budget = shelfThicknessBudget({ shelves: shelves ?? state.shelves }, side, viewport)
    if (!shelfFitsBudget(budget)) {
      // 摆不下 —— 收成细梁(见上)。已经收着的就是恒等变换:厚度一个字不动,
      // 窗口拉回去展开时它还是用户拖出来的那个数。
      if (shelf.collapsed) continue
      shelves ??= { ...state.shelves }
      shelves[side] = { ...shelf, collapsed: true }
      continue
    }
    const next = clampShelfThickness(shelf.thickness, shelfViewportExtent(side, viewport), budget)
    if (next === shelf.thickness) continue
    shelves ??= { ...state.shelves }
    shelves[side] = { ...shelf, thickness: next }
  }
  return shelves ? { ...state, shelves } : state
}

/** 这条边排在钉边序的第几位。不在账上 = -1(比任何真名次都早,于是最后才钳)。 */
function nailRank(state: StageState, side: ShelfSide): number {
  return state.shelfNailOrder?.indexOf(side) ?? -1
}

/* ── 拖拽吸附(纯判定:输入是坐标,输出是「该落哪条边」) ────────────────────── */

/** 边 → 指针到这条边的距离。四条边只在这一张表里被写成坐标,别处不许再拼。 */
const EDGE_DISTANCE: Record<ShelfSide, (p: Point, v: Viewport) => number> = {
  left: (p) => p.x,
  right: (p, v) => v.w - p.x,
  top: (p) => p.y,
  bottom: (p, v) => v.h - p.y,
}

/**
 * 指针落在哪条边的热带里 —— 落不进任何一条就是 null(不吸,松手照常落位)。
 * 角落归最近的那条边;**平手优先左右**,理由是竖架子是主力形态(右栏是出厂默认),
 * 判据写死在这张表的次序里(left/right 排在前,严格小于才换人)。
 */
export function snapSideAt(pointer: Point, viewport: Viewport, band: number = SNAP_BAND): ShelfSide | null {
  let best: ShelfSide | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const side of SHELF_SIDES) {
    const d = EDGE_DISTANCE[side](pointer, viewport)
    if (d > band) continue
    if (d < bestDistance) {
      best = side
      bestDistance = d
    }
  }
  return best
}

/**
 * 从架子上往主区方向拖了多远。为负 = 还压在架子那一侧。
 * innerEdge 是架子朝主区那一侧的坐标(宿主量 DOM 得到)。
 */
export function tearOffDistance(side: ShelfSide, pointer: Point, innerEdge: number): number {
  if (side === 'right') return innerEdge - pointer.x
  if (side === 'left') return pointer.x - innerEdge
  if (side === 'bottom') return innerEdge - pointer.y
  return pointer.y - innerEdge
}

/** 拖过阈值才算「撕下来」——够不着阈值的一次按下松开仍然是一次普通点击。 */
export function shouldTearOff(
  side: ShelfSide,
  pointer: Point,
  innerEdge: number,
  threshold: number = TEAR_OFF_DISTANCE,
): boolean {
  return tearOffDistance(side, pointer, innerEdge) > threshold
}

/**
 * 刚被撕下来的那扇窗落在哪:指针是**标题栏的中心**(横向居中、纵向落在标题栏一半高处),
 * 所以手指底下那一点仍然是「用户抓着的地方」。身量由调用方给(有记忆就用记忆)。
 */
export function floatRectForGrab(
  pointer: Point,
  size: { w: number; h: number },
  viewport: Viewport,
  headerHeight: number = FLOAT_HEADER_H,
): FloatRect {
  return clampFloatRect(
    { w: size.w, h: size.h, x: pointer.x - size.w / 2, y: pointer.y - headerHeight / 2 },
    viewport,
  )
}

/* ── Dock 自动隐藏的边缘带(去元素化:热区是一次距离判定,不是一个盖住别人的 div) ── */

const DOCK_EDGE_DISTANCE: Record<DockEdge, (p: Point, v: Viewport) => number> = {
  left: (p) => p.x,
  right: (p, v) => v.w - p.x,
  top: (p) => p.y,
  bottom: (p, v) => v.h - p.y,
}

export function withinDockWakeBand(
  pointer: Point,
  viewport: Viewport,
  edge: DockEdge,
  band: number = DOCK_WAKE_BAND,
): boolean {
  return DOCK_EDGE_DISTANCE[edge](pointer, viewport) <= band
}

/**
 * 自动隐藏的**留驻区**:Dock 已滑出后,指针在这个区域内就不收回。
 * 区域 = Dock 矩形向所属边**补到视口边**(边带与本体之间原有 4px 死缝,
 * 真鼠标连续移动必经,08-29 用户报"一闪而逝"的根因),再四周放 pad 余量。
 */
export interface Rect { left: number; right: number; top: number; bottom: number }

/**
 * Dock **停稳时**占的那块矩形。
 *
 * 滑入 / 滑出走的是 `transform: translate`,而 translate **不改变尺寸** ——
 * 所以停稳位可以由「量到的身量 + 它贴的那条边 + 边距」当场算出来,不必等动画停。
 * 沿边那一轴照抄量到的值:那一截 translate(--dock-align-*)是常量,从不动画。
 *
 * 这是 08-31 报障「Dock 唤醒后轻微上移就秒消失」的**主因**修法。真机时间线
 * (probe 实测,底边、视口 900):收着 top=912 → 40ms top=863.8 → 80ms
 * top=837.7 → 120ms top=826.6 → 停稳 826。整个滑入 ~140ms(--dur-enter),
 * 而手往上够那块瓦只要几十毫秒。修前拿飞行中的矩形判「离开没有」,于是
 * 唤醒后第 40ms 抬到 y=850 就被判成走了 —— 可它明明是往 Dock 停稳的位置去的。
 * 判据换成停稳位之后,这条路径整段都在留驻区里。
 *
 * `inset` = Dock 离那条边的距离(--sp-3),由宿主量一次递进来 —— 纯函数不读 CSS。
 */
export function settledDockRect(
  rect: Rect,
  viewport: Viewport,
  edge: DockEdge,
  inset: number,
): Rect {
  const { left, right, top, bottom } = rect
  const w = right - left
  const h = bottom - top
  /*
   * 四条边各自**整条列出来**,不写 `{ ...rect, top, bottom }`。
   * 这不是风格洁癖,是一次真机事故:宿主递进来的常常是一个 `DOMRect`,而 DOMRect
   * 的 left/right/top/bottom 全是**原型上的取值器**,不是自有属性 —— 展开它得到的
   * 是一个空对象,于是「沿边那一轴照抄」照抄出四个 undefined,留驻区当场恒假
   * (08-31 修完 (d) 一跑探针:Dock 停在 826,指针停在窗体正中的 862 也被判成走了)。
   * 上面那一行解构是安全的(解构会读取值器);往下只用解出来的数。
   */
  if (edge === 'bottom') {
    return { left, right, bottom: viewport.h - inset, top: viewport.h - inset - h }
  }
  if (edge === 'top') return { left, right, top: inset, bottom: inset + h }
  if (edge === 'left') return { top, bottom, left: inset, right: inset + w }
  return { top, bottom, right: viewport.w - inset, left: viewport.w - inset - w }
}

export function withinDockHoldZone(
  pointer: Point,
  viewport: Viewport,
  edge: DockEdge,
  rect: Rect,
  pad = DOCK_HOLD_PAD,
): boolean {
  let { left, right, top, bottom } = rect
  if (edge === 'right') right = viewport.w
  if (edge === 'left') left = 0
  if (edge === 'top') top = 0
  if (edge === 'bottom') bottom = viewport.h
  return (
    pointer.x >= left - pad && pointer.x <= right + pad && pointer.y >= top - pad && pointer.y <= bottom + pad
  )
}

/**
 * **Dock 此刻该不该在屏上** —— 唯一回答这句话的地方(09-01)。
 *
 * 两个语义在这里分岔,而分岔就是那一行 `if (!shown)`:
 *  - 还没出来(`shown === false`)→ **唤醒**:贴边窄带 **且**在带内停够
 *    `DOCK_WAKE_DWELL_MS`。留驻区一个字都不问 —— 它讲的是「手已经在 Dock 上了,
 *    别为一点抖动就跑」,而手还没把它叫出来时,这句话没有主语。
 *    停留那一半是 09-03 加的(报障「dock 的出现太敏感」):窗口边不是墙,
 *    穿过去的手不该唤醒它,病历写在 DOCK_WAKE_DWELL_MS 上。
 *    时间由宿主喂(`dwelledMs` = 指针在带内已经连续待了多久),**判据仍只有这一处**:
 *    宿主只负责起表 / 续表 / 清表,「够不够」这句话不许在宿主里再写一遍。
 *  - 已经出来(`shown === true`)→ **留驻**:窄带 ∪ 停稳位留驻区(含本体到视口边
 *    那条 4px 死缝,08-29「一闪而逝」的根因)。
 *
 * 收在纯函数里而不是宿主的 useEffect 里,是因为这两个语义**上一次就是在宿主里
 * 被并成一句的**(`band || holdZone` 一行伺候两件事),而那一行看上去完全无辜。
 * 判据进了这里,合并就得先删掉一行有名字、有病历、有反证用例的代码。
 *
 * `rect` = Dock 的**停稳位**(settledDockRect 算出来的),藏着时不必量也不该量。
 * `dwelledMs` 缺省 0:纯函数不认识时钟,不喂时间就是「刚碰到」。
 */
export function shouldShowDock(args: {
  shown: boolean
  pointer: Point
  viewport: Viewport
  edge: DockEdge
  rect?: Rect
  dwelledMs?: number
}): boolean {
  const { shown, pointer, viewport, edge, rect, dwelledMs } = args
  const inBand = withinDockWakeBand(pointer, viewport, edge)
  // 藏着 → 唤醒:窄带**且**停够。缺省 0 = 「刚碰到」,所以不传时间就永远唤不醒 ——
  // 宿主漏喂时间会当场表现为「叫不出来」,而不是悄悄退回旧的碰一下就出来。
  if (!shown) return inBand && (dwelledMs ?? 0) >= DOCK_WAKE_DWELL_MS
  // 已经出来 → 留驻:窄带 ∪ 停稳位留驻区,**不看** dwelledMs(它是入门的门槛,不是住下的条件)。
  if (inBand) return true
  return rect ? withinDockHoldZone(pointer, viewport, edge, rect) : false
}

/* ── Dock 上露不露面(「所有应用」那块管理瓦的判据) ────────────────────────── */

/**
 * 藏起来的瓦**不是被删掉的瓦**:它照样有落点、有记忆、能被 ⌘P 与「所有应用」
 * 打开,只是 Dock 上不给它留一格。所以这条判据只出现在 Dock 的投影里,
 * 形态机的其余部分一个字都不知道有这回事。
 */
export function isItemHidden(hiddenItems: readonly string[], id: string): boolean {
  return hiddenItems.includes(id)
}

/**
 * 翻转一块瓦的 Dock 露面。返回**新的 hiddenItems**(纯函数,不碰 state)。
 *
 * `alwaysInDock` 的瓦藏不掉 —— 判据由调用方从 items 表上取并递进来(纯函数
 * 不认识那张表)。挡在这里而不是只在 UI 上禁用那颗开关:UI 是可以绕过去的
 * (右键、快捷键、将来的命令面板),而「留一个回家的门」这条不该有例外。
 */
export function setItemHidden(
  hiddenItems: readonly string[],
  id: string,
  hidden: boolean,
  alwaysInDock = false,
): string[] {
  if (hidden && alwaysInDock) return [...hiddenItems]
  const without = hiddenItems.filter((x) => x !== id)
  return hidden ? [...without, id] : without
}

/* ── persist ───────────────────────────────────────────────────────────────── */

/**
 * persist 迁移。逐版顺着往上补,不跳级 —— v0 的档案要连过三段。
 *  v0 → v1:存的是单值 `pinnedId`,v1 起是 tab 数组。
 *  v1 → v2:多了 Dock 四边/沿边位置/大小与钉栏收起态,旧档案缺哪条补哪条。
 *  v2 → v3:三态枚举升 Placement —— 旧的 pinned/activePinnedId/pinnedWidth/pinnedCollapsed
 *           整组翻成 shelves.right + placements(每条 tab 一条 edge:right)。
 *  v3 → v4:每瓦的「打开方式」配置(openOverrides)退役,并入位置记忆 ——
 *           用户配过的一条都不丢,只是换了一种存在方式:配置变成初始记忆。
 * 放在这里(而不是 store 里)是为了它能被当成纯函数测 —— 迁移只有一次机会跑对。
 */
export function migrateStagePersisted(
  persisted: unknown,
  version: number,
  /**
   * **v9 那一段的交接口**(W4)。它在把住处摘掉**之前**被调一次(每个空间一格,
   * 扁平层那一份的空间 id 是 `null`)。
   *
   * 为什么是回调而不是「事后再读一遍档案」:一份 v0 的档案里根本没有 `shelves`
   * ——那时的钉栏是一格 `pinnedId`,v3 那段才把它翻成 `shelves.right.tabs`。
   * 走到 v9 时手上这一份已经逐版补齐过,交出去的才是完整的。病历全文写在
   * `stage/legacy-furniture.ts` 的文件头。**缺席 = 只摘不交**(纯函数用例那一路)。
   */
  onResidency?: (spaceId: string | null, furniture: Record<string, unknown>) => void,
): unknown {
  if (version >= STAGE_PERSIST_VERSION) return persisted
  if (!persisted || typeof persisted !== 'object') return persisted
  let out = persisted as Record<string, unknown>
  if (version < 1) {
    const { pinnedId, ...rest } = out
    out = typeof pinnedId === 'string' ? { ...rest, pinned: [pinnedId], activePinnedId: pinnedId } : rest
  }
  if (version < 2) {
    // 缺省补默认:已有的值赢,所以这里是「铺底」而不是「覆盖」。
    out = {
      dockEdge: initialStageSettings.dockEdge,
      dockAlign: initialStageSettings.dockAlign,
      dockSize: initialStageSettings.dockSize,
      pinnedCollapsed: false,
      ...out,
    }
  }
  if (version < 3) {
    const { pinned, activePinnedId, pinnedWidth, pinnedCollapsed, ...rest } = out
    const tabs = Array.isArray(pinned) ? pinned.filter((x): x is string => typeof x === 'string') : []
    const placements: Record<string, Placement> = {}
    for (const id of tabs) placements[id] = { kind: 'edge', side: 'right' }
    const shelves = emptyShelves()
    shelves.right = {
      tabs,
      activeId: typeof activePinnedId === 'string' && tabs.includes(activePinnedId) ? activePinnedId : (tabs[tabs.length - 1] ?? null),
      thickness: typeof pinnedWidth === 'number' ? pinnedWidth : SHELF_DEFAULT_THICKNESS,
      collapsed: pinnedCollapsed === true,
    }
    out = { ...rest, placements, floats: {}, floatOrder: [], shelves }
  }
  if (version < 4) {
    const { openOverrides, ...rest } = out
    // 活 placements / floats / shelves 照旧恢复,这一段只把**配置**翻成记忆。
    const floats = (rest.floats ?? {}) as Record<string, FloatRect>
    const shelves = (rest.shelves ?? emptyShelves()) as Record<ShelfSide, ShelfState>
    const memory: Record<string, PlacementMemory> = {}
    if (openOverrides && typeof openOverrides === 'object') {
      for (const [id, value] of Object.entries(openOverrides as Record<string, unknown>)) {
        if (value === 'stage') memory[id] = { kind: 'stage' }
        else if (value === 'float') {
          /*
           * 有存过的矩形就用存过的;**没有就是没有**(W7-p 修一轮裁定 1)。
           * 从前这里拿兜底视口编一个矩形出来 —— 迁移期根本没有真视口,编出来的
           * 那一份随后被当成「用户摆过的身量」永久留在档案里。缺矩形一律落到
           * 唯一那只产地(`freshFloatRect`),它开窗那一刻拿得到真视口与真中央区。
           */
          memory[id] = { kind: 'float', rect: floats[id] }
        } else if (value === 'pinned') {
          const tabs = shelves.right?.tabs ?? []
          const at = tabs.indexOf(id)
          memory[id] = { kind: 'edge', side: 'right', index: at < 0 ? tabs.length : at }
        }
        // 'default'(以及任何不认识的值)= 这块瓦从没表过态,不写记忆:
        // 它继续跟全局默认档走,与升级前逐字同一个结果。
      }
    }
    out = { ...rest, memory }
  }
  if (version < 5) {
    // 舞台退出打开档(08-30):存量 defaultOpen 的 'stage' 迁到 'float';
    // 记忆里的 stage 条目直接删 —— 缺记忆 = 跟默认档走,resolveOpen 会补浮窗默认身量
    // (迁移期拿不到视口,不在这里编一个矩形)。活 placements 不动:开着的舞台照常恢复,
    // 它仍是合法形态,只是点开的路不再通向它。
    if (out.defaultOpen === 'stage') out = { ...out, defaultOpen: 'float' }
    const memory = out.memory
    if (memory && typeof memory === 'object') {
      const next: Record<string, unknown> = {}
      for (const [id, value] of Object.entries(memory as Record<string, unknown>)) {
        if (!(value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'stage')) next[id] = value
      }
      out = { ...out, memory: next }
    }
  }
  if (version < 6) {
    /*
     * T-W1:家具按工作区各持一份。存量档案是「只有一个空间」时代的扁平形,
     * **原样折进默认空间那一格** —— 零丢失:用户摆了半年的架子与浮窗仍在,
     * 只是从此它们属于默认工作区(别的空间那时还不存在,自然是出厂布局)。
     *
     * 摘的是 STAGE_FURNITURE_KEYS 那五格,**不是全部** —— Dock 贴哪条边、
     * 界面语言、藏了哪些瓦是这台机器的偏好,换个空间不该跟着变(判据写在
     * `workspace/per-space.ts` 文件头)。它们留在扁平层,一个字不动。
     */
    out = foldFlatIntoDefaultSpace(out, V6_FURNITURE_KEYS, DEFAULT_SPACE_ID) as Record<string, unknown>
  }
  if (version < 7) {
    /*
     * 09-02:Dock 放大变成可配置的三格(开关 / 幅度 / 运行点)。**铺底不覆盖** ——
     * 三个缺省就是升级前的行为,所以老档案升上来一点感觉都没有:放大照旧开着、
     * 幅度就是那时唯一存在的那一档、运行点照旧画。
     */
    out = {
      dockMagnify: initialStageSettings.dockMagnify,
      dockMagnifyLevel: initialStageSettings.dockMagnifyLevel,
      dockRunningDot: initialStageSettings.dockRunningDot,
      ...out,
    }
  }
  if (version < 8) {
    /*
     * W1:查看器不再是一块瓦(`stage/items.ts` 的 VIEWER_ITEM_ID 上写着理由)。
     * 存量档案里可能到处都是它的条目 —— 一格 placement、一条架子 tab、一扇浮窗、
     * 一格位置记忆、一行「Dock 上藏起来的瓦」。留着它们**不是无害的**:
     * placements 里留一格就等于开机恢复出一块查不到内容的瓦(`renderContent`
     * 答 null,屏幕上是一扇空浮窗)。所以逐格清掉。
     *
     * 这一段走**每一个空间那一格**(家具账 `byWorkspace`)加扁平层那一份 ——
     * 只清当前那一格的话,切到别的空间才露出同一个病。
     *
     * `cover → full` 那一格**不在这一批**(它是 W2 的事,拍点 ② 已拍但没实现)。
     */
    /*
     * **一格都没碰到就原样交回**(引用恒等)。迁移是幂等的,而「幂等」在这一族
     * 档案上的机器化判据就是**同一个对象** —— 存量用例(v6 折叠那一条)钉的正是它。
     */
    const nextHidden = withoutViewerId(out.hiddenItems)
    if (nextHidden !== out.hiddenItems) out = { ...out, hiddenItems: nextHidden }
    const ledger = out.byWorkspace
    if (ledger && typeof ledger === 'object') {
      let changed = false
      const next: Record<string, unknown> = {}
      for (const [spaceId, furniture] of Object.entries(ledger as Record<string, unknown>)) {
        const stripped = stripViewerFurniture(furniture)
        if (stripped !== furniture) changed = true
        next[spaceId] = stripped
      }
      if (changed) out = { ...out, byWorkspace: next }
    }
    out = stripViewerFurniture(out) as Record<string, unknown>
  }
  if (version < 9) {
    /*
     * W4:**住处搬家**。`placements` 与 `shelves[side].{tabs,activeId}` 从今天起是
     * 拼贴树的投影(判词在 `./residency.ts`),事实归 `onething.workbench` 那本账。
     * 所以这一段做的是**搬走**,不是删掉:
     *  · 接的那一头是 `stage/legacy-furniture.ts` —— 它在这只迁移跑之前先把
     *    **原件**拍下来(`captureLegacyStageSnapshot`,`stage/store.ts` 的 migrate
     *    第一行就调它),`startWorkbench()` 再把那份原件折进树里;
     *  · 这一头只负责把这三格从 stage 的档案里摘干净,免得留下第二份说法。
     *
     * 顺序是可靠的,不是碰运气:zustand 的 persist 要等 `migrate` **返回之后**
     * 才把新档案写回去,所以「先拍照、后摘除」在同一次水合里必然成立。
     *
     * **一格都没碰到就原样交回**(引用恒等 —— 幂等的机器化判据,同 v8)。
     */
    const ledger = out.byWorkspace
    if (ledger && typeof ledger === 'object') {
      let changed = false
      const next: Record<string, unknown> = {}
      for (const [spaceId, furniture] of Object.entries(ledger as Record<string, unknown>)) {
        if (furniture && typeof furniture === 'object') {
          onResidency?.(spaceId, furniture as Record<string, unknown>)
        }
        const stripped = stripResidencyFurniture(furniture)
        if (stripped !== furniture) changed = true
        next[spaceId] = stripped
      }
      if (changed) out = { ...out, byWorkspace: next }
    }
    onResidency?.(null, out)
    out = stripResidencyFurniture(out) as Record<string, unknown>
  }
  if (version < 10) {
    /*
     * W2:**「盖」并入真全屏**(拍点 ②)。要迁的只有**位置记忆**一格 ——
     * `memory[id].kind === 'cover'` 原地翻成 `'full'`,于是「所有应用上次是盖着
     * 打开的」这条事实一字不丢地变成「上次是全屏打开的」。
     *
     * `placements` 一个字都不用迁:W4 起它是树的投影(v9 已经把它从档案里摘走了),
     * 而盖本来就是瞬态、从来不落盘。
     *
     * **扁平层与 `byWorkspace` 每个空间那一格,两条路都要走** —— 只迁当前那一格的话,
     * 切到别的空间就会露出同一个病(与 v8 / v9 逐字同一条判据)。
     *
     * **一格都没碰到就原样交回**(引用恒等 —— 幂等的机器化判据,同 v8 / v9)。
     */
    const ledger = out.byWorkspace
    if (ledger && typeof ledger === 'object') {
      let changed = false
      const next: Record<string, unknown> = {}
      for (const [spaceId, furniture] of Object.entries(ledger as Record<string, unknown>)) {
        const swapped = coverMemoryToFull(furniture)
        if (swapped !== furniture) changed = true
        next[spaceId] = swapped
      }
      if (changed) out = { ...out, byWorkspace: next }
    }
    out = coverMemoryToFull(out) as Record<string, unknown>
  }
  return out
}

/**
 * 一份家具里那张位置记忆表:`{ kind: 'cover' }` → `{ kind: 'full' }`(v10 迁移用)。
 * **逐格换**,别的记忆一格不动;**一格都没换到就原样交回**(引用恒等)。
 */
export function coverMemoryToFull(furniture: unknown): unknown {
  if (!furniture || typeof furniture !== 'object') return furniture
  const source = furniture as Record<string, unknown>
  const memory = source.memory
  if (!memory || typeof memory !== 'object') return source
  let touched = false
  const next: Record<string, unknown> = {}
  for (const [id, value] of Object.entries(memory as Record<string, unknown>)) {
    if (value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'cover') {
      next[id] = { kind: 'full' }
      touched = true
      continue
    }
    next[id] = value
  }
  return touched ? { ...source, memory: next } : source
}

/**
 * 一份家具里所有**住处**的痕迹(v9 迁移用):整格 `placements`,以及每条架子上的
 * `tabs` / `activeId`。厚度与收起态**一个字不动** —— 那是几何,归 stage。
 *
 * **一格都没碰到就原样交回**(引用恒等),与 `stripViewerFurniture` 同一条口径。
 */
export function stripResidencyFurniture(furniture: unknown): unknown {
  if (!furniture || typeof furniture !== 'object') return furniture
  const source = furniture as Record<string, unknown>
  let touched = false
  const f: Record<string, unknown> = { ...source }
  if ('placements' in f) {
    delete f.placements
    touched = true
  }
  const shelves = f.shelves
  if (shelves && typeof shelves === 'object') {
    let shelvesTouched = false
    const nextShelves: Record<string, unknown> = {}
    for (const [side, shelf] of Object.entries(shelves as Record<string, unknown>)) {
      if (!shelf || typeof shelf !== 'object') {
        nextShelves[side] = shelf
        continue
      }
      const one = { ...(shelf as Record<string, unknown>) }
      const had = 'tabs' in one || 'activeId' in one
      delete one.tabs
      delete one.activeId
      nextShelves[side] = had ? one : shelf
      if (had) shelvesTouched = true
    }
    if (shelvesTouched) {
      f.shelves = nextShelves
      touched = true
    }
  }
  return touched ? f : source
}

/**
 * 一份家具里所有 `viewer` 的痕迹(v8 迁移用)。**逐格清**,不是整份丢:
 * 用户摆了半年的别的瓦一格都不能动。
 */
function stripViewerFurniture(furniture: unknown): unknown {
  if (!furniture || typeof furniture !== 'object') return furniture
  const source = furniture as Record<string, unknown>
  const f: Record<string, unknown> = { ...source }
  let touched = false
  for (const key of ['placements', 'floats', 'memory'] as const) {
    const table = f[key]
    if (table && typeof table === 'object' && VIEWER_ITEM_ID in (table as object)) {
      const next = { ...(table as Record<string, unknown>) }
      delete next[VIEWER_ITEM_ID]
      f[key] = next
      touched = true
    }
  }
  const nextOrder = withoutViewerId(f.floatOrder)
  if (nextOrder !== f.floatOrder) {
    f.floatOrder = nextOrder
    touched = true
  }
  const shelves = f.shelves
  if (shelves && typeof shelves === 'object') {
    let shelvesTouched = false
    const nextShelves: Record<string, unknown> = {}
    for (const [side, shelf] of Object.entries(shelves as Record<string, unknown>)) {
      if (!shelf || typeof shelf !== 'object') {
        nextShelves[side] = shelf
        continue
      }
      const one = { ...(shelf as Record<string, unknown>) }
      const nextTabs = withoutViewerId(one.tabs)
      if (nextTabs !== one.tabs) {
        one.tabs = nextTabs
        shelvesTouched = true
      }
      if (one.activeId === VIEWER_ITEM_ID) {
        const tabs = Array.isArray(one.tabs) ? (one.tabs as string[]) : []
        one.activeId = tabs[tabs.length - 1] ?? null
        shelvesTouched = true
      }
      nextShelves[side] = shelvesTouched ? one : shelf
    }
    if (shelvesTouched) {
      f.shelves = nextShelves
      touched = true
    }
  }
  return touched ? f : source
}

/** 摘掉那个 id。**一格都没摘到就原样交回**(引用恒等 —— 幂等的机器化判据)。 */
function withoutViewerId(list: unknown): unknown {
  if (!Array.isArray(list)) return list
  if (!list.includes(VIEWER_ITEM_ID)) return list
  return list.filter((id) => id !== VIEWER_ITEM_ID)
}
