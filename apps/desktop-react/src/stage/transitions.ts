import type {
  OpenBehavior,
  ResolvedOpen,
  StageForm,
  StageSettings,
  StageState,
} from './types'

/** 钉栏最小宽度,与 --pin-min 同一事实。 */
export const PIN_MIN = 320

export const initialStageState: StageState = {
  stageId: null,
  pinned: [],
  activePinnedId: null,
  pinnedWidth: 400,
  flashPinned: 0,
}

export const initialStageSettings: StageSettings = {
  defaultOpen: 'stage',
  locale: 'system',
  openOverrides: {},
}

/**
 * 形态是「派生」的,不是存的:一个 id 的形态完全由 state 决定。
 * 组件只能读这个函数,不许自己拼条件。
 * 注意:钉栏里的非活动 tab 也是 pinned —— 形态说的是「它在哪」,不是「它可见吗」。
 */
export function formOf(state: StageState, id: string): StageForm {
  if (state.stageId === id) return 'stage'
  if (state.pinned.includes(id)) return 'pinned'
  return 'dock'
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/**
 * 解析「打开方式」:图标自己的覆盖优先,没表态(或没登记)才落到全局默认。
 * 这是设置层与形态机之间唯一的翻译,形态机本身不认识 'default'。
 */
export function resolveOpen(
  id: string,
  overrides: Record<string, OpenBehavior>,
  defaultOpen: ResolvedOpen,
): ResolvedOpen {
  const own = overrides[id] ?? 'default'
  return own === 'default' ? defaultOpen : own
}

/**
 * 点 Dock 图标。四条互斥规则,按顺序判:
 *  - 已在舞台 → 关舞台(再点一次收回去)
 *  - 已在钉栏 → 不新开,只把那个 tab 激活 + 闪一下(flashPinned+1)告诉用户"它在那儿"
 *  - behavior='pinned' → 追加成新 tab 并激活;舞台开着的话不动它,两者正交
 *  - behavior='stage' → 上舞台。舞台一次只有一个,直接替换,不排队。
 */
export function clickDockIcon(state: StageState, id: string, behavior: ResolvedOpen): StageState {
  if (state.stageId === id) return { ...state, stageId: null }
  if (state.pinned.includes(id)) {
    return { ...state, activePinnedId: id, flashPinned: state.flashPinned + 1 }
  }
  if (behavior === 'pinned') {
    return { ...state, pinned: [...state.pinned, id], activePinnedId: id }
  }
  return { ...state, stageId: id }
}

/** 把当前舞台落成钉栏里的一个 tab(追加到末尾并激活),舞台清空。没有舞台时是恒等变换。 */
export function pinStage(state: StageState): StageState {
  const id = state.stageId
  if (id === null) return state
  const pinned = state.pinned.includes(id) ? state.pinned : [...state.pinned, id]
  return { ...state, pinned, activePinnedId: id, stageId: null }
}

/**
 * 摘掉一个 tab。摘的若是活动 tab,焦点落到相邻 tab —— 先右后左,和浏览器一致;
 * 摘光了就是 null(整栏随之不存在)。
 */
export function unpin(state: StageState, id: string): StageState {
  const at = state.pinned.indexOf(id)
  if (at < 0) return state
  const pinned = state.pinned.filter((x) => x !== id)
  const activePinnedId =
    state.activePinnedId === id ? (pinned[at] ?? pinned[at - 1] ?? null) : state.activePinnedId
  return { ...state, pinned, activePinnedId }
}

/** 激活一个已有 tab。不在钉栏里、或已经是活动的,都是恒等变换。 */
export function activatePinnedTab(state: StageState, id: string): StageState {
  if (!state.pinned.includes(id)) return state
  if (state.activePinnedId === id) return state
  return { ...state, activePinnedId: id }
}

export function closeStage(state: StageState): StageState {
  if (state.stageId === null) return state
  return { ...state, stageId: null }
}

/** 钉栏宽度 clamp 到 [320, 视口一半];视口太窄时下界赢。 */
export function setPinnedWidth(state: StageState, w: number, viewport: number): StageState {
  return { ...state, pinnedWidth: clamp(w, PIN_MIN, viewport * 0.5) }
}

/**
 * persist 迁移:v0 存的是单值 `pinnedId`,v1 起是 tab 数组。
 * 放在这里(而不是 store 里)是为了它能被当成纯函数测 —— 迁移只有一次机会跑对。
 */
export function migrateStagePersisted(persisted: unknown, version: number): unknown {
  if (version >= 1) return persisted
  if (!persisted || typeof persisted !== 'object') return persisted
  const { pinnedId, ...rest } = persisted as Record<string, unknown>
  if (typeof pinnedId !== 'string') return rest
  return { ...rest, pinned: [pinnedId], activePinnedId: pinnedId }
}
