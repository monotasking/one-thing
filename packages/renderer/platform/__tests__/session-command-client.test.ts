/**
 * 命令过线时 mentions 的拍平(`withPlainCommandMentions`)。
 *
 * 结构债 P4c 第四批之前这段守在 `apps/electron/src/preload/bridge.ts` 的
 * `emitCommand` 包装上(测试在 `preload/__tests__/command-mentions.test.ts`)。
 * 命令总线迁到 `session-command` RPC 域之后,通用的 `rpcInvoke` 不该认识任何一个
 * 域的载荷,拍平因此跟着调用点走 —— 于是这组用例也跟过来,并且**两条传输面
 * 同时被它守住**(以前 web 走 HTTP 原样透传,只有桌面这条被拍平)。
 *
 * 守的命题没变:拍平只负责「变成普通对象」,**不负责挑字段**。逐字段白名单曾把
 * W14a 之后加的 `kind`/`userHandle` 悄悄剥掉,于是 `@用户` 只在桌面这条通道上
 * 失效,而两端跑的是同一份渲染层代码 —— 按传输方式分叉的 bug 没有任何一个
 * 前端测试看得见,只能钉在过线这一刻。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionCommand } from '@shared/events'

const mocks = vi.hoisted(() => ({
  rpcInvoke: vi.fn(async (_request: unknown) => ({ ok: true, data: { success: true } })),
}))

vi.mock('../index', () => ({
  platformApi: {
    get rpcInvoke() {
      return mocks.rpcInvoke
    },
  },
}))

async function emit(command: SessionCommand): Promise<SessionCommand> {
  const { sessionCommands } = await import('../session-command-client')
  await sessionCommands.emit({ sessionId: 's1', command })
  const [request] = mocks.rpcInvoke.mock.calls.at(-1) as [
    { domain: string; method: string; payload: { sessionId: string; command: SessionCommand } },
  ]
  expect(request.domain).toBe('session-command')
  expect(request.method).toBe('emit')
  expect(request.payload.sessionId).toBe('s1')
  return request.payload.command
}

describe('withPlainCommandMentions', () => {
  beforeEach(() => {
    mocks.rpcInvoke.mockClear()
  })

  it('kind / userHandle 过得了线', async () => {
    const command = await emit({
      type: 'command:send-message',
      content: '@songyitian 你说了算',
      mentions: [
        { kind: 'user', agentId: '', label: 'songyitian', userHandle: '3f9c1e2a' },
      ],
    } as SessionCommand)
    expect((command as { mentions: unknown[] }).mentions).toEqual([
      { kind: 'user', agentId: '', label: 'songyitian', userHandle: '3f9c1e2a' },
    ])
  })

  it('缺省的 kind 不被物化 —— 老转录里没有这个键,拍平不该凭空造一批', async () => {
    const command = await emit({
      type: 'command:send-message',
      content: '@小李 看一下',
      mentions: [{ agentId: 'fe', label: '小李' }],
    } as SessionCommand)
    const [mention] = (command as unknown as { mentions: Record<string, unknown>[] }).mentions
    expect(mention).toEqual({ agentId: 'fe', label: '小李' })
    expect('kind' in mention).toBe(false)
    expect('userHandle' in mention).toBe(false)
  })

  it('句柄缺席的用户 mention 不长出一个空 userHandle', async () => {
    const command = await emit({
      type: 'command:send-message',
      content: '@我 看下',
      mentions: [{ kind: 'user', agentId: '', label: 'songyitian' }],
    } as SessionCommand)
    const [mention] = (command as unknown as { mentions: Record<string, unknown>[] }).mentions
    expect(mention).toEqual({ kind: 'user', agentId: '', label: 'songyitian' })
    expect('userHandle' in mention).toBe(false)
  })

  it('拍平出来的是可 structuredClone 的普通对象(这个函数存在的理由)', async () => {
    const reactive = new Proxy(
      { agentId: 'fe', label: '小李' },
      { get: (target, prop) => Reflect.get(target, prop) },
    )
    const command = await emit({
      type: 'command:send-message',
      content: '@小李',
      mentions: [reactive],
    } as unknown as SessionCommand)
    const { mentions } = command as { mentions: unknown[] }
    expect(() => structuredClone(mentions)).not.toThrow()
  })

  it('没有 mentions 的命令原样通过', async () => {
    const command = await emit({
      type: 'command:inject-steering',
      content: '换个方向',
      source: 'user',
    } as SessionCommand)
    expect(command).toEqual({
      type: 'command:inject-steering',
      content: '换个方向',
      source: 'user',
    })
  })
})
