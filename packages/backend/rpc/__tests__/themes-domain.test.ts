/**
 * themes 域,端到端穿过 dispatcher(结构债 P4c 第七批)。
 *
 * 接的是被删掉的三处转发的测试位:`apps/electron/src/ipc/themes.ts` 的工厂
 * (连同它的 `__tests__/themes.test.ts`)、bridge 上那五条包装、server 的三条 REST
 * 路由 + `/api/themes/<id>[/apply]` 正则块。值得钉的是:
 *  - 五个方法都在 router 的白名单上,**本域零推送**(系统深浅色变化是设置域的
 *    `SYSTEM_THEME_CHANGED`,不是这条通道);
 *  - `apply` 现在在**域处理者**里拼插件主题覆盖:token 覆盖与皮肤档位是
 *    `applyTheme` 的**参数**(必须前移,派生层从它算),表面旋钮是**叠加**在
 *    成品 cssVariables 上;失败响应原样返回,不叠旋钮;
 *  - `openFolder` 走 `configureShellHost` 端口 —— 未注入宿主时拿到结构化失败
 *    (Electron 打开原语的约定:空串才算成功,非空串 = 失败原因)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { themesRouter } from '@shared/ipc/themes.js'

const themeRuntime = vi.hoisted(() => ({
  listThemes: vi.fn(),
  getTheme: vi.fn(),
  applyTheme: vi.fn(),
  refreshThemes: vi.fn(),
  openThemesFolder: vi.fn(),
}))

const shell = vi.hoisted(() => ({
  openPath: vi.fn(),
}))

const plugins = vi.hoisted(() => ({
  getPluginThemeOverrideTokenValues: vi.fn(),
  getPluginThemeKnobVariables: vi.fn(),
  getPluginSkinTiers: vi.fn(),
}))

vi.mock('@onething/runtime/themes/theme-runtime', () => ({
  defaultOnethingThemeRuntime: themeRuntime,
}))

vi.mock('@onething/runtime/shell/host-ports', () => ({
  getShellHost: () => shell,
}))

vi.mock('../../wiring/plugins/theme-overrides.js', () => ({
  getPluginThemeOverrideTokenValues: plugins.getPluginThemeOverrideTokenValues,
  getPluginThemeKnobVariables: plugins.getPluginThemeKnobVariables,
}))

vi.mock('../../wiring/plugins/skin.js', () => ({
  getPluginSkinTiers: plugins.getPluginSkinTiers,
}))

async function loadDomain() {
  const [{ dispatchRpc, registerRouterHandlers, resetRpcRegistryForTests }, { themesRpcHandlers }] =
    await Promise.all([import('../registry.js'), import('../domains/themes.js')])
  return { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, themesRpcHandlers }
}

describe('themes RPC domain', () => {
  let dispose: (() => void) | undefined

  beforeEach(async () => {
    themeRuntime.listThemes.mockReset().mockResolvedValue({ success: true, themes: [{ id: 'flexoki' }] })
    themeRuntime.getTheme.mockReset().mockResolvedValue({ success: true, theme: { id: 'flexoki' } })
    themeRuntime.applyTheme.mockReset().mockResolvedValue({ success: true, cssVariables: { '--bg': '#fff' } })
    themeRuntime.refreshThemes.mockReset().mockResolvedValue({ success: true, themes: [] })
    // 真投影会把「非空串」折成失败;这里直接用真行为的两种结果做替身。
    themeRuntime.openThemesFolder.mockReset().mockImplementation(async (open: (p: string) => Promise<string>) => {
      const result = await open('/store/themes')
      return typeof result === 'string' && result.trim().length > 0
        ? { success: false, error: result }
        : { success: true }
    })
    shell.openPath.mockReset().mockResolvedValue('')
    plugins.getPluginThemeOverrideTokenValues.mockReset().mockReturnValue({})
    plugins.getPluginThemeKnobVariables.mockReset().mockReturnValue({})
    plugins.getPluginSkinTiers.mockReset().mockReturnValue({})

    const { resetRpcRegistryForTests, registerRouterHandlers, themesRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(themesRouter, themesRpcHandlers)
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  it('binds the five methods and nothing else — the domain has no push face', async () => {
    const { dispatchRpc } = await loadDomain()

    for (const method of ['getAll', 'get', 'apply', 'refresh', 'openFolder']) {
      const response = await dispatchRpc({
        domain: 'themes',
        method,
        payload: { themeId: 'flexoki', mode: 'dark' },
      })
      expect(response.ok, `${method} should dispatch`).toBe(true)
    }

    await expect(dispatchRpc({ domain: 'themes', method: 'onSystemThemeChanged', payload: {} }))
      .resolves.toMatchObject({ ok: false })
  })

  it('getAll and get forward straight to the theme runtime', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(dispatchRpc({ domain: 'themes', method: 'getAll', payload: {} }))
      .resolves.toEqual({ ok: true, data: { success: true, themes: [{ id: 'flexoki' }] } })

    await expect(dispatchRpc({ domain: 'themes', method: 'get', payload: { themeId: 'flexoki' } }))
      .resolves.toEqual({ ok: true, data: { success: true, theme: { id: 'flexoki' } } })
    expect(themeRuntime.getTheme).toHaveBeenCalledWith('flexoki')
  })

  it('apply passes plugin token overrides and skin tiers as arguments, and layers the knobs on top', async () => {
    plugins.getPluginThemeOverrideTokenValues.mockReturnValue({ 'colors.primary': '#ff0000' })
    plugins.getPluginSkinTiers.mockReturnValue({ '--skin-grain': 'strong' })
    plugins.getPluginThemeKnobVariables.mockReturnValue({ '--ot-blur': '18px' })

    const { dispatchRpc } = await loadDomain()
    const response = await dispatchRpc({
      domain: 'themes',
      method: 'apply',
      payload: { themeId: 'flexoki', mode: 'light' },
    })

    // 前移:覆盖与档位是 applyTheme 的第三、第四个参数(派生层要从它们重新算)。
    expect(themeRuntime.applyTheme).toHaveBeenCalledWith(
      'flexoki',
      'light',
      { 'colors.primary': '#ff0000' },
      { '--skin-grain': 'strong' },
    )
    // 叠加:旋钮没有任何东西从它派生,所以叠在成品之上。
    expect(response).toEqual({
      ok: true,
      data: { success: true, cssVariables: { '--bg': '#fff', '--ot-blur': '18px' } },
    })
  })

  it('apply returns a failed response untouched — no knobs layered onto a failure', async () => {
    themeRuntime.applyTheme.mockResolvedValue({ success: false, error: 'Theme not found: nope' })
    plugins.getPluginThemeKnobVariables.mockReturnValue({ '--ot-blur': '18px' })

    const { dispatchRpc } = await loadDomain()
    await expect(dispatchRpc({
      domain: 'themes',
      method: 'apply',
      payload: { themeId: 'nope', mode: 'dark' },
    })).resolves.toEqual({ ok: true, data: { success: false, error: 'Theme not found: nope' } })
  })

  it('openFolder goes through the shell host port and degrades structurally when it is not wired', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(dispatchRpc({ domain: 'themes', method: 'openFolder', payload: {} }))
      .resolves.toEqual({ ok: true, data: { success: true } })
    expect(shell.openPath).toHaveBeenCalledWith('/store/themes')

    // 未注入宿主 = 门面回那句统一原因串,投影据此折成失败结果。
    shell.openPath.mockResolvedValue('shell host not available')
    await expect(dispatchRpc({ domain: 'themes', method: 'openFolder', payload: {} }))
      .resolves.toEqual({ ok: true, data: { success: false, error: 'shell host not available' } })
  })

  it('refresh forwards the optional project path', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(dispatchRpc({ domain: 'themes', method: 'refresh', payload: { projectPath: '/workspace' } }))
      .resolves.toEqual({ ok: true, data: { success: true, themes: [] } })
    expect(themeRuntime.refreshThemes).toHaveBeenCalledWith('/workspace')

    await dispatchRpc({ domain: 'themes', method: 'refresh', payload: {} })
    expect(themeRuntime.refreshThemes).toHaveBeenLastCalledWith(undefined)
  })
})
