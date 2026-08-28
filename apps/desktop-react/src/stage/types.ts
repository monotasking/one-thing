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
}

export type DockDisplay = 'always' | 'autohide'
