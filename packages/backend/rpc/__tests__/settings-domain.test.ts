/**
 * settings 域,端到端穿过 dispatcher(结构债 P4c 第十一批)。
 *
 * 接的是被删掉的三处转发的测试位:`apps/electron/src/settings/__tests__/ipc-host.test.ts`
 * 里那四条 handler 的用例、bridge 上那四条包装、server 的
 * `GET|POST /api/settings` + `POST /api/network/test-proxy` 三条路由(连同
 * `server/__tests__/http.test.ts` 里的 per-owner 用例)。值得钉的是:
 *  - 四个方法都在 router 的白名单上,**两条 C(开设置窗 / 原生对话框)不在**;
 *  - `saveSettings` 的副作用链顺序与迁移前逐字一致,而三件宿主能力走
 *    `configureSettingsHost` 的端口 —— 未注入即安静跳过;
 *  - 网关设置的套用走 `configureGatewayHost` 的 `applySettings` 那一格;
 *  - `SETTINGS_CHANGED` 走 `configureSettingsEventBroadcaster` 注入端口,并把
 *    宿主铸进 dispatch context 的 `callerId` 原样递成 `excludeCallerId`
 *    —— 发起保存的那扇窗不收自己的回声(回灌整份 settings 会冲掉它的草稿);
 *  - **http 分叉的两道真护栏**:出门脱敏(`transport:'http'` 才脱)、
 *    回来把哨兵合并回真值(于是「只改主题」不会洗掉 apiKey);
 *  - `getSystemTheme` 读的是宿主端口(未注入 = 浅色)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeWithDefaults } from '@shared/defaults/settings.js'
import type { AppSettings } from '@shared/ipc/settings.js'
import { SERVER_REDACTED_SECRET } from '../../server/mcp-secrets.js'
import { settingsRouter } from '@shared/ipc/settings.js'

const store = vi.hoisted(() => ({
  current: null as unknown as AppSettings,
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
}))

const ports = vi.hoisted(() => ({
  invalidateProviderCache: vi.fn(),
  startTodoPlanWatcher: vi.fn(async () => {}),
  getVoiceServiceSafe: vi.fn(() => undefined),
  updateMCPSettings: vi.fn(async () => {}),
  registerMCPTools: vi.fn(async () => {}),
  updateACPSettings: vi.fn(async () => {}),
  applyGatewaySettings: vi.fn(async () => {}),
}))

vi.mock('../../stores/settings.js', () => ({
  getSettings: () => store.getSettings(),
  saveSettings: (next: AppSettings) => store.saveSettings(next),
}))

vi.mock('../../wiring/providers/registry.js', () => ({
  invalidateProviderCache: ports.invalidateProviderCache,
}))

vi.mock('../../wiring/todo-plan/store.js', () => ({
  startTodoPlanWatcher: ports.startTodoPlanWatcher,
}))

vi.mock('../../wiring/voice/service.js', () => ({
  getVoiceServiceSafe: ports.getVoiceServiceSafe,
}))

vi.mock('@onething/runtime/mcp/index.wiring', () => ({
  MCPManager: { updateSettings: ports.updateMCPSettings },
  registerMCPTools: ports.registerMCPTools,
}))

vi.mock('@onething/runtime/acp', () => ({
  ACPManager: { updateSettings: ports.updateACPSettings },
}))

vi.mock('../../wiring/gateway/host-ports.js', () => ({
  getGatewayHost: () => ({ applySettings: ports.applyGatewaySettings }),
}))

async function loadDomain() {
  const [registry, domain, hostPorts, events] = await Promise.all([
    import('../registry.js'),
    import('../domains/settings.js'),
    import('../../wiring/settings/host-ports.js'),
    import('../../wiring/settings/events.js'),
  ])
  return { ...registry, ...domain, ...hostPorts, ...events }
}

function unwrap(response: { ok: boolean } & Record<string, unknown>) {
  expect(response.ok).toBe(true)
  return (response as { ok: true; data: unknown }).data as Record<string, any>
}

describe('settings RPC domain', () => {
  let dispose: (() => void) | undefined

  beforeEach(() => {
    store.current = mergeWithDefaults({ theme: 'dark' })
    store.current.ai.providers.openai.apiKey = 'sk-real-openai'
    store.getSettings.mockReset().mockImplementation(() => store.current)
    store.saveSettings.mockReset().mockImplementation((next: AppSettings) => {
      store.current = mergeWithDefaults(next as never)
    })
    for (const fn of Object.values(ports)) (fn as ReturnType<typeof vi.fn>).mockClear()
  })

  afterEach(async () => {
    dispose?.()
    dispose = undefined
    const { resetRpcRegistryForTests } = await import('../registry.js')
    resetRpcRegistryForTests()
    const { configureSettingsHost } = await import('../../wiring/settings/host-ports.js')
    configureSettingsHost({})
    const { configureSettingsEventBroadcaster } = await import('../../wiring/settings/events.js')
    configureSettingsEventBroadcaster(null)
    vi.resetModules()
  })

  it('serves the desktop settings verbatim and redacts only for http callers', async () => {
    const { dispatchRpc, registerRouterHandlers, settingsRpcHandlers } = await loadDomain()
    dispose = registerRouterHandlers(settingsRouter, settingsRpcHandlers)

    const desktop = unwrap(await dispatchRpc({ domain: 'settings', method: 'getSettings', payload: {} }))
    expect(desktop.success).toBe(true)
    expect(desktop.settings.ai.providers.openai.apiKey).toBe('sk-real-openai')

    const remote = unwrap(await dispatchRpc(
      { domain: 'settings', method: 'getSettings', payload: {} },
      { transport: 'http', ownerUid: 'alice', workspaceId: 'w', sandboxRoot: '/w' },
    ))
    expect(remote.settings.ai.providers.openai.apiKey).toBe(SERVER_REDACTED_SECRET)
    expect(JSON.stringify(remote.settings)).not.toContain('sk-real-openai')
  })

  it('runs the save side-effect chain and broadcasts the normalized settings', async () => {
    const {
      dispatchRpc,
      registerRouterHandlers,
      settingsRpcHandlers,
      configureSettingsHost,
      configureSettingsEventBroadcaster,
    } = await loadDomain()
    const applyNetworkProxySettings = vi.fn()
    const registerGlobalWindowShortcuts = vi.fn()
    configureSettingsHost({ applyNetworkProxySettings, registerGlobalWindowShortcuts })
    const broadcast = vi.fn()
    configureSettingsEventBroadcaster(broadcast)
    dispose = registerRouterHandlers(settingsRouter, settingsRpcHandlers)

    const next = mergeWithDefaults({ theme: 'light' })
    const result = unwrap(await dispatchRpc({
      domain: 'settings',
      method: 'saveSettings',
      payload: next,
    }))

    expect(result.success).toBe(true)
    expect(result.settings.theme).toBe('light')
    expect(store.saveSettings).toHaveBeenCalledTimes(1)
    expect(ports.invalidateProviderCache).toHaveBeenCalledTimes(1)
    expect(applyNetworkProxySettings).toHaveBeenCalledTimes(1)
    expect(registerGlobalWindowShortcuts).toHaveBeenCalledTimes(1)
    expect(ports.updateMCPSettings).toHaveBeenCalledTimes(1)
    expect(ports.registerMCPTools).toHaveBeenCalledTimes(1)
    expect(ports.updateACPSettings).toHaveBeenCalledTimes(1)
    expect(ports.applyGatewaySettings).toHaveBeenCalledWith(expect.objectContaining({ theme: 'light' }))
    expect(ports.startTodoPlanWatcher).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledWith({
      type: 'settings:changed',
      settings: expect.objectContaining({ theme: 'light' }),
      excludeCallerId: undefined,
    })
  })

  it('excludes the calling window from the settings broadcast', async () => {
    const { dispatchRpc, registerRouterHandlers, settingsRpcHandlers, configureSettingsEventBroadcaster } =
      await loadDomain()
    const broadcast = vi.fn()
    configureSettingsEventBroadcaster(broadcast)
    dispose = registerRouterHandlers(settingsRouter, settingsRpcHandlers)

    // 桌面壳(`@main/ipc/rpc.ts`)从 `event.sender.id` 铸进来的那一格。
    await dispatchRpc(
      { domain: 'settings', method: 'saveSettings', payload: mergeWithDefaults({ theme: 'light' }) },
      { transport: 'ipc', callerId: 42 },
    )

    expect(broadcast).toHaveBeenCalledWith({
      type: 'settings:changed',
      settings: expect.objectContaining({ theme: 'light' }),
      excludeCallerId: 42,
    })

    // http 没有窗可排除 —— 那一格缺席,广播照旧扇出到全部订阅者。
    broadcast.mockClear()
    await dispatchRpc(
      { domain: 'settings', method: 'saveSettings', payload: mergeWithDefaults({ theme: 'dark' }) },
      { transport: 'http', sandboxRoot: '/w' },
    )
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ excludeCallerId: undefined }),
    )
  })

  it('merges redacted secrets back before saving an http caller payload', async () => {
    const { dispatchRpc, registerRouterHandlers, settingsRpcHandlers } = await loadDomain()
    dispose = registerRouterHandlers(settingsRouter, settingsRpcHandlers)

    // 浏览器拿到的是脱敏那份;它只改主题就交回来。
    const sanitized = unwrap(await dispatchRpc(
      { domain: 'settings', method: 'getSettings', payload: {} },
      { transport: 'http', sandboxRoot: '/w' },
    )).settings
    sanitized.theme = 'light'

    const saved = unwrap(await dispatchRpc(
      { domain: 'settings', method: 'saveSettings', payload: sanitized },
      { transport: 'http', sandboxRoot: '/w' },
    ))

    expect(saved.settings.theme).toBe('light')
    // 出门仍然脱敏……
    expect(saved.settings.ai.providers.openai.apiKey).toBe(SERVER_REDACTED_SECRET)
    // ……但盘上那份是真值,没有被哨兵洗掉。
    expect(store.current.ai.providers.openai.apiKey).toBe('sk-real-openai')
  })

  it('reads the system theme from the host port and falls back to light', async () => {
    const { dispatchRpc, registerRouterHandlers, settingsRpcHandlers, configureSettingsHost } = await loadDomain()
    dispose = registerRouterHandlers(settingsRouter, settingsRpcHandlers)

    expect(unwrap(await dispatchRpc({ domain: 'settings', method: 'getSystemTheme', payload: {} })))
      .toEqual({ success: true, theme: 'light' })

    configureSettingsHost({ shouldUseDarkColors: () => true })
    expect(unwrap(await dispatchRpc({ domain: 'settings', method: 'getSystemTheme', payload: {} })))
      .toEqual({ success: true, theme: 'dark' })
  })

  it('rejects a disabled proxy without reaching the network', async () => {
    const { dispatchRpc, registerRouterHandlers, settingsRpcHandlers } = await loadDomain()
    dispose = registerRouterHandlers(settingsRouter, settingsRpcHandlers)

    expect(unwrap(await dispatchRpc({
      domain: 'settings',
      method: 'testProxy',
      payload: { proxy: { enabled: false, url: '' } },
    }))).toEqual({ success: false, error: 'Proxy is disabled.' })
  })

  it('refuses a method that is not on the router', async () => {
    const { dispatchRpc, registerRouterHandlers, settingsRpcHandlers } = await loadDomain()
    dispose = registerRouterHandlers(settingsRouter, settingsRpcHandlers)

    const response = await dispatchRpc({
      domain: 'settings',
      method: 'showOpenDialog',
      payload: {},
    })
    expect(response.ok).toBe(false)
  })
})
