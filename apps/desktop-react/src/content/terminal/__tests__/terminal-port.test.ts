import { describe, expect, it } from 'vitest'
import { asDataEvent, asExitEvent } from '../../../data/terminal-port'

/**
 * **判形:名字与形都对上才算**(T1;照 `music-port.asResourceEvent` 那条判例)。
 *
 * `GET /api/events` 是一条**广播**:会话事件、设置变更、资源事实、终端输出全骑
 * 同一条线,载荷是从网线上来的。少了这一层,一条形状不对的帧会以 `undefined`
 * 的样子被写进 xterm(或者把 `lastSeq` 记成 `NaN`,从此每一帧都被判成旧帧)。
 */

describe('terminal:data', () => {
  it('三格齐全才认', () => {
    expect(asDataEvent({ terminalId: 't1', seq: 3, data: 'x' })).toEqual({
      terminalId: 't1',
      seq: 3,
      data: 'x',
    })
    // 空串是合法输出(一次 flush 攒到的就是空的),不许被真值判据吃掉。
    expect(asDataEvent({ terminalId: 't1', seq: 0, data: '' })).toEqual({
      terminalId: 't1',
      seq: 0,
      data: '',
    })
  })

  it('缺一格 / 类型不对 / NaN 一律当没看见', () => {
    expect(asDataEvent(null)).toBeNull()
    expect(asDataEvent('terminal:data')).toBeNull()
    expect(asDataEvent({ seq: 1, data: 'x' })).toBeNull()
    expect(asDataEvent({ terminalId: 't1', data: 'x' })).toBeNull()
    expect(asDataEvent({ terminalId: 't1', seq: 1 })).toBeNull()
    expect(asDataEvent({ terminalId: 't1', seq: Number.NaN, data: 'x' })).toBeNull()
    expect(asDataEvent({ terminalId: 't1', seq: '3', data: 'x' })).toBeNull()
  })

  it('多出来的字段不拦路,但也不带走(全局事件自己那格 `type` 就是多出来的)', () => {
    expect(asDataEvent({ type: 'terminal:data', terminalId: 't1', seq: 1, data: 'x' })).toEqual({
      terminalId: 't1',
      seq: 1,
      data: 'x',
    })
  })
})

describe('terminal:exit', () => {
  it('`exitCode` 可以是 null(被信号杀掉)', () => {
    expect(asExitEvent({ terminalId: 't1', exitCode: 0 })).toEqual({ terminalId: 't1', exitCode: 0 })
    expect(asExitEvent({ terminalId: 't1', exitCode: null })).toEqual({
      terminalId: 't1',
      exitCode: null,
    })
  })

  it('缺 id / 码不是数也不是 null → 当没看见', () => {
    expect(asExitEvent({ exitCode: 0 })).toBeNull()
    expect(asExitEvent({ terminalId: 't1', exitCode: 'killed' })).toBeNull()
    expect(asExitEvent({ terminalId: 't1' })).toBeNull()
  })
})
