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

/** 形态的名字 = Placement 的 kind。组件想分支时读它,别自己拼条件。 */
export type StageForm = Placement['kind']

/**
 * 「放得下东西」的那三种落点。dock 不在其中 —— dock 是**缺席**,不是一个地方,
 * 所以「把它放到 dock」和「记得它在 dock」这两句话都没有意义。
 */
export type MemorablePlacement = Exclude<Placement, { kind: 'dock' }>

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
  | { kind: 'float'; rect: FloatRect }
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
  scope: 'session' | 'global'
  /** lucide 图标名 */
  icon: string
  badge?: StageBadge
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
  tabs: string[]
  activeId: string | null
  thickness: number
  collapsed: boolean
}

export interface StageState {
  /**
   * 唯一事实源:id → 它当下在哪。缺席 = dock(所以初始表是空的,不是全量表)。
   * 「舞台至多一个」是 transitions 维护的不变式,不是类型能表达的。
   */
  placements: Record<string, Placement>
  /** 浮窗矩形按 item 记忆 —— 收回 Dock 不擦,再开还在老位置。 */
  floats: Record<string, FloatRect>
  /** 浮窗置顶序,末位最上。只登记当下是 float 的 id。 */
  floatOrder: string[]
  shelves: Record<ShelfSide, ShelfState>
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
 */
export type ResolvedOpen = 'stage' | 'float' | 'pinned'

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
}

export type DockDisplay = 'always' | 'autohide'

/** 四条边。Dock 永远是浮层,所以「停靠」只决定贴哪儿,不决定谁让位。 */
export type DockEdge = 'bottom' | 'top' | 'left' | 'right'

/** 沿边方向的位置。start/end 指的是那条边自己的起点/终点,不是屏幕的上下左右。 */
export type DockAlign = 'start' | 'center' | 'end'

export type DockSize = 'sm' | 'md' | 'lg'

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
  placement: MemorablePlacement
  labelKey: MessageKey
  pin?: boolean
}> = [
  { key: 'stage', placement: { kind: 'stage' }, labelKey: 'dock.openStage' },
  { key: 'float', placement: { kind: 'float' }, labelKey: 'dock.openFloat' },
  ...SHELF_SIDE_CHOICES.map((c) => ({
    key: `edge:${c.value}`,
    placement: { kind: 'edge' as const, side: c.value },
    labelKey: c.labelKey,
    pin: true,
  })),
]
