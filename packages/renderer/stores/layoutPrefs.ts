/**
 * 布局偏好 store —— 外壳布局收敛 L0(`docs/design/shell-layout-2026-08.md` §L0)。
 *
 * 在此之前,各列的尺寸/开合偏好裸写 localStorage,5 个 key 散在两个文件里
 * (`sidebarWidth` / `sidebarCollapsed` / `inspectorPanelSize` / `inspectorOpen` /
 * `chatSidePanelCollapsed`),clamp 逻辑跟着散(App.vue 一份、ChatContainer 一份),
 * 于是"窗口一窄右栏就跌破 250px 地板"这类 bug 只能在读的那一侧逐处补。
 *
 * 这里是**唯一**的读写点:单 key `onething.layout.v1`(JSON),clamp 只做一次,
 * 首次读时把旧 5 个 key 迁进来并删掉它们。
 *
 * 三条纪律:
 *  1. **只装偏好,不装状态**。"用户折叠了右栏"是偏好(写这里);"窗口太窄所以
 *     右栏暂时收起"是预算结果(只活在 `useShellLayout` 的输出里)。恢复窗宽要
 *     能自动回弹,靠的就是后者从不落盘。
 *  2. **px 是唯一单位**。旧的 `inspectorPanelSize` 存的是百分比,地板却是像素,
 *     所以每次读都得拿容器宽重新换算一遍(L1 删掉的那套 hack)。迁移时按当时的
 *     窗宽换算一次,之后永远是 px。
 *  3. `workbenchOpen` 是**三态**:`null` = 用户从没表过态,交给
 *     `resolveInspectorDefaultOpen` 按窗宽给默认值(W-Q2:≥1400 默认展开)。
 *     存过 `false` 与没存过是两件事 —— 手动收起过的人不该每次启动被弹开。
 */
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

/**
 * 单一 localStorage key。旧的 5 个 key 只在迁移路径上出现一次。
 *
 * L3 起 `chatSideCollapsed` 这一格没了(大纲栏并入右栏,不再是一列):迁移表里
 * 那条旧 key 仍**读一次再删**,只是读到的值不再落进任何字段 —— 留着它是为了
 * "旧 key 一次性清干净"这条不变量,删掉它等于让老用户的 localStorage 里永远
 * 躺着一条谁也不读的垃圾。
 */
export const LAYOUT_PREFS_STORAGE_KEY = 'onething.layout.v1'

/** 迁移源(读一次 → 写进新 key → 删)。 */
export const LEGACY_LAYOUT_STORAGE_KEYS = {
  sidebarWidth: 'sidebarWidth',
  sidebarCollapsed: 'sidebarCollapsed',
  /** 存的是**百分比**,迁移时按当时窗宽换算成 px。 */
  workbenchWidth: 'inspectorPanelSize',
  workbenchOpen: 'inspectorOpen',
  /** L3 已退役,只在迁移时被清理,不再有对应字段。 */
  chatSideCollapsed: 'chatSidePanelCollapsed',
} as const

export const MIN_SIDEBAR_WIDTH = 200
export const MAX_SIDEBAR_WIDTH = 500
export const DEFAULT_SIDEBAR_WIDTH = 300

/**
 * 右栏最窄 250px 是设计稿硬指标(`right-panel.html`)。宽度**没有固定上限**
 * (2026-08-24 裁定):能拖多宽由布局协调器按"聊天列 ≥ 480px"的预算实时给,
 * 偏好层只守地板。
 */
export const MIN_WORKBENCH_WIDTH = 250
export const DEFAULT_WORKBENCH_WIDTH = 360

export interface LayoutPrefs {
  /** 停靠态侧栏宽度(px)。 */
  sidebarWidth: number
  /** 用户折叠了侧栏(≠ 预算把它转成浮层)。 */
  sidebarCollapsed: boolean
  /** 右栏展开时的宽度(px)。 */
  workbenchWidth: number
  /** 用户上次留下的右栏开合;`null` = 没表过态。 */
  workbenchOpen: boolean | null
}

/** 只需要 `localStorage` 的三个方法 —— 测试可以喂一个 Map 假件。 */
export interface LayoutPrefsStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function createDefaultLayoutPrefs(): LayoutPrefs {
  return {
    sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    sidebarCollapsed: false,
    workbenchWidth: DEFAULT_WORKBENCH_WIDTH,
    workbenchOpen: null,
  }
}

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_SIDEBAR_WIDTH
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)))
}

export function clampWorkbenchWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_WORKBENCH_WIDTH
  return Math.max(MIN_WORKBENCH_WIDTH, Math.round(width))
}

function resolveStorage(storage?: LayoutPrefsStorage | null): LayoutPrefsStorage | null {
  if (storage) return storage
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    // 隐私模式 / 无 DOM 的测试夹具:当作没有存储,全部走默认值。
    return null
  }
}

function readRaw(storage: LayoutPrefsStorage, key: string): string | null {
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

function removeRaw(storage: LayoutPrefsStorage, key: string): void {
  try {
    storage.removeItem(key)
  } catch {
    // 删不掉就算了:新 key 已经是唯一读取源,旧 key 只是留了份垃圾。
  }
}

function parseBoolean(raw: string | null): boolean | null {
  if (raw === 'true') return true
  if (raw === 'false') return false
  return null
}

function normalizeLayoutPrefs(input: Partial<LayoutPrefs> | null | undefined): LayoutPrefs {
  const defaults = createDefaultLayoutPrefs()
  if (!input || typeof input !== 'object') return defaults
  return {
    sidebarWidth: clampSidebarWidth(
      typeof input.sidebarWidth === 'number' ? input.sidebarWidth : defaults.sidebarWidth,
    ),
    sidebarCollapsed: input.sidebarCollapsed === true,
    workbenchWidth: clampWorkbenchWidth(
      typeof input.workbenchWidth === 'number' ? input.workbenchWidth : defaults.workbenchWidth,
    ),
    workbenchOpen: typeof input.workbenchOpen === 'boolean' ? input.workbenchOpen : null,
  }
}

export interface LoadLayoutPrefsOptions {
  storage?: LayoutPrefsStorage | null
  /**
   * 迁移旧 `inspectorPanelSize`(百分比)时的换算基数。百分比原先是相对**分栏
   * 容器**的(窗宽扣掉停靠侧栏),所以这里传窗宽,函数自己扣。
   */
  viewportWidth?: number
}

/**
 * 迁移旧的 5 个 key。返回 `null` 表示一条旧记录都没有(全新用户)。
 *
 * 无论有没有读到值,**只要有任何一个旧 key 在场就把它们全删掉** —— 迁移是
 * 一次性的,留着旧 key 只会让下次启动再走一遍这条路。
 */
export function migrateLegacyLayoutPrefs(
  storage: LayoutPrefsStorage,
  viewportWidth = 0,
): Partial<LayoutPrefs> | null {
  const raw = {
    sidebarWidth: readRaw(storage, LEGACY_LAYOUT_STORAGE_KEYS.sidebarWidth),
    sidebarCollapsed: readRaw(storage, LEGACY_LAYOUT_STORAGE_KEYS.sidebarCollapsed),
    workbenchWidth: readRaw(storage, LEGACY_LAYOUT_STORAGE_KEYS.workbenchWidth),
    workbenchOpen: readRaw(storage, LEGACY_LAYOUT_STORAGE_KEYS.workbenchOpen),
    /* 读它只为"在场即清理";L3 之后没有字段接它。 */
    chatSideCollapsed: readRaw(storage, LEGACY_LAYOUT_STORAGE_KEYS.chatSideCollapsed),
  }
  const present = Object.values(raw).some(value => value !== null)
  if (!present) return null

  const migrated: Partial<LayoutPrefs> = {}

  const sidebarWidth = Number.parseFloat(raw.sidebarWidth ?? '')
  if (Number.isFinite(sidebarWidth)) migrated.sidebarWidth = clampSidebarWidth(sidebarWidth)

  const sidebarCollapsed = parseBoolean(raw.sidebarCollapsed)
  if (sidebarCollapsed !== null) migrated.sidebarCollapsed = sidebarCollapsed

  const workbenchPercent = Number.parseFloat(raw.workbenchWidth ?? '')
  if (Number.isFinite(workbenchPercent)) {
    // 百分比是相对分栏容器的:窗宽先扣掉停靠侧栏,扣不出正数就退回默认值。
    const sidebar = migrated.sidebarCollapsed ? 0 : (migrated.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH)
    const base = Math.max(0, (Number.isFinite(viewportWidth) ? viewportWidth : 0) - sidebar)
    migrated.workbenchWidth = base > 0
      ? clampWorkbenchWidth(base * workbenchPercent / 100)
      : DEFAULT_WORKBENCH_WIDTH
  }

  const workbenchOpen = parseBoolean(raw.workbenchOpen)
  if (workbenchOpen !== null) migrated.workbenchOpen = workbenchOpen

  for (const key of Object.values(LEGACY_LAYOUT_STORAGE_KEYS)) removeRaw(storage, key)

  return migrated
}

/** 读一次布局偏好:新 key 优先,没有则迁移旧 key,都没有则默认值。 */
export function loadLayoutPrefs(options: LoadLayoutPrefsOptions = {}): LayoutPrefs {
  const storage = resolveStorage(options.storage)
  if (!storage) return createDefaultLayoutPrefs()

  const raw = readRaw(storage, LAYOUT_PREFS_STORAGE_KEY)
  if (raw !== null) {
    try {
      // 损坏的 JSON / 非对象 / 字段类型不对 —— 一律回默认值,不让一行坏数据
      // 把整个外壳布局带歪。
      const parsed = JSON.parse(raw) as Partial<LayoutPrefs> | null
      return normalizeLayoutPrefs(parsed)
    } catch {
      return createDefaultLayoutPrefs()
    }
  }

  const viewportWidth = options.viewportWidth
    ?? (typeof window === 'undefined' ? 0 : window.innerWidth)
  const migrated = migrateLegacyLayoutPrefs(storage, viewportWidth)
  const prefs = normalizeLayoutPrefs(migrated)
  if (migrated) saveLayoutPrefs(prefs, storage)
  return prefs
}

export function saveLayoutPrefs(prefs: LayoutPrefs, storage?: LayoutPrefsStorage | null): void {
  const target = resolveStorage(storage)
  if (!target) return
  try {
    target.setItem(LAYOUT_PREFS_STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // 存不下就算了:本次会话照常用,下次启动退回默认值。
  }
}

export const useLayoutPrefsStore = defineStore('layoutPrefs', () => {
  const initial = loadLayoutPrefs()

  const sidebarWidth = ref(initial.sidebarWidth)
  const sidebarCollapsed = ref(initial.sidebarCollapsed)
  const workbenchWidth = ref(initial.workbenchWidth)
  const workbenchOpen = ref<boolean | null>(initial.workbenchOpen)

  function snapshot(): LayoutPrefs {
    return {
      sidebarWidth: sidebarWidth.value,
      sidebarCollapsed: sidebarCollapsed.value,
      workbenchWidth: workbenchWidth.value,
      workbenchOpen: workbenchOpen.value,
    }
  }

  /* 一处落盘。`flush: 'post'` 让同一 tick 里的多次改动只写一次。 */
  watch(
    [sidebarWidth, sidebarCollapsed, workbenchWidth, workbenchOpen],
    () => saveLayoutPrefs(snapshot()),
    { flush: 'post' },
  )

  function setSidebarWidth(width: number): void {
    sidebarWidth.value = clampSidebarWidth(width)
  }

  function setWorkbenchWidth(width: number): void {
    workbenchWidth.value = clampWorkbenchWidth(width)
  }

  function setSidebarCollapsed(collapsed: boolean): void {
    sidebarCollapsed.value = collapsed
  }

  function setWorkbenchOpen(open: boolean): void {
    workbenchOpen.value = open
  }

  return {
    sidebarWidth,
    sidebarCollapsed,
    workbenchWidth,
    workbenchOpen,
    snapshot,
    setSidebarWidth,
    setSidebarCollapsed,
    setWorkbenchWidth,
    setWorkbenchOpen,
  }
})
