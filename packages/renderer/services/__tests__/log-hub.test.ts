import { describe, it, expect, vi } from 'vitest'
import { RENDERER_LOG_ECHO_MARK, type AppendLogsRequest } from '@shared/ipc/logs.js'
import { createRendererLogHub } from '../log'

/** 手动时钟:定时器不自己跑,由测试决定"下一帧"什么时候到。 */
function createManualTimers() {
  const pending = new Map<number, () => void>()
  let next = 1
  return {
    setTimer: (fn: () => void) => {
      const id = next++
      pending.set(id, fn)
      return id
    },
    clearTimer: (handle: unknown) => {
      pending.delete(handle as number)
    },
    tick(): void {
      const fns = [...pending.values()]
      pending.clear()
      for (const fn of fns) fn()
    },
    pendingCount: () => pending.size,
  }
}

function createHub(overrides: Partial<Parameters<typeof createRendererLogHub>[0]> = {}) {
  const sent: AppendLogsRequest[] = []
  const timers = createManualTimers()
  const hub = createRendererLogHub({
    send: async request => {
      sent.push(request)
    },
    echo: false,
    level: 'trace',
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...overrides,
  })
  return { hub, sent, timers }
}

describe('RendererLogHub', () => {
  it('batches records into one append per flush window', () => {
    const { hub, sent, timers } = createHub()
    const log = hub.getLogger('chat-store')

    log.info('a')
    log.info('b')
    log.info('c')
    expect(sent).toHaveLength(0)

    timers.tick()
    expect(sent).toHaveLength(1)
    expect(sent[0].records.map(record => record.msg)).toEqual(['a', 'b', 'c'])
    expect(sent[0].records[0].ns).toBe('chat-store')
  })

  it('flushes immediately once the batch size is reached, without waiting for the window', () => {
    const { hub, sent, timers } = createHub({ batchSize: 3 })
    const log = hub.getLogger('x')

    log.info('1')
    log.info('2')
    expect(sent).toHaveLength(0)
    log.info('3')
    expect(sent).toHaveLength(1)
    expect(timers.pendingCount()).toBe(0)
  })

  it('flushes fatal immediately — the process may not survive the next frame', () => {
    const { hub, sent } = createHub()
    hub.getLogger('boot').fatal('dying')
    expect(sent).toHaveLength(1)
    expect(sent[0].records[0].level).toBe('fatal')
  })

  it('carries fields and a normalized error across the wire', () => {
    const { hub, sent, timers } = createHub()
    hub.getLogger('svc').error('load failed', { sessionId: 's1' }, new Error('boom'))
    timers.tick()

    const record = sent[0].records[0]
    expect(record.fields).toEqual({ sessionId: 's1' })
    expect(record.err?.name).toBe('Error')
    expect(record.err?.message).toBe('boom')
    expect(record.err?.stack).toContain('boom')
  })

  it('keeps the newest 200 in the memory ring regardless of transport', () => {
    const { hub } = createHub({ ringSize: 5 })
    for (let i = 0; i < 12; i += 1) hub.getLogger('ring').info(`m${i}`)
    const dumped = hub.dump()
    expect(dumped).toHaveLength(5)
    expect(dumped.map(record => record.msg)).toEqual(['m7', 'm8', 'm9', 'm10', 'm11'])
  })

  it('drops the OLDEST pending records over the queue limit and reports the count', async () => {
    const { hub, sent, timers } = createHub({ queueLimit: 3, batchSize: 100 })
    const log = hub.getLogger('flood')
    for (let i = 0; i < 6; i += 1) log.info(`m${i}`)

    expect(hub.droppedCount()).toBe(3)
    timers.tick()
    expect(sent[0].dropped).toBe(3)
    expect(sent[0].records.map(record => record.msg)).toEqual(['m3', 'm4', 'm5'])
    // 报过一次就清零 —— 计数是"这一批丢了多少",不是累计。
    expect(hub.droppedCount()).toBe(0)
  })

  it('a failing transport never throws back into the caller', async () => {
    const { hub, timers } = createHub({
      send: async () => {
        throw new Error('offline')
      },
    })
    expect(() => hub.getLogger('x').warn('still fine')).not.toThrow()
    expect(() => timers.tick()).not.toThrow()
    await hub.flush()
  })

  it('level spec filters by namespace prefix', () => {
    const { hub, sent, timers } = createHub({ level: 'info,noisy.*=error' })
    hub.getLogger('noisy.poller').info('suppressed')
    hub.getLogger('noisy.poller').error('kept')
    hub.getLogger('quiet').info('kept too')
    timers.tick()
    expect(sent[0].records.map(record => record.msg)).toEqual(['kept', 'kept too'])
  })

  it('dev echo goes to console.debug for <=info and carries the zero-width mark', () => {
    const target = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const { hub } = createHub({ echo: true, console: target })

    hub.getLogger('e').info('hello')
    hub.getLogger('e').warn('careful')
    hub.getLogger('e').error('bad')

    expect(target.debug).toHaveBeenCalledTimes(1)
    expect(target.warn).toHaveBeenCalledTimes(1)
    expect(target.error).toHaveBeenCalledTimes(1)
    for (const spy of [target.debug, target.warn, target.error]) {
      const line = spy.mock.calls[0][0] as string
      expect(line.startsWith(RENDERER_LOG_ECHO_MARK)).toBe(true)
    }
  })

  it('does not echo at all when echo is off', () => {
    const target = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const { hub } = createHub({ echo: false, console: target })
    hub.getLogger('e').error('bad')
    expect(target.debug).not.toHaveBeenCalled()
    expect(target.error).not.toHaveBeenCalled()
  })

  it('flush() sends whatever is pending without waiting for the timer', async () => {
    const { hub, sent, timers } = createHub()
    hub.getLogger('bye').info('last words')
    expect(sent).toHaveLength(0)
    await hub.flush()
    expect(sent).toHaveLength(1)
    // 定时器被撤了,tick 之后不该再发一次空批。
    timers.tick()
    expect(sent).toHaveLength(1)
  })

  it('works with no transport at all (SSR / tests): ring still fills, nothing throws', () => {
    const hub = createRendererLogHub({ echo: false, level: 'trace' })
    expect(() => hub.getLogger('nowhere').info('ok')).not.toThrow()
    expect(hub.dump()).toHaveLength(1)
    expect(hub.pendingCount()).toBe(0)
  })
})
