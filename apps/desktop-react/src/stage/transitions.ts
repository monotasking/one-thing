import type {
  DockEdge,
  FloatRect,
  MemorablePlacement,
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
export const FLOAT_DEFAULT_W = 880
export const FLOAT_DEFAULT_H = 520

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
export const STAGE_PERSIST_VERSION = 7

const DOCK: Placement = { kind: 'dock' }

function emptyShelf(): ShelfState {
  return { tabs: [], activeId: null, thickness: SHELF_DEFAULT_THICKNESS, collapsed: false }
}

export function emptyShelves(): Record<ShelfSide, ShelfState> {
  return { left: emptyShelf(), right: emptyShelf(), top: emptyShelf(), bottom: emptyShelf() }
}

export const initialStageState: StageState = {
  placements: {},
  floats: {},
  floatOrder: [],
  shelves: emptyShelves(),
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
export const STAGE_FURNITURE_KEYS = [
  'placements',
  'floats',
  'floatOrder',
  'shelves',
  'memory',
] as const

/** stage 那一份家具的形。 */
export interface StageFurniture {
  placements: StageState['placements']
  floats: StageState['floats']
  floatOrder: StageState['floatOrder']
  shelves: StageState['shelves']
  memory: StageState['memory']
}

/** 出厂布局 —— 首次进入某个空间摊开的就是它。 */
export function factoryStageFurniture(): StageFurniture {
  return {
    placements: {},
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
    placements: withoutTransientPlacements(state.placements),
    floats: state.floats,
    floatOrder: state.floatOrder,
    shelves: state.shelves,
    memory: state.memory,
  }
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
 * **至多一个**的那几种形态。舞台盖住整个视口、盖接管整条内容栏 —— 两块叠在
 * 同一处,下面那块永远见不到光,所以它们各自只许有一个。
 *
 * 写成一张表而不是两段 if:再多一种独占形态时,这里加一个字面量就够了,
 * openAs 里那段不变式一个字都不用改(08-31 加 'cover' 时正是这么加的)。
 * 浮窗与架子不在表里 —— 它们生来就是可以有好几个的。
 */
const EXCLUSIVE_FORMS: StageForm[] = ['stage', 'cover']

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

/** 独占形态至多一个,所以「谁在舞台上 / 谁盖着内容栏」是查询而不是字段。 */
function idInForm(state: StageState, form: StageForm): string | null {
  for (const [id, p] of Object.entries(state.placements)) {
    if (p.kind === form) return id
  }
  return null
}

export function stageIdOf(state: StageState): string | null {
  return idInForm(state, 'stage')
}

export function coverIdOf(state: StageState): string | null {
  return idInForm(state, 'cover')
}

/**
 * Esc 该退掉哪一块面 —— **唯一**回答这句话的地方(08-31 修「Esc 关不掉浮窗」)。
 *
 * 退层次序 = 视觉上压在最上面的那一块先退,与 z 序逐条对应:
 *   ① 盖(--z-cover,盖满整扇窗;09-01 用户推翻「只接管内容栏」)
 *   ② 舞台(--z-overlay,scrim 铺满视口)
 *   ③ 最上面那扇浮窗(floatOrder 末位最上)
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
export function escapeTargetOf(state: StageState): string | null {
  return coverIdOf(state) ?? stageIdOf(state) ?? (state.floatOrder[state.floatOrder.length - 1] ?? null)
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
export function memoryOf(
  state: StageState,
  id: string,
  viewport: Viewport = FALLBACK_VIEWPORT,
): PlacementMemory | null {
  const p = placementOf(state, id)
  if (p.kind === 'dock') return null
  if (p.kind === 'stage') return { kind: 'stage' }
  // 盖没有第二个参数(它的几何由内容栏说了算),所以折出来的记忆就是它自己。
  if (p.kind === 'cover') return { kind: 'cover' }
  if (p.kind === 'float') {
    return { kind: 'float', rect: state.floats[id] ?? defaultFloatRect(viewport) }
  }
  const at = state.shelves[p.side].tabs.indexOf(id)
  return { kind: 'edge', side: p.side, index: at < 0 ? state.shelves[p.side].tabs.length : at }
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
export function memoryIsAt(m: PlacementMemory | undefined, placement: MemorablePlacement): boolean {
  if (!m || m.kind !== placement.kind) return false
  if (m.kind === 'edge' && placement.kind === 'edge') return m.side === placement.side
  return true
}

/**
 * 按一条记忆把 id 放回去。三种形态各自需要补的那一件事都在这里:
 *  - edge:插回 min(记忆次序, 组长) —— 两块瓦记着同一条边,各自钳一下就都坐得下,不需要仲裁;
 *  - float:矩形先过**与拖拽落定同一把**视口钳制 —— 显示器变小了不能把窗开到屏外;
 *  - stage:什么都不用补(舞台没有第二个参数)。
 */
export function openFromMemory(
  state: StageState,
  id: string,
  m: PlacementMemory,
  viewport: Viewport = FALLBACK_VIEWPORT,
): StageState {
  if (m.kind === 'stage') return openAs(state, id, { kind: 'stage' }, viewport)
  if (m.kind === 'cover') return openAs(state, id, { kind: 'cover' }, viewport)
  if (m.kind === 'edge') return openAs(state, id, { kind: 'edge', side: m.side }, viewport, m.index)
  const seeded = { ...state, floats: { ...state.floats, [id]: clampFloatRect(m.rect, viewport) } }
  return openAs(seeded, id, { kind: 'float' }, viewport)
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
 * 浮窗取新窗默认矩形,钉边排到那条边的末尾,舞台与盖本来就没有第二个参数。
 *
 * 两个调用方共用它(全局默认档 / item 天生落点),所以「补什么」只写一次。
 */
export function completeMemory(
  state: StageState,
  placement: MemorablePlacement,
  viewport: Viewport = FALLBACK_VIEWPORT,
): PlacementMemory {
  if (placement.kind === 'float') return { kind: 'float', rect: defaultFloatRect(viewport) }
  if (placement.kind === 'edge') {
    return { kind: 'edge', side: placement.side, index: state.shelves[placement.side].tabs.length }
  }
  return placement
}

/** 全局默认档补成一条完整记忆。 */
export function defaultOpenMemory(
  state: StageState,
  open: ResolvedOpen,
  viewport: Viewport = FALLBACK_VIEWPORT,
): PlacementMemory {
  return completeMemory(state, placementForOpen(open), viewport)
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
  viewport: Viewport = FALLBACK_VIEWPORT,
  itemDefault?: MemorablePlacement,
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
  if (itemDefault) return completeMemory(state, itemDefault, viewport)
  return defaultOpenMemory(state, defaultOpen, viewport)
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

/** 新浮窗:居中、默认身量(视口比默认还小就取视口)。 */
export function defaultFloatRect(viewport: Viewport): FloatRect {
  const w = Math.min(FLOAT_DEFAULT_W, viewport.w)
  const h = Math.min(FLOAT_DEFAULT_H, viewport.h)
  return clampFloatRect({ w, h, x: (viewport.w - w) / 2, y: (viewport.h - h) / 2 }, viewport)
}

/**
 * **视口变了之后把每一格浮窗矩形重钳一遍**(09-04 §4)。
 *
 * 它治的是「钳制只发生在手势那一刻」这条老毛病:窗子放大时存下来的 880 宽浮窗,
 * 换到 1100 宽的窗里既没人量也没人钳,于是右缘被切在屏幕外 —— 而拖它一下就好了,
 * 正说明少的不是判据(clampFloatRect 一直在),是**触发时机**。
 *
 * 钳的是三处、同一句话:
 *  · `floats` —— 此刻开着的那些窗;
 *  · `memory` 里 `kind: 'float'` 的那些 rect —— 关着的窗再开出来也得是钳过的;
 *  · `byWorkspace` 每个空间那一格家具里的同样两格 —— 别的空间切回来时同样在这扇窗里。
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
  const live = reclampFloatGeometry(state, viewport)
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
  const floats = reclampFloatMap(source.floats, viewport)
  const memory = reclampMemoryMap(source.memory, viewport)
  if (floats === source.floats && memory === source.memory) return source
  return { ...source, floats, memory }
}

function reclampFloatMap(
  floats: StageState['floats'],
  viewport: Viewport,
): StageState['floats'] {
  let next: StageState['floats'] | null = null
  for (const [id, rect] of Object.entries(floats)) {
    const clamped = fitFloatRect(rect, viewport)
    if (sameRect(clamped, rect)) continue
    next ??= { ...floats }
    next[id] = clamped
  }
  return next ?? floats
}

function reclampMemoryMap(
  memory: StageState['memory'],
  viewport: Viewport,
): StageState['memory'] {
  let next: StageState['memory'] | null = null
  for (const [id, remembered] of Object.entries(memory)) {
    if (remembered.kind !== 'float') continue
    const clamped = fitFloatRect(remembered.rect, viewport)
    if (sameRect(clamped, remembered.rect)) continue
    next ??= { ...memory }
    next[id] = { kind: 'float', rect: clamped }
  }
  return next ?? memory
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

/* ── 落点变更(唯一的写入口,不变式都在这里维护) ──────────────────────────── */

/** 把 id 从它当下待的地方摘出来:架子 tab 与浮窗序。摘架子的活动 tab 时焦点先右后左。 */
function detach(state: StageState, id: string): StageState {
  let shelves = state.shelves
  let touched = false
  for (const side of SHELF_SIDES) {
    const shelf = shelves[side]
    const at = shelf.tabs.indexOf(id)
    if (at < 0) continue
    const tabs = shelf.tabs.filter((x) => x !== id)
    const activeId = shelf.activeId === id ? (tabs[at] ?? tabs[at - 1] ?? null) : shelf.activeId
    shelves = { ...shelves, [side]: { ...shelf, tabs, activeId } }
    touched = true
  }
  const inFloat = state.floatOrder.includes(id)
  if (!touched && !inFloat) return state
  return {
    ...state,
    shelves,
    floatOrder: inFloat ? state.floatOrder.filter((x) => x !== id) : state.floatOrder,
  }
}

/**
 * 把 id 放到某个落点。**全系统唯一改 placements 的函数** —— 三条不变式都在这里:
 *  1. 一个 id 只在一处:先从旧落点摘干净(架子 tab / 浮窗序),再登记新的;
 *  2. 舞台至多一个:新的上台,旧的落回 dock;
 *  3. dock 是缺席态:落回 dock 就是把它从表里删掉,不留一条 {kind:'dock'}。
 * 浮窗矩形不在这里擦 —— 那是记忆,收回 Dock 再开还要用。
 *
 * G 批起它还多做一件事:**落定即写记忆**。这是全系统唯一改 placements 的函数,
 * 所以把记忆挂在这里,「菜单点名 / 拖拽吸附 / tab 撕出 / 舞台转边」四条路一次全接上,
 * 不必每个组件在松手时另外记得写一次(散在组件里的记忆,迟早有一条忘了写)。
 *
 * edgeIndex 只在 placement 是 edge 时有意义:缺省 = 排到末尾(新来的排最后),
 * 给了 = 按记忆插回去,并钳进 [0, 组长] —— 它记着第 5 个,那条边现在只有 2 个,就坐第 3 个位子。
 */
export function openAs(
  state: StageState,
  id: string,
  placement: Placement,
  viewport: Viewport = FALLBACK_VIEWPORT,
  edgeIndex?: number,
): StageState {
  let next = detach(state, id)

  const placements = { ...next.placements }
  // 独占形态(舞台 / 盖):新的上来,同形态的旧的落回 dock。表在 EXCLUSIVE_FORMS。
  if (EXCLUSIVE_FORMS.includes(placement.kind)) {
    for (const [other, p] of Object.entries(placements)) {
      if (p.kind === placement.kind && other !== id) delete placements[other]
    }
  }
  if (placement.kind === 'dock') delete placements[id]
  else placements[id] = placement
  next = { ...next, placements }

  if (placement.kind === 'edge') {
    const shelf = next.shelves[placement.side]
    const at =
      edgeIndex === undefined ? shelf.tabs.length : clamp(Math.round(edgeIndex), 0, shelf.tabs.length)
    const tabs = [...shelf.tabs]
    tabs.splice(at, 0, id)
    // 新入架子顺手展开:用户的动作意图是「让它看得见」。
    next = {
      ...next,
      shelves: {
        ...next.shelves,
        [placement.side]: { ...shelf, tabs, activeId: id, collapsed: false },
      },
    }
  }

  if (placement.kind === 'float') {
    const rect = clampFloatRect(next.floats[id] ?? defaultFloatRect(viewport), viewport)
    next = {
      ...next,
      floats: { ...next.floats, [id]: rect },
      floatOrder: [...next.floatOrder, id],
    }
  }

  // 落定即写:折的是 next(已经落好的那一份),所以 edge 记下的是真实插入位、
  // float 记下的是钳制过的矩形 —— 记忆里没有一个「本来想放但没放成」的数。
  return remember(next, id, memoryOf(next, id, viewport))
}

/**
 * 收回 Dock。**关闭是归档,不是删除**:先把当下的落点折成记忆,再摘活表 ——
 * 顺序反了就什么都记不到(摘完之后 placements / shelves 里已经没有它了)。
 * 已经在 Dock 里的是恒等变换(它的记忆是上次归档时留下的,这一下不该动它)。
 */
export function closeToDock(state: StageState, id: string): StageState {
  if (placementOf(state, id).kind === 'dock') return state
  return remember(openAs(state, id, DOCK), id, memoryOf(state, id))
}

/**
 * 点 Dock 图标。先问「它现在在哪」,再决定这一下是什么意思:
 *  - 在舞台 / 盖着内容栏 → 关掉(再点一次收回去)
 *  - 在架子上 → 不新开。判据是「它现在看得见吗」:
 *      看不见(不是活动 tab,或整栏收着)→ 激活 + 展开 + 闪一下,告诉用户"它在那儿";
 *      看得见(是活动 tab 且栏展开着)  → 再点一次是"收回去",与舞台那条同一个手感。
 *  - 已是浮窗 → 置顶它(浮窗可以有好几个,所以这一下是"把它翻到最上面")
 *  - 在 Dock 里 → 按解析出的记忆开(见 resolveOpen 的三层序)。
 */
export function clickDockIcon(
  state: StageState,
  id: string,
  open: PlacementMemory,
  viewport: Viewport = FALLBACK_VIEWPORT,
): StageState {
  const current = placementOf(state, id)

  if (EXCLUSIVE_FORMS.includes(current.kind)) return closeToDock(state, id)

  if (current.kind === 'edge') {
    const shelf = state.shelves[current.side]
    const visible = shelf.activeId === id && !shelf.collapsed
    if (visible) return setShelfCollapsed(state, current.side, true)
    return {
      ...state,
      shelves: { ...state.shelves, [current.side]: { ...shelf, activeId: id, collapsed: false } },
      flashPinned: state.flashPinned + 1,
      flashSide: current.side,
    }
  }

  if (current.kind === 'float') return focusFloat(state, id)

  return openFromMemory(state, id, open, viewport)
}

/**
 * ⌘P 那种「开关一块面」的语义:在 Dock 里就按打开方式开,在别处(舞台/浮窗/架子)
 * 就收回 Dock。它与 clickDockIcon 的区别只有一条 —— 快捷键没有"收起整栏"这个中间态,
 * 按第二下就是关掉,所以它不判架子看不看得见。
 */
export function togglePlacement(
  state: StageState,
  id: string,
  open: PlacementMemory,
  viewport: Viewport = FALLBACK_VIEWPORT,
): StageState {
  if (placementOf(state, id).kind === 'dock') return openFromMemory(state, id, open, viewport)
  return closeToDock(state, id)
}

/* ── 舞台 ──────────────────────────────────────────────────────────────────── */

export function closeStage(state: StageState): StageState {
  const id = stageIdOf(state)
  if (id === null) return state
  return openAs(state, id, DOCK)
}

/** 关掉盖。没有盖时是恒等变换。 */
export function closeCover(state: StageState): StageState {
  const id = coverIdOf(state)
  if (id === null) return state
  return openAs(state, id, DOCK)
}

/**
 * Esc 退一层:按 escapeTargetOf 的次序收掉最上面那一块面。
 * 没有面可退时是恒等变换 —— 宿主据此判断「这一下 Esc 我没接住」。
 */
export function escapeTopmost(state: StageState): StageState {
  const id = escapeTargetOf(state)
  if (id === null) return state
  return closeToDock(state, id)
}

/** 舞台 → 浮窗。没有舞台时是恒等变换。 */
export function stageToFloat(state: StageState, viewport: Viewport = FALLBACK_VIEWPORT): StageState {
  const id = stageIdOf(state)
  if (id === null) return state
  return openAs(state, id, { kind: 'float' }, viewport)
}

/** 舞台 → 某条边的架子。没有舞台时是恒等变换。 */
export function stageToEdge(state: StageState, side: ShelfSide): StageState {
  const id = stageIdOf(state)
  if (id === null) return state
  return openAs(state, id, { kind: 'edge', side })
}

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

/** 浮窗 → 架子。不是浮窗时是恒等变换。 */
export function floatToEdge(state: StageState, id: string, side: ShelfSide): StageState {
  if (placementOf(state, id).kind !== 'float') return state
  return openAs(state, id, { kind: 'edge', side })
}

/** 架子 → 浮窗。不在架子上时是恒等变换;有旧矩形就回到旧位置。 */
export function edgeToFloat(
  state: StageState,
  id: string,
  viewport: Viewport = FALLBACK_VIEWPORT,
): StageState {
  if (placementOf(state, id).kind !== 'edge') return state
  return openAs(state, id, { kind: 'float' }, viewport)
}

/* ── 架子 ──────────────────────────────────────────────────────────────────── */

/**
 * 整栏关闭:这条边上的 tab 全部收回 Dock(逐个走 closeToDock,复用它的全部清理)。
 *
 * 次序要在**动手之前**整条拓下来:逐个收会让后面的 tab 次序一路往前塌,
 * 那样记下的就是塌过的次序 —— 整栏关掉再一个个开回来,三块瓦会挤成一摞。
 * 所以先按原状折一遍记忆,收完再把这一份盖回去(只覆盖这条边上的 id,别人一条不碰)。
 */
export function closeShelf(state: StageState, side: ShelfSide): StageState {
  const tabs = state.shelves[side].tabs
  if (tabs.length === 0) return state
  const memory = { ...state.memory }
  for (const id of tabs) {
    const m = memoryOf(state, id)
    if (m) memory[id] = m
  }
  return { ...tabs.reduce((st, id) => closeToDock(st, id), state), memory }
}

/** 激活一条边上的某个 tab。不在这条边上、或已经是活动的,都是恒等变换。 */
export function activateShelfTab(state: StageState, side: ShelfSide, id: string): StageState {
  const shelf = state.shelves[side]
  if (!shelf.tabs.includes(id)) return state
  if (shelf.activeId === id) return state
  return { ...state, shelves: { ...state.shelves, [side]: { ...shelf, activeId: id } } }
}

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

/**
 * 架子厚度钳到 [240, 视口对应维度的 55%];视口太窄时下界赢(clamp 自己保证)。
 * 上界取整:厚度最终是一个 px,55% 算出来的浮点尾巴不该被存进档案。
 */
export function clampShelfThickness(thickness: number, viewportExtent: number): number {
  return clamp(
    Math.round(thickness),
    SHELF_MIN_THICKNESS,
    Math.round(viewportExtent * SHELF_MAX_RATIO),
  )
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

export function setShelfThickness(
  state: StageState,
  side: ShelfSide,
  thickness: number,
  viewportExtent: number,
): StageState {
  const shelf = state.shelves[side]
  return {
    ...state,
    shelves: {
      ...state.shelves,
      [side]: { ...shelf, thickness: clampShelfThickness(thickness, viewportExtent) },
    },
  }
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
 * 存盘前把**瞬态形**(舞台 / 盖)那几条摘掉:架子和浮窗是用户摆好的工作台,
 * 理应留着;舞台与盖是「当下正在看的那一眼」,重开该从收拢态开始
 * (与 W1 之前同一条判例)。摘的判据与 EXCLUSIVE_FORMS 是同一张表 ——
 * 「至多一个」与「不存盘」在这套形态里恰好说的是同一批形态:两者都源于
 * 「它接管了一整片地方,所以它是一眼而不是一件家具」。
 */
export function withoutTransientPlacements(
  placements: Record<string, Placement>,
): Record<string, Placement> {
  const out: Record<string, Placement> = {}
  for (const [id, p] of Object.entries(placements)) {
    if (!EXCLUSIVE_FORMS.includes(p.kind)) out[id] = p
  }
  return out
}

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
export function migrateStagePersisted(persisted: unknown, version: number): unknown {
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
          // 有存过的矩形就用存过的;没有就给新窗的默认身量(恢复时还会再过一次视口钳制)。
          memory[id] = { kind: 'float', rect: floats[id] ?? defaultFloatRect(FALLBACK_VIEWPORT) }
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
    out = foldFlatIntoDefaultSpace(out, STAGE_FURNITURE_KEYS, DEFAULT_SPACE_ID) as Record<string, unknown>
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
  return out
}
