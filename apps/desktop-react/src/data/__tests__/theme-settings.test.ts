import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  patchDarkTheme,
  patchLightTheme,
  patchThemeMode,
  projectThemeSettings,
  themesFor,
} from '../theme-settings-model'
import { configureThemeSettingsPort, type ThemeSettingsPort } from '../theme-settings-port'
import {
  resetThemeSettingsSourceForTest,
  setDarkThemeMutation,
  setLightThemeMutation,
  setThemeModeMutation,
  themeSettingsQuery,
} from '../theme-settings-source'
import type { AppSettings } from '@shared/ipc/settings'
import type { ThemeMeta } from '@shared/ipc/themes'

vi.mock('../../theme/theme-source', async () => {
  const actual = await vi.importActual<typeof import('../../theme/theme-source')>(
    '../../theme/theme-source',
  )
  return { ...actual, refreshThemeFromSettings: vi.fn(async () => ({ applied: true, count: 1 })) }
})
const { refreshThemeFromSettings } = await import('../../theme/theme-source')

/**
 * 设置页「主题」那一节的数据层。
 *
 * 两半分开量:纯函数那一半(投影 / 过滤 / 三只合并)不碰端口;三条写路那一半
 * 用假端口,量的是「写回去的整份里**只动了那一格**」与「写完手动重判了一次主题」。
 */

const THEMES: ThemeMeta[] = [
  { id: 'flexoki', name: 'Flexoki', type: 'full', source: 'builtin', colorScheme: 'both' },
  { id: 'daylight', name: 'Daylight', type: 'full', source: 'builtin', colorScheme: 'light' },
  { id: 'midnight', name: 'Midnight', type: 'full', source: 'user', colorScheme: 'dark' },
]

/** 一份够用的整份设置。别的字段是**故意放进来的**:写路不许碰它们。 */
function settings(over: Partial<AppSettings> = {}): AppSettings {
  return {
    ai: { temperature: 0.7 } as AppSettings['ai'],
    theme: 'system',
    general: {
      animationSpeed: 0.25,
      sendShortcut: 'enter',
      colorTheme: 'purple',
      lightThemeId: 'daylight',
      darkThemeId: 'midnight',
    } as AppSettings['general'],
    tools: {} as AppSettings['tools'],
    browser: { cdp: { enabled: false, port: 9333 } } as AppSettings['browser'],
    ...over,
  }
}

describe('投影', () => {
  it('三格照实投,名册原样带过', () => {
    const view = projectThemeSettings(settings(), THEMES)
    expect(view).toEqual({
      mode: 'system',
      lightThemeId: 'daylight',
      darkThemeId: 'midnight',
      themes: THEMES,
    })
  })

  it('两格主题 id 缺席时兜底,而兜底的那个 id 与主题管道**同源**', () => {
    const view = projectThemeSettings(
      { theme: 'dark', general: {} as AppSettings['general'] },
      [],
    )
    expect(view.lightThemeId).toBe('flexoki')
    expect(view.darkThemeId).toBe('flexoki')
  })

  it('`theme` 是个认不出的值时读作「跟随系统」(存档 / 后端都可能给怪东西)', () => {
    const view = projectThemeSettings(
      { theme: 'neon' as AppSettings['theme'], general: {} as AppSettings['general'] },
      [],
    )
    expect(view.mode).toBe('system')
  })
})

describe('按明暗过滤', () => {
  it('`both` 两档都算;只属于另一档的不出现', () => {
    expect(themesFor(THEMES, 'light').map((r) => r.id)).toEqual(['flexoki', 'daylight'])
    expect(themesFor(THEMES, 'dark').map((r) => r.id)).toEqual(['flexoki', 'midnight'])
  })

  it('**当前 id 不在过滤结果里 → 补进末尾**(否则选择器找不到当前项画成空白)', () => {
    const rows = themesFor(THEMES, 'light', 'midnight')
    expect(rows.map((r) => r.id)).toEqual(['flexoki', 'daylight', 'midnight'])
    // 名册里没有它的显示名,所以名字就是 id 本身 —— 编一个更糟。
    expect(rows[2]!.name).toBe('midnight')
  })

  it('当前 id 已经在表上就不补(不许出现两行同一个 id)', () => {
    expect(themesFor(THEMES, 'light', 'daylight').map((r) => r.id)).toEqual(['flexoki', 'daylight'])
  })

  it('名册整个是空的:只剩当前那一格,而明暗那一行照常可用', () => {
    expect(themesFor([], 'dark', 'midnight').map((r) => r.id)).toEqual(['midnight'])
    expect(themesFor([], 'dark')).toEqual([])
  })
})

describe('三只合并函数:只动自己那一格', () => {
  it('明暗', () => {
    const next = patchThemeMode(settings(), 'dark')
    expect(next.theme).toBe('dark')
    expect(next.general).toEqual(settings().general)
    expect(next.browser).toEqual(settings().browser)
  })

  it('浅色 / 深色两格互不干扰,`general` 的别的字段逐字不变', () => {
    const light = patchLightTheme(settings(), 'flexoki')
    expect(light.general.lightThemeId).toBe('flexoki')
    expect(light.general.darkThemeId).toBe('midnight')
    expect(light.general.colorTheme).toBe('purple')

    const dark = patchDarkTheme(settings(), 'flexoki')
    expect(dark.general.darkThemeId).toBe('flexoki')
    expect(dark.general.lightThemeId).toBe('daylight')
  })

  it('`general` 整段缺席也不炸,而且不会把它写成只有一格的对象以外的东西', () => {
    const bare = { ...settings(), general: undefined as unknown as AppSettings['general'] }
    expect(patchLightTheme(bare, 'flexoki').general).toEqual({ lightThemeId: 'flexoki' })
  })
})

describe('三条写路', () => {
  let saved: AppSettings[] = []

  function installPort(over: Partial<ThemeSettingsPort> = {}): void {
    configureThemeSettingsPort({
      ready: async () => undefined,
      readSettings: async () => ({ success: true, settings: settings() }),
      saveSettings: async (next) => {
        saved.push(next)
        return { success: true }
      },
      listThemes: async () => ({ success: true, themes: THEMES }),
      onSettingsChanged: () => () => {},
      ...over,
    })
  }

  beforeEach(() => {
    saved = []
    resetThemeSettingsSourceForTest()
    vi.mocked(refreshThemeFromSettings).mockClear()
    installPort()
  })

  afterEach(() => {
    configureThemeSettingsPort(undefined)
    resetThemeSettingsSourceForTest()
  })

  it('query:设置 + 名册合成一份屏幕形状', async () => {
    await themeSettingsQuery.ensure()
    expect(themeSettingsQuery.get().data).toEqual({
      mode: 'system',
      lightThemeId: 'daylight',
      darkThemeId: 'midnight',
      themes: THEMES,
    })
  })

  it('**名册拉不到不算整节失败**:三格照读,只是名册空着', async () => {
    installPort({ listThemes: async () => ({ success: false, error: 'nope' }) })
    await themeSettingsQuery.ensure()
    expect(themeSettingsQuery.get().data?.themes).toEqual([])
    expect(themeSettingsQuery.get().data?.mode).toBe('system')
  })

  /*
   * kernel 的 `ensure()` **不抛**:它把后端那句原话记进 `error` 并**留住上一份**
   * (律②)。所以这一条量的是「错话上来了、而且屏幕上没被编出一份假数据」。
   */
  it('设置读不到:错话原样记下,`data` 不被编出来', async () => {
    installPort({ readSettings: async () => ({ success: false, error: '后端说不行' }) })
    await themeSettingsQuery.ensure()
    expect(themeSettingsQuery.get().error).toBe('后端说不行')
    expect(themeSettingsQuery.get().data).toBeUndefined()
  })

  it('写明暗:整份写回,只有 `theme` 那一格变了', async () => {
    await setThemeModeMutation.run('dark')
    expect(saved).toHaveLength(1)
    expect(saved[0]).toEqual({ ...settings(), theme: 'dark' })
    expect(refreshThemeFromSettings).toHaveBeenCalledTimes(1)
  })

  it('写浅色主题:`general` 的别的字段、`browser`、`ai` 逐字不变', async () => {
    await setLightThemeMutation.run('flexoki')
    expect(saved[0]).toEqual({
      ...settings(),
      general: { ...settings().general, lightThemeId: 'flexoki' },
    })
    expect(refreshThemeFromSettings).toHaveBeenCalledTimes(1)
  })

  it('写深色主题同理', async () => {
    await setDarkThemeMutation.run('flexoki')
    expect(saved[0]?.general.darkThemeId).toBe('flexoki')
    expect(saved[0]?.general.lightThemeId).toBe('daylight')
    expect(refreshThemeFromSettings).toHaveBeenCalledTimes(1)
  })

  it('**底本是当场读的那一份**,不是屏幕上缓存的那一份', async () => {
    // 先灌一份屏幕缓存(旧),再让端口交出一份「别人刚改过」的新设置。
    await themeSettingsQuery.ensure()
    const fresh = settings({ theme: 'light', browser: { cdp: { enabled: true, port: 9333 } } as AppSettings['browser'] })
    installPort({
      readSettings: async () => ({ success: true, settings: fresh }),
      saveSettings: async (next) => {
        saved.push(next)
        return { success: true }
      },
    })
    await setDarkThemeMutation.run('flexoki')
    // 别人刚开的那一格调试口没有被抹掉 —— 那正是「当场读一份新的」要保的东西。
    expect(saved[0]?.browser?.cdp?.enabled).toBe(true)
  })

  /*
   * mutation 的 `run()` 同样**不抛**(回滚 + `onError` 已经在里面做完了),
   * 失败答 `undefined`、把原话记进快照。这一条真正要钉的是第二句:
   * **写不进去就不许重判主题** —— 否则屏幕上的颜色会先按乐观值变一下再弹回来。
   */
  it('后端拒了:原话记下、答 undefined,而且**一次主题都不重判**', async () => {
    installPort({ saveSettings: async () => ({ success: false, error: '写不动' }) })
    expect(await setThemeModeMutation.run('light')).toBeUndefined()
    expect(setThemeModeMutation.get().error).toBe('写不动')
    expect(refreshThemeFromSettings).not.toHaveBeenCalled()
  })
})
