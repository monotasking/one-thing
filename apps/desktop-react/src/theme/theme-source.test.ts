import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, GetSettingsResponse } from '@shared/ipc/settings'
import { configureThemePort, type ThemePort } from './theme-port'
import { THEME_SNAPSHOT_KEY, type ThemeSnapshot } from './theme-snapshot'
import {
  applyThemeVariables,
  decideTheme,
  refreshThemeFromSettings,
  resetThemeSourceForTest,
  restoreThemeSnapshot,
  startThemeSource,
  themeProbe,
} from './theme-source'

/** 只造判据用得到的那几个字段 —— AppSettings 的其余部分与主题无关。 */
function settings(
  theme: AppSettings['theme'],
  general?: { darkThemeId?: string; lightThemeId?: string },
): AppSettings {
  return { theme, general } as unknown as AppSettings
}

type PortCalls = { applied: Array<{ themeId: string; mode: 'dark' | 'light' }> }

function fakePort(options: {
  settings?: AppSettings
  systemTheme?: 'light' | 'dark'
  cssVariables?: Record<string, string> | undefined
  applyError?: string
  ready?: () => Promise<unknown>
  /**
   * `getSettings` 永不 resolve —— 于是 `pull()` 一直挂着,而两条推送(它们在
   * `ready()` 之后、`pull()` 之前就订好了)是这一局里唯一还能走通的路。
   * 快照那一组要的就是这个窗口:开场那一趟还没回来时,推送该不该被短路。
   */
  holdSettings?: boolean
}): {
  port: ThemePort
  calls: PortCalls
  emitSystemTheme: (t: 'light' | 'dark') => void
  emitSettings: (s: AppSettings) => void
  getSettingsCalls: () => number
} {
  const calls: PortCalls = { applied: [] }
  let listener: ((t: 'light' | 'dark') => void) | undefined
  let settingsListener: ((s: AppSettings) => void) | undefined
  let getSettingsCalls = 0
  const port: ThemePort = {
    ready: options.ready ?? (async () => undefined),
    getSettings: async () => {
      getSettingsCalls += 1
      if (options.holdSettings) return new Promise<GetSettingsResponse>(() => {})
      return { success: true, settings: options.settings ?? settings('system') }
    },
    getSystemTheme: async () => ({ success: true, theme: options.systemTheme ?? 'dark' }),
    applyTheme: async (themeId, mode) => {
      calls.applied.push({ themeId, mode })
      if (options.applyError) return { success: false, error: options.applyError }
      return { success: true, cssVariables: options.cssVariables ?? { '--ui-surface-app-bg': '#111' } }
    },
    onSystemThemeChanged: (callback) => {
      listener = callback
      return () => {
        listener = undefined
      }
    },
    onSettingsChanged: (callback) => {
      settingsListener = callback
      return () => {
        settingsListener = undefined
      }
    },
  }
  return {
    port,
    calls,
    emitSystemTheme: (t) => listener?.(t),
    emitSettings: (s) => settingsListener?.(s),
    getSettingsCalls: () => getSettingsCalls,
  }
}

afterEach(() => {
  resetThemeSourceForTest()
  configureThemePort(undefined)
  window.localStorage.clear()
  vi.restoreAllMocks()
})

/** 往 localStorage 里塞一份快照(产品路径读的就是这个键)。 */
function seedSnapshot(snapshot: unknown): void {
  window.localStorage.setItem(THEME_SNAPSHOT_KEY, JSON.stringify(snapshot))
}

function readSnapshot(): ThemeSnapshot | null {
  const text = window.localStorage.getItem(THEME_SNAPSHOT_KEY)
  return text ? (JSON.parse(text) as ThemeSnapshot) : null
}

describe('decideTheme —— 当前主题的判据(与旧 Vue 壳同源)', () => {
  it('theme=system 时明暗跟系统色走', () => {
    expect(decideTheme(settings('system'), 'dark').mode).toBe('dark')
    expect(decideTheme(settings('system'), 'light').mode).toBe('light')
  })

  it('theme 显式指定时压过系统色', () => {
    expect(decideTheme(settings('light'), 'dark').mode).toBe('light')
    expect(decideTheme(settings('dark'), 'light').mode).toBe('dark')
  })

  it('主题 id 按明暗分别取 darkThemeId / lightThemeId', () => {
    const s = settings('system', { darkThemeId: 'dracula', lightThemeId: 'catppuccin' })
    expect(decideTheme(s, 'dark')).toEqual({ themeId: 'dracula', mode: 'dark' })
    expect(decideTheme(s, 'light')).toEqual({ themeId: 'catppuccin', mode: 'light' })
  })

  it('没有配 id 时兜底 flexoki', () => {
    expect(decideTheme(settings('light'), 'dark').themeId).toBe('flexoki')
    // 只配了 dark 那一档:暗档拿 nord,亮档仍然兜底 —— 两档各读各的键。
    expect(decideTheme(settings('dark', { darkThemeId: 'nord' }), 'light').themeId).toBe('nord')
    expect(decideTheme(settings('light', { darkThemeId: 'nord' }), 'dark').themeId).toBe('flexoki')
  })
})

describe('applyThemeVariables —— 把表贴上 :root', () => {
  it('变量落在 :root 上、桥的标记在场、color-scheme 跟着明暗', () => {
    const count = applyThemeVariables(
      { '--ui-surface-app-bg': '#E6E4D9', '--ui-text-primary-fg': '#262523' },
      'light',
    )
    expect(count).toBe(2)
    const style = document.getElementById('onething-theme-vars')
    expect(style?.textContent).toContain('--ui-surface-app-bg: #E6E4D9;')
    expect(style?.textContent).toContain('--ui-text-primary-fg: #262523;')
    expect(document.documentElement.hasAttribute('data-theme-bridge')).toBe(true)
    expect(document.documentElement.style.colorScheme).toBe('light')
  })

  it('重贴是整体换,不会越积越多', () => {
    applyThemeVariables({ '--ui-a': '#111', '--ui-b': '#222' }, 'dark')
    applyThemeVariables({ '--ui-a': '#333' }, 'light')
    const text = document.getElementById('onething-theme-vars')?.textContent ?? ''
    expect(text).toContain('--ui-a: #333;')
    expect(text).not.toContain('--ui-b')
    expect(document.documentElement.style.colorScheme).toBe('light')
  })

  it('挡掉能破坏 CSS 语法的键与值', () => {
    const count = applyThemeVariables(
      {
        '--ui-ok': '#fff',
        'not-a-var': '#fff',
        '--ui-bad': '#fff } :root { --surface-0: red',
        '--ui-tag': '</style><script>',
      },
      'dark',
    )
    expect(count).toBe(1)
    const text = document.getElementById('onething-theme-vars')?.textContent ?? ''
    expect(text).toContain('--ui-ok')
    expect(text).not.toContain('not-a-var')
    expect(text).not.toContain('--ui-bad')
    expect(text).not.toContain('--ui-tag')
  })
})

describe('startThemeSource —— 取数 → 判 → 贴', () => {
  it('用勘察到的判据调 apply,并把变量写上 root', async () => {
    const { port, calls } = fakePort({
      settings: settings('system', { darkThemeId: 'dracula', lightThemeId: 'flexoki' }),
      systemTheme: 'dark',
      cssVariables: { '--ui-surface-app-bg': '#100F0F' },
    })
    configureThemePort(port)

    const result = await startThemeSource()

    expect(calls.applied).toEqual([{ themeId: 'dracula', mode: 'dark' }])
    expect(result.applied).toBe(true)
    expect(result.themeId).toBe('dracula')
    expect(result.mode).toBe('dark')
    expect(document.getElementById('onething-theme-vars')?.textContent).toContain(
      '--ui-surface-app-bg: #100F0F;',
    )
    expect(document.documentElement.hasAttribute('data-theme-bridge')).toBe(true)
  })

  it('幂等:调两次只连通一次', async () => {
    const { port, calls } = fakePort({ settings: settings('light') })
    configureThemePort(port)
    await Promise.all([startThemeSource(), startThemeSource()])
    expect(calls.applied).toHaveLength(1)
  })

  it('系统明暗变化会重 apply(theme=system 时换主题 id 也跟着换)', async () => {
    const { port, calls, emitSystemTheme } = fakePort({
      settings: settings('system', { darkThemeId: 'dracula', lightThemeId: 'flexoki' }),
      systemTheme: 'dark',
    })
    configureThemePort(port)
    await startThemeSource()
    expect(calls.applied).toEqual([{ themeId: 'dracula', mode: 'dark' }])

    emitSystemTheme('light')
    await vi.waitFor(() => expect(calls.applied).toHaveLength(2))
    expect(calls.applied[1]).toEqual({ themeId: 'flexoki', mode: 'light' })
    expect(document.documentElement.style.colorScheme).toBe('light')
  })
})

describe('接不上就维持原状 —— 不打激活标记', () => {
  it('传输面没就绪(whenConnected 抛)= 不 apply、不打标记', async () => {
    const { port, calls } = fakePort({
      ready: async () => {
        throw new Error('no core')
      },
    })
    configureThemePort(port)

    const result = await startThemeSource()

    expect(calls.applied).toHaveLength(0)
    expect(result.applied).toBe(false)
    expect(result.error).toBe('no core')
    expect(document.getElementById('onething-theme-vars')).toBeNull()
    expect(document.documentElement.hasAttribute('data-theme-bridge')).toBe(false)
  })

  it('apply 返回失败 = 不打标记,错误留在探针上', async () => {
    const { port } = fakePort({ settings: settings('light'), applyError: 'theme not found' })
    configureThemePort(port)

    const result = await startThemeSource()

    expect(result.applied).toBe(false)
    expect(result.error).toBe('theme not found')
    expect(document.documentElement.hasAttribute('data-theme-bridge')).toBe(false)
  })

  it('apply 成功但表是空的 = 不打标记(贴不了就不算接管)', async () => {
    const { port } = fakePort({ settings: settings('light'), cssVariables: {} })
    configureThemePort(port)

    const result = await startThemeSource()

    expect(result.applied).toBe(false)
    expect(document.documentElement.hasAttribute('data-theme-bridge')).toBe(false)
  })
})

describe('refreshThemeFromSettings —— 设置变更没有推送面时的手动重判口', () => {
  it('重读设置并重贴', async () => {
    const { port, calls } = fakePort({
      settings: settings('dark', { darkThemeId: 'nord' }),
      systemTheme: 'light',
    })
    configureThemePort(port)
    await startThemeSource()
    expect(calls.applied).toEqual([{ themeId: 'nord', mode: 'dark' }])

    await refreshThemeFromSettings()

    expect(calls.applied).toHaveLength(2)
    expect(themeProbe().themeId).toBe('nord')
  })
})


/**
 * H 批:设置变更从「听不见」变成一条真订阅(共享层读侧补齐 E 批把 web 的空桩
 * 换成了骑 `GET /api/events` 的具名 SSE 事件)。
 *
 * 三态各一条:没变 / 变明暗 / 变主题 id。判据仍然是同一个纯函数 `decideTheme`,
 * 这里钉的是「什么时候该重贴、什么时候不该」。
 */
describe('设置变更 → 自动重判(H 批)', () => {
  it('变了主题 id 就重贴', async () => {
    const { port, calls, emitSettings } = fakePort({
      settings: settings('dark', { darkThemeId: 'dracula' }),
    })
    configureThemePort(port)
    await startThemeSource()
    expect(calls.applied).toEqual([{ themeId: 'dracula', mode: 'dark' }])

    emitSettings(settings('dark', { darkThemeId: 'nord' }))

    await vi.waitFor(() => expect(calls.applied).toHaveLength(2))
    expect(calls.applied[1]).toEqual({ themeId: 'nord', mode: 'dark' })
    expect(themeProbe().themeId).toBe('nord')
  })

  it('变了明暗就重贴,而且换的是那一档自己的主题 id', async () => {
    const { port, calls, emitSettings } = fakePort({
      settings: settings('dark', { darkThemeId: 'dracula', lightThemeId: 'catppuccin' }),
    })
    configureThemePort(port)
    await startThemeSource()

    emitSettings(settings('light', { darkThemeId: 'dracula', lightThemeId: 'catppuccin' }))

    await vi.waitFor(() => expect(calls.applied).toHaveLength(2))
    expect(calls.applied[1]).toEqual({ themeId: 'catppuccin', mode: 'light' })
    expect(document.documentElement.style.colorScheme).toBe('light')
  })

  it('判据没变就**不**重贴 —— 改一个与主题无关的开关也会推一份整设置过来', async () => {
    const { port, calls, emitSettings } = fakePort({
      settings: settings('dark', { darkThemeId: 'dracula' }),
    })
    configureThemePort(port)
    await startThemeSource()
    expect(calls.applied).toHaveLength(1)

    emitSettings(settings('dark', { darkThemeId: 'dracula' }))
    await Promise.resolve()
    await Promise.resolve()

    expect(calls.applied).toHaveLength(1)
  })

  it('theme=system 时设置里那两个 id 换了照样跟着换(明暗仍由系统色说了算)', async () => {
    const { port, calls, emitSettings } = fakePort({
      settings: settings('system', { darkThemeId: 'dracula' }),
      systemTheme: 'dark',
    })
    configureThemePort(port)
    await startThemeSource()

    emitSettings(settings('system', { darkThemeId: 'nord' }))

    await vi.waitFor(() => expect(calls.applied).toHaveLength(2))
    expect(calls.applied[1]).toEqual({ themeId: 'nord', mode: 'dark' })
  })

  it('载荷直接喂判据 —— 不再回问一趟 getSettings', async () => {
    const { port, emitSettings, getSettingsCalls } = fakePort({
      settings: settings('dark', { darkThemeId: 'dracula' }),
    })
    configureThemePort(port)
    await startThemeSource()
    expect(getSettingsCalls()).toBe(1) // 开场那一次

    emitSettings(settings('light', { lightThemeId: 'catppuccin' }))
    await vi.waitFor(() => expect(themeProbe().themeId).toBe('catppuccin'))

    expect(getSettingsCalls()).toBe(1)
  })

  it('设置推来之后系统色再变,用的是新偏好而不是开场那份', async () => {
    const { port, calls, emitSettings, emitSystemTheme } = fakePort({
      settings: settings('system', { darkThemeId: 'dracula', lightThemeId: 'flexoki' }),
      systemTheme: 'dark',
    })
    configureThemePort(port)
    await startThemeSource()

    emitSettings(settings('system', { darkThemeId: 'dracula', lightThemeId: 'catppuccin' }))
    await Promise.resolve()
    emitSystemTheme('light')

    await vi.waitFor(() => expect(themeProbe().themeId).toBe('catppuccin'))
    expect(calls.applied.at(-1)).toEqual({ themeId: 'catppuccin', mode: 'light' })
  })

  it('reset 会把这条订阅也退掉', async () => {
    const { port, calls, emitSettings } = fakePort({ settings: settings('dark') })
    configureThemePort(port)
    await startThemeSource()
    resetThemeSourceForTest()

    emitSettings(settings('light', { lightThemeId: 'catppuccin' }))
    await Promise.resolve()

    expect(calls.applied).toHaveLength(1)
  })
})

/**
 * **启动快照**(启动闪色的治法)。钉四件事:贴得上、坏存档不许贴、apply 成功要
 * 存、以及「快照贴过之后连通仍然真的校正一次」—— 最后那条是 `lastDecision`
 * 故意不写的全部理由(判词在 theme-source.ts 文件头)。
 */
describe('restoreThemeSnapshot —— createRoot 之前那一句同步颜色', () => {
  it('有合法快照:变量上 root、桥的标记在场、color-mode 跟快照的 mode', () => {
    seedSnapshot({
      v: 1,
      themeId: 'one-light',
      mode: 'light',
      cssVariables: { '--ui-surface-app-bg': '#FAFAFA', '--ui-text-primary-fg': '#383A42' },
    })

    const result = restoreThemeSnapshot()

    expect(result.applied).toBe(true)
    expect(result.count).toBe(2)
    expect(result.themeId).toBe('one-light')
    expect(result.source).toBe('snapshot')
    const style = document.getElementById('onething-theme-vars')
    expect(style?.textContent).toContain('--ui-surface-app-bg: #FAFAFA;')
    expect(document.documentElement.hasAttribute('data-theme-bridge')).toBe(true)
    expect(document.documentElement.getAttribute('data-color-mode')).toBe('light')
    expect(document.documentElement.style.colorScheme).toBe('light')
  })

  it('没有快照:什么都不做(与从前逐字一样,palette 静态值顶着)', () => {
    const result = restoreThemeSnapshot()

    expect(result.applied).toBe(false)
    expect(result.source).toBeUndefined()
    expect(document.getElementById('onething-theme-vars')).toBeNull()
    expect(document.documentElement.hasAttribute('data-theme-bridge')).toBe(false)
  })

  it.each([
    ['不是 JSON', undefined],
    ['版本号不对', { v: 2, themeId: 'nord', mode: 'dark', cssVariables: { '--ui-a': '#111' } }],
    ['mode 不在两档里', { v: 1, themeId: 'nord', mode: 'sepia', cssVariables: { '--ui-a': '#111' } }],
    ['表里有非字符串值', { v: 1, themeId: 'nord', mode: 'dark', cssVariables: { '--ui-a': 111 } }],
    ['themeId 空', { v: 1, themeId: '', mode: 'dark', cssVariables: { '--ui-a': '#111' } }],
  ])('坏存档(%s):不贴、不打标记、不抛', (_label, payload) => {
    if (payload === undefined) window.localStorage.setItem(THEME_SNAPSHOT_KEY, '{半截')
    else seedSnapshot(payload)

    expect(() => restoreThemeSnapshot()).not.toThrow()
    expect(themeProbe().applied).toBe(false)
    expect(document.getElementById('onething-theme-vars')).toBeNull()
    expect(document.documentElement.hasAttribute('data-theme-bridge')).toBe(false)
  })

  it('快照整表都被 CSS 护栏挡掉 = 当作没贴上(走的是同一只 applyThemeVariables)', () => {
    seedSnapshot({
      v: 1,
      themeId: 'nord',
      mode: 'dark',
      cssVariables: { '--ui-bad': '#fff } :root { --surface-0: red' },
    })

    const result = restoreThemeSnapshot()

    expect(result.applied).toBe(false)
    expect(document.documentElement.hasAttribute('data-theme-bridge')).toBe(false)
  })
})

describe('apply 成功 → 存一份快照给下次开机', () => {
  it('存的是这一次的 themeId / mode / 那张表', async () => {
    const { port } = fakePort({
      settings: settings('dark', { darkThemeId: 'nord' }),
      cssVariables: { '--ui-surface-app-bg': '#2E3440', '--ui-text-primary-fg': '#D8DEE9' },
    })
    configureThemePort(port)

    await startThemeSource()

    expect(readSnapshot()).toEqual({
      v: 1,
      themeId: 'nord',
      mode: 'dark',
      cssVariables: { '--ui-surface-app-bg': '#2E3440', '--ui-text-primary-fg': '#D8DEE9' },
    })
    expect(themeProbe().source).toBe('core')
  })

  it('apply 失败 / 表贴不上 = 不存(下次开机白读一趟没意义)', async () => {
    const { port } = fakePort({ settings: settings('light'), applyError: 'theme not found' })
    configureThemePort(port)
    await startThemeSource()
    expect(readSnapshot()).toBeNull()

    resetThemeSourceForTest()
    configureThemePort(undefined)
    const empty = fakePort({ settings: settings('light'), cssVariables: {} })
    configureThemePort(empty.port)
    await startThemeSource()
    expect(readSnapshot()).toBeNull()
  })
})

describe('快照不短路校正 —— lastDecision 故意不写', () => {
  it('贴过快照之后 startThemeSource() 仍然真的 apply 一次,而且新表盖掉旧表', async () => {
    // 上一次开机是 one-light;这一次设置里已经换成 nord/dark。
    seedSnapshot({
      v: 1,
      themeId: 'one-light',
      mode: 'light',
      cssVariables: { '--ui-surface-app-bg': '#FAFAFA' },
    })
    restoreThemeSnapshot()
    expect(themeProbe().source).toBe('snapshot')

    const { port, calls } = fakePort({
      settings: settings('dark', { darkThemeId: 'nord' }),
      cssVariables: { '--ui-surface-app-bg': '#2E3440' },
    })
    configureThemePort(port)

    await startThemeSource()

    expect(calls.applied).toEqual([{ themeId: 'nord', mode: 'dark' }])
    const text = document.getElementById('onething-theme-vars')?.textContent ?? ''
    expect(text).toContain('--ui-surface-app-bg: #2E3440;')
    expect(text).not.toContain('#FAFAFA')
    expect(document.documentElement.getAttribute('data-color-mode')).toBe('dark')
    expect(themeProbe().source).toBe('core')
    expect(readSnapshot()?.themeId).toBe('nord')
  })

  it('推送抢在 pull 之前到达时也不被快照短路(applyIfChanged 的判据只认真 apply)', async () => {
    // 快照说的是 catppuccin/light;若 restore 去写了 lastDecision,下面这条设置推送
    // 就会被 applyIfChanged 判成「没变」而短路掉,屏幕上顶着一张陈旧的表。
    seedSnapshot({
      v: 1,
      themeId: 'catppuccin',
      mode: 'light',
      cssVariables: { '--ui-surface-app-bg': '#EFF1F5' },
    })
    restoreThemeSnapshot()

    const { port, calls, emitSettings, getSettingsCalls } = fakePort({
      settings: settings('dark', { darkThemeId: 'nord' }),
      holdSettings: true, // 开场那一趟挂着,只剩推送这一条路(见 fakePort 那一格)
    })
    configureThemePort(port)
    void startThemeSource()
    await vi.waitFor(() => expect(getSettingsCalls()).toBe(1)) // 订阅已就位

    emitSettings(settings('light', { lightThemeId: 'catppuccin' }))

    await vi.waitFor(() => expect(calls.applied).toHaveLength(1))
    expect(calls.applied[0]).toEqual({ themeId: 'catppuccin', mode: 'light' })
  })
})
