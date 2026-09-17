/**
 * session-command 域,端到端穿过 dispatcher(结构债 P4c 第四批)。
 *
 * 接的是被删掉的四处转发的测试位:`apps/electron/src/ipc/session-command.ts` 的
 * 工厂(连同 `__tests__/session-command.test.ts`)、`@main/ipc/handlers.ts` 里
 * `registerCommandHandler` 那段壳适配、`preload/bridge.ts` 的 `emitCommand`、
 * 以及 `server/http.ts` + `server/runtime.ts` 那条 REST 路由与它的 adapter
 * (`http.test.ts` 里靠那条路由跑的用例同批调整)。
 *
 * 只桩装配层的端口(总线 / 引擎 / Permission / 评估补写),**清洗不桩** ——
 * `sanitizeRendererOrigin` 是真跑的,所以这组用例证的是「域把两条传输面各自
 * 的语义接对了」,而不是「域自己又实现了一遍」。
 *
 * 值得钉的四件:
 *  - `ipc` 上 origin 真被盖上去(渲染层自己写的 origin 不算数);
 *  - `ipc` 上 retry / edit-and-resend 会补写一次事故包(迟到负信号);
 *  - `http` 上 `command:abort` **不进总线**,就地中止并清权限;
 *  - `http` 上不带 channel 的权限应答会认领待批那条的 `targetChannel`
 *    —— `scripts/shadow-battery.mjs` 的两个权限场景就靠它。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionCommandRouter } from '@shared/ipc/session-command.js'

const bus = vi.hoisted(() => ({
  emit: vi.fn(async (_sessionId: string, _command: unknown): Promise<unknown> => 'emitted'),
}))
const engine = vi.hoisted(() => ({
  abort: vi.fn(() => true),
  getController: vi.fn((_sessionId: string): AbortController | undefined => undefined),
}))
const permission = vi.hoisted(() => ({
  getPendingPrompts: vi.fn(() => [] as Array<Record<string, unknown>>),
  clearSession: vi.fn(),
}))
const incident = vi.hoisted(() => ({
  createIncidentForTurn: vi.fn(async () => ({
    incidentId: 'incident-1',
    userMessage: 'u',
    assistantText: 'a',
  })),
}))
const runtimeAmend = vi.hoisted(() => ({
  amendTurnRetry: vi.fn(),
  amendTurnEditResend: vi.fn(),
}))

vi.mock('../../events/index.js', () => ({ getEventBus: () => bus }))
vi.mock('../../wiring/engine/index.js', () => ({ getStreamEngine: () => engine }))
vi.mock('../../wiring/permission/index.js', () => ({ Permission: permission }))
vi.mock('../../wiring/evals/incident.js', () => incident)
vi.mock('@onething/runtime', () => runtimeAmend)
vi.mock('../../session/access.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../session/access.js')>()
  return { ...actual, sessionAccess: actual.createSessionAccess({ findMeta: () => ({}) }) }
})

const IPC = { transport: 'ipc' } as const
const HTTP = { transport: 'http', sandboxRoot: '/store', ownerUid: 'local-user' } as const

async function loadDomain() {
  const [{ dispatchRpc, registerRouterHandlers, resetRpcRegistryForTests }, { sessionCommandRpcHandlers }] =
    await Promise.all([import('../registry.js'), import('../domains/session-command.js')])
  return { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, sessionCommandRpcHandlers }
}

/** 等 fire-and-forget 的补写跑完(两个动态 import + 两层 await)。 */
async function flush(amend: { mock: { calls: unknown[] } }): Promise<void> {
  await vi.waitFor(() => {
    expect(amend.mock.calls.length).toBeGreaterThan(0)
  })
}

describe('session-command RPC domain', () => {
  let dispose: (() => void) | undefined

  beforeEach(async () => {
    bus.emit.mockReset().mockResolvedValue('emitted')
    engine.abort.mockReset().mockReturnValue(true)
    engine.getController.mockReset().mockReturnValue(undefined)
    permission.getPendingPrompts.mockReset().mockReturnValue([])
    permission.clearSession.mockReset()
    incident.createIncidentForTurn.mockClear()
    runtimeAmend.amendTurnRetry.mockReset()
    runtimeAmend.amendTurnEditResend.mockReset()

    const { resetRpcRegistryForTests, registerRouterHandlers, sessionCommandRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(sessionCommandRouter, sessionCommandRpcHandlers)
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  it('binds exactly one method — 分派在总线那一侧,router 不再劈一次 type', async () => {
    const { dispatchRpc } = await loadDomain()

    const ok = await dispatchRpc({
      domain: 'session-command',
      method: 'emit',
      payload: { sessionId: 's1', command: { type: 'command:send-message', content: 'hi' } },
    }, IPC)
    expect(ok.ok).toBe(true)

    // 白名单是封闭的:没有 `abort` / `respond` 之类的第二个入口。
    for (const method of ['abort', 'respond', 'send']) {
      const unknown = await dispatchRpc({ domain: 'session-command', method, payload: {} }, IPC)
      expect(unknown.ok, `${method} must not be a route`).toBe(false)
    }
  })

  it('ipc: a send-message reaches the bus with a host-stamped origin', async () => {
    const { dispatchRpc } = await loadDomain()

    const response = await dispatchRpc({
      domain: 'session-command',
      method: 'emit',
      payload: {
        sessionId: 's1',
        command: {
          type: 'command:send-message',
          content: 'hello',
          // 渲染层自己写的 origin 不算数 —— 装配层盖章。
          origin: { source: 'wechat', transport: 'wechat' },
        },
      },
    }, IPC)

    expect(response).toEqual({ ok: true, data: { success: true, result: 'emitted' } })
    expect(bus.emit).toHaveBeenCalledTimes(1)
    const [sessionId, command] = bus.emit.mock.calls[0] as [string, Record<string, any>]
    expect(sessionId).toBe('s1')
    expect(command.type).toBe('command:send-message')
    expect(command.content).toBe('hello')
    expect(command.origin.source).not.toBe('wechat')
  })

  /**
   * `messageId` 那一格是**客户端预铸的用户消息 id**(09-13)。这一跳既不铸也不
   * 校验也不摘 —— 判形与「会话内唯一」在引擎里(`resolveUserMessageId`)。
   *
   * 钉它的理由:这条链上有过一次白名单式的清洗(`sanitizeRendererCommand` 给
   * 四条带正文的命令盖 origin),而「盖章」与「只让这几格过去」看起来像同一件事。
   * 哪天有人把它改成摘字段,壳那一格乐观气泡就会**悄悄**回到靠正文认领 ——
   * 屏幕上再次出现第二条用户气泡,而没有任何一处报错。
   */
  it.each([
    ['ipc', IPC],
    ['http', HTTP],
  ])('%s: send-message 的 messageId 原样到得了总线', async (_label, context) => {
    const { dispatchRpc } = await loadDomain()

    await dispatchRpc({
      domain: 'session-command',
      method: 'emit',
      payload: {
        sessionId: 's1',
        command: {
          type: 'command:send-message',
          content: '@/abs/x.lua',
          messageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        },
      },
    }, context)

    const [, command] = bus.emit.mock.calls[0] as [string, Record<string, any>]
    expect(command.messageId).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
  })

  it('ipc: retry / edit-and-resend amend the turn record (late negative signal)', async () => {
    const { dispatchRpc } = await loadDomain()

    await dispatchRpc({
      domain: 'session-command',
      method: 'emit',
      payload: {
        sessionId: 's1',
        command: { type: 'command:retry-message', sessionId: 's1', messageId: 'assistant-9' },
      },
    }, IPC)
    await flush(runtimeAmend.amendTurnRetry)

    expect(incident.createIncidentForTurn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      // turnId 是被重试的那条 assistant 消息 id,不是 sessionId ——
      // 用后者会把一个会话里每一轮都塌到同一条记录上。
      turnId: 'assistant-9',
      origin: 'auto',
      signals: { retried: true },
    }))
    expect(runtimeAmend.amendTurnRetry).toHaveBeenCalledWith({
      turnId: 'assistant-9',
      sessionId: 's1',
      incidentRef: 'incident-1',
    })
    // 重试命令本身照常进总线(补写是 fire-and-forget 的旁路)。
    expect(bus.emit).toHaveBeenCalledTimes(1)

    incident.createIncidentForTurn.mockClear()
    await dispatchRpc({
      domain: 'session-command',
      method: 'emit',
      payload: {
        sessionId: 's1',
        command: { type: 'command:edit-and-resend', sessionId: 's1', messageId: 'user-3', newContent: 'x' },
      },
    }, IPC)
    await flush(runtimeAmend.amendTurnEditResend)

    expect(incident.createIncidentForTurn).toHaveBeenCalledWith(expect.objectContaining({
      turnId: 'user-3',
      signals: { editResent: true },
    }))
    expect(runtimeAmend.amendTurnEditResend).toHaveBeenCalledTimes(1)
    // edit-and-resend 也在盖章名单里。
    const [, editCommand] = bus.emit.mock.calls[1] as [string, Record<string, any>]
    expect(editCommand.origin).toBeTruthy()
  })

  it('ipc: everything outside the stamp list travels byte-identical', async () => {
    const { dispatchRpc } = await loadDomain()

    const command = { type: 'command:compact-context', requestId: 'r1', manual: true }
    await dispatchRpc({
      domain: 'session-command',
      method: 'emit',
      payload: { sessionId: 's1', command },
    }, IPC)

    expect(bus.emit).toHaveBeenCalledWith('s1', command, { executionContext: { userId: 'local-user', workspaceId: 'default' } })
    expect(incident.createIncidentForTurn).not.toHaveBeenCalled()
  })

  it('http: command:abort is handled locally — engine + permissions, never the bus', async () => {
    const { dispatchRpc } = await loadDomain()

    const response = await dispatchRpc({
      domain: 'session-command',
      method: 'emit',
      payload: { sessionId: 's1', command: { type: 'command:abort' } },
    }, HTTP)

    expect(response).toEqual({ ok: true, data: { success: true } })
    expect(engine.abort).toHaveBeenCalledWith('s1', 'HTTP abort')
    expect(permission.clearSession).toHaveBeenCalledWith('s1')
    expect(bus.emit).not.toHaveBeenCalled()
  })

  it('http: a channel-less permission respond adopts the pending ask targetChannel', async () => {
    const { dispatchRpc } = await loadDomain()
    permission.getPendingPrompts.mockReturnValue([
      { id: 'req-1', callId: 'call_denied', targetChannel: 'ipc' },
    ])

    await dispatchRpc({
      domain: 'session-command',
      method: 'emit',
      payload: {
        sessionId: 's1',
        command: {
          type: 'command:permission-respond',
          toolCallId: 'call_denied',
          decision: 'reject',
          rejectReason: 'no',
        },
      },
    }, HTTP)

    expect(bus.emit).toHaveBeenCalledWith('s1', expect.objectContaining({
      type: 'command:permission-respond',
      toolCallId: 'call_denied',
      channel: 'ipc',
    }), { executionContext: { userId: 'local-user', workspaceId: 'default' } })

    // 没有待批的那条 → 退回 'api'(与被删掉的 adapter 逐字一致)。
    bus.emit.mockClear()
    permission.getPendingPrompts.mockReturnValue([])
    await dispatchRpc({
      domain: 'session-command',
      method: 'emit',
      payload: {
        sessionId: 's1',
        command: { type: 'command:permission-respond', requestId: 'req-x', decision: 'once' },
      },
    }, HTTP)
    expect(bus.emit).toHaveBeenCalledWith('s1', expect.objectContaining({ channel: 'api' }), { executionContext: { userId: 'local-user', workspaceId: 'default' } })

    // 显式带了 channel 就不认领。
    bus.emit.mockClear()
    await dispatchRpc({
      domain: 'session-command',
      method: 'emit',
      payload: {
        sessionId: 's1',
        command: { type: 'command:permission-respond', requestId: 'req-x', decision: 'once', channel: 'wechat' },
      },
    }, HTTP)
    expect(bus.emit).toHaveBeenCalledWith('s1', expect.objectContaining({ channel: 'wechat' }), { executionContext: { userId: 'local-user', workspaceId: 'default' } })
  })

  it('http: a send-message forwards WHOLE — no desktop origin is stamped onto a network command', async () => {
    const { dispatchRpc } = await loadDomain()

    const command = { type: 'command:send-message', content: 'from the browser' }
    await dispatchRpc({
      domain: 'session-command',
      method: 'emit',
      payload: { sessionId: 's1', command },
    }, HTTP)

    expect(bus.emit).toHaveBeenCalledWith('s1', command, { executionContext: { userId: 'local-user', workspaceId: 'default' } })
    expect(incident.createIncidentForTurn).not.toHaveBeenCalled()
  })

  it.each([['ipc', IPC], ['http', HTTP]] as const)('%s: busy attachment sends fail before delivery and can retry when idle', async (_transport, context) => {
    const { dispatchRpc } = await loadDomain()
    const controller = new AbortController()
    engine.getController.mockImplementation(sessionId => sessionId === 's1' ? controller : undefined)
    const request = {
      domain: 'session-command',
      method: 'emit',
      payload: {
        sessionId: 's1',
        command: {
          type: 'command:send-message',
          content: '',
          messageId: 'file-message',
          attachments: [{ id: 'file', fileName: 'note.txt', mimeType: 'text/plain', size: 4, mediaType: 'file', base64Data: 'bm90ZQ==' }],
        },
      },
    }

    expect(await dispatchRpc(request, context)).toEqual({
      ok: true,
      data: { success: false, error: 'A response is still running — messages with files wait until it finishes.' },
    })
    expect(bus.emit).not.toHaveBeenCalled()
    expect(controller.signal.aborted).toBe(false)

    engine.getController.mockReturnValue(undefined)
    expect(await dispatchRpc(request, context)).toMatchObject({ ok: true, data: { success: true } })
    expect(bus.emit).toHaveBeenCalledWith('s1', expect.objectContaining(request.payload.command), expect.any(Object))
  })

  it.each([['ipc', IPC], ['http', HTTP]] as const)('%s: busy text steering and persist-only attachments still reach the bus', async (_transport, context) => {
    const { dispatchRpc } = await loadDomain()
    engine.getController.mockReturnValue(new AbortController())
    for (const command of [
      { type: 'command:send-message', content: '补一句' },
      { type: 'command:send-message', content: '补一句', attachments: [] },
      { type: 'command:send-message', content: '', persistOnly: true, attachments: [{ id: 'file' }] },
    ]) {
      expect(await dispatchRpc({
        domain: 'session-command',
        method: 'emit',
        payload: { sessionId: 's1', command },
      }, context)).toMatchObject({ ok: true, data: { success: true } })
    }
    expect(bus.emit).toHaveBeenCalledTimes(3)
  })

  it('a bus failure comes back as a structured result, not a thrown RPC', async () => {
    const { dispatchRpc } = await loadDomain()
    bus.emit.mockRejectedValueOnce(new Error('engine is down'))

    const response = await dispatchRpc({
      domain: 'session-command',
      method: 'emit',
      payload: { sessionId: 's1', command: { type: 'command:send-message', content: 'hi' } },
    }, IPC)

    expect(response).toEqual({ ok: true, data: { success: false, error: 'engine is down' } })
  })
})
