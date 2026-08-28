import type { Locale, MessageKey } from '../i18n'

/**
 * 形态机的形状。这里只有数据,没有 React、没有 DOM。
 * 三种形态:dock(收在坞里)/ stage(舞台,居中浮层,一次一个)/ pinned(钉在右栏,一组 tab)。
 */
export type StageForm = 'dock' | 'stage' | 'pinned'

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

/**
 * 「打开方式」:每个图标可覆盖的落点。
 * 'default' 是「不表态」,真正落点由全局默认决定 —— 所以它只存在于设置层,
 * 形态机接到的永远是已解析的 ResolvedOpen。
 */
export type OpenBehavior = 'default' | 'stage' | 'pinned'
export type ResolvedOpen = Exclude<OpenBehavior, 'default'>

export interface StageState {
  stageId: string | null
  /** 钉栏里的 tab 次序;空数组 = 整栏不存在。 */
  pinned: string[]
  activePinnedId: string | null
  pinnedWidth: number
  /**
   * 钉栏收起态。收起的是「整栏」而不是某个 tab —— 栏还在(细梁),
   * 所以它是栏的状态,不是 tab 的;pinned/activePinnedId 一个都不动。
   */
  pinnedCollapsed: boolean
  /** 递增计数,触发钉栏闪烁 */
  flashPinned: number
}

/**
 * 设置层:不参与形态推导,只参与「点一下该去哪」的解析。
 * 与 StageState 分开,是因为它跨会话持久,而形态是当下的。
 */
export interface StageSettings {
  defaultOpen: ResolvedOpen
  /** 界面语言。'system' = 问浏览器;解析在 i18n/resolveLang,不在这里。 */
  locale: Locale
  /** 未登记的 id 等价于 'default',所以初始值是空表而不是全量表。 */
  openOverrides: Record<string, OpenBehavior>
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
