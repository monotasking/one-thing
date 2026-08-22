/**
 * tools 域,端到端穿过 dispatcher(结构债 P4c 第九批)。
 *
 * 接的是被删掉的三处转发的测试位:`apps/electron/src/ipc/tools.ts` 的工厂(连同
 * `__tests__/tools.test.ts`)、`@main/ipc/tools.ts` 的壳适配、bridge 上那六条包装、
 * server 的六条 REST 路由 + `tools` facade adapter。
 *
 * 本域最要紧的判据是 **#19 的安全面**:同一份实现要给出两种语义。
 *  - `transport:'ipc'`(桌面)直跑 runner,与迁移前 `@main` handler 逐字同义;
 *  - `transport:'http'` 执行面三道闸(白名单只有 `read` / 会话必须存在 / 路径夹进
 *    会话沙箱),文案逐字沿用旧 server adapter;
 *  - `backgroundJobsList` 在 http 上恒空表、`backgroundJobsStop` 与 `updateToolCall`
 *    在 http 上按原话拒绝;
 *  - `cancelTool` 两条传输面**同一个答案**(旧 adapter 也是空操作)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcDispatchContext, RpcResponse } from '@shared/ipc/rpc.js'

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
  return { transport: 'http', ownerUid: 'alice', workspaceId: 'w1', sandboxRoot }
}

function unwrap(response: RpcResponse): Record<string, unknown> {
  if (!response.ok) throw new Error(`dispatch failed: ${response.error.message}`)
  return response.data as Record<string, unknown>
}

describe('tools RPC domain', () => {
  let dispatchRpc: typeof import('../registry.js')['dispatchRpc']
  let dispose: (() => void) | undefined

  beforeEach(async () => {
    const [registry, domain] = await Promise.all([
      import('../registry.js'),
      import('../domains/tools.js'),
    ])
    dispatchRpc = registry.dispatchRpc
    registry.resetRpcRegistryForTests()
    dispose = domain.registerToolsRpcDomain()
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

  it('runs the tool directly on desktop (ipc is unconfined, no whitelist)', async () => {
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

  it('refuses every non-read tool over http, with the old server wording', async () => {
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

  it('refuses an unknown session over http before touching the runner', async () => {
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

  it('clamps read paths into the session sandbox over http, and lets inside paths through', async () => {
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
    for (const context of [IPC, http()]) {
      expect(unwrap(await call('cancelTool', { toolCallId: 't1' }, context))).toEqual({
        success: true,
      })
    }
  })

  it('reports a real background-job table on ipc and an empty one on http', async () => {
    jobs.listBackgroundJobs.mockReturnValue([{ id: 'job-1' }])

    expect(unwrap(await call('backgroundJobsList', { includeInactive: true }, IPC))).toEqual({
      success: true,
      jobs: [{ id: 'job-1' }],
    })
    expect(jobs.listBackgroundJobs).toHaveBeenCalledWith({ includeInactive: true })

    expect(unwrap(await call('backgroundJobsList', {}, http()))).toEqual({
      success: true,
      jobs: [],
    })
  })

  it('stops a job on ipc and refuses over http with the old server wording', async () => {
    expect(unwrap(await call('backgroundJobsStop', { jobId: 'job-1' }, IPC))).toEqual({
      success: true,
    })
    expect(jobs.stopBackgroundJob).toHaveBeenCalledWith('job-1')

    expect(unwrap(await call('backgroundJobsStop', { jobId: 'job-1' }, http()))).toEqual({
      success: false,
      error: 'Background jobs are not available in the web server runtime.',
    })
  })

  it('refuses tool-call writes over http with the old server wording, and never touches the store', async () => {
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

  it('keeps every method on the router allowlist and rejects anything else', async () => {
    const response = await dispatchRpc(
      { domain: 'tools', method: 'deleteEverything', payload: {} },
      IPC,
    )
    expect(response.ok).toBe(false)
  })
})
