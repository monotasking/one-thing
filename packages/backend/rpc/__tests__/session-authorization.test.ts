import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSessionAccess } from '../../session/access.js'
import { installSessionLayerForTest } from '../../session/testing/session-layer.js'
import { getEventBus } from '../../events/index.js'

// 授权判据直取子路径(工单 4 C2),替身跟着搬到同一条路上。
vi.mock('@onething/runtime/evals/incident', async importOriginal => ({
  ...await importOriginal<typeof import('@onething/runtime/evals/incident')>(),
  readIncident: vi.fn((id: string) => id === 'alice-incident' ? { id, sessionId: 'alice-session' } : undefined),
}))

const alice = { transport: 'http' as const, ownerUid: 'alice', workspaceId: 'tenant', sandboxRoot: '/tmp/alice/tenant' }
const bob = { transport: 'http' as const, ownerUid: 'bob', workspaceId: 'tenant', sandboxRoot: '/tmp/bob/tenant' }
const rows = {
  'alice-session': { ownerUserId: 'alice', ownerWorkspaceId: 'tenant' },
  'bob-session': { ownerUserId: 'bob', ownerWorkspaceId: 'tenant' },
}
let fixture: ReturnType<typeof installSessionLayerForTest>
let root: string
let originalStore: string | undefined
let delivered: unknown[]

beforeEach(() => {
  originalStore = process.env.ONETHING_STORE_PATH
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-authorization-'))
  process.env.ONETHING_STORE_PATH = root
  fixture = installSessionLayerForTest({
    access: createSessionAccess({ findMeta: id => rows[id as keyof typeof rows] }),
  })
  delivered = []
  getEventBus().onAnySessionAny(envelope => { delivered.push(envelope) }, 'authorization-test')
})

beforeEach(async () => {
  const { registerRouterHandlers } = await import('../registry.js')
  const { sessionsRouter } = await import('@shared/ipc/sessions.js')
  const { chatRouter } = await import('@shared/ipc/chat.js')
  const { scratchpadRouter } = await import('@shared/ipc/scratchpad.js')
  registered.push(
    registerRouterHandlers(sessionsRouter, domainHandlers.get('sessions')!.sessionsRpcHandlers as never),
    registerRouterHandlers(chatRouter, domainHandlers.get('chat')!.chatRpcHandlers as never),
    registerRouterHandlers(scratchpadRouter, domainHandlers.get('scratchpad')!.scratchpadRpcHandlers as never),
  )
})

afterEach(() => {
  while (registered.length) registered.pop()!()
})

afterEach(async () => {
  expect(delivered).toEqual([])
  await fixture.dispose()
  fs.rmSync(root, { recursive: true, force: true })
  if (originalStore === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = originalStore
})

type Case = [string, string, string, Record<string, unknown>]
const loadDomains: Record<string, () => Promise<unknown>> = {
  sessions: () => import('../domains/sessions.js'),
  'session-command': () => import('../domains/session-command.js'),
  permission: () => import('../domains/permission.js'),
  interaction: () => import('../domains/interaction.js'),
  variables: () => import('../domains/variables.js'),
  scratchpad: () => import('../domains/scratchpad.js'),
  goal: () => import('../domains/goal.js'),
  acp: () => import('../domains/acp.js'),
  'session-events': () => import('../domains/session-events.js'),
  chat: () => import('../domains/chat.js'),
  files: () => import('../domains/files.js'),
  plugins: () => import('../domains/plugins.js'),
  tools: () => import('../domains/tools.js'),
  usage: () => import('../domains/usage.js'),
  evals: () => import('../domains/evals.js'),
  'evals-workbench': () => import('../domains/evals-workbench.js'),
}

/**
 * 十六个域的模块图**一次性**拉起来(工单 4 A9)。
 *
 * 从前每个用例自己 `await import(...)`,于是排在最前面的那个(`sessions.rename`)
 * 一个人扛下整棵树的首次加载,全量跑时经常越过 vitest 单例 5s 的默认预算而红 ——
 * 红的是加载时间,不是它要验的那条授权规则,读的人却只看到「rename 超时」。
 * 加载搬进 `beforeAll` 并给它自己的预算之后,每个用例只剩下它自己那一句断言。
 */
const domainHandlers = new Map<string, Record<string, Record<string, (request: unknown, context: typeof bob) => Promise<unknown>>>>()
/** 契约自述那一批的判据在派发面上,所以这三个域要真的挂进派发表。 */
const registered: (() => void)[] = []
beforeAll(async () => {
  const storeBefore = process.env.ONETHING_STORE_PATH
  // 加载期不该有任何模块去读库(`import-side-effect-free` 那条律),但真要有,
  // 让它读到一个临时目录而不是用户的真库。
  const loadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-authorization-load-'))
  process.env.ONETHING_STORE_PATH = loadRoot
  try {
    for (const [domain, load] of Object.entries(loadDomains)) {
      domainHandlers.set(domain, await load() as never)
    }
  } finally {
    if (storeBefore === undefined) delete process.env.ONETHING_STORE_PATH
    else process.env.ONETHING_STORE_PATH = storeBefore
    fs.rmSync(loadRoot, { recursive: true, force: true })
  }
}, 120_000)

afterAll(() => { domainHandlers.clear() })

const cases: Case[] = [
  ['session-command', 'sessionCommandRpcHandlers', 'emit', { command: { type: 'command:send-message', content: 'stolen' } }],
  ['session-command', 'sessionCommandRpcHandlers', 'emit', { command: { type: 'command:abort' } }],
  ['session-command', 'sessionCommandRpcHandlers', 'emit', { command: { type: 'command:permission-respond', decision: 'always' } }],
  ['permission', 'permissionRpcHandlers', 'getPending', {}],
  ['permission', 'permissionRpcHandlers', 'clearSession', {}],
  ['interaction', 'interactionRpcHandlers', 'respond', { requestId: 'prompt', decision: 'allow' }],
  ['interaction', 'interactionRpcHandlers', 'getPending', {}],
  ['variables', 'variablesRpcHandlers', 'list', {}],
  ['variables', 'variablesRpcHandlers', 'set', { key: 'secret', value: 'changed' }],
  ['variables', 'variablesRpcHandlers', 'delete', { key: 'secret' }],
  ['goal', 'goalRpcHandlers', 'get', {}],
  ['goal', 'goalRpcHandlers', 'set', { goal: 'changed' }],
  ['goal', 'goalRpcHandlers', 'diffs', {}],
  ['acp', 'acpRpcHandlers', 'cancelSession', {}],
  ['session-events', 'sessionEventsRpcHandlers', 'list', {}],
  ['session-events', 'sessionEventsRpcHandlers', 'listRaw', {}],
  ['session-events', 'sessionEventsRpcHandlers', 'readBlob', { hash: 'a'.repeat(64) }],
  ['session-events', 'sessionEventsRpcHandlers', 'getTrace', { messageId: 'message' }],
  ['chat', 'chatRpcHandlers', 'abortStream', {}],
  ['files', 'filesRpcHandlers', 'list', { path: '/tmp' }],
  ['plugins', 'pluginsRpcHandlers', 'executeCommand', { commandName: 'fake', args: '' }],
  ['tools', 'toolsRpcHandlers', 'executeTool', { toolId: 'bash', arguments: { command: 'echo changed' } }],
  ['usage', 'usageRpcHandlers', 'getSession', {}],
  ['evals', 'evalsRpcHandlers', 'recordDownvote', { turnId: 'turn' }],
]

describe('session resources reject a different owner before business work', () => {
  it.each(cases)('%s.%s.%s', async (domain, exportName, method, payload) => {
    const handlers = domainHandlers.get(domain)!
    await expect(handlers[exportName][method]({ sessionId: 'alice-session', ...payload }, bob)).rejects.toThrow('Session not found')
  })

  it.each(['incidentGet', 'incidentUpdate', 'incidentReadFile', 'replayStart', 'replayCancel',
    'incidentAnalyze', 'incidentPromote', 'roundList', 'roundReplay', 'diagnoseStart'])('guards incident resource %s before replay, cancellation or writes', async method => {
    const evalsWorkbenchRpcHandlers = domainHandlers.get('evals-workbench')!.evalsWorkbenchRpcHandlers
    const handler = evalsWorkbenchRpcHandlers[method as keyof typeof evalsWorkbenchRpcHandlers]
    await expect(handler({ incidentId: 'alice-incident', patch: {}, relativePath: 'incident.md', caseId: 'copy' } as never, bob)).rejects.toThrow('Session not found')
  })


  it('does not trust a different nested session id in an otherwise authorized command', async () => {
    const sessionCommandRpcHandlers = domainHandlers.get('session-command')!.sessionCommandRpcHandlers
    await expect(sessionCommandRpcHandlers.emit({ sessionId: 'bob-session', command: {
      type: 'command:retry-message', sessionId: 'alice-session', messageId: 'turn',
    } } as never, bob)).rejects.toThrow('Session not found')
  })

  /*
   * **契约自述的那一批**(工单 5 §6,triage C1)。
   *
   * 这些方法的会话闸不再写在处理者的第一行,而是写在 router 契约里,由 `dispatchRpc`
   * 一处执法 —— 所以判据也搬到派发面上来:直接调处理者(在进程内)不再是外部调用者
   * 走的那条路,而外部调用者**只有** `dispatchRpc` 这一个入口。
   * 反证(实跑过):把 `registry.ts` 里读 `entry.session[method]` 那一段摘掉 → 下面
   * 每一行都变成 `ok: true`。
   */
  it.each([
    ['sessions', 'rename', { newName: 'stolen' }],
    ['sessions', 'get', {}],
    ['sessions', 'updatePin', { isPinned: true }],
    ['sessions', 'removeMessage', { messageId: 'message' }],
    ['sessions', 'updatePermissionMode', { mode: 'auto' }],
    ['chat', 'getHistory', {}],
    ['chat', 'getSystemPromptSnapshot', {}],
    ['chat', 'updateMessageThinkingTime', { messageId: 'message', thinkingTime: 1 }],
    ['scratchpad', 'get', {}],
    ['scratchpad', 'update', { content: 'changed' }],
    ['scratchpad', 'delete', {}],
  ])('%s.%s is refused by the declared contract, before the handler runs', async (domain, method, payload) => {
    const { dispatchRpc } = await import('../registry.js')
    const response = await dispatchRpc(
      { domain, method, payload: { sessionId: 'alice-session', ...payload } },
      bob,
    )
    expect(response).toEqual({ ok: false, error: { message: 'Session not found' } })
  })

  it('authorizes both scratchpad transfer ends before moving either', async () => {
    const { dispatchRpc } = await import('../registry.js')
    // 搬进去那一条由契约判(派发面),搬出来那一条由处理者判 —— 两头都拦得住。
    expect(await dispatchRpc({ domain: 'scratchpad', method: 'adopt', payload: { fromSessionId: 'bob-session', toSessionId: 'alice-session' } }, bob))
      .toEqual({ ok: false, error: { message: 'Session not found' } })
    expect(await dispatchRpc({ domain: 'scratchpad', method: 'adopt', payload: { fromSessionId: 'alice-session', toSessionId: 'bob-session' } }, bob))
      .toEqual({ ok: false, error: { message: 'Session not found' } })
  })

  it('keeps authorized owner resolution available across independent product spaces', () => {
    expect(fixture.sessionLayer.access.resolve(alice, 'alice-session', 'read')).toBe(rows['alice-session'])
    expect(fixture.sessionLayer.access.filter(bob, Object.entries(rows).map(([id, owner]) => ({ id, ...owner, workspaceId: 'product-space' })))).toEqual([
      { id: 'bob-session', ...rows['bob-session'], workspaceId: 'product-space' },
    ])
  })
})
