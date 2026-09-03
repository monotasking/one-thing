// @vitest-environment happy-dom
/**
 * **真链路那一格**:RPC 面拉回来的账本,喂得动折叠器吗。
 *
 * U1-b 的判据测试喂的是手写的 v2 夹具、直接进 `compareUiRefold` —— 它证的是
 * **比较器**对不对。真机上第一次跑就红了(`hand:6 / ledger:0`),根因不在比较器:
 * ui-refold 当时拉的是 `sessionEvents.list`,而那条在出口按**老七类**再筛一道
 * (`parseSessionEventLog`),折叠器要的开张事件(`session/created` / `user/message` /
 * `run/start`)全被筛掉,折出来必然是空树。诊断:
 * `docs/audit/web-lane-sse-diagnosis-2026-08-28.md`。
 *
 * 所以这只测试**不绕 RPC**:写一份真的 `events.jsonl` → 过 `dispatchRpc` →
 * 把交回来的事件原样喂进 `foldLedgerMessages` / `compareUiRefold`。
 * 同时把老 `list` 的行为也钉一格 —— 它**依旧**折不出消息,那不是 bug,是它本来
 * 就是轨迹面板的词汇;这一格防的是有人把 ui-refold 换回去。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeSessionLogEventLine } from '@onething/core/session/events'
import type { SessionLogEventRecord } from '@onething/core/session/events'
import { sessionEventsRouter } from '@shared/ipc/session-events.js'
import { compareUiRefold, foldLedgerMessages } from '@/stores/ui-refold'
import type { ChatMessage } from '@shared/ipc'

const paths = vi.hoisted(() => ({ sessionsDir: '' }))

// 与 event-log.ts 引同一个模块 —— 路径差一层就等于什么都没 mock,
// 测试会转而去读用户真实的 ~/.onething/sessions。
vi.mock('@onething/runtime/storage', () => ({
  getOnethingSessionsDir: () => paths.sessionsDir,
}))

const SESSION_ID = 'listraw-projection'

let root = ''
let seq = 0

function event(type: string, data: unknown): SessionLogEventRecord {
  seq += 1
  return { seq, time: 1000 + seq, type, data } as unknown as SessionLogEventRecord
}

/** 一轮走完的真账本:开张 → 请求 → 正文 → 收尾。全是 v2 词汇。 */
function writeLedger(): SessionLogEventRecord[] {
  seq = 0
  const records: SessionLogEventRecord[] = [
    event('session/created', { sessionId: SESSION_ID, agentId: 'default' }),
    event('user/message', {
      message: { id: 'u1', role: 'user', content: '在吗', timestamp: 1000 },
    }),
    event('run/start', {
      runId: 'r1',
      kind: 'send',
      assistantMessageId: 'a1',
      provider: 'deepseek',
      model: 'deepseek-chat',
      timestamp: 1002,
      createdAssistantMessage: true,
    }),
    event('request/start', { runId: 'r1', requestIndex: 1, messageId: 'a1' }),
    event('assistant/chunks', {
      runId: 'r1',
      requestIndex: 1,
      messageId: 'a1',
      partIndex: 0,
      kind: 'text',
      time0: 1000,
      dt: [0],
      text: ['在的'],
    }),
    event('assistant/part-end', {
      runId: 'r1', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'text',
    }),
    event('request/response', { runId: 'r1', requestIndex: 1, messageId: 'a1' }),
    event('request/end', { runId: 'r1', requestIndex: 1, messageId: 'a1' }),
    event('run/end', { runId: 'r1', outcome: 'completed' }),
  ]
  fs.mkdirSync(path.join(paths.sessionsDir, SESSION_ID), { recursive: true })
  fs.writeFileSync(
    path.join(paths.sessionsDir, SESSION_ID, 'events.jsonl'),
    records.map(encodeSessionLogEventLine).join(''),
    'utf8',
  )
  return records
}

async function loadDomain() {
  const [{ dispatchRpc, registerRouterHandlers, resetRpcRegistryForTests }, { sessionEventsRpcHandlers }] =
    await Promise.all([
      import('../registry.js'),
      import('../domains/session-events.js'),
    ])
  return { dispatchRpc, registerRouterHandlers, resetRpcRegistryForTests, sessionEventsRpcHandlers }
}

async function pull(method: 'list' | 'listRaw'): Promise<unknown[]> {
  const { dispatchRpc } = await loadDomain()
  const response = await dispatchRpc({
    domain: 'sessionEvents',
    method,
    payload: { sessionId: SESSION_ID },
  })
  expect(response.ok).toBe(true)
  return (response as { ok: true; data: { events: unknown[] } }).data.events
}

describe('sessionEvents.readBlob → 渲染层的正文读口(U2-a0)', () => {
  let unregister: (() => void) | undefined
  let blobRoot = ''

  beforeEach(async () => {
    blobRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-readblob-'))
    paths.sessionsDir = path.join(blobRoot, 'sessions')
    fs.mkdirSync(paths.sessionsDir, { recursive: true })
    const { registerRouterHandlers, sessionEventsRpcHandlers } = await loadDomain()
    unregister = registerRouterHandlers(sessionEventsRouter, sessionEventsRpcHandlers)
  })

  afterEach(async () => {
    unregister?.()
    unregister = undefined
    const { resetRpcRegistryForTests } = await loadDomain()
    resetRpcRegistryForTests()
    fs.rmSync(blobRoot, { recursive: true, force: true })
  })

  async function readBlob(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { dispatchRpc } = await loadDomain()
    const response = await dispatchRpc({ domain: 'sessionEvents', method: 'readBlob', payload })
    expect(response.ok).toBe(true)
    return (response as { ok: true; data: Record<string, unknown> }).data
  }

  it('写下去的字节读得回来(base64 + 字节数)', async () => {
    const { putSessionBlob } = await import('../../session/blob-store.js')
    const bytes = Buffer.from('hello blob world')
    const ref = putSessionBlob(SESSION_ID, bytes)
    expect(ref).toBeTruthy()

    const result = await readBlob({ sessionId: SESSION_ID, hash: ref!.hash })

    expect(Buffer.from(result.base64 as string, 'base64').toString('utf8')).toBe('hello blob world')
    expect(result.bytes).toBe(bytes.byteLength)
  })

  it('没这段字节 = 空对象,不是错误', async () => {
    expect(await readBlob({ sessionId: SESSION_ID, hash: 'deadbeefdeadbeef' })).toEqual({})
  })

  it('非法 id / hash 在门口就没了(路径穿越拿不到任何东西)', async () => {
    expect(await readBlob({ sessionId: '../../etc', hash: 'deadbeefdeadbeef' })).toEqual({})
    expect(await readBlob({ sessionId: SESSION_ID, hash: '../../../etc/passwd' })).toEqual({})
    expect(await readBlob({ sessionId: SESSION_ID, hash: 'NOTHEX' })).toEqual({})
  })
})

describe('sessionEvents.listRaw → ui-refold 的账本侧', () => {
  let unregister: (() => void) | undefined

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-listraw-'))
    paths.sessionsDir = path.join(root, 'sessions')
    fs.mkdirSync(paths.sessionsDir, { recursive: true })
    writeLedger()
    const { registerRouterHandlers, sessionEventsRpcHandlers } = await loadDomain()
    unregister = registerRouterHandlers(sessionEventsRouter, sessionEventsRpcHandlers)
  })

  afterEach(async () => {
    unregister?.()
    unregister = undefined
    const { resetRpcRegistryForTests } = await loadDomain()
    resetRpcRegistryForTests()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('listRaw 交回全集原词汇,折得出消息树', async () => {
    const events = await pull('listRaw')

    // 全集:开张三件套都在(它们是折叠器的入口条件)。
    const types = events.map(item => (item as { type: string }).type)
    expect(types).toContain('session/created')
    expect(types).toContain('user/message')
    expect(types).toContain('run/start')
    expect(events.length).toBe(9)

    const messages = foldLedgerMessages(events)
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(messages[1]?.content).toBe('在的')
  })

  it('同一份账本过 RPC 回来,与屏幕侧逐格相等(门在真机形态下是绿的)', async () => {
    const events = await pull('listRaw')
    // 屏幕侧这里用同一棵树代表"拼装正确的那一份" —— 本测试钉的是
    // **输入喂对了**,拼装器本身的对错由 `stores/__tests__/ui-refold.test.ts` 钉。
    const hand = foldLedgerMessages(events) as unknown as ChatMessage[]

    const result = compareUiRefold(hand, events)

    expect(result.diff).toEqual([])
    expect(result.match).toBe(true)
    expect(result.ledgerCount).toBe(2)
  })

  it('老 list 依旧只交老七类,折出来是空树 —— 这一格防的是换回去', async () => {
    const events = await pull('list')

    const types = new Set(events.map(item => (item as { type: string }).type))
    expect(types.has('session/created')).toBe(false)
    expect(types.has('user/message')).toBe(false)
    expect(types.has('run/start')).toBe(false)

    expect(foldLedgerMessages(events)).toEqual([])
  })
})
