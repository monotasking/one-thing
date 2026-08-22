// @vitest-environment happy-dom
/**
 * B 期(L2)生效/撤除时机:插件目录一变,主题就重推。
 *
 * renderer 完全不知道"覆盖"这件事 —— 合成在主进程做,这里只钉住
 * **重拉这一步存在且只挂一次**:少了它,用户开关插件要重启才变色;
 * 挂多次的话开关一次会打 N 遍 IPC。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

function installLocalStorage() {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)) },
    removeItem: (key: string) => { values.delete(key) },
    clear: () => { values.clear() },
  })
}

const applyTheme = vi.fn(async () => ({
  success: true,
  cssVariables: { '--color-primary': '#ff0000' },
}))

// P4c 第七批:themes 走通用 RPC 域客户端;`@/platform` 上只剩 settings store 要的几条。
vi.mock('@/platform/themes-client', () => ({
  themesApi: {
    getAll: vi.fn(async () => ({ success: true, themes: [] })),
    apply: (...args: unknown[]) => applyTheme(...(args as [])),
  },
}))

vi.mock('@/platform', () => ({
  platformApi: {
    // settings store 在 setup 期就挂系统主题监听 —— 主题 store 会连带把它建起来。
    onSystemThemeChanged: vi.fn(() => () => {}),
    getSystemTheme: vi.fn(async () => ({ success: true, theme: 'dark' })),
    getSettings: vi.fn(async () => ({ success: false })),
    saveSettings: vi.fn(async () => ({ success: true })),
  },
}))

describe('主题 store:插件目录变化触发重推', () => {
  beforeEach(() => {
    vi.resetModules()
    applyTheme.mockClear()
    setActivePinia(createPinia())
    installLocalStorage()
    document.documentElement.style.cssText = ''
  })

  it('plugins-changed 后重新拉当前主题(且重复 initialize 不会重复挂监听)', async () => {
    const { useThemeStore } = await import('../themes')
    const store = useThemeStore()
    // 主窗/设置窗各建一次、设置变更后重跑 —— initialize 被调多次是常态。
    await store.initialize()
    await store.initialize()
    applyTheme.mockClear()

    window.dispatchEvent(new CustomEvent('onething:plugins-changed'))
    await new Promise(resolve => setTimeout(resolve, 0))

    // 挂了两遍就会是 2:一次开关打两遍 IPC。
    expect(applyTheme).toHaveBeenCalledTimes(1)
    expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe('#ff0000')
  })
})
