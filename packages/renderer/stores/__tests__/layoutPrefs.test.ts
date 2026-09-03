// @vitest-environment happy-dom
/**
 * 布局偏好 store(外壳布局收敛 L0)。
 *
 * 三件必须钉死的事:
 *  1. 旧的 5 个裸 key 迁得进来、且**迁完就删**(否则下次启动又走一遍老路);
 *  2. clamp 只在这里做一次 —— 读进来的越界值当场收敛,读的那一侧不再各补各的;
 *  3. 一行坏 JSON 不能把整个外壳布局带歪(回默认值,不抛)。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  DEFAULT_SIDEBAR_WIDTH,
  DEFAULT_WORKBENCH_WIDTH,
  LAYOUT_PREFS_STORAGE_KEY,
  LEGACY_LAYOUT_STORAGE_KEYS,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  MIN_WORKBENCH_WIDTH,
  clampSidebarWidth,
  clampWorkbenchWidth,
  createDefaultLayoutPrefs,
  loadLayoutPrefs,
  saveLayoutPrefs,
  useLayoutPrefsStore,
  type LayoutPrefsStorage,
} from '../layoutPrefs'

function makeStorage(seed: Record<string, string> = {}): LayoutPrefsStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed))
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, String(value)) },
    removeItem: (key: string) => { map.delete(key) },
  }
}

describe('clamp', () => {
  it('侧栏宽度收敛在 200–500,坏数取默认', () => {
    expect(clampSidebarWidth(120)).toBe(MIN_SIDEBAR_WIDTH)
    expect(clampSidebarWidth(9000)).toBe(MAX_SIDEBAR_WIDTH)
    expect(clampSidebarWidth(321.4)).toBe(321)
    expect(clampSidebarWidth(Number.NaN)).toBe(DEFAULT_SIDEBAR_WIDTH)
  })

  it('右栏宽度只守 250 地板,没有固定上限 —— 能拖多宽由协调器按聊天预算实时给', () => {
    expect(clampWorkbenchWidth(10)).toBe(MIN_WORKBENCH_WIDTH)
    expect(clampWorkbenchWidth(2000)).toBe(2000)
    expect(clampWorkbenchWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_WORKBENCH_WIDTH)
  })
})

describe('loadLayoutPrefs —— 旧 key 迁移', () => {
  it('旧 key 全迁进新 key,并把旧 key(含 L3 退役的那条)删干净', () => {
    const storage = makeStorage({
      [LEGACY_LAYOUT_STORAGE_KEYS.sidebarWidth]: '420',
      [LEGACY_LAYOUT_STORAGE_KEYS.sidebarCollapsed]: 'false',
      // 百分比:窗宽 1600 扣掉 420 的侧栏 = 1180 的分栏容器,30% ≈ 354px
      [LEGACY_LAYOUT_STORAGE_KEYS.workbenchWidth]: '30',
      [LEGACY_LAYOUT_STORAGE_KEYS.workbenchOpen]: 'true',
      [LEGACY_LAYOUT_STORAGE_KEYS.chatSideCollapsed]: 'true',
    })

    const prefs = loadLayoutPrefs({ storage, viewportWidth: 1600 })

    expect(prefs.sidebarWidth).toBe(420)
    expect(prefs.sidebarCollapsed).toBe(false)
    expect(prefs.workbenchWidth).toBe(354)
    expect(prefs.workbenchOpen).toBe(true)
    // L3:大纲栏并入右栏之后 `chatSidePanelCollapsed` 不再有对应字段,但它仍要
    // 被清理掉(下面那圈断言),不能在老用户的存储里躺着。
    expect('chatSideCollapsed' in prefs).toBe(false)

    for (const key of Object.values(LEGACY_LAYOUT_STORAGE_KEYS)) {
      expect(storage.map.has(key)).toBe(false)
    }
    // 迁移结果当场落进新 key,下次启动直接读它。
    expect(JSON.parse(storage.map.get(LAYOUT_PREFS_STORAGE_KEY) ?? '{}')).toEqual(prefs)
  })

  it('迁移时同样过 clamp —— 旧存档里的越界值不会漏进来', () => {
    const storage = makeStorage({
      [LEGACY_LAYOUT_STORAGE_KEYS.sidebarWidth]: '1200',
      // 48% × (900 − 500) = 192px,低于 250 的硬地板
      [LEGACY_LAYOUT_STORAGE_KEYS.workbenchWidth]: '48',
    })

    const prefs = loadLayoutPrefs({ storage, viewportWidth: 900 })

    expect(prefs.sidebarWidth).toBe(MAX_SIDEBAR_WIDTH)
    expect(prefs.workbenchWidth).toBe(MIN_WORKBENCH_WIDTH)
  })

  it('只迁到一部分旧 key 时,其余走默认值', () => {
    const storage = makeStorage({ [LEGACY_LAYOUT_STORAGE_KEYS.sidebarCollapsed]: 'true' })

    const prefs = loadLayoutPrefs({ storage, viewportWidth: 1440 })

    expect(prefs.sidebarCollapsed).toBe(true)
    expect(prefs.sidebarWidth).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(prefs.workbenchWidth).toBe(DEFAULT_WORKBENCH_WIDTH)
  })

  it('「没存过」与「存过 false」是两件事 —— workbenchOpen 是三态', () => {
    const never = loadLayoutPrefs({ storage: makeStorage(), viewportWidth: 1440 })
    expect(never.workbenchOpen).toBeNull()

    const stored = loadLayoutPrefs({
      storage: makeStorage({ [LEGACY_LAYOUT_STORAGE_KEYS.workbenchOpen]: 'false' }),
      viewportWidth: 1440,
    })
    expect(stored.workbenchOpen).toBe(false)
  })

  it('新 key 在场就不再看旧 key(迁移只发生一次)', () => {
    const storage = makeStorage({
      [LAYOUT_PREFS_STORAGE_KEY]: JSON.stringify({ ...createDefaultLayoutPrefs(), sidebarWidth: 260 }),
      [LEGACY_LAYOUT_STORAGE_KEYS.sidebarWidth]: '480',
    })

    expect(loadLayoutPrefs({ storage, viewportWidth: 1600 }).sidebarWidth).toBe(260)
  })
})

describe('loadLayoutPrefs —— 损坏数据', () => {
  it('坏 JSON 回默认值,不抛', () => {
    const storage = makeStorage({ [LAYOUT_PREFS_STORAGE_KEY]: '{ this is not json' })
    expect(loadLayoutPrefs({ storage })).toEqual(createDefaultLayoutPrefs())
  })

  it('JSON 合法但不是对象 / 字段类型不对 —— 逐字段回默认,不整体崩', () => {
    expect(loadLayoutPrefs({ storage: makeStorage({ [LAYOUT_PREFS_STORAGE_KEY]: 'null' }) }))
      .toEqual(createDefaultLayoutPrefs())
    expect(loadLayoutPrefs({ storage: makeStorage({ [LAYOUT_PREFS_STORAGE_KEY]: '"nope"' }) }))
      .toEqual(createDefaultLayoutPrefs())

    const mixed = loadLayoutPrefs({
      storage: makeStorage({
        [LAYOUT_PREFS_STORAGE_KEY]: JSON.stringify({
          sidebarWidth: 'wide',
          sidebarCollapsed: 'yes',
          workbenchWidth: 999999,
          workbenchOpen: 'true',
        }),
      }),
    })
    expect(mixed.sidebarWidth).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(mixed.sidebarCollapsed).toBe(false)
    expect(mixed.workbenchWidth).toBe(999999)
    expect(mixed.workbenchOpen).toBeNull()
  })

  it('没有 localStorage(隐私模式 / 无 DOM 夹具)也能起来', () => {
    expect(loadLayoutPrefs({ storage: null })).toEqual(createDefaultLayoutPrefs())
    expect(() => saveLayoutPrefs(createDefaultLayoutPrefs(), null)).not.toThrow()
  })
})

describe('useLayoutPrefsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // happy-dom 的 localStorage 没有 clear();换一份自备的假件,顺便保证每个用例
    // 从空存储起步。
    const fake = makeStorage()
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: fake })
    Object.defineProperty(window, 'localStorage', { configurable: true, value: fake })
  })

  it('setter 过 clamp,改动落进单一 key', async () => {
    const store = useLayoutPrefsStore()

    store.setSidebarWidth(1000)
    store.setWorkbenchWidth(10)
    store.setSidebarCollapsed(true)
    store.setWorkbenchOpen(false)
    await Promise.resolve()

    expect(store.sidebarWidth).toBe(MAX_SIDEBAR_WIDTH)
    expect(store.workbenchWidth).toBe(MIN_WORKBENCH_WIDTH)
    expect(JSON.parse(localStorage.getItem(LAYOUT_PREFS_STORAGE_KEY) ?? '{}')).toEqual({
      sidebarWidth: MAX_SIDEBAR_WIDTH,
      sidebarCollapsed: true,
      workbenchWidth: MIN_WORKBENCH_WIDTH,
      workbenchOpen: false,
    })
  })

  it('旧 key 在真 localStorage 上也走同一条迁移路', () => {
    localStorage.setItem(LEGACY_LAYOUT_STORAGE_KEYS.sidebarCollapsed, 'true')
    localStorage.setItem(LEGACY_LAYOUT_STORAGE_KEYS.chatSideCollapsed, 'true')

    const store = useLayoutPrefsStore()

    expect(store.sidebarCollapsed).toBe(true)
    expect(localStorage.getItem(LEGACY_LAYOUT_STORAGE_KEYS.sidebarCollapsed)).toBeNull()
    expect(localStorage.getItem(LEGACY_LAYOUT_STORAGE_KEYS.chatSideCollapsed)).toBeNull()
  })
})
