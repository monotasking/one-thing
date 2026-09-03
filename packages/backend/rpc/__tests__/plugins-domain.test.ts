/**
 * plugins 域,端到端穿过 dispatcher(结构债 P4 终态批 C2)。
 *
 * 接的是被删掉的两处转发的测试位:`apps/electron/src/ipc/plugins.ts` 那只可移植
 * 工厂(与它的 `__tests__/plugins.test.ts`)和 `@main/ipc/plugins.ts` 的十九条壳
 * 适配。值得钉的是:
 *
 *  - **ipc 分支**落到同一批 `*ForIpc` 投影上,参数解包逐字沿用旧壳适配;
 *  - **http 的六条读/开关面**走 `server/plugin-catalog.ts` 那个单槽端口 ——
 *    也就是从前 `/api/plugins*` 六条 REST 背后的同一批闭包;
 *  - **http 的 `configGet`** 从那份清单投影里就地派生只读值(逐字搬自迁移前
 *    `platform/web.ts`);
 *  - **http 的写面**按「插件管理器在不在场」判定:缺席时回**逐字相同**的降级
 *    文案,在场时(桌面内嵌 HTTP 面)走与 ipc 同一条路;
 *  - **`pickFile` 未注入宿主 = 结构化降级**,不是抛错也不是 `canceled`;
 *  - **`request` 的进度按 `callerId` 定向回送**(设置窗是独立 BrowserWindow,
 *    广播出去等于每扇窗都收一份别人的进度)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcDispatchContext, RpcResponse } from '@shared/ipc/rpc.js'
import { pluginsRouter } from '@shared/ipc/plugins.js'

const IPC: RpcDispatchContext = { transport: 'ipc', callerId: 7 }
const HTTP: RpcDispatchContext = {
  transport: 'http',
  ownerUid: 'alice',
  workspaceId: 'w1',
  sandboxRoot: '/sandbox/alice/w1',
}

const manager = {
  getPlugins: vi.fn(() => [] as unknown[]),
  enablePlugin: vi.fn(async () => {}),
  disablePlugin: vi.fn(async () => {}),
  refreshPlugins: vi.fn(async () => {}),
  getPluginCommands: vi.fn(() => new Map<string, unknown>()),
  getCommandHandler: vi.fn(() => undefined),
  uninstallPlugin: vi.fn(async () => ({ success: true, archivePath: '/archive' })),
  installPlugin: vi.fn(async () => ({ success: true, pluginId: 'demo' })),
  updatePlugin: vi.fn(async () => ({ success: true, pluginId: 'demo', version: '2.0.0' })),
  checkPluginUpdates: vi.fn(async () => [{ pluginId: 'demo', current: '1.0.0', latest: '2.0.0' }]),
  handleRequest: vi.fn(async (_input: unknown) => ({ success: true, requestId: 'r-1', result: 'ok' })),
  abortRequest: vi.fn(() => true),
  getRequestActions: vi.fn(() => [] as string[]),
}

const mocks = vi.hoisted(() => ({
  currentManager: { value: null as unknown },
  configAccess: {
    describe: vi.fn(() => ({
      declared: true,
      supported: true,
      title: 'Demo',
      fields: [],
      unsupportedReasons: [],
    })),
    read: vi.fn(() => ({ retentionDays: 7 })),
    write: vi.fn(() => ({ success: true, config: { retentionDays: 1 } })),
  },
  readPluginTarballSummary: vi.fn(() => ({ success: true, summary: { path: '/x.tgz' } })),
  probePluginNpmAvailability: vi.fn(async () => true),
  getPluginMarketIndexSnapshot: vi.fn(async () => ({ index: null, fetchedAt: null, stale: false })),
  getPluginFootprint: vi.fn(() => ({
    pluginId: 'demo',
    dataDir: '/data/demo',
    dataDirExists: true,
    entries: ['kv.json'],
    legacyKvExists: false,
    settingsKeys: [],
  })),
  executePluginCommandOnHost: vi.fn(async () => ({ success: true, message: 'ran' })),
}))

vi.mock('../../wiring/plugins/index.js', () => ({
  getPluginManager: () => mocks.currentManager.value,
}))
vi.mock('../../wiring/plugins/background.js', () => ({
  getPluginBackgroundParams: () => undefined,
}))
vi.mock('../../wiring/plugins/install.js', () => ({
  getPluginMarketIndexSnapshot: mocks.getPluginMarketIndexSnapshot,
  probePluginNpmAvailability: mocks.probePluginNpmAvailability,
}))
vi.mock('../../wiring/plugins/loader.js', () => ({
  getPluginFootprint: mocks.getPluginFootprint,
}))
vi.mock('../../wiring/plugins/commands.js', () => ({
  executePluginCommandOnHost: mocks.executePluginCommandOnHost,
}))
vi.mock('@onething/runtime/plugins/config-access', () => ({
  createPluginConfigAccess: () => mocks.configAccess,
}))
vi.mock('@onething/runtime/plugins/tarball.wiring', () => ({
  readPluginTarballSummary: mocks.readPluginTarballSummary,
}))
vi.mock('@onething/runtime/plugins/app-version', () => ({
  getPluginAppVersion: () => '1.0.0',
}))
vi.mock('@onething/runtime/plugins/health', () => ({
  clearPluginRuntimeHealth: vi.fn(),
}))

function unwrap(response: RpcResponse): Record<string, unknown> {
  // 读 `data` 之前先看 `ok` —— 失败的信封里没有 `data`。
  if (!response.ok) throw new Error(`dispatch failed: ${response.error.message}`)
  return response.data as Record<string, unknown>
}

/** server 那本只读镜像目录的替身:六格,与真端口同形。 */
const catalog = {
  list: vi.fn(async () => ({
    success: true,
    plugins: [{
      id: 'note-skills',
      name: 'Note skills',
      enabled: true,
      configTitle: 'Notes',
      configFields: [{ key: 'root', control: 'text', label: 'Root', required: false, defaultValue: '' }],
      configValues: { root: '/notes' },
      configUnsupportedReasons: [],
    }],
  })),
  enable: vi.fn(async () => ({ success: true })),
  disable: vi.fn(async () => ({ success: true })),
  refresh: vi.fn(async () => ({ success: true })),
  commands: vi.fn(async () => ({ success: true, commands: [] })),
  executeCommand: vi.fn(async () => ({ success: true, message: 'server ran' })),
}

describe('plugins RPC domain', () => {
  let dispatchRpc: typeof import('../registry.js')['dispatchRpc']
  let dispose: (() => void) | undefined
  let restoreCatalog: (() => void) | undefined
  let configurePluginsHost: typeof import('../../wiring/plugins/host-ports.js')['configurePluginsHost']
  let configureProgress: typeof import('../../wiring/plugins/events.js')['configurePluginRequestProgressBroadcaster']

  const call = (method: string, payload: unknown, context: RpcDispatchContext) =>
    dispatchRpc({ domain: 'plugins', method, payload }, context)

  beforeEach(async () => {
    const [registry, domain, hostPorts, events, catalogPort] = await Promise.all([
      import('../registry.js'),
      import('../domains/plugins.js'),
      import('../../wiring/plugins/host-ports.js'),
      import('../../wiring/plugins/events.js'),
      import('../../server/plugin-catalog.js'),
    ])
    dispatchRpc = registry.dispatchRpc
    registry.resetRpcRegistryForTests()
    dispose = registry.registerRouterHandlers(pluginsRouter, domain.pluginsRpcHandlers)
    configurePluginsHost = hostPorts.configurePluginsHost
    configureProgress = events.configurePluginRequestProgressBroadcaster
    configurePluginsHost({})
    configureProgress(null)
    restoreCatalog = catalogPort.configureServerPluginCatalogPort(null)
    mocks.currentManager.value = manager
    for (const fn of Object.values(manager)) fn.mockClear?.()
    for (const fn of Object.values(catalog)) fn.mockClear()
    mocks.executePluginCommandOnHost.mockClear()
    mocks.configAccess.write.mockClear()
    mocks.readPluginTarballSummary.mockClear()
  })

  afterEach(() => {
    dispose?.()
    restoreCatalog?.()
    configurePluginsHost({})
    configureProgress(null)
  })

  // ── ipc 分支 ────────────────────────────────────────────────
  it('ipc:目录 / 启停 / 刷新落到同一批投影上', async () => {
    expect(unwrap(await call('list', {}, IPC))).toMatchObject({ success: true, plugins: [] })
    expect(unwrap(await call('enable', { pluginId: 'demo' }, IPC))).toEqual({ success: true })
    expect(manager.enablePlugin).toHaveBeenCalledWith('demo')
    expect(unwrap(await call('disable', { pluginId: 'demo' }, IPC))).toEqual({ success: true })
    expect(manager.disablePlugin).toHaveBeenCalledWith('demo')
    expect(unwrap(await call('refresh', {}, IPC))).toEqual({ success: true })
    expect(manager.refreshPlugins).toHaveBeenCalled()
  })

  it('ipc:命令执行走装配层那份接线(与网关共用同一条路)', async () => {
    expect(unwrap(await call('executeCommand', {
      commandName: '/demo',
      args: '--fast',
      sessionId: 's1',
    }, IPC))).toEqual({ success: true, message: 'ran' })
    expect(mocks.executePluginCommandOnHost).toHaveBeenCalledWith({
      commandName: '/demo',
      args: '--fast',
      sessionId: 's1',
    })
  })

  it('ipc:npm 生命周期四条 + 预读 + 足迹逐条转调', async () => {
    expect(unwrap(await call('install', { pkg: 'demo', path: '/x.tgz' }, IPC)))
      .toEqual({ success: true, pluginId: 'demo' })
    expect(manager.installPlugin).toHaveBeenCalledWith({
      pkg: 'demo',
      tarballUrl: undefined,
      path: '/x.tgz',
      integrity: undefined,
    })
    expect(unwrap(await call('update', { pluginId: 'demo' }, IPC)))
      .toMatchObject({ success: true, version: '2.0.0' })
    expect(unwrap(await call('checkUpdates', {}, IPC)))
      .toMatchObject({ success: true, offers: [{ pluginId: 'demo' }] })
    expect(unwrap(await call('lifecycleInfo', {}, IPC)))
      .toEqual({ success: true, npmAvailable: true })
    expect(unwrap(await call('readTarball', { path: '/x.tgz' }, IPC)))
      .toMatchObject({ success: true })
    expect(mocks.readPluginTarballSummary).toHaveBeenCalledWith('/x.tgz')
    expect(unwrap(await call('footprint', { pluginId: 'demo' }, IPC)))
      .toMatchObject({ success: true, footprint: { pluginId: 'demo' } })
    expect(unwrap(await call('uninstall', { pluginId: 'demo' }, IPC)))
      .toMatchObject({ success: true, archivePath: '/archive' })
  })

  it('ipc:配置读写不碰插件代码', async () => {
    expect(unwrap(await call('configGet', { pluginId: 'demo' }, IPC)))
      .toMatchObject({ success: true, declared: true, editable: true, config: { retentionDays: 7 } })
    expect(unwrap(await call('configSet', { pluginId: 'demo', config: { retentionDays: 1 } }, IPC)))
      .toMatchObject({ success: true })
    expect(mocks.configAccess.write).toHaveBeenCalledWith('demo', { retentionDays: 1 })
  })

  /**
   * 进度必须**定向**回送给发起这次调用的窗口 —— 这一格是 `callerId`,
   * 由宿主铸进 dispatch context,域只负责原样递过去。
   */
  it('ipc:统一请求通道把进度按 callerId 递给注入的广播器', async () => {
    const sent: Array<[unknown, unknown]> = []
    configureProgress((progress, callerId) => { sent.push([progress, callerId]) })
    manager.handleRequest.mockImplementationOnce(async (input: unknown) => {
      const options = input as { onProgress?: (payload: unknown) => void }
      options.onProgress?.({ requestId: 'r-1', pluginId: 'demo', action: 'go', payload: 1 })
      return { success: true, requestId: 'r-1', result: 'ok' }
    })

    expect(unwrap(await call('request', { pluginId: 'demo', action: 'go' }, IPC)))
      .toMatchObject({ success: true, requestId: 'r-1' })
    expect(sent).toEqual([[
      { requestId: 'r-1', pluginId: 'demo', action: 'go', payload: 1 },
      7,
    ]])

    expect(unwrap(await call('requestAbort', { requestId: 'r-1' }, IPC)))
      .toEqual({ success: true, aborted: true })
    expect(manager.abortRequest).toHaveBeenCalledWith('r-1')
  })

  it('pickFile:未注入宿主 = 结构化降级,文案逐字沿用迁移前的硬桩', async () => {
    expect(unwrap(await call('pickFile', { pluginId: 'demo' }, IPC))).toEqual({
      error: 'Importing files into a plugin works on the desktop app only.',
    })
  })

  it('pickFile:注入之后把 callerId 一起递给宿主', async () => {
    const pickFile = vi.fn(async () => ({ path: 'storage:demo/a.png', name: 'a.png', size: 1 }))
    configurePluginsHost({ pickFile })
    expect(unwrap(await call('pickFile', { pluginId: 'demo', accept: ['png'] }, IPC)))
      .toMatchObject({ path: 'storage:demo/a.png' })
    expect(pickFile).toHaveBeenCalledWith({ pluginId: 'demo', accept: ['png'] }, 7)
  })

  // ── 管理器不在场:退到 server 那本只读镜像目录 ────────────────
  //
  // B1(方案 `docs/design/backend-transport-forks-2026-09.md` §2.2):这一组从前
  // 钉在 `transport === 'http'` 上,于是**装着真管理器的桌面内嵌 HTTP 面也走镜像**
  // (审计 2026-09-02 §2.5 的脑裂)。现在判据只有一个 —— 这个进程装没装管理器。
  describe('无管理器(独立 server / React 壳):七条读面退到镜像目录', () => {
    beforeEach(async () => {
      const catalogPort = await import('../../server/plugin-catalog.js')
      restoreCatalog?.()
      restoreCatalog = catalogPort.configureServerPluginCatalogPort(catalog)
      mocks.currentManager.value = null
    })

    it('list / enable / disable / refresh / commands / executeCommand 全走端口', async () => {
      expect(unwrap(await call('list', {}, HTTP))).toMatchObject({ success: true })
      expect(catalog.list).toHaveBeenCalledWith({ userId: 'alice', workspaceId: 'w1' })
      await call('enable', { pluginId: 'note-skills' }, HTTP)
      expect(catalog.enable).toHaveBeenCalledWith('note-skills', { userId: 'alice', workspaceId: 'w1' })
      await call('disable', { pluginId: 'note-skills' }, HTTP)
      expect(catalog.disable).toHaveBeenCalled()
      await call('refresh', {}, HTTP)
      expect(catalog.refresh).toHaveBeenCalled()
      await call('commands', {}, HTTP)
      expect(catalog.commands).toHaveBeenCalled()
      expect(unwrap(await call('executeCommand', {
        commandName: '/demo',
        sessionId: 's1',
      }, HTTP))).toEqual({ success: true, message: 'server ran' })
      // 桌面那条接线一次都没被走到。
      expect(mocks.executePluginCommandOnHost).not.toHaveBeenCalled()
      expect(manager.getPlugins).not.toHaveBeenCalled()
    })

    it('configGet 从清单投影里就地派生只读值', async () => {
      expect(unwrap(await call('configGet', { pluginId: 'note-skills' }, HTTP))).toMatchObject({
        success: true,
        declared: true,
        title: 'Notes',
        config: { root: '/notes' },
        editable: false,
        readOnlyReason: 'Plugin configuration is editable on the desktop host only.',
      })
    })

    it('configGet 对不认识的插件照实说,而不是装作配置是空的', async () => {
      expect(unwrap(await call('configGet', { pluginId: 'ghost' }, HTTP))).toEqual({
        success: false,
        error: 'Unknown plugin "ghost"',
      })
    })
  })

  // B1 的正题:同一条 http 请求,管理器在位就读自己那棵真树。
  describe('管理器在场 + http:读面读管理器,不读镜像(B1 修脑裂)', () => {
    beforeEach(async () => {
      const catalogPort = await import('../../server/plugin-catalog.js')
      restoreCatalog?.()
      // 端口也装着 —— 桌面内嵌 HTTP 面就是这个处境(两样都有)。
      restoreCatalog = catalogPort.configureServerPluginCatalogPort(catalog)
      mocks.currentManager.value = manager
    })

    it('list / enable / commands 走管理器那条路,镜像目录一次都不问', async () => {
      expect(unwrap(await call('list', {}, HTTP))).toMatchObject({ success: true, plugins: [] })
      expect(manager.getPlugins).toHaveBeenCalled()
      expect(unwrap(await call('enable', { pluginId: 'demo' }, HTTP))).toEqual({ success: true })
      expect(manager.enablePlugin).toHaveBeenCalledWith('demo')
      await call('commands', {}, HTTP)
      for (const fn of Object.values(catalog)) expect(fn).not.toHaveBeenCalled()
    })

    /**
     * C0 R4(方案 `docs/design/backend-principal-and-mcp-lifecycle-2026-09.md` §1.3)。
     *
     * `configGet` 是七条读面里唯一一条从前**没有** HTTP 侧断言的:它的镜像半边被
     * 上面那个 describe 钉着,管理器在位这一半却是裸的 —— 而这一半才是有意行为的
     * 那一半(方案 §4 拍板 3:owner 用 HTTP 客户端管插件,交出的是**真配置**且
     * `editable:true`,与 IPC 逐字同一批答案;插件配置没有密钥概念,与设置域的
     * 出界脱敏不是一回事)。
     *
     * 三条判据:真配置(不是投影里那份派生值)、可编辑、镜像目录一次都没问。
     * 反证(实跑过):把 `configGet` 里的 `pluginCatalogFallback()` 换成
     * `getServerPluginCatalogPort()`(即回到 B1 之前"http 就读镜像"的口径)→
     * 这三条一起红。
     */
    it('C0 R4:configGet 交出真配置且可编辑,不经镜像端口', async () => {
      expect(unwrap(await call('configGet', { pluginId: 'demo' }, HTTP))).toMatchObject({
        success: true,
        declared: true,
        editable: true,
        config: { retentionDays: 7 },
      })
      // 只读那条路会带上 `readOnlyReason` —— 管理器在位时不该出现。
      expect(unwrap(await call('configGet', { pluginId: 'demo' }, HTTP)))
        .not.toHaveProperty('readOnlyReason')
      for (const fn of Object.values(catalog)) expect(fn).not.toHaveBeenCalled()
    })
  })

  describe('两者都无:读面与 ipc 上管理器缺席时逐字同一批答案', () => {
    beforeEach(async () => {
      const catalogPort = await import('../../server/plugin-catalog.js')
      restoreCatalog?.()
      restoreCatalog = catalogPort.configureServerPluginCatalogPort(null)
      mocks.currentManager.value = null
    })

    it('http 与 ipc 给出同一个答案 —— 判据里已经没有 transport 了', async () => {
      const overHttp = unwrap(await call('list', {}, HTTP))
      const overIpc = unwrap(await call('list', {}, IPC))
      expect(overHttp).toEqual(overIpc)
      const commandsHttp = unwrap(await call('commands', {}, HTTP))
      expect(commandsHttp).toEqual(unwrap(await call('commands', {}, IPC)))
    })
  })

  describe('写面按「插件管理器在不在场」判定(B1 去掉了 `http &&` 那半个条件)', () => {
    it('管理器缺席(独立 server)= 逐字相同的降级文案', async () => {
      mocks.currentManager.value = null
      expect(unwrap(await call('install', { pkg: 'demo' }, HTTP)))
        .toEqual({ success: false, error: 'Plugins are installed on the desktop host only.' })
      expect(unwrap(await call('update', { pluginId: 'demo' }, HTTP)))
        .toEqual({ success: false, pluginId: '', error: 'Plugins are updated on the desktop host only.' })
      expect(unwrap(await call('uninstall', { pluginId: 'demo' }, HTTP))).toEqual({
        success: false,
        error: 'Plugins are installed and uninstalled on the desktop host only; this server mirrors the plugin catalog read-only.',
      })
      expect(unwrap(await call('configSet', { pluginId: 'demo', config: {} }, HTTP))).toEqual({
        success: false,
        error: 'Plugin configuration is editable on the desktop host only; this server mirrors the plugin catalog read-only.',
      })
      expect(unwrap(await call('footprint', { pluginId: 'demo' }, HTTP)))
        .toEqual({ success: false, error: 'Plugin data lives on the desktop host only.' })
      expect(unwrap(await call('readTarball', { path: '/x.tgz' }, HTTP))).toEqual({
        success: false,
        errorCode: 'not-supported',
        error: 'Plugin tarballs are inspected on the desktop host only.',
      })
      expect(unwrap(await call('market', {}, HTTP))).toEqual({
        success: false,
        entries: [],
        fetchedAt: null,
        stale: false,
        error: 'Plugin market is unavailable in the web host',
      })
      expect(unwrap(await call('checkUpdates', {}, HTTP))).toEqual({ success: true, offers: [] })
      expect(unwrap(await call('lifecycleInfo', {}, HTTP)))
        .toEqual({ success: true, npmAvailable: false })
      expect(unwrap(await call('requestAbort', { requestId: 'r-1' }, HTTP)))
        .toEqual({ success: false, aborted: false, error: 'Plugins execute on the desktop host only' })
      // 那条 501 的正文,逐字保留 —— 结构化形状,不再是 HTTP 状态码。
      expect(unwrap(await call('request', { pluginId: 'demo', action: 'go', requestId: 'r-9' }, HTTP)))
        .toEqual({
          success: false,
          requestId: 'r-9',
          error: 'Plugins execute on the desktop host only; this server mirrors the plugin catalog read-only.',
        })
      // 一条都不许落到管理器上。
      expect(manager.installPlugin).not.toHaveBeenCalled()
      expect(manager.handleRequest).not.toHaveBeenCalled()
    })

    it('管理器在场(桌面内嵌 HTTP 面)= 与 ipc 同一条路', async () => {
      expect(unwrap(await call('install', { pkg: 'demo' }, HTTP)))
        .toEqual({ success: true, pluginId: 'demo' })
      expect(manager.installPlugin).toHaveBeenCalled()
    })
  })
})
