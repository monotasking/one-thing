import { describe, expect, it, vi } from 'vitest'
import { CoreStreamEngine, type CoreStreamEngineOptions, type CoreStreamEngineRuntime } from '../core-stream-engine.js'
import { AgentExecutionCheckpointError } from '../../agent-loop/errors.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

class TestEngine extends CoreStreamEngine {
  readonly errors: string[] = []
  constructor(options: CoreStreamEngineOptions = {}, runtime = {} as CoreStreamEngineRuntime) { super(runtime, options) }
  protected override emitStreamError(_sessionId: string, error: string): void { this.errors.push(error) }
  protected override logError(): void {}
  protected override onSessionCleared(): void {}
  execute(sessionId: string, controller: AbortController, completion: Promise<void>): Promise<void> {
    return this.trackSessionExecution(sessionId, async () => {
      this.registerController(sessionId, controller)
      await completion // Includes the recorder's final durable checkpoint.
      this.removeController(sessionId, controller)
    })
  }
}

describe('engine execution ownership', () => {
  it('lets the answer start even when title generation fails outright', async () => {
    // 工单 4 A1:标题是**发后不管**的旁路(回 HEAD 形状)。2026-09-06/07 那轮把它
    // 改成 `await`,于是标题这一次独立的模型调用一旦失败(这里是最狠的一种:
    // 账本检查点失败),整条回复就跟着不发生 —— 用户看到的是「发出去,什么都没有」。
    // 现在它只记一行日志,回复照跑。
    const failure = new AgentExecutionCheckpointError('title result', new Error('disk failure'))
    const generateTitle = vi.fn(async () => { throw failure })
    const renameSession = vi.fn()
    const executeMessageStream = vi.fn()
    const settings = {
      ai: { provider: 'test', providers: { test: { model: 'model' } } },
      // 压缩不参与这条用例;关掉它省掉一大串与标题无关的替身。
      chat: { contextCompactEnabled: false },
    }
    const engine = new TestEngine({}, {
      store: {
        getSession: () => ({ name: 'New Chat', createdAt: 0 }),
        listMessages: () => [], getSettings: () => settings,
        addMessage: vi.fn((_id: string, message: unknown) => message), renameSession,
      },
      provider: {
        isSupported: () => true, requiresOAuth: () => false,
        getEffectiveConfig: () => ({ providerId: 'test', providerConfig: { model: 'model' }, model: 'model' }),
        resolveAuth: async () => ({ kind: 'api-key', apiKey: 'test' }), getApiType: () => undefined, generateTitle,
      },
      models: { getModelContextLength: async () => 128000 },
      history: { buildMessages: () => [] },
      skills: { getForSession: () => [] },
      media: { ingestMessageAttachments: () => undefined },
      prompts: { resolveReferences: (content: string) => ({ modelContent: content, displayContent: content }) },
      ids: { createId: () => 'user-1' }, clock: { now: () => 1 }, streams: { executeMessageStream },
    } as unknown as CoreStreamEngineRuntime)

    await expect(engine.handleSendMessage('s', { content: 'Work' }, {})).resolves.toBeUndefined()

    expect(generateTitle).toHaveBeenCalledTimes(1)
    // 标题没改成(它失败了),但回复开跑了。
    expect(renameSession).not.toHaveBeenCalled()
    expect(executeMessageStream).toHaveBeenCalledTimes(1)
    await engine.abortAll()
  })

  /*
   * 工单 5 §4(triage B8/D4)。授权谓词是**入口**判一次,不是准备段前后各判一次。
   *
   * 判次数而不是判结果:三次调用与一次调用的结果一模一样(它是纯谓词),变的只有
   * 一条发送要跑几遍会话归属解析。反证:把 `prepareSessionExecution` 里那两句
   * `authorizeExecution` 加回去 → 这里 expected 1 got 3。
   */
  it('authorizes one send exactly once', async () => {
    const authorizeExecution = vi.fn()
    const executeMessageStream = vi.fn()
    const settings = { ai: { provider: 'test', providers: { test: { model: 'model' } } }, chat: { contextCompactEnabled: false } }
    const engine = new TestEngine({ authorizeExecution }, {
      store: {
        getSession: () => ({ name: 'Named', createdAt: 0 }),
        listMessages: () => [], getSettings: () => settings,
        addMessage: vi.fn((_id: string, message: unknown) => message), renameSession: vi.fn(),
      },
      provider: {
        isSupported: () => true, requiresOAuth: () => false,
        getEffectiveConfig: () => ({ providerId: 'test', providerConfig: { model: 'model' }, model: 'model' }),
        resolveAuth: async () => ({ kind: 'api-key', apiKey: 'test' }), getApiType: () => undefined,
        generateTitle: vi.fn(),
      },
      models: { getModelContextLength: async () => 128000 },
      history: { buildMessages: () => [] },
      skills: { getForSession: () => [] },
      media: { ingestMessageAttachments: () => undefined },
      prompts: { resolveReferences: (content: string) => ({ modelContent: content, displayContent: content }) },
      ids: { createId: () => 'user-1' }, clock: { now: () => 1 }, streams: { executeMessageStream },
    } as unknown as CoreStreamEngineRuntime)

    await engine.handleSendMessage('s', { content: 'Work' }, {}, { executionContext: { userId: 'u', workspaceId: 'w' } })
    expect(authorizeExecution).toHaveBeenCalledTimes(1)
    expect(authorizeExecution).toHaveBeenCalledWith('s', { userId: 'u', workspaceId: 'w' })
    await engine.abortAll()
  })
  it('old cleanup cannot remove the controller that must be cancelled by shutdown', async () => {
    const engine = new TestEngine()
    const oldDone = deferred()
    const newDone = deferred()
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = engine.execute('s', firstController, oldDone.promise)
    const second = engine.execute('s', secondController, newDone.promise)
    oldDone.resolve()
    await first
    expect(engine.getController('s')).toBe(secondController)
    const closing = engine.abortAll()
    expect(secondController.signal.aborted).toBe(true)
    newDone.resolve()
    await Promise.all([second, closing])
  })
  it('abortAndDrain waits for superseded execution cleanup after its controller was removed', async () => {
    const engine = new TestEngine()
    const oldDone = deferred()
    const newDone = deferred()
    const oldController = new AbortController()
    const newController = new AbortController()
    const first = engine.execute('s', oldController, oldDone.promise)
    const second = engine.execute('s', newController, newDone.promise)
    expect(oldController.signal.aborted).toBe(true)
    let drained = false
    const closing = engine.abortAndDrain('s').then(() => { drained = true })
    expect(newController.signal.aborted).toBe(true)
    expect(engine.getActiveSessionIds()).toEqual([])
    newDone.resolve()
    await second
    expect(drained).toBe(false)
    oldDone.resolve()
    await Promise.all([first, closing])
    expect(drained).toBe(true)
  })

  it('rejects a prepared command after admission closes, before touching the store or model', async () => {
    const prepare = deferred()
    const entered = deferred()
    const storeRead = vi.fn()
    let accepting = true
    const engine = new TestEngine({
      assertAccepting: sessionId => { expect(sessionId).toBe('s'); if (!accepting) throw new Error('Session is closing') },
      prepareSession: async () => { entered.resolve(); await prepare.promise },
    }, { store: { getSession: storeRead } } as unknown as CoreStreamEngineRuntime)
    const command = engine.handleSendMessage('s', { content: 'hello' }, {})
    await entered.promise
    accepting = false
    let drained = false
    const closing = engine.abortAll().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    prepare.resolve()
    await Promise.all([command, closing])
    expect(storeRead).not.toHaveBeenCalled()
    expect(engine.errors).toEqual(['Session is closing'])
  })

  it('checks admission at the actual controller registration and still permits cleanup', async () => {
    const assertAccepting = vi.fn(() => { throw new Error('Backend is closing') })
    const engine = new TestEngine({ assertAccepting })
    expect(() => engine.registerController('s', new AbortController())).toThrow('Backend is closing')
    await expect(engine.handleSendMessage('s', { content: 'late' }, {})).rejects.toThrow('Backend is closing')
    expect(assertAccepting).toHaveBeenCalledWith('s')
    await expect(engine.abortAndDrain('s')).resolves.toBeUndefined()
    expect(() => engine.removeController('s')).not.toThrow()
  })
})
