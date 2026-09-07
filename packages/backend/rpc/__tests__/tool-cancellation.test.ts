/**
 * 取消一次在跑的工具调用 —— **今天它的入口是 `ToolExecutionRegistry.cancel`,
 * 不是 `tools.cancelTool` 那条 RPC**(工单 4 B1)。
 *
 * `tools.cancelTool` 是个空操作(记一行日志恒回 success),那是 08-18 判例下的
 * 默认口径:把一个从前什么都不做的按钮改成真会中断执行,是用户可感知的行为变化,
 * 要用户点头。等它点头之后,这条 RPC 重新接到下面这个 `cancel()` 调的同一个方法上,
 * 这份用例一行不用改。注册表本身连同它的授权规则**已经在树上**,所以这里照旧验它。
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Catalog, textResult } from '@onething/core/toolkit'
import { ScriptedTool } from '../../../core/toolkit/__tests__/fakes.js'
import type { RpcDispatchContext } from '@shared/ipc/rpc.js'
import { toolsRouter } from '@shared/ipc/tools.js'

vi.mock('@onething/runtime/plugins/tool-call-intercept-bound', () => ({
  runPluginToolCallIntercept: async (context: { input: unknown }) => ({ action: 'allow', input: context.input, rewrittenBy: [], ran: 0 }),
}))
vi.mock('@onething/runtime/plugins/tool-result-intercept-bound', () => ({
  runPluginToolResultIntercept: vi.fn(async (context: { result: unknown }) => ({ action: 'keep', result: context.result, rewrittenBy: [], ran: 0 })),
}))
vi.mock('../../wiring/tools/core/permission-policy.js', () => ({ enforcePermissionPolicy: async () => undefined }))

function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

const alice = { userId: 'alice', workspaceId: 'one' }
const bob = { userId: 'bob', workspaceId: 'one' }
const aliceHttp: RpcDispatchContext = { transport: 'http', ownerUid: 'alice', workspaceId: 'one' }
const bobHttp: RpcDispatchContext = { transport: 'http', ownerUid: 'bob', workspaceId: 'one' }
let directory: string
let previous: string | undefined
let fixture: Awaited<ReturnType<typeof import('../../session/testing/store-layer.js')['installStoreSessionLayerForTest']>>
let registry: typeof import('../registry.js')
let current: typeof import('../../current.js')
let wiring: typeof import('../../wiring/toolkit/wiring.js')
let catalog: Catalog
const cleanups: Array<() => void> = []

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-cancellation-'))
  previous = process.env.ONETHING_STORE_PATH
  process.env.ONETHING_STORE_PATH = directory
  const { installStoreSessionLayerForTest } = await import('../../session/testing/store-layer.js')
  fixture = await installStoreSessionLayerForTest()
  const store = await import('../../stores/sessions.js')
  store.createSession('alice-session', 'Alice', { initialOwner: alice })
  store.createSession('alice-second', 'Alice second', { initialOwner: alice })
  store.createSession('bob-session', 'Bob', { initialOwner: bob })
  wiring = await import('../../wiring/toolkit/wiring.js')
  wiring.resetToolkitCatalogForTests()
  catalog = new Catalog()
  const { configureToolkitCatalog } = await import('@onething/runtime/toolkit')
  configureToolkitCatalog(catalog)
  current = await import('../../current.js')
  registry = await import('../registry.js')
  registry.resetRpcRegistryForTests()
  const { toolsRpcHandlers } = await import('../domains/tools.js')
  cleanups.push(registry.registerRouterHandlers(toolsRouter, toolsRpcHandlers))
  // 这只 hook 第一次跑要把整棵 toolkit / 会话层 transform 一遍(实测约 10s,
  // 正好压在 vitest 默认 hook 预算线上)。给它自己的预算,免得这个文件按机器忙闲
  // 随机红 —— 红的会是编译时间,不是被测的取消语义。
}, 60_000)

afterEach(async () => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  await fixture?.dispose()
  wiring?.resetToolkitCatalogForTests()
  const { resetHostLocalTrustForTests } = await import('../../server/host-trust.js')
  resetHostLocalTrustForTests()
  if (previous === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previous
  await fs.rm(directory, { recursive: true, force: true })
})

function executions() {
  return current.getCurrentBackend('toolExecutions').toolExecutions
}

function holdingTool(id: string) {
  const started = barrier()
  const release = barrier()
  const aborted = vi.fn()
  const ended = vi.fn()
  cleanups.push(release.release)
  catalog.register(new ScriptedTool({
    id,
    apply: async (_intent, ctx) => {
      ctx.abort.onAbort(aborted)
      started.release()
      await release.promise
      ended()
      return textResult('finished')
    },
  }))
  return { started: started.promise, release: release.release, aborted, ended }
}

function run(toolId: string, callId: string, sessionId = 'alice-session', owner = alice, signal?: AbortSignal) {
  return wiring.runToolkitToolDirectly(toolId, {}, {
    sessionId, toolCallId: callId, messageId: 'message', executionContext: owner,
    principal: { kind: 'user', userId: 'forged-principal' }, abortSignal: signal,
  })
}

/**
 * 请求里那两格 `ownerUid` / `executionContext` 是**伪造的**,故意留着:身份只认
 * 第二个参数(宿主鉴过权之后盖的章),请求体说什么都不算。
 */
function cancel(toolCallId: string, context = aliceHttp, sessionId?: string) {
  return executions().cancel({
    toolCallId, sessionId, ownerUid: 'bob', executionContext: bob,
  } as never, context)
}

it('cancels only the authorized call and waits for actual work after the runner abort race', async () => {
  const first = holdingTool('first')
  const second = holdingTool('second')
  const parent = new AbortController()
  const running = run('first', 'call-first', 'alice-session', alice, parent.signal)
  const other = run('second', 'call-second', 'alice-session', alice, parent.signal)
  await Promise.all([first.started, second.started])
  let cancelled = false
  const cancellation = cancel('call-first').then(result => { cancelled = true; return result })
  await expect(running).resolves.toMatchObject({ success: false, aborted: true })
  expect(first.aborted).toHaveBeenCalledOnce()
  expect(first.ended).not.toHaveBeenCalled()
  expect(cancelled).toBe(false)
  expect(parent.signal.aborted).toBe(false)
  expect(second.aborted).not.toHaveBeenCalled()
  first.release()
  await expect(cancellation).resolves.toBe(true)
  expect(first.ended).toHaveBeenCalledOnce()
  await expect(cancel('call-first')).resolves.toBe(false)
  second.release()
  await expect(other).resolves.toMatchObject({ success: true })
})

it('rejects unknown and foreign IDs identically, ignoring payload identity and principal claims', async () => {
  const held = holdingTool('foreign')
  const running = run('foreign', 'shared-id', 'bob-session', bob)
  await held.started
  const missing = await cancel('missing')
  expect(await cancel('shared-id')).toEqual(missing)
  expect(await cancel('shared-id', aliceHttp, 'bob-session')).toEqual(missing)
  expect(await cancel('shared-id', { ...bobHttp, workspaceId: 'other-tenant' })).toEqual(missing)
  expect(held.aborted).not.toHaveBeenCalled()
  held.release()
  await expect(running).resolves.toMatchObject({ success: true })
})

it('disambiguates reused call IDs by authorized session and prevents replacing a live registration', async () => {
  const first = holdingTool('one')
  const second = holdingTool('two')
  const a = run('one', 'reused')
  const b = run('two', 'reused', 'alice-second')
  await Promise.all([first.started, second.started])
  await expect(run('two', 'reused')).rejects.toThrow('already executing')
  await expect(cancel('reused')).resolves.toBe(false)
  expect(first.aborted).not.toHaveBeenCalled()
  expect(second.aborted).not.toHaveBeenCalled()
  const cancellation = cancel('reused', aliceHttp, 'alice-session')
  await expect(a).resolves.toMatchObject({ aborted: true })
  first.release()
  await expect(cancellation).resolves.toBe(true)
  expect(second.aborted).not.toHaveBeenCalled()
  second.release()
  await b
})

it('registers before preparation and waits for it without starting the cancelled tool', async () => {
  const preparing = barrier()
  const release = barrier()
  cleanups.push(release.release)
  const apply = vi.fn(async () => textResult('unexpected'))
  catalog.register(new ScriptedTool({ id: 'preparing', prepare: async () => {
    preparing.release()
    await release.promise
  }, apply }))
  const running = run('preparing', 'preparing-call')
  await preparing.promise
  let settled = false
  const cancellation = cancel('preparing-call').then(result => { settled = true; return result })
  await Promise.resolve()
  expect(settled).toBe(false)
  release.release()
  await expect(running).resolves.toMatchObject({ aborted: true })
  await expect(cancellation).resolves.toBe(true)
  expect(apply).not.toHaveBeenCalled()
})

it('uses the optional RPC invocation ID through the real execute route and ToolRunner', async () => {
  const { configureHostLocalTrust } = await import('../../server/host-trust.js')
  configureHostLocalTrust({ origin: 'desktop-embedded' })
  const held = holdingTool('rpc-tool')
  const running = registry.dispatchRpc({ domain: 'tools', method: 'executeTool', payload: {
    toolId: 'rpc-tool', arguments: {}, messageId: 'message', sessionId: 'alice-session', toolCallId: 'rpc-call',
  } }, aliceHttp)
  await held.started
  const cancellation = cancel('rpc-call')
  held.release()
  await expect(cancellation).resolves.toBe(true)
  // 这一条是 `executeTool` 那条 RPC 的答复(信封形状),不是取消的答复。
  await expect(running).resolves.toMatchObject({ ok: true, data: { success: false } })
  expect(held.aborted).toHaveBeenCalledOnce()
})

it('rechecks current ownership after preparation and does not let either owner borrow the original call', async () => {
  const preparing = barrier()
  const release = barrier()
  cleanups.push(release.release)
  const apply = vi.fn(async () => textResult('unexpected'))
  catalog.register(new ScriptedTool({ id: 'transferred', prepare: async () => {
    preparing.release()
    await release.promise
  }, apply }))
  const running = run('transferred', 'transferred-call')
  await preparing.promise
  const patch = { id: 'alice-session', ownerUserId: bob.userId, ownerWorkspaceId: bob.workspaceId }
  fixture.sessionLayer.commands.patchSession('alice-session', {
    patch, mutateIndexMeta: meta => { Object.assign(meta, patch) },
  })
  const reads = vi.spyOn(await import('../../store.js'), 'getSession')
  cleanups.push(() => reads.mockRestore())
  for (const context of [aliceHttp, bobHttp]) {
    await expect(cancel('transferred-call', context)).resolves.toBe(false)
  }
  release.release()
  await expect(running).resolves.toMatchObject({ success: false, error: 'Session not found' })
  expect(apply).not.toHaveBeenCalled()
  expect(reads).not.toHaveBeenCalled()
})

it('keeps cancellation authoritative while the plugin result finalizer is still running', async () => {
  const finalizing = barrier()
  const release = barrier()
  cleanups.push(release.release)
  const { runPluginToolResultIntercept } = await import('@onething/runtime/plugins/tool-result-intercept-bound')
  vi.mocked(runPluginToolResultIntercept).mockImplementationOnce(async context => {
    finalizing.release()
    await release.promise
    return { action: 'keep', result: context.result, rewrittenBy: [], ran: 0 }
  })
  catalog.register(new ScriptedTool({ id: 'finalizing' }))
  const running = run('finalizing', 'finalizing-call')
  await finalizing.promise
  let settled = false
  const cancellation = cancel('finalizing-call').then(result => { settled = true; return result })
  await Promise.resolve()
  expect(settled).toBe(false)
  release.release()
  await expect(running).resolves.toMatchObject({ success: false, aborted: true })
  await expect(cancellation).resolves.toBe(true)
})

it('stops a real bash child before reporting cancellation complete', { timeout: 15000 }, async () => {
  const { createDesktopCatalog } = await import('../../wiring/toolkit/catalog.js')
  const { createLocalBashOperations } = await import('@onething/runtime/tools/bash-executor')
  const builtin = createDesktopCatalog({ bash: {
    getDefaultWorkingDirectory: () => directory,
    getToolOutputsDir: () => path.join(directory, 'outputs'),
    createOperations: options => createLocalBashOperations({ ...options, envAllowlist: [] }),
  } })
  catalog.register(builtin.get('bash')!)
  const pidPath = path.join(directory, 'child.pid')
  const script = `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000)`
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
  const command = `${quote(process.execPath)} -e ${quote(script)}`
  const running = wiring.runToolkitToolDirectly('bash', { command }, {
    sessionId: 'alice-session', toolCallId: 'real-child', messageId: 'message', executionContext: alice,
    workingDirectory: directory,
  })
  let earlyResult: unknown
  void running.then(result => { earlyResult = result })
  let pid = 0
  cleanups.push(() => { if (pid) { try { process.kill(pid, 'SIGKILL') } catch { /* 子进程已退出:兜底清理,不是断言 */ } } })
  await vi.waitFor(async () => {
    expect(earlyResult).toBeUndefined()
    pid = Number(await fs.readFile(pidPath, 'utf8'))
    expect(pid).toBeGreaterThan(0)
  }, { timeout: 5000 })
  expect(() => process.kill(pid, 0)).not.toThrow()
  await expect(cancel('real-child')).resolves.toBe(true)
  await expect(running).resolves.toMatchObject({ success: false, aborted: true })
  expect(() => process.kill(pid, 0)).toThrow()
  pid = 0
})
