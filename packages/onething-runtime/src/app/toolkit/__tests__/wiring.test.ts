/**
 * R2b —— 接线测试。
 *
 * 判据是**真链路**:调的是 `app/engine/stream/tool-execution.ts` 里那个
 * `executeToolDirectly`(每一次工具直调的唯一必经点,agent-loop / orchestrator /
 * sub-agent 三条路最后都收敛到它),开关翻开之后它应该走进新树,而返回的形状、
 * 四个回调收到的东西、权限拒绝与取消的形状**与旧路逐字相同** —— 那正是
 * "ipc-bridge 与 http.ts 不动"这句话的依据。
 *
 * 三处注入是有意的,每处都有独立测试兜着:
 *  · `enforcePermissionPolicy` —— 真权限核会去问人。批准/拒绝两路在这里由它切换,
 *    翻译成 `Decision` 的那一段由 `authorizer.test.ts` 钉着。
 *  · 两条插件拦截链 —— 链内部(逐 handler fail-closed、熔断、改写后的 zod 校验)
 *    有自己的测试;这里测的是 `Interceptor` 有没有把三态原样兑现。
 *  · MCP bridge —— 真 MCP 要连服务器。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BashOperations } from '@onething/runtime/tools/bash-executor'
import type { Step, ToolPartialResult } from '@shared/ipc.js'
import type { JsonObject } from '@shared/json.js'

const harness = vi.hoisted(() => {
  // hoisted 块跑在所有 import 之前(所以不能用上面那几个 import)。它只做一件事:
  // 把 store 根定下来 —— 审计要落进 `<store>/sessions/<id>/events.jsonl`,而那条
  // 路径在 import 期就可能被解析。目录本身在下面用真 fs 建。
  const tmp = process.env.TMPDIR?.replace(/\/$/, '') ?? '/tmp'
  const root = `${tmp}/toolkit-wiring-${process.pid}`
  process.env.ONETHING_STORE_PATH = root
  return {
    root,
    enforce: vi.fn(async () => undefined),
    callIntercept: vi.fn(async (context: { input: unknown }) => ({
      action: 'allow' as const,
      input: context.input,
      rewrittenBy: [] as string[],
      ran: 0,
    })),
    resultIntercept: vi.fn(async (context: { result: { content: string; isError: boolean } }) => ({
      action: 'keep' as const,
      result: context.result,
      rewrittenBy: [] as string[],
      ran: 0,
    })),
    mcpDefinitions: vi.fn(() => [] as Array<{ id: string; name: string; description: string; parameterSchema?: JsonObject }>),
    mcpExecute: vi.fn(async () => 'mcp said hi'),
  }
})

vi.mock('../../tools/core/permission-policy.js', () => ({
  enforcePermissionPolicy: harness.enforce,
}))

vi.mock('../../plugins/tool-call-intercept.js', () => ({
  runPluginToolCallIntercept: harness.callIntercept,
}))

vi.mock('../../plugins/tool-result-intercept.js', () => ({
  runPluginToolResultIntercept: harness.resultIntercept,
}))

vi.mock('../../mcp/index.js', () => ({
  isMCPTool: (id: string) => id.startsWith('mcp:'),
  executeMCPTool: harness.mcpExecute,
  resolveMCPServerIdForToolRef: () => 'server-1',
  getMCPToolDefinitionsForModel: harness.mcpDefinitions,
  getMCPRouterToolDefinition: () => null,
  parseMCPToolId: () => null,
  findMCPToolIdByShortName: () => null,
  MCPManager: { getServerState: () => null },
}))

const { configureToolkitCatalog } = await import('@onething/runtime/toolkit')
const { createDesktopCatalog } = await import('../catalog.js')
const { resetToolkitCatalogForTests } = await import('../wiring.js')
const { syncMcpToolsIntoCatalog, resetMcpCatalogSyncForTests } = await import('../mcp-catalog.js')
const { executeToolDirectly } = await import('../../engine/stream/tool-execution.js')

const SESSION_ID = 'wiring-session'
const workspace = path.join(harness.root, 'workspace')
fs.mkdirSync(workspace, { recursive: true })
fs.mkdirSync(path.join(harness.root, 'sessions', SESSION_ID), { recursive: true })

/** ops.exec 的两种假执行体:立刻收工,或者挂到信号响。 */
function echoOps(output = 'hello\n'): BashOperations {
  return {
    exec: async (_command: string, _cwd: string, options: { onData: (data: Buffer) => void }) => {
      options.onData(Buffer.from(output))
      return { exitCode: 0 }
    },
  }
}

function hangingOps(output = 'partial line\n'): BashOperations {
  return {
    exec: (_command: string, _cwd: string, options: { onData: (data: Buffer) => void; signal?: AbortSignal }) => {
      options.onData(Buffer.from(output))
      return new Promise<{ exitCode: number | null }>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          const error = new Error('The operation was aborted')
          error.name = 'AbortError'
          reject(error)
        })
      })
    },
  }
}

function installCatalog(ops: BashOperations = echoOps()) {
  const catalog = createDesktopCatalog({
    mutatingFile: {
      getFileMutationsDir: () => path.join(harness.root, 'file-mutations'),
      getDefaultWorkingDirectory: () => workspace,
    },
    read: { getDefaultWorkingDirectory: () => workspace },
    bash: {
      getDefaultWorkingDirectory: () => workspace,
      getToolOutputsDir: () => path.join(harness.root, 'tool-outputs'),
      createOperations: () => ops,
    },
  })
  configureToolkitCatalog(catalog)
  return catalog
}

interface Recorded {
  metadata: Array<{ title?: string; metadata?: JsonObject }>
  partial: ToolPartialResult[]
  steps: Step[]
  sideEffects: number
}

function contextFor(overrides: Partial<Parameters<typeof executeToolDirectly>[2]> = {}) {
  const recorded: Recorded = { metadata: [], partial: [], steps: [], sideEffects: 0 }
  const context = {
    sessionId: SESSION_ID,
    messageId: 'wiring-message',
    toolCallId: `call-${Math.random().toString(36).slice(2, 8)}`,
    workingDirectory: workspace,
    workingDirectoryRoots: [workspace],
    principal: { kind: 'user' as const, userId: 'local' },
    onMetadata: (update: { title?: string; metadata?: JsonObject }) => { recorded.metadata.push(update) },
    onPartialResult: (update: ToolPartialResult) => { recorded.partial.push(update) },
    onStepStart: (step: Step) => { recorded.steps.push(step) },
    onStepComplete: (step: Step) => { recorded.steps.push(step) },
    beforeSideEffect: async () => { recorded.sideEffects += 1 },
    ...overrides,
  }
  return { context: context as Parameters<typeof executeToolDirectly>[2], recorded }
}

beforeEach(() => {
  process.env.ONETHING_TOOLKIT = '1'
  harness.enforce.mockReset()
  harness.enforce.mockResolvedValue(undefined)
  harness.callIntercept.mockReset()
  harness.callIntercept.mockImplementation(async (context: { input: unknown }) => ({
    action: 'allow' as const, input: context.input, rewrittenBy: [], ran: 0,
  }))
  harness.resultIntercept.mockReset()
  harness.resultIntercept.mockImplementation(async (context: { result: { content: string; isError: boolean } }) => ({
    action: 'keep' as const, result: context.result, rewrittenBy: [], ran: 0,
  }))
  harness.mcpDefinitions.mockReset()
  harness.mcpDefinitions.mockReturnValue([])
  harness.mcpExecute.mockReset()
  harness.mcpExecute.mockResolvedValue('mcp said hi')
  resetMcpCatalogSyncForTests()
  installCatalog()
})

afterEach(() => {
  delete process.env.ONETHING_TOOLKIT
  resetToolkitCatalogForTests()
  vi.clearAllMocks()
})

afterAll(async () => {
  await fsp.rm(harness.root, { recursive: true, force: true })
})

describe('R2b 缝 2 + 缝 3:executeToolDirectly 走新树', () => {
  it('write / read / bash 的结果形状与回调与旧路同形', async () => {
    const write = contextFor()
    const written = await executeToolDirectly('write', { path: 'note.txt', content: 'hello\n' }, write.context)
    expect(written.success).toBe(true)
    expect(fs.readFileSync(path.join(workspace, 'note.txt'), 'utf-8')).toBe('hello\n')
    // 旧 `ToolResult` 的三件套:title / output / metadata —— 渲染器读的就是它们。
    const writeData = written.data as { title: string; output: string; metadata: JsonObject }
    expect(typeof writeData.title).toBe('string')
    expect(typeof writeData.output).toBe('string')
    expect(writeData.metadata).toBeTypeOf('object')
    // 缝 3:`annotate` 事件投影成 onMetadata。
    expect(write.recorded.metadata.length).toBeGreaterThan(0)

    const read = contextFor()
    const readResult = await executeToolDirectly('read', { path: 'note.txt' }, read.context)
    expect(readResult.success).toBe(true)
    expect((readResult.data as { output: string }).output).toContain('hello')

    const bash = contextFor()
    const bashResult = await executeToolDirectly('bash', { command: 'echo hello' }, bash.context)
    expect(bashResult.success).toBe(true)
    expect((bashResult.data as { output: string }).output).toContain('hello')
    // 流式输出走 `partial` 事件 → onPartialResult(形状恒等映射)。
    expect(bash.recorded.partial.length).toBeGreaterThan(0)
  }, 20_000)

  it('beforeSideEffect 只对会动手的工具触发(与旧路那三只逐字相同)', async () => {
    const read = contextFor()
    await executeToolDirectly('read', { path: 'note.txt' }, read.context)
    expect(read.recorded.sideEffects).toBe(0)

    const write = contextFor()
    await executeToolDirectly('write', { path: 'gate.txt', content: 'x\n' }, write.context)
    expect(write.recorded.sideEffects).toBe(1)
  }, 20_000)

  it('目录里没有的工具原样退回旧路(不吞掉调用)', async () => {
    const { context } = contextFor()
    // `getAllTools` 里没有 `definitely_not_a_tool`,旧路会回一条"未知工具"的错误
    // 结果 —— 这里要的是"没有崩、也没有被新树静默吃掉"。
    const result = await executeToolDirectly('definitely_not_a_tool', {}, context)
    expect(result.success).toBe(false)
  })
})

describe('R2b:权限的两路', () => {
  it('批准 → 成功;拒绝 → rejected + rejectionReason(一次,不拼两遍)', async () => {
    const approved = contextFor()
    const ok = await executeToolDirectly(
      'edit',
      { path: 'note.txt', edits: [{ oldText: 'hello', newText: 'world' }] },
      approved.context,
    )
    expect(ok.success).toBe(true)
    expect(harness.enforce).toHaveBeenCalledTimes(1)
    // 权限拿到的是 plan 报出来的效果 + 预览,不是工具名。
    const input = (harness.enforce.mock.calls as unknown as unknown[][])[0][0] as {
      toolName: string
      effects: Array<{ kind: string }>
      preview?: { title: string }
    }
    expect(input.toolName).toBe('edit')
    expect(input.effects.map(effect => effect.kind)).toContain('file_edit')
    expect(input.preview?.title).toBeTruthy()

    const rejection = Object.assign(new Error('Permission denied by user'), {
      name: 'PermissionRejectedError',
      reason: '别改这个文件',
    })
    harness.enforce.mockRejectedValueOnce(rejection)

    const denied = contextFor()
    const result = await executeToolDirectly(
      'edit',
      { path: 'note.txt', edits: [{ oldText: 'world', newText: 'nope' }] },
      denied.context,
    )
    expect(result.success).toBe(false)
    expect(result.rejected).toBe(true)
    expect(result.rejectionReason).toBe('别改这个文件')
    // 旧 registry 把理由拼两遍(`… Reason: X Reason: X`);新路只出一次。
    expect(result.error?.match(/别改这个文件/g)).toHaveLength(1)
    // 拒绝了就不该动手。
    expect(denied.recorded.sideEffects).toBe(0)
    expect(fs.readFileSync(path.join(workspace, 'note.txt'), 'utf-8')).toBe('world\n')
  }, 20_000)
})

describe('R2b:取消', () => {
  it('bash 跑到一半被掐 → aborted,已收到的输出进 <partial_output>', async () => {
    installCatalog(hangingOps())
    const controller = new AbortController()
    const { context } = contextFor({ abortSignal: controller.signal })
    const pending = executeToolDirectly('bash', { command: 'sleep 30' }, context)
    await new Promise(resolve => setTimeout(resolve, 60))
    controller.abort()

    const result = await pending
    expect(result.success).toBe(false)
    expect(result.aborted).toBe(true)
    expect(result.error).toContain('cancelled')
    expect(result.error).toContain('<partial_output>')
    expect(result.error).toContain('partial line')
  }, 20_000)
})

describe('R2b 缝 3:插件拦截的三态', () => {
  it('block → 一条普通的工具错误结果,工具没跑', async () => {
    harness.callIntercept.mockResolvedValueOnce({
      action: 'block',
      reason: 'plugin-x 挡下了这次调用',
      blockedBy: 'plugin-x',
      ran: 1,
    } as never)

    const { context } = contextFor()
    const result = await executeToolDirectly('write', { path: 'blocked.txt', content: 'x' }, context)
    expect(result.success).toBe(false)
    expect(result.error).toBe('plugin-x 挡下了这次调用')
    expect(result.rejected).toBeUndefined()
    expect(fs.existsSync(path.join(workspace, 'blocked.txt'))).toBe(false)
    // 挡下的调用不该先去打扰权限系统。
    expect(harness.enforce).not.toHaveBeenCalled()
  })

  it('rewrite → 跑的是改写后的参数', async () => {
    harness.callIntercept.mockResolvedValueOnce({
      action: 'allow',
      input: { path: 'rewritten.txt', content: 'from plugin\n' },
      rewrittenBy: ['plugin-x'],
      ran: 1,
    } as never)

    const { context } = contextFor()
    const result = await executeToolDirectly('write', { path: 'original.txt', content: 'from model' }, context)
    expect(result.success).toBe(true)
    expect(fs.existsSync(path.join(workspace, 'original.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(workspace, 'rewritten.txt'), 'utf-8')).toBe('from plugin\n')
  }, 20_000)

  it('结果改写链拿到的是工具真正产出的结果视图', async () => {
    const { context } = contextFor()
    await executeToolDirectly('read', { path: 'note.txt' }, context)
    expect(harness.resultIntercept).toHaveBeenCalledTimes(1)
    const view = ((harness.resultIntercept.mock.calls as unknown as unknown[][])[0][0] as {
      result: { content: string; isError: boolean }
    }).result
    expect(view.isError).toBe(false)
    expect(view.content).toContain('world')
  }, 20_000)
})

describe('R2b 缝 1 / MCP:目录里的 McpTool 跑同一条', () => {
  it('假 bridge 一条:同步进目录 → 执行 → 结果同形', async () => {
    harness.mcpDefinitions.mockReturnValue([{
      id: 'mcp:server-1:echo',
      name: 'echo',
      description: 'echo tool',
      parameterSchema: { type: 'object', properties: {}, required: [] },
    }])

    const { context } = contextFor()
    const result = await executeToolDirectly('mcp:server-1:echo', { text: 'hi' }, context)
    expect(result.success).toBe(true)
    expect((result.data as { output: string }).output).toBe('mcp said hi')
    expect(harness.mcpExecute).toHaveBeenCalledWith(
      'mcp:server-1:echo',
      { text: 'hi' },
      expect.anything(),
    )
    // mcp 是一条 `ask` 的效果 —— 它经过了权限闸,而不是绕过去。
    expect(harness.enforce).toHaveBeenCalledTimes(1)
  })

  it('服务器工具面缩回去时,目录里的那只被摘掉', async () => {
    const catalog = installCatalog()
    harness.mcpDefinitions.mockReturnValue([{ id: 'mcp:server-1:echo', name: 'echo', description: '' }])
    syncMcpToolsIntoCatalog(catalog)
    expect(catalog.has('mcp:server-1:echo')).toBe(true)

    harness.mcpDefinitions.mockReturnValue([])
    syncMcpToolsIntoCatalog(catalog)
    expect(catalog.has('mcp:server-1:echo')).toBe(false)
  })
})

describe('R2b:审计落进 events.jsonl', () => {
  it('每次调用一条 tool/audit,带效果类、授权结论与结局', async () => {
    const { context } = contextFor()
    await executeToolDirectly('read', { path: 'note.txt' }, context)

    const { flushSessionEventLog } = await import('../../session/event-log.js')
    await flushSessionEventLog(SESSION_ID)

    const lines = fs.readFileSync(
      path.join(harness.root, 'sessions', SESSION_ID, 'events.jsonl'),
      'utf-8',
    ).trim().split('\n')
    const audits = lines
      .map(line => JSON.parse(line) as { type: string; data: Record<string, unknown> })
      .filter(record => record.type === 'tool/audit')
    expect(audits.length).toBeGreaterThan(0)
    const last = audits[audits.length - 1].data
    expect(last.toolId).toBe('read')
    expect(last.effects).toEqual(['read'])
    expect(last.decision).toBe('allow')
    expect(last.outcome).toBe('ok')
  }, 20_000)
})

describe('R2b 缝 1:工具面由 Surface 解析', () => {
  it('Surface 投影出来的定义喂给 planAgentLoopTools,名字与目录一致', async () => {
    const { resolveToolkitSurface, toolkitAgentSourceTools } = await import('@onething/runtime/toolkit')
    const { planAgentLoopTools } = await import('@onething/core/engine')

    const surface = resolveToolkitSurface({
      session: { id: SESSION_ID, kind: 'chat', workingDirectory: workspace },
      enabledSkillNames: [],
      allowlist: null,
      toolSettings: { radio: { enabled: false } },
    })
    expect(surface).toBeDefined()

    const plan = planAgentLoopTools({
      toolLoadingEnabled: true,
      allEnabledTools: toolkitAgentSourceTools(surface!),
      mcpTools: [],
      allowedToolIds: null,
    })
    expect(plan.hasTools).toBe(true)
    // 场景门:普通对话看不见协作四件套,也看不见没有 active goal 的 goal。
    expect(plan.toolNames).toContain('read')
    expect(plan.toolNames).toContain('bash')
    expect(plan.toolNames).not.toContain('board')
    expect(plan.toolNames).not.toContain('goal')
    // 设置页关掉的工具根本不进面。
    expect(plan.toolNames).not.toContain('radio')
  })

  it('空白名单 = 不限制(旧路语义,归一门在接线处过一次)', async () => {
    const { resolveToolkitSurface } = await import('@onething/runtime/toolkit')
    const surface = resolveToolkitSurface({
      session: { id: SESSION_ID, kind: 'chat', workingDirectory: workspace },
      allowlist: [],
    })
    expect(surface!.tools().length).toBeGreaterThan(0)
  })
})
