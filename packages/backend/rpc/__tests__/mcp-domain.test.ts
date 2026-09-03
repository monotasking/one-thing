/**
 * mcp 域,端到端穿过 dispatcher(结构债 P4c 第六批)。
 *
 * 接的是被删掉的三处转发的测试位:`apps/electron/src/ipc/mcp.ts` 工厂的十六条用例、
 * `@main/ipc/mcp.ts` 的壳适配,以及 server 的九条 REST 路由 + 两个正则块 +
 * `mcp` facade adapter 背后那套 per-owner 的第二台 `HeadlessMCPManager`。
 *
 * 只桩**管家**(`@onething/runtime/mcp/index.wiring` 的 `MCPManager` 单例、
 * `registerMCPTools`、`probeMCPServerConfig`)与设置缓存,**投影不桩** ——
 * `*OnethingMCP*ForIpc` 是真跑的。
 *
 * 除了「域把端口接对了」,这里主要钉的是**四道护栏**(拍板 #20 的纪律:server 侧
 * 比桌面多的校验一条不放宽)。B2(`docs/design/backend-transport-forks-2026-09.md`
 * §2.2)之后四道分成两问 —— 1/2 问「payload 出不出进程」(还是 `transport`),
 * 3/4 问「调用方是不是本机可信」(`server/host-trust.ts`):
 *  1. 私密字段(command/args/env/cwd/url/headers)出界脱敏、进程内原样;
 *  2. 更新时把哨兵合并回磁盘上的真值 —— 「只改个名字」不会洗掉凭证;
 *  3. `readConfigFile` 在**不可信**宿主上不读本机文件;
 *  4. stdio 探测**只对桌面内嵌面**免闸(方案 §4 的保守裁定);其余宿主 —— 包括
 *     声明了可信的回环 `server:start` —— 仍旧 `ONETHING_SERVER_MCP_STDIO === '1'`
 *     才放行。「起本机子进程」比「读本机文件」重,所以它比 3 多一档。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { SERVER_REDACTED_SECRET } from '../../server/mcp-secrets.js'
import { mcpRouter } from '@shared/ipc/mcp.js'

const manager = vi.hoisted(() => ({
  getServerStates: vi.fn(() => [] as unknown[]),
  addServer: vi.fn(async (_config: unknown) => ({}) as unknown),
  updateServer: vi.fn(async (_config: unknown) => ({}) as unknown),
  removeServer: vi.fn(async (_serverId: string) => {}),
  connectServer: vi.fn(async (_serverId: string) => ({}) as unknown),
  disconnectServer: vi.fn(async (_serverId: string) => {}),
  refreshServer: vi.fn(async (_serverId: string) => ({}) as unknown),
  getServerState: vi.fn((_serverId: string) => undefined as unknown),
  getAllTools: vi.fn(() => [] as unknown[]),
  getAllResources: vi.fn(() => [] as unknown[]),
  getAllPrompts: vi.fn(() => [] as unknown[]),
  callTool: vi.fn(async () => ({ success: true, content: [] })),
  readResource: vi.fn(async () => ({ success: true, content: {} })),
  getPrompt: vi.fn(async () => ({ success: true, messages: [] })),
  updateSettings: vi.fn(async () => {}),
}))

const wiring = vi.hoisted(() => ({
  registerMCPTools: vi.fn(async () => {}),
  probeMCPServerConfig: vi.fn(async () => ({ ok: true })),
}))

const settings = vi.hoisted(() => ({
  getSettings: vi.fn(() => ({}) as Record<string, unknown>),
  saveSettings: vi.fn(async (_settings: Record<string, unknown>) => {}),
}))

vi.mock('@onething/runtime/mcp/index.wiring', () => ({
  MCPManager: manager,
  registerMCPTools: wiring.registerMCPTools,
  probeMCPServerConfig: wiring.probeMCPServerConfig,
}))
vi.mock('@onething/runtime/mcp/oauth/index', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMCPOAuthFlowManager: () => ({ logout: vi.fn(async () => {}) }),
}))
vi.mock('../../stores/settings.js', () => settings)

const HTTP_CONTEXT = { transport: 'http' as const, sandboxRoot: '/tmp/sandbox' }
const IPC_CONTEXT = { transport: 'ipc' as const }

const SECRET_SERVER = {
  id: 'server-1',
  name: 'Secret MCP',
  transport: 'sse' as const,
  enabled: true,
  url: 'https://mcp.example.test/sse?token=route-secret',
  headers: { Authorization: 'Bearer route-header' },
}

function stateOf(config: unknown) {
  return { config, status: 'disconnected', tools: [], resources: [], prompts: [] }
}

async function loadDomain() {
  const [
    { dispatchRpc, registerRouterHandlers, resetRpcRegistryForTests },
    { mcpRpcHandlers },
    { configureHostLocalTrust, resetHostLocalTrustForTests },
  ] = await Promise.all([
    import('../registry.js'),
    import('../domains/mcp.js'),
    import('../../server/host-trust.js'),
  ])
  // 可信是**进程级单槽**;这个文件每条用例都 `vi.resetModules()` 重装一次模块图,
  // 但清一次不花钱,也让"从未声明起跑"这条写在明面上。
  resetHostLocalTrustForTests()
  return {
    dispatchRpc,
    resetRpcRegistryForTests,
    registerRouterHandlers,
    mcpRpcHandlers,
    configureHostLocalTrust,
    resetHostLocalTrustForTests,
  }
}

describe('mcp RPC domain', () => {
  let dispose: (() => void) | undefined
  const previousStdioEnv = process.env.ONETHING_SERVER_MCP_STDIO

  beforeEach(() => {
    for (const fn of Object.values(manager)) fn.mockReset()
    manager.getServerStates.mockReturnValue([])
    manager.getAllTools.mockReturnValue([])
    manager.getAllResources.mockReturnValue([])
    manager.getAllPrompts.mockReturnValue([])
    manager.addServer.mockResolvedValue(stateOf(SECRET_SERVER))
    manager.updateServer.mockResolvedValue(stateOf(SECRET_SERVER))
    manager.connectServer.mockResolvedValue(stateOf(SECRET_SERVER))
    manager.refreshServer.mockResolvedValue(stateOf(SECRET_SERVER))
    manager.removeServer.mockResolvedValue(undefined)
    manager.disconnectServer.mockResolvedValue(undefined)
    manager.callTool.mockResolvedValue({ success: true, content: [] })
    manager.readResource.mockResolvedValue({ success: true, content: {} })
    manager.getPrompt.mockResolvedValue({ success: true, messages: [] })
    wiring.registerMCPTools.mockReset().mockResolvedValue(undefined)
    wiring.probeMCPServerConfig.mockReset().mockResolvedValue({ ok: true })
    settings.getSettings.mockReset().mockReturnValue({
      mcp: { enabled: true, servers: [SECRET_SERVER] },
    })
    settings.saveSettings.mockReset().mockResolvedValue(undefined)
    delete process.env.ONETHING_SERVER_MCP_STDIO
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
    if (previousStdioEnv === undefined) delete process.env.ONETHING_SERVER_MCP_STDIO
    else process.env.ONETHING_SERVER_MCP_STDIO = previousStdioEnv
    vi.resetModules()
  })

  it('exposes exactly the sixteen mcp methods and refuses anything else', async () => {
    const { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, mcpRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(mcpRouter, mcpRpcHandlers)

    const unknown = await dispatchRpc({ domain: 'mcp', method: 'startServer', payload: {} })
    expect(unknown.ok).toBe(false)
    expect(unknown.ok === false && unknown.error?.code).toBe('UNKNOWN_METHOD')

    for (const method of [
      'getServers',
      'addServer',
      'updateServer',
      'removeServer',
      'connectServer',
      'disconnectServer',
      'logoutServer',
      'probeServer',
      'refreshServer',
      'getTools',
      'callTool',
      'getResources',
      'readResource',
      'getPrompts',
      'getPrompt',
      'readConfigFile',
    ]) {
      const response = await dispatchRpc(
        {
          domain: 'mcp',
          method,
          payload: {
            serverId: SECRET_SERVER.id,
            config: SECRET_SERVER,
            toolName: 'echo',
            arguments: {},
            uri: 'mock://r',
            name: 'draft',
            filePath: '/nope.json',
          },
        },
        IPC_CONTEXT,
      )
      expect(response.ok, method).toBe(true)
    }
  })

  it('redacts private server fields for an http caller and leaves them alone on ipc', async () => {
    const { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, mcpRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(mcpRouter, mcpRpcHandlers)
    manager.getServerStates.mockReturnValue([stateOf(SECRET_SERVER)])

    const remote = await dispatchRpc({ domain: 'mcp', method: 'getServers', payload: {} }, HTTP_CONTEXT)
    expect(remote.ok).toBe(true)
    expect(JSON.stringify(remote)).not.toContain('route-secret')
    expect(JSON.stringify(remote)).not.toContain('route-header')
    const remoteData = remote.ok ? (remote.data as { servers: Array<{ config: Record<string, unknown> }> }) : undefined
    expect(remoteData?.servers[0].config.url).toBe(SERVER_REDACTED_SECRET)
    expect(remoteData?.servers[0].config.headers).toBe(SERVER_REDACTED_SECRET)

    const local = await dispatchRpc({ domain: 'mcp', method: 'getServers', payload: {} }, IPC_CONTEXT)
    const localData = local.ok ? (local.data as { servers: Array<{ config: Record<string, unknown> }> }) : undefined
    expect(localData?.servers[0].config.url).toBe(SECRET_SERVER.url)

    // 变更结果同样脱敏(add / connect / refresh / update 四条)。
    const connected = await dispatchRpc(
      { domain: 'mcp', method: 'connectServer', payload: { serverId: SECRET_SERVER.id } },
      HTTP_CONTEXT,
    )
    expect(JSON.stringify(connected)).not.toContain('route-secret')
  })

  it('merges the redaction sentinel back to the stored value on an http update', async () => {
    const { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, mcpRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(mcpRouter, mcpRpcHandlers)

    await dispatchRpc(
      {
        domain: 'mcp',
        method: 'updateServer',
        payload: {
          config: {
            ...SECRET_SERVER,
            name: 'Renamed',
            url: SERVER_REDACTED_SECRET,
            headers: SERVER_REDACTED_SECRET,
          },
        },
      },
      HTTP_CONTEXT,
    )

    const saved = settings.saveSettings.mock.calls[0][0] as unknown as {
      mcp: { servers: Array<Record<string, unknown>> }
    }
    expect(saved.mcp.servers[0].name).toBe('Renamed')
    // 凭证没有被那句「改个名字」洗掉。
    expect(saved.mcp.servers[0].url).toBe(SECRET_SERVER.url)
    expect(saved.mcp.servers[0].headers).toEqual(SECRET_SERVER.headers)
    expect(JSON.stringify(saved)).not.toContain(SERVER_REDACTED_SECRET)
  })

  it('refuses to read a local config file for an untrusted caller, reads it once trusted', async () => {
    const { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, mcpRpcHandlers, configureHostLocalTrust } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(mcpRouter, mcpRpcHandlers)

    // 未声明可信:两种 transport 都拿那句恒定的「不存在」,一个字节不读盘。
    for (const context of [HTTP_CONTEXT, IPC_CONTEXT]) {
      const refused = await dispatchRpc(
        { domain: 'mcp', method: 'readConfigFile', payload: { filePath: '/etc/hosts' } },
        context,
      )
      expect(refused.ok).toBe(true)
      expect(refused.ok && (refused.data as { success: boolean }).success).toBe(false)
    }

    // 声明可信之后**真的**去看盘,只是文件不在 —— 与上面那条恒定的「不存在」不同源;
    // 而且 http 与 ipc 逐字同一个答案(B2 的目的)。
    configureHostLocalTrust({ origin: 'desktop-embedded' })
    const overIpc = await dispatchRpc(
      { domain: 'mcp', method: 'readConfigFile', payload: { filePath: '/definitely/not/here.json' } },
      IPC_CONTEXT,
    )
    const overHttp = await dispatchRpc(
      { domain: 'mcp', method: 'readConfigFile', payload: { filePath: '/definitely/not/here.json' } },
      HTTP_CONTEXT,
    )
    expect(overIpc.ok).toBe(true)
    expect(overIpc.ok && (overIpc.data as { success: boolean }).success).toBe(false)
    expect(overHttp.ok && overHttp.data).toEqual(overIpc.ok && overIpc.data)
  })

  /**
   * 「替调用方起本机进程」的三态(方案 §4 的保守裁定:用户缺省 = 只给桌面内嵌面)。
   */
  it('opens the stdio probe only for the desktop-embedded face; loopback still needs the env opt-in', async () => {
    const { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, mcpRpcHandlers, configureHostLocalTrust, resetHostLocalTrustForTests } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(mcpRouter, mcpRpcHandlers)
    const stdioConfig = {
      id: 'stdio-1',
      name: 'Local',
      transport: 'stdio' as const,
      enabled: true,
      command: 'npx',
    }
    const probe = (context: typeof HTTP_CONTEXT | typeof IPC_CONTEXT) =>
      dispatchRpc({ domain: 'mcp', method: 'probeServer', payload: { config: stdioConfig } }, context)
    const REFUSED = {
      ok: false,
      error: 'MCP stdio transport is disabled in the web server runtime.',
    }

    // ① 未声明可信:两种 transport 都拒,一次都不起进程。
    for (const context of [HTTP_CONTEXT, IPC_CONTEXT]) {
      expect((await probe(context) as { ok: true; data: unknown }).data).toEqual(REFUSED)
    }
    expect(wiring.probeMCPServerConfig).not.toHaveBeenCalled()

    // ② 回环 server 声明了可信 —— 别的闸(读配置文件 / 文件树)对它开,这一道**仍然拒**。
    const restoreLoopback = configureHostLocalTrust({ origin: 'loopback-server', host: '127.0.0.1' })
    expect((await probe(HTTP_CONTEXT) as { ok: true; data: unknown }).data).toEqual(REFUSED)
    expect(wiring.probeMCPServerConfig).not.toHaveBeenCalled()

    // ③ 回环 + 环境变量显式开:放行(旧口径一格没动)。
    process.env.ONETHING_SERVER_MCP_STDIO = '1'
    await probe(HTTP_CONTEXT)
    expect(wiring.probeMCPServerConfig).toHaveBeenCalledTimes(1)
    delete process.env.ONETHING_SERVER_MCP_STDIO
    restoreLoopback()
    resetHostLocalTrustForTests()

    // ④ 桌面内嵌面:不看环境变量,直接放行,两种 transport 同权。
    configureHostLocalTrust({ origin: 'desktop-embedded' })
    await probe(HTTP_CONTEXT)
    await probe(IPC_CONTEXT)
    expect(wiring.probeMCPServerConfig).toHaveBeenCalledTimes(3)
  })

  it('routes capability reads at the live manager', async () => {
    const { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, mcpRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(mcpRouter, mcpRpcHandlers)
    manager.getAllTools.mockReturnValue([{ name: 'echo', serverId: 'server-1' }])

    const tools = await dispatchRpc({ domain: 'mcp', method: 'getTools', payload: {} }, IPC_CONTEXT)
    expect(tools.ok && tools.data).toEqual({
      success: true,
      tools: [{ name: 'echo', serverId: 'server-1' }],
    })

    await dispatchRpc(
      {
        domain: 'mcp',
        method: 'callTool',
        payload: { serverId: 'server-1', toolName: 'echo', arguments: { text: 'hi' } },
      },
      IPC_CONTEXT,
    )
    expect(manager.callTool).toHaveBeenCalledWith('server-1', 'echo', { text: 'hi' })
  })
})
