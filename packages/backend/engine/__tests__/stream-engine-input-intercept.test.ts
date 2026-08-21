/**
 * N2 —— 发送前拦截的**挂点**验收(装配层这一半)。
 *
 * 协议层(三态归一化、链的次序与累积、fail-open、声明门)在
 * `packages/core/plugins/__tests__/input-intercept.test.ts`。这一份打的是
 * 只有引擎说了算的四件事:
 *
 *  1. 哪些命令**进链**(真实用户发送)、哪些**豁免**(系统内部源,含 `plugin:` 前缀族);
 *  2. transform 的结果就是持久化的文本,痕迹只留归因(`origin.inputTransformed`);
 *  3. handled 走 `persistOnly` —— 消息在册在屏,但一个模型调用都不发生;
 *  4. `reply` 以插件身份贴出,复用 N1 的 posted 那一格。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  superHandleSendMessage: vi.fn(async () => {}),
  route: vi.fn((input: { sessionId: string }) => ({
    sessionId: input.sessionId,
    origin: { transport: 'desktop', source: 'text', receivedAt: 1 },
  })),
  runIntercept: vi.fn(async (ctx: { text: string }) => ({
    text: ctx.text,
    handled: false,
    transformedBy: [] as string[],
    ran: 0,
  })),
  postReply: vi.fn(() => {}),
  steerMessage: vi.fn(() => {}),
}))

vi.mock('@onething/runtime/stream-engine', () => ({
  OnethingStreamEngine: class {
    constructor(_runtime: unknown) {
      void _runtime
    }

    async handleSendMessage(...args: unknown[]): Promise<void> {
      await mocks.superHandleSendMessage(...(args as []))
    }

    steerMessage(...args: unknown[]): void {
      mocks.steerMessage(...(args as []))
    }
  },
}))

vi.mock('../stream-engine-runtime.js', () => ({
  createMainStreamEngineRuntime: vi.fn(() => ({})),
}))

vi.mock('../../channel/index.js', () => ({
  getChannelSessionRouter: () => ({ route: mocks.route }),
}))

vi.mock('../../plugins/input-intercept.js', () => ({
  runPluginInputIntercept: mocks.runIntercept,
}))

vi.mock('../../plugins/sessions.js', () => ({
  pluginPostInterceptReply: mocks.postReply,
}))

const { StreamEngine } = await import('../stream-engine.js')

const sender = {} as never

type Forwarded = {
  content: string
  persistOnly?: boolean
  origin?: { inputTransformed?: { by: string[] } }
}

function forwarded(): Forwarded {
  const calls = mocks.superHandleSendMessage.mock.calls as unknown as unknown[][]
  return calls[0]?.[1] as Forwarded
}

describe('N2 挂点:谁进链', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear()
    mocks.runIntercept.mockImplementation(async (ctx: { text: string }) => ({
      text: ctx.text,
      handled: false,
      transformedBy: [],
      ran: 0,
    }))
  })

  it('真实用户发送进链,ctx 带**路由后**的 sessionId', async () => {
    mocks.route.mockReturnValueOnce({
      sessionId: 'identity:gateway:wechat:default:u1',
      origin: { transport: 'gateway', source: 'gateway', receivedAt: 1 },
    } as never)

    await new StreamEngine().handleSendMessage('inbox', { content: 'hello' }, sender)

    expect(mocks.runIntercept).toHaveBeenCalledTimes(1)
    // 路由会把网关消息改派到身份会话;插件拿到的必须是消息真正落地的那个 id,
    // 否则它 peek / 回贴的是一个不存在于界面上的会话。
    expect(mocks.runIntercept.mock.calls[0][0]).toEqual({
      sessionId: 'identity:gateway:wechat:default:u1',
      text: 'hello',
      source: 'user',
    })
  })

  it.each([
    ['goal', 'goal'],
    ['radio', 'radio'],
    ['collab', 'collab'],
    ['插件投递(N1 的前缀族)', 'plugin:session-link'],
  ])('系统内部源豁免:%s', async (_label, source) => {
    await new StreamEngine().handleSendMessage(
      'sys-session',
      { content: 'internal drive', source },
      sender,
    )

    // 一条都不进链:否则 N1 的插件投递会被别的插件二次改写,盘上那条消息
    // 再也说不清是谁写的。
    expect(mocks.runIntercept).not.toHaveBeenCalled()
    expect(mocks.superHandleSendMessage).toHaveBeenCalledTimes(1)
  })
})

describe('N2 挂点:三个分支落到引擎上的样子', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear()
  })

  it('continue:内容原样,不留任何痕迹', async () => {
    mocks.runIntercept.mockResolvedValueOnce({
      text: 'hello', handled: false, transformedBy: [], ran: 2,
    } as never)

    await new StreamEngine().handleSendMessage('s1', { content: 'hello' }, sender)

    const cmd = forwarded()
    expect(cmd.content).toBe('hello')
    expect(cmd.persistOnly).toBeUndefined()
    expect(cmd.origin?.inputTransformed).toBeUndefined()
  })

  it('transform:改写后的文本就是持久化的文本;只记归因,不存原文', async () => {
    mocks.runIntercept.mockResolvedValueOnce({
      text: 'HELLO', handled: false, transformedBy: ['input-macros', 'other'], ran: 2,
    } as never)

    await new StreamEngine().handleSendMessage('s1', { content: 'big:hello' }, sender)

    const cmd = forwarded()
    expect(cmd.content).toBe('HELLO')
    expect(cmd.origin?.inputTransformed).toEqual({ by: ['input-macros', 'other'] })
    // 原文不进盘:两份内容 = 历史重建 / 编辑重发 / 压缩各多一个分叉。
    expect(JSON.stringify(cmd)).not.toContain('big:hello')
    expect(cmd.persistOnly).toBeUndefined()
    expect(mocks.postReply).not.toHaveBeenCalled()
  })

  it('handled:走 persistOnly —— 消息在册在屏,零模型调用', async () => {
    mocks.runIntercept.mockResolvedValueOnce({
      text: '=1+2', handled: true, handledBy: 'input-macros', transformedBy: [], ran: 1,
    } as never)

    await new StreamEngine().handleSendMessage('s1', { content: '=1+2' }, sender)

    expect(mocks.superHandleSendMessage).toHaveBeenCalledTimes(1)
    expect(forwarded()).toMatchObject({ content: '=1+2', persistOnly: true })
    // 没给 reply 就不贴任何东西。
    expect(mocks.postReply).not.toHaveBeenCalled()
  })

  it('handled + reply:以插件身份贴一条不起轮的消息', async () => {
    mocks.runIntercept.mockResolvedValueOnce({
      text: '=1+2*3', handled: true, handledBy: 'input-macros', reply: '7', transformedBy: [], ran: 1,
    } as never)

    await new StreamEngine().handleSendMessage('s1', { content: '=1+2*3' }, sender)

    expect(forwarded()).toMatchObject({ persistOnly: true })
    expect(mocks.postReply).toHaveBeenCalledTimes(1)
    const [, pluginId, sessionId, reply] = mocks.postReply.mock.calls[0] as unknown as [
      unknown, string, string, string,
    ]
    expect({ pluginId, sessionId, reply }).toEqual({
      pluginId: 'input-macros',
      sessionId: 's1',
      reply: '7',
    })
  })

  it('handled 时前面累积的改写照样是真相(短路不丢前手结果)', async () => {
    mocks.runIntercept.mockResolvedValueOnce({
      text: 'HELLO', handled: true, handledBy: 'taker', transformedBy: ['shouter'], ran: 2,
    } as never)

    await new StreamEngine().handleSendMessage('s1', { content: 'big:hello' }, sender)

    const cmd = forwarded()
    expect(cmd.content).toBe('HELLO')
    expect(cmd.persistOnly).toBe(true)
    expect(cmd.origin?.inputTransformed).toEqual({ by: ['shouter'] })
  })
})
