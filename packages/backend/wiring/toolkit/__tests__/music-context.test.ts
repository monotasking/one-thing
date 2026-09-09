/**
 * K3-b —— **信任上下文必须先过,才轮到播放器**(旧 `radio-context.test.ts` 迁过来)。
 *
 * 旧那只文件问的是:一次带着**别人身份**的调用(`executionContext` 不是那个固定的
 * 本机操作员),`radio` 工具的五个 action 会不会在被拒之前就已经动了播放器。
 * `radio` 随 K3-b 退役,同一个问题原样搬到 `music` 这个 scheme 上 —— 那道门
 * (`assertMusicOperator(fixedExecutionContext(…))`)与它的位置(在端口的**第一行**,
 * 早于任何一次真正的调用)一个字都没变,变的只是调用的形状:从 `radio({action})`
 * 变成 `music({op})`。
 *
 * 旧的五个 action 在新面上的对应:open / retune / close / request 是四条**做法**,
 * 再加 K3-b 新开的播放器四条(pause / resume / next / like)—— 八条一起过这道门。
 *
 * ## `status` 那一条为什么不在这张表里(留账,不是漏了)
 *
 * 它退成了**读法**(`music({read: 'radio'})`),而读的上下文里没有
 * `executionContext` 这一格 —— `ResourceReadContext` 带的是 `Principal`,两套词汇
 * 不通,硬折就是拿一个字符串冒充凭据。完整的理由与退场条件写在
 * `wiring/resource/music-provider.ts` 的 `read` 那一段注释上;这里只说清楚:
 * **这条门在读那一侧今天不成立**,所以把它写进这张表会是一句假话。
 */
import { describe, expect, it, vi } from 'vitest'
import { ToolRunner } from '@onething/core/toolkit'
import { ResourceTool } from '@onething/core/resource'
import { ZodValidator } from '@onething/runtime/toolkit'
import { allowAuthorizer, RecordingObserver } from '../../../../core/toolkit/__tests__/fakes.js'

const radio = vi.hoisted(() => ({
  radioToolOpen: vi.fn(async () => ({ active: true, intent: 'quiet', programmeLength: 1 })),
  radioToolClose: vi.fn(async () => ({ active: false, intent: '', programmeLength: 0 })),
  radioToolStatus: vi.fn(() => ({ active: true, intent: 'quiet', programmeLength: 1 })),
  requestSong: vi.fn(async () => ({ success: true, title: 'song' })),
}))
vi.mock('../../music/radio.js', () => radio)

const OPS: Array<readonly [string, Record<string, unknown>]> = [
  ['open', { op: 'open', intent: 'quiet music' }],
  ['retune', { op: 'retune', intent: 'quiet music' }],
  ['close', { op: 'close' }],
  ['request', { op: 'request', song: 'song' }],
  ['pause', { op: 'pause' }],
  ['resume', { op: 'resume' }],
  ['next', { op: 'next' }],
  ['like', { op: 'like' }],
]

describe('music resource trusted execution context', () => {
  it.each(OPS)('carries the host context through %s before touching the player', async (_name, input) => {
    vi.clearAllMocks()
    const { createMusicResourceProvider } = await import('../../resource/music-provider.js')
    const tool = new ResourceTool(createMusicResourceProvider())
    const runner = new ToolRunner({
      authorizer: allowAuthorizer,
      observer: new RecordingObserver(),
      validator: new ZodValidator(),
      session: () => ({ id: 'alice-session' }),
    })
    const outcome = await runner.run(tool, {
      callId: 'music-call',
      toolId: 'music',
      sessionId: 'alice-session',
      messageId: 'message',
      principal: { kind: 'user', userId: 'local-user' },
      executionContext: { userId: 'alice', workspaceId: 'default' },
      input,
    })
    expect(outcome.kind).not.toBe('ok')
    expect(radio.radioToolOpen).not.toHaveBeenCalled()
    expect(radio.radioToolClose).not.toHaveBeenCalled()
    expect(radio.radioToolStatus).not.toHaveBeenCalled()
    expect(radio.requestSong).not.toHaveBeenCalled()
  })
})
