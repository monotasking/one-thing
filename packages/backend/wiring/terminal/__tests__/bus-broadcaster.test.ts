/**
 * 终端输出的宿主广播器(T0,方案 `apps/desktop-react/docs/terminal-browser-2026-09.md`
 * §2.1-2)。
 *
 * 钉三件:
 *
 * ① `sendData` → 总线上一条 `terminal:data`,字段与端口收到的载荷**逐字相同**
 *    (只多一格 `type`)。形状只有一份 —— 全局事件 `extends` 的就是那个载荷类型,
 *    这条断言防的是将来有人在广播器里"顺手"改名或补字段。
 * ② `sendExit` 同。
 * ③ **装配完成之前调它不抛**,只丢一行 warn。这一条是给 `pty.onData` 那个回调
 *    买的保险:那里炸出来的异常会顺着 node-pty 的读循环走,而丢一批输出只是下一次
 *    `attach` 的 ring 要多补一点。
 *
 * 用的是**真 `EventBus` + 进程当前实例槽**(`createBackendHandle({ eventBus })`,
 * 同 `wiring/engine/__tests__/gateway-session-runtime.test.ts` 的轻装法),不起整只
 * backend:这只文件问的是"广播器把事件放上了哪条总线",不是装配顺序。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from '../../../events/event-bus.js'
import { createBackendHandle, setCurrentBackend } from '../../../current.js'
import { createEventBusTerminalBroadcaster } from '../bus-broadcaster.js'

let bus: EventBus

beforeEach(() => {
  bus = new EventBus()
  setCurrentBackend(createBackendHandle({ eventBus: bus }))
})

afterEach(() => {
  setCurrentBackend(null)
  vi.restoreAllMocks()
})

describe('createEventBusTerminalBroadcaster', () => {
  it('① sendData → 总线上一条 terminal:data,字段原样', () => {
    const seen: unknown[] = []
    bus.onGlobal('terminal:data', envelope => { seen.push(envelope.event) })

    createEventBusTerminalBroadcaster().sendData({ terminalId: 'term-1', seq: 7, data: '$ ls\r\n' })

    expect(seen).toEqual([{ type: 'terminal:data', terminalId: 'term-1', seq: 7, data: '$ ls\r\n' }])
  })

  it('② sendExit → 总线上一条 terminal:exit,字段原样(exitCode 可以是 null)', () => {
    const seen: unknown[] = []
    bus.onGlobal('terminal:exit', envelope => { seen.push(envelope.event) })

    const broadcaster = createEventBusTerminalBroadcaster()
    broadcaster.sendExit({ terminalId: 'term-1', exitCode: 0 })
    broadcaster.sendExit({ terminalId: 'term-2', exitCode: null })

    expect(seen).toEqual([
      { type: 'terminal:exit', terminalId: 'term-1', exitCode: 0 },
      { type: 'terminal:exit', terminalId: 'term-2', exitCode: null },
    ])
  })

  /**
   * 反证口:把 `isEventSystemInitialized()` 那道闸拆掉 → 这一条变成
   * `BackendNotAssembledError` 红。
   */
  it('③ 装配完成之前调它不抛,一帧都不发', () => {
    setCurrentBackend(null)
    const seen: unknown[] = []
    bus.onGlobal('terminal:data', envelope => { seen.push(envelope.event) })

    const broadcaster = createEventBusTerminalBroadcaster()
    expect(() => broadcaster.sendData({ terminalId: 'term-1', seq: 1, data: 'x' })).not.toThrow()
    expect(() => broadcaster.sendExit({ terminalId: 'term-1', exitCode: 1 })).not.toThrow()

    expect(seen).toEqual([])
  })

  /**
   * 广播器**每次调用**才取总线(惰性)—— 它在 `applyHostPorts` 那一步就被注入,
   * 那时事件系统还没造出来。构造时抓一份就会抓到上一只 backend 的总线(或当场抛)。
   */
  it('④ 换一只 backend,同一只广播器发到新总线上', () => {
    const broadcaster = createEventBusTerminalBroadcaster()

    const next = new EventBus()
    setCurrentBackend(createBackendHandle({ eventBus: next }))
    const onOld: unknown[] = []
    const onNew: unknown[] = []
    bus.onGlobal('terminal:data', envelope => { onOld.push(envelope.event) })
    next.onGlobal('terminal:data', envelope => { onNew.push(envelope.event) })

    broadcaster.sendData({ terminalId: 'term-1', seq: 1, data: 'hi' })

    expect(onOld).toEqual([])
    expect(onNew).toHaveLength(1)
  })
})
