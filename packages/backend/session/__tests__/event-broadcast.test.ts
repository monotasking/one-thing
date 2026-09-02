/**
 * **账本词汇上总线**(B 期,§17.8)。
 *
 * 钉的是三件事:
 *
 *  1. 写入口每落一条事件,总线上就有**同一条记录**(原样,不投影、不改写);
 *  2. 它骑的是**既有的 `session:event` 推送面** —— 一个新的事件型,而不是新通道
 *     (桌面 IPCBridge 与 web SSE 都观察总线,于是"两个传输同步"是构造性的);
 *  3. 推送坏了不影响写账(总线抛错时 `writeSessionEvent` 照常返回 seq)。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SESSION_EVENT_TYPES } from '@onething/core/events'

const { resetSessionEventLogCache } = await import('../event-log.js')
const { writeSessionEvent } = await import('../event-writer.js')
const { installSessionLedgerEventBroadcaster, uninstallSessionLedgerEventBroadcaster } =
  await import('../event-broadcast.js')
const { createEventSystem, getEventBus } = await import('../../events/index.js')
const { createBackendHandle, setCurrentBackend } = await import('../../current.js')

const SESSION = 'ledger-broadcast-1'

let store = ''
let previousStorePath: string | undefined
/** A2:事件系统是造出来的,不是"初始化"出来的;槽里只填它那两格。 */
let disposeEventSystem: (() => void) | null = null

beforeEach(() => {
  previousStorePath = process.env.ONETHING_STORE_PATH
  store = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-ledger-cast-'))
  process.env.ONETHING_STORE_PATH = store
  resetSessionEventLogCache()
  const { eventBus, streamChannel } = createEventSystem()
  setCurrentBackend(createBackendHandle({ eventBus, streamChannel }))
  disposeEventSystem = () => {
    eventBus.shutdown()
    streamChannel.shutdown()
  }
  installSessionLedgerEventBroadcaster()
})

afterEach(() => {
  uninstallSessionLedgerEventBroadcaster()
  disposeEventSystem?.()
  disposeEventSystem = null
  setCurrentBackend(null)
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  fs.rmSync(store, { recursive: true, force: true })
})

/** 总线是异步的(观察者是同步段,广播排在链上),等一拍。 */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
  await Promise.resolve()
}

describe('会话账本事件的推送广播', () => {
  it('写一条 = 总线上一条,记录逐字原样', async () => {
    const seen: Array<{ type: string; record?: { seq: number; type: string } }> = []
    getEventBus().onAnySessionAny(envelope => {
      seen.push((envelope as unknown as { event: { type: string; record?: { seq: number; type: string } } }).event)
    }, 'test')

    const seq = writeSessionEvent(SESSION, 'session/created', { sessionId: SESSION })
    expect(seq).toBe(1)
    writeSessionEvent(SESSION, 'user/message', {
      message: { id: 'u1', role: 'user', content: 'hi', timestamp: 1000 },
    } as never)
    await settle()

    const ledgerEvents = seen.filter(event => event.type === SESSION_EVENT_TYPES.SESSION_LEDGER_EVENT)
    expect(ledgerEvents).toHaveLength(2)
    // 原样:类型与 seq 与账本那一行同一个字。
    expect(ledgerEvents.map(event => event.record?.type)).toEqual(['session/created', 'user/message'])
    expect(ledgerEvents.map(event => event.record?.seq)).toEqual([1, 2])
  })

  it('顺序按 seq —— 同一条会话的行不许乱序上总线', async () => {
    const seqs: number[] = []
    getEventBus().onAnySessionAny(envelope => {
      const event = (envelope as unknown as { event: { type: string; record?: { seq: number } } }).event
      if (event.type === SESSION_EVENT_TYPES.SESSION_LEDGER_EVENT && event.record) {
        seqs.push(event.record.seq)
      }
    }, 'test')

    for (let index = 0; index < 12; index++) {
      writeSessionEvent(SESSION, 'session/created', { sessionId: SESSION })
    }
    await settle()
    await settle()

    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(seqs).toHaveLength(12)
  })

  it('推送坏了不影响写账', async () => {
    getEventBus().onAnySessionAny(() => {
      throw new Error('boom')
    }, 'test')

    expect(writeSessionEvent(SESSION, 'session/created', { sessionId: SESSION })).toBe(1)
    expect(writeSessionEvent(SESSION, 'session/created', { sessionId: SESSION })).toBe(2)
    await settle()
  })

  it('拆掉之后总线上不再有账本行(退出可逆)', async () => {
    uninstallSessionLedgerEventBroadcaster()
    const seen: string[] = []
    getEventBus().onAnySessionAny(envelope => {
      seen.push((envelope as unknown as { event: { type: string } }).event.type)
    }, 'test')

    writeSessionEvent(SESSION, 'session/created', { sessionId: SESSION })
    await settle()

    expect(seen).not.toContain(SESSION_EVENT_TYPES.SESSION_LEDGER_EVENT)
  })
})
