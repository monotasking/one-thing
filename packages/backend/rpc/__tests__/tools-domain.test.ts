/**
 * tools 域,端到端穿过 dispatcher(结构债 P4c 第九批)。
 *
 * 接的是被删掉的三处转发的测试位:`apps/electron/src/ipc/tools.ts` 的工厂(连同
 * `__tests__/tools.test.ts`)、`@main/ipc/tools.ts` 的壳适配、bridge 上那六条包装、
 * server 的六条 REST 路由 + `tools` facade adapter。
 *
 * 本域最要紧的判据是 **#19 的安全面**:同一份实现要给出两种语义。B2
 * (`docs/design/backend-transport-forks-2026-09.md` §2.2)之前这两种语义钉在
 * `transport` 上;现在钉在 `isHostLocallyTrusted()`(`server/host-trust.ts`)上,
 * 因为那才是它在问的事 —— 桌面内嵌 HTTP 面与回环 `server:start` 服务的是本机
 * 同一个人的同一个 store。
 *  - **本机可信**(桌面 IPC / 声明过的 HTTP 面)直跑 runner,与迁移前 `@main`
 *    handler 逐字同义;
 *  - **不可信**执行面三道闸(白名单只有 `read` / 会话必须存在 / 路径夹进会话
 *    沙箱),文案逐字沿用旧 server adapter;
 *  - `backgroundJobsList` 在不可信宿主上恒空表、`backgroundJobsStop` 与
 *    `updateToolCall` 按原话拒绝;
 *  - `cancelTool` 两边**同一个答案**(旧 adapter 也是空操作)。
 *
 * 每条用例因此按「声明了没有」分组:声明过 → http 与 ipc 逐字同一个答案;
 * 没声明 → http 与 B2 之前逐字相同。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcDispatchContext, RpcResponse } from '@shared/ipc/rpc.js'
import { toolsRouter } from '@shared/ipc/tools.js'

const store = vi.hoisted(() => ({
  getSession: vi.fn((_id: string): unknown => undefined),
  updateMessageToolCalls: vi.fn(),
  updateMessageStep: vi.fn(),
}))
const toolkit = vi.hoisted(() => ({
  runToolkitToolDirectly: vi.fn(async (): Promise<unknown> => ({ success: true, data: 'ran' })),
  toolkitCatalogToolDefinitions: vi.fn((): unknown[] => []),
}))
const jobs = vi.hoisted(() => ({
  listBackgroundJobs: vi.fn((): unknown[] => []),
  stopBackgroundJob: vi.fn(async () => true),
}))

vi.mock('../../store.js', () => store)
vi.mock('../../wiring/toolkit/index.js', () => toolkit)
vi.mock('@onething/runtime/tools/background-jobs-bound', () => jobs)
vi.mock('@onething/runtime/mcp/index.wiring', () => ({
  getMCPToolDefinitionsForModel: () => [],
}))

const IPC: RpcDispatchContext = { transport: 'ipc' }

function http(sandboxRoot = '/sandbox/alice/w1'): RpcDispatchContext {
  return { transport: 'http', ownerUid: 'local-user', workspaceId: 'default', sandboxRoot }
}

function unwrap(response: RpcResponse): Record<string, unknown> {
  if (!response.ok) throw new Error(`dispatch failed: ${response.error.message}`)
  return response.data as Record<string, unknown>
}

describe('tools RPC domain', () => {
  let dispatchRpc: typeof import('../registry.js')['dispatchRpc']
  let configureHostLocalTrust: typeof import('../../server/host-trust.js')['configureHostLocalTrust']
  let resetHostLocalTrustForTests: typeof import('../../server/host-trust.js')['resetHostLocalTrustForTests']
  let dispose: (() => void) | undefined

  beforeEach(async () => {
    const [registry, domain, trust] = await Promise.all([
      import('../registry.js'),
      import('../domains/tools.js'),
      import('../../server/host-trust.js'),
    ])
    dispatchRpc = registry.dispatchRpc
    configureHostLocalTrust = trust.configureHostLocalTrust
    resetHostLocalTrustForTests = trust.resetHostLocalTrustForTests
    // 可信是**进程级单槽**:每条用例从"未声明 + 无强制开关"起跑。
    resetHostLocalTrustForTests()
    delete process.env.ONETHING_SERVER_FILES_SANDBOX
    registry.resetRpcRegistryForTests()
    dispose = registry.registerRouterHandlers(toolsRouter, domain.toolsRpcHandlers)
    store.getSession.mockReset().mockReturnValue(undefined)
    store.updateMessageToolCalls.mockReset()
    store.updateMessageStep.mockReset()
    toolkit.runToolkitToolDirectly
      .mockReset()
      .mockResolvedValue({ success: true, data: 'ran' } as never)
    toolkit.toolkitCatalogToolDefinitions.mockReset().mockReturnValue([])
    jobs.listBackgroundJobs.mockReset().mockReturnValue([])
    jobs.stopBackgroundJob.mockReset().mockResolvedValue(true)
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
    resetHostLocalTrustForTests()
    delete process.env.ONETHING_SERVER_FILES_SANDBOX
    vi.restoreAllMocks()
  })

  const call = (method: string, payload: unknown, context: RpcDispatchContext) =>
    dispatchRpc({ domain: 'tools', method, payload }, context)

  it('lists the catalog projection on both transports', async () => {
    toolkit.toolkitCatalogToolDefinitions.mockReturnValue([
      { id: 'read', name: 'read', description: '', parameters: [], enabled: true, autoExecute: true, category: 'builtin' },
    ])

    for (const context of [IPC, http()]) {
      const data = unwrap(await call('getTools', {}, context))
      expect(data.success).toBe(true)
      expect((data.tools as Array<{ id: string }>).map(tool => tool.id)).toEqual(['read'])
    }
  })

  it('runs the tool directly on a locally trusted host (unconfined, no whitelist)', async () => {
    configureHostLocalTrust({ origin: 'desktop-embedded' })
    store.getSession.mockReturnValue({ id: 's1', workingDirectory: '/anywhere' })

    const data = unwrap(
      await call(
        'executeTool',
        { toolId: 'bash', arguments: { command: 'pwd' }, messageId: 'm1', sessionId: 's1' },
        IPC,
      ),
    )
    expect(data.success).toBe(true)
    expect(toolkit.runToolkitToolDirectly).toHaveBeenCalledWith(
      'bash',
      { command: 'pwd' },
      expect.objectContaining({ sessionId: 's1', messageId: 'm1' }),
    )
  })

  it('refuses every non-read tool on an untrusted host, with the old server wording', async () => {
    store.getSession.mockReturnValue({ id: 's1', workingDirectory: '/sandbox/alice/w1' })

    const data = unwrap(
      await call(
        'executeTool',
        { toolId: 'bash', arguments: { command: 'pwd' }, messageId: 'm1', sessionId: 's1' },
        http(),
      ),
    )
    expect(data).toEqual({
      success: false,
      error: 'Tool execution for "bash" is disabled in the web server runtime.',
    })
    expect(toolkit.runToolkitToolDirectly).not.toHaveBeenCalled()
  })

  it('refuses an unknown session on an untrusted host before touching the runner', async () => {
    const data = unwrap(
      await call(
        'executeTool',
        { toolId: 'read', arguments: { path: 'a.txt' }, messageId: 'm1', sessionId: 'ghost' },
        http(),
      ),
    )
    expect(data).toEqual({ success: false, error: 'Session not found' })
    expect(toolkit.runToolkitToolDirectly).not.toHaveBeenCalled()
  })

  it('clamps read paths into the session sandbox when untrusted, and lets inside paths through', async () => {
    store.getSession.mockReturnValue({ id: 's1', workingDirectory: '/sandbox/alice/w1/project' })

    const escaped = unwrap(
      await call(
        'executeTool',
        { toolId: 'read', arguments: { path: '/etc/passwd' }, messageId: 'm1', sessionId: 's1' },
        http(),
      ),
    )
    expect(escaped).toEqual({
      success: false,
      error: 'Tool "read" can only access paths inside the session workspace.',
    })
    expect(toolkit.runToolkitToolDirectly).not.toHaveBeenCalled()

    const inside = unwrap(
      await call(
        'executeTool',
        { toolId: 'read', arguments: { path: 'notes.md' }, messageId: 'm1', sessionId: 's1' },
        http(),
      ),
    )
    expect(inside.success).toBe(true)
    expect(toolkit.runToolkitToolDirectly).toHaveBeenCalledTimes(1)
  })

  it('answers cancelTool identically on both transports (the old adapter was a no-op too)', async () => {
    // 工单 4 B1:真取消是一次可感知的行为变化,已回旧;这里钉的是「两边同一个答案」。
    for (const context of [IPC, http()]) {
      expect(unwrap(await call('cancelTool', { toolCallId: 't1' }, context))).toEqual({
        success: true,
      })
    }
  })

  it('reports a real background-job table when trusted and an empty one when not', async () => {
    jobs.listBackgroundJobs.mockReturnValue([{ id: 'job-1' }])

    configureHostLocalTrust({ origin: 'desktop-embedded' })
    expect(unwrap(await call('backgroundJobsList', { includeInactive: true }, IPC))).toEqual({
      success: true,
      jobs: [{ id: 'job-1' }],
    })
    expect(jobs.listBackgroundJobs).toHaveBeenCalledWith({ includeInactive: true })

    resetHostLocalTrustForTests()
    expect(unwrap(await call('backgroundJobsList', {}, http()))).toEqual({
      success: true,
      jobs: [],
    })
  })

  it('stops a job when trusted and refuses when not, with the old server wording', async () => {
    configureHostLocalTrust({ origin: 'desktop-embedded' })
    jobs.listBackgroundJobs.mockReturnValue([{ id: 'job-1', sessionId: 'session-1' }])
    expect(unwrap(await call('backgroundJobsStop', { jobId: 'job-1' }, IPC))).toEqual({
      success: true,
    })
    expect(jobs.stopBackgroundJob).toHaveBeenCalledWith('job-1')

    resetHostLocalTrustForTests()
    expect(unwrap(await call('backgroundJobsStop', { jobId: 'job-1' }, http()))).toEqual({
      success: false,
      error: 'Background jobs are not available in the web server runtime.',
    })
  })

  it('answers "already finished" for an unknown job id instead of "session not found"', async () => {
    // 工单 4 C1:登记簿里没有这个 id 是**常事**(任务刚跑完就点了停),不是越权。
    configureHostLocalTrust({ origin: 'desktop-embedded' })
    jobs.listBackgroundJobs.mockReturnValue([])
    expect(unwrap(await call('backgroundJobsStop', { jobId: 'gone' }, IPC))).toEqual({
      success: false,
      error: 'That background job has already finished.',
    })
    expect(jobs.stopBackgroundJob).not.toHaveBeenCalled()
  })

  it('refuses tool-call writes when untrusted with the old server wording, and never touches the store', async () => {
    const data = unwrap(
      await call(
        'updateToolCall',
        { sessionId: 's1', messageId: 'm1', toolCallId: 't1', updates: { status: 'cancelled' } },
        http(),
      ),
    )
    expect(data).toEqual({
      success: false,
      error: 'Tool call updates are not available in the web server runtime yet.',
    })
    expect(store.updateMessageToolCalls).not.toHaveBeenCalled()
  })

  it('B2: a trusted http caller gets the very same four answers as ipc', async () => {
    configureHostLocalTrust({ origin: 'desktop-embedded' })
    store.getSession.mockReturnValue({ id: 's1', workingDirectory: '/anywhere', messages: [] })
    jobs.listBackgroundJobs.mockReturnValue([{ id: 'job-1' }])

    // 1) 执行面:白名单那道闸不再拦(桌面内嵌面 = 用户自己那台机器)。
    const run = unwrap(await call(
      'executeTool',
      { toolId: 'bash', arguments: { command: 'pwd' }, messageId: 'm1', sessionId: 's1' },
      http(),
    ))
    expect(run.success).toBe(true)
    expect(toolkit.runToolkitToolDirectly).toHaveBeenCalledWith(
      'bash', { command: 'pwd' }, expect.objectContaining({ sessionId: 's1' }),
    )

    // 2) 后台任务表:真表,与 ipc 逐字相同。
    expect(unwrap(await call('backgroundJobsList', { includeInactive: true }, http())))
      .toEqual(unwrap(await call('backgroundJobsList', { includeInactive: true }, IPC)))

    // 3) 停止:真停。
    expect(unwrap(await call('backgroundJobsStop', { jobId: 'job-1' }, http())))
      .toEqual({ success: true })

    // 4) 工具调用更新:走到投影(找不到那条消息是投影自己的答案),不再是那句拒绝。
    const overHttp = unwrap(await call(
      'updateToolCall',
      { sessionId: 's1', messageId: 'm1', toolCallId: 't1', updates: { status: 'cancelled' } },
      http(),
    ))
    const overIpc = unwrap(await call(
      'updateToolCall',
      { sessionId: 's1', messageId: 'm1', toolCallId: 't1', updates: { status: 'cancelled' } },
      IPC,
    ))
    expect(overHttp).toEqual(overIpc)
    expect(overHttp.error).not.toBe('Tool call updates are not available in the web server runtime yet.')
  })

  it('B2: ONETHING_SERVER_FILES_SANDBOX=1 puts the gates back even on a trusted host', async () => {
    configureHostLocalTrust({ origin: 'desktop-embedded' })
    process.env.ONETHING_SERVER_FILES_SANDBOX = '1'
    store.getSession.mockReturnValue({ id: 's1', workingDirectory: '/sandbox/alice/w1' })

    expect(unwrap(await call(
      'executeTool',
      { toolId: 'bash', arguments: { command: 'pwd' }, messageId: 'm1', sessionId: 's1' },
      http(),
    ))).toEqual({
      success: false,
      error: 'Tool execution for "bash" is disabled in the web server runtime.',
    })
    expect(toolkit.runToolkitToolDirectly).not.toHaveBeenCalled()
  })

  it('keeps every method on the router allowlist and rejects anything else', async () => {
    const response = await dispatchRpc(
      { domain: 'tools', method: 'deleteEverything', payload: {} },
      IPC,
    )
    expect(response.ok).toBe(false)
  })
})
// Adapter fixtures explicitly belong to the local operator on both transports.
vi.mock('../../session/access.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../session/access.js')>()
  return { ...actual, sessionAccess: actual.createSessionAccess({ findMeta: () => ({}) }) }
})
