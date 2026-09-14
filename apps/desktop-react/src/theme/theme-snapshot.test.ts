import { afterEach, describe, expect, it } from 'vitest'
import {
  normalizeThemeSnapshot,
  ThemeSnapshotStore,
  THEME_SNAPSHOT_KEY,
  type ThemeSnapshotStorage,
} from './theme-snapshot'

/** 一份最小的假存储 —— 测试不该摆弄真 `window.localStorage`(跨用例串味)。 */
function fakeStorage(seed?: Record<string, string>): ThemeSnapshotStorage & {
  map: Map<string, string>
} {
  const map = new Map<string, string>(Object.entries(seed ?? {}))
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
    },
    removeItem: (key) => {
      map.delete(key)
    },
  }
}

afterEach(() => {
  try {
    window.localStorage.clear()
  } catch {
    /* 没有就算了 */
  }
})

describe('normalizeThemeSnapshot —— 存档当不可信输入,按形状归一', () => {
  const good = {
    v: 1,
    themeId: 'one-light',
    mode: 'light',
    cssVariables: { '--ui-surface-app-bg': '#FAFAFA' },
  }

  it('合法的整份原样收下', () => {
    expect(normalizeThemeSnapshot(good)).toEqual(good)
  })

  it('不是对象 / 是数组 / 是 null → null', () => {
    expect(normalizeThemeSnapshot(null)).toBeNull()
    expect(normalizeThemeSnapshot('one-light')).toBeNull()
    expect(normalizeThemeSnapshot(42)).toBeNull()
    expect(normalizeThemeSnapshot([good])).toBeNull()
  })

  it('版本号不对 → null(形状变了就当没缓存)', () => {
    expect(normalizeThemeSnapshot({ ...good, v: 2 })).toBeNull()
    expect(normalizeThemeSnapshot({ ...good, v: undefined })).toBeNull()
  })

  it('themeId 不是非空字符串 → null', () => {
    expect(normalizeThemeSnapshot({ ...good, themeId: '' })).toBeNull()
    expect(normalizeThemeSnapshot({ ...good, themeId: 7 })).toBeNull()
  })

  it('mode 不在两档里 → null', () => {
    expect(normalizeThemeSnapshot({ ...good, mode: 'system' })).toBeNull()
    expect(normalizeThemeSnapshot({ ...good, mode: undefined })).toBeNull()
  })

  it('cssVariables 不是表 / 是空表 / 有一个值不是字符串 → 整份不认', () => {
    expect(normalizeThemeSnapshot({ ...good, cssVariables: '#FAFAFA' })).toBeNull()
    expect(normalizeThemeSnapshot({ ...good, cssVariables: {} })).toBeNull()
    // 半张表贴上去比不贴更难看:缺的键回落 palette 静态值,一屏两套色。
    expect(
      normalizeThemeSnapshot({
        ...good,
        cssVariables: { '--ui-a': '#111', '--ui-b': 222 },
      }),
    ).toBeNull()
  })
})

describe('ThemeSnapshotStore —— 读写', () => {
  it('写进去再读出来是同一份', () => {
    const storage = fakeStorage()
    const store = new ThemeSnapshotStore(storage)
    store.write({ themeId: 'nord', mode: 'dark', cssVariables: { '--ui-a': '#111' } })

    expect(storage.map.has(THEME_SNAPSHOT_KEY)).toBe(true)
    expect(store.read()).toEqual({
      v: 1,
      themeId: 'nord',
      mode: 'dark',
      cssVariables: { '--ui-a': '#111' },
    })
  })

  it('没有存档 → null', () => {
    expect(new ThemeSnapshotStore(fakeStorage()).read()).toBeNull()
  })

  it('坏 JSON → null,不抛,而且**不**在读路上删东西', () => {
    const storage = fakeStorage({ [THEME_SNAPSHOT_KEY]: '{半截' })
    const store = new ThemeSnapshotStore(storage)
    expect(() => store.read()).not.toThrow()
    expect(store.read()).toBeNull()
    expect(storage.map.has(THEME_SNAPSHOT_KEY)).toBe(true)
  })

  it('形状不对的存档 → null(归一那一层挡住)', () => {
    const storage = fakeStorage({
      [THEME_SNAPSHOT_KEY]: JSON.stringify({ v: 1, themeId: 'nord', mode: 'sepia' }),
    })
    expect(new ThemeSnapshotStore(storage).read()).toBeNull()
  })

  it('存储抛(隐私模式 / 配额满)= 静默降级,读答 null、写不炸', () => {
    const angry: ThemeSnapshotStorage = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {
        throw new Error('SecurityError')
      },
    }
    const store = new ThemeSnapshotStore(angry)
    expect(store.read()).toBeNull()
    expect(() => store.write({ themeId: 'nord', mode: 'dark', cssVariables: { '--a': '#1' } })).not.toThrow()
    expect(() => store.clear()).not.toThrow()
  })

  it('clear 清掉', () => {
    const storage = fakeStorage()
    const store = new ThemeSnapshotStore(storage)
    store.write({ themeId: 'nord', mode: 'dark', cssVariables: { '--ui-a': '#111' } })
    store.clear()
    expect(storage.map.has(THEME_SNAPSHOT_KEY)).toBe(false)
    expect(store.read()).toBeNull()
  })

  it('缺省用 window.localStorage', () => {
    const store = new ThemeSnapshotStore()
    store.write({ themeId: 'one-light', mode: 'light', cssVariables: { '--ui-a': '#FAFAFA' } })
    expect(window.localStorage.getItem(THEME_SNAPSHOT_KEY)).toContain('one-light')
    expect(store.read()?.themeId).toBe('one-light')
  })
})
