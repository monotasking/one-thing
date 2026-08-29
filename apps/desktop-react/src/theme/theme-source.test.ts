import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '@shared/ipc/settings'
import { configureThemePort, type ThemePort } from './theme-port'
import {
  applyThemeVariables,
  decideTheme,
  refreshThemeFromSettings,
  resetThemeSourceForTest,
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
}): { port: ThemePort; calls: PortCalls; emitSystemTheme: (t: 'light' | 'dark') => void } {
  const calls: PortCalls = { applied: [] }
  let listener: ((t: 'light' | 'dark') => void) | undefined
  const port: ThemePort = {
    ready: options.ready ?? (async () => undefined),
    getSettings: async () => ({ success: true, settings: options.settings ?? settings('system') }),
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
  }
  return { port, calls, emitSystemTheme: (t) => listener?.(t) }
}

afterEach(() => {
  resetThemeSourceForTest()
  configureThemePort(undefined)
  vi.restoreAllMocks()
})

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
