/**
 * N2 —— 发送前拦截的**挂点**验收(引擎这一半)。
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
  superPerformSendMessage: vi.fn(async () => {}),
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
  authorizeExecution: vi.fn((..._args: unknown[]) => {}),
  steerMessage: vi.fn(() => {}),
}))

// P3'e A1:`OnethingStreamEngine` 那层已并进 `ProductStreamEngine`,基类直接就是
// core 的 `CoreStreamEngine` —— 桩就打在它身上(其余导出保留真身)。
vi.mock('@onething/core/engine', async importOriginal => ({
  ...(await importOriginal<typeof import('@onething/core/engine')>()),
  CoreStreamEngine: class {
    authorizeExecution(...args: unknown[]): void { mocks.authorizeExecution(...(args as [])) }
    assertAccepting(): void {}
    trackSessionExecution<T>(_sessionId: string, work: () => Promise<T>): Promise<T> { return work() }
    constructor(_runtime: unknown) {
      void _runtime
    }

    async performSendMessage(...args: unknown[]): Promise<void> {
      await mocks.superPerformSendMessage(...(args as []))
    }

    steerMessage(...args: unknown[]): void {
      mocks.steerMessage(...(args as []))
    }
  },
}))

vi.mock('../../plugins/input-intercept-bound.js', () => ({
  runPluginInputIntercept: mocks.runIntercept,
}))

const { ProductStreamEngine } = await import('../stream-engine.js')

// P3'e-A2a 的顺带收益:引擎对后端的需要全走端口,所以这一份不再 mock 装配层
// 的任何模块 —— 桩就是端口本身,缺席的端口(roomIngress / agentBinding /
// steeringDelivery)按「无此能力」跑。
function engine() {
  return new ProductStreamEngine({} as never, {
    router: { route: mocks.route as never },
    pluginIntercept: { postReply: mocks.postReply },
  })
}

const sender = {} as never

type Forwarded = {
  content: string
  persistOnly?: boolean
  origin?: { inputTransformed?: { by: string[] } }
}

function forwarded(): Forwarded {
  const calls = mocks.superPerformSendMessage.mock.calls as unknown as unknown[][]
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

    await engine().handleSendMessage('inbox', { content: 'hello' }, sender)

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
    await engine().handleSendMessage(
      'sys-session',
      { content: 'internal drive', source },
      sender,
    )

    // 一条都不进链:否则 N1 的插件投递会被别的插件二次改写,盘上那条消息
    // 再也说不清是谁写的。
    expect(mocks.runIntercept).not.toHaveBeenCalled()
    expect(mocks.superPerformSendMessage).toHaveBeenCalledTimes(1)
  })

  /*
   * 工单 5 §4:一条发送 = 一次授权。判次数,不判结果。
   *
   * 第二条是那唯一的例外并且它是**必须**的:路由把消息改派到另一条会话时,写的是
   * 那一条,所以那一条也要判 —— 少了它,一个网关主体就能靠"发给我自己的收件箱、
   * 让路由改派"写进它并不拥有的会话。
   * 反证:把产品层那句 `this.authorizeExecution(sessionId, …)` 删掉 → 第一条
   * expected 1 got 0;把路由后那一句删掉 → 第二条 expected 2 got 1。
   */
  it('一条发送恰好授权一次;路由改派了会话才多判那一条', async () => {
    await engine().handleSendMessage('same', { content: 'hi' }, sender, {
      executionContext: { userId: 'u', workspaceId: 'w' },
    })
    expect(mocks.authorizeExecution).toHaveBeenCalledTimes(1)
    expect(mocks.authorizeExecution).toHaveBeenCalledWith('same', { userId: 'u', workspaceId: 'w' })

    mocks.authorizeExecution.mockClear()
    mocks.route.mockReturnValueOnce({
      sessionId: 'identity:gateway:wechat:default:u1',
      origin: { transport: 'gateway', source: 'gateway', receivedAt: 1 },
    } as never)
    await engine().handleSendMessage('inbox', { content: 'hi' }, sender, {
      executionContext: { userId: 'u', workspaceId: 'w' },
    })
    expect(mocks.authorizeExecution.mock.calls.map(call => call[0])).toEqual([
      'inbox', 'identity:gateway:wechat:default:u1',
    ])
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

    await engine().handleSendMessage('s1', { content: 'hello' }, sender)

    const cmd = forwarded()
    expect(cmd.content).toBe('hello')
    expect(cmd.persistOnly).toBeUndefined()
    expect(cmd.origin?.inputTransformed).toBeUndefined()
  })

  it('transform:改写后的文本就是持久化的文本;只记归因,不存原文', async () => {
    mocks.runIntercept.mockResolvedValueOnce({
      text: 'HELLO', handled: false, transformedBy: ['input-macros', 'other'], ran: 2,
    } as never)

    await engine().handleSendMessage('s1', { content: 'big:hello' }, sender)

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

    await engine().handleSendMessage('s1', { content: '=1+2' }, sender)

    expect(mocks.superPerformSendMessage).toHaveBeenCalledTimes(1)
    expect(forwarded()).toMatchObject({ content: '=1+2', persistOnly: true })
    // 没给 reply 就不贴任何东西。
    expect(mocks.postReply).not.toHaveBeenCalled()
  })

  it('handled + reply:以插件身份贴一条不起轮的消息', async () => {
    mocks.runIntercept.mockResolvedValueOnce({
      text: '=1+2*3', handled: true, handledBy: 'input-macros', reply: '7', transformedBy: [], ran: 1,
    } as never)

    await engine().handleSendMessage('s1', { content: '=1+2*3' }, sender)

    expect(forwarded()).toMatchObject({ persistOnly: true })
    expect(mocks.postReply).toHaveBeenCalledTimes(1)
    const [pluginId, sessionId, reply] = mocks.postReply.mock.calls[0] as unknown as [
      string, string, string,
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

    await engine().handleSendMessage('s1', { content: 'big:hello' }, sender)

    const cmd = forwarded()
    expect(cmd.content).toBe('HELLO')
    expect(cmd.persistOnly).toBe(true)
    expect(cmd.origin?.inputTransformed).toEqual({ by: ['shouter'] })
  })
})
