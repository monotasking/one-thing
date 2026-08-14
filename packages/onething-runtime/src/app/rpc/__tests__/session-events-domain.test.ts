/**
 * 会话事件日志读取域(主线 E1),端到端过 dispatcher。
 *
 * 钉住的不是"handler 被调用了",而是**轨迹面板真正依赖的那条语义**:
 * 一次工具调用永远解析到**它当时那份 schema**。所以这里不 mock 读取器,而是
 * 写一份真的 `events.jsonl`(两条 header,工具 schema 中途改过),让查询穿过
 * 完整链路:RPC 信封 → readSessionEvents → resolveToolCallInspection。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  encodeSessionEventLine,
  type SessionEventRecord,
} from '@onething/runtime/sessions/session-events'

const paths = vi.hoisted(() => ({ sessionsDir: '' }))

// 与 event-log.ts 引的是同一个模块 —— 路径差一层就等于什么都没 mock,
// 测试会转而去读用户真实的 ~/.onething/sessions。
vi.mock('../../stores/paths.js', () => ({
  getSessionsDir: () => paths.sessionsDir,
}))

const SESSION_ID = 'session-under-test'

let root = ''

function event(record: SessionEventRecord): string {
  return encodeSessionEventLine(record)
}

/**
 * 一份两轮请求的日志:
 *  - seq 1  request/tools(read 的 description 是「旧描述」)
 *  - seq 2  header(引用 catalog-one)
 *  - seq 3  request/start #1
 *  - seq 4  tool/call  call-old
 *  - seq 5  tool/result call-old
 *  - seq 6  request/end #1
 *  - seq 7  request/tools(read 的 description 改成「新描述」—— 目录变了才追加)
 *  - seq 8  header(model 与 system 也变了,引用 catalog-two)
 *  - seq 9  request/start #2
 *  - seq 10 tool/call  call-new(没有 result:执行中/未收尾)
 */
function writeLog(): void {
  const lines = [
    event({
      seq: 1,
      time: 1000,
      type: 'request/tools',
      data: {
        requestIndex: 1,
        toolsHash: 'catalog-one',
        tools: [{ name: 'read', description: '旧描述', parameters: { type: 'object' } }],
      },
    }),
    event({
      seq: 2,
      time: 1000,
      type: 'request/header',
      data: {
        requestIndex: 1,
        provider: 'anthropic',
        model: 'claude-old',
        systemPromptHash: 'hash-one',
        toolsHash: 'catalog-one',
        reason: 'initial',
      },
    }),
    event({ seq: 3, time: 1010, type: 'request/start', data: { requestIndex: 1, messageId: 'm1' } }),
    event({
      seq: 4,
      time: 1100,
      type: 'tool/call',
      data: { callId: 'call-old', argumentsRaw: '{"file_path":"/a.ts"}', name: 'read', messageId: 'm1' },
    }),
    event({
      seq: 5,
      time: 1350,
      type: 'tool/result',
      data: { callId: 'call-old', isError: false, resultPreview: 'ok', sourceSeq: 4 },
    }),
    event({
      seq: 6,
      time: 1400,
      type: 'request/end',
      data: { requestIndex: 1, stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 20 } },
    }),
    event({
      seq: 7,
      time: 2000,
      type: 'request/tools',
      data: {
        requestIndex: 2,
        toolsHash: 'catalog-two',
        tools: [{ name: 'read', description: '新描述', parameters: { type: 'object' } }],
      },
    }),
    event({
      seq: 8,
      time: 2000,
      type: 'request/header',
      data: {
        requestIndex: 2,
        provider: 'anthropic',
        model: 'claude-new',
        systemPromptHash: 'hash-two',
        toolsHash: 'catalog-two',
        reason: 'change',
      },
    }),
    event({ seq: 9, time: 2010, type: 'request/start', data: { requestIndex: 2, messageId: 'm2' } }),
    event({
      seq: 10,
      time: 2100,
      type: 'tool/call',
      data: { callId: 'call-new', argumentsRaw: '{"file_path":"/b.ts"}', name: 'read', messageId: 'm2' },
    }),
  ]
  fs.mkdirSync(path.join(paths.sessionsDir, SESSION_ID), { recursive: true })
  fs.writeFileSync(path.join(paths.sessionsDir, SESSION_ID, 'events.jsonl'), lines.join(''), 'utf8')
}

async function loadDomain() {
  const [{ dispatchRpc, resetRpcRegistryForTests }, { registerSessionEventsRpcDomain }] =
    await Promise.all([
      import('../registry.js'),
      import('../domains/session-events.js'),
    ])
  return { dispatchRpc, resetRpcRegistryForTests, registerSessionEventsRpcDomain }
}

describe('sessionEvents RPC domain', () => {
  let unregister: (() => void) | undefined

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-session-events-'))
    paths.sessionsDir = path.join(root, 'sessions')
    fs.mkdirSync(paths.sessionsDir, { recursive: true })
    writeLog()
  })

  afterEach(async () => {
    unregister?.()
    unregister = undefined
    const { resetRpcRegistryForTests } = await loadDomain()
    resetRpcRegistryForTests()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('list 交回整份日志,按 seq 升序', async () => {
    const { dispatchRpc, registerSessionEventsRpcDomain } = await loadDomain()
    unregister = registerSessionEventsRpcDomain()

    const response = await dispatchRpc({
      domain: 'sessionEvents',
      method: 'list',
      payload: { sessionId: SESSION_ID },
    })

    expect(response.ok).toBe(true)
    const events = (response as { ok: true; data: { events: SessionEventRecord[] } }).data.events
    expect(events.map(item => item.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('没有事件日志的会话交回空数组,而不是错误', async () => {
    const { dispatchRpc, registerSessionEventsRpcDomain } = await loadDomain()
    unregister = registerSessionEventsRpcDomain()

    const response = await dispatchRpc({
      domain: 'sessionEvents',
      method: 'list',
      payload: { sessionId: 'never-existed' },
    })

    expect(response).toEqual({ ok: true, data: { events: [] } })
  })

  it('inspectCall 把历史调用解析到「当时那份」schema,而不是今天那份', async () => {
    const { dispatchRpc, registerSessionEventsRpcDomain } = await loadDomain()
    unregister = registerSessionEventsRpcDomain()

    const older = await dispatchRpc({
      domain: 'sessionEvents',
      method: 'inspectCall',
      payload: { sessionId: SESSION_ID, callId: 'call-old' },
    })
    const newer = await dispatchRpc({
      domain: 'sessionEvents',
      method: 'inspectCall',
      payload: { sessionId: SESSION_ID, callId: 'call-new' },
    })

    const oldInspection = (older as { ok: true; data: { inspection: Record<string, unknown> } }).data.inspection
    const newInspection = (newer as { ok: true; data: { inspection: Record<string, unknown> } }).data.inspection

    // 同一个工具,两次调用,两份 schema —— 这就是 E0 那条「记录当时模型看到的世界」。
    expect((oldInspection.schema as { description: string }).description).toBe('旧描述')
    expect((newInspection.schema as { description: string }).description).toBe('新描述')

    // 事实齐全:参数原样、结果、起止时刻(时长永远由消费者现算,这里没有 duration 字段)。
    expect(oldInspection.argumentsRaw).toBe('{"file_path":"/a.ts"}')
    expect(oldInspection.resultPreview).toBe('ok')
    expect(oldInspection.callTime).toBe(1100)
    expect(oldInspection.resultTime).toBe(1350)
    expect(oldInspection).not.toHaveProperty('duration')

    // 没配到 result 的那一笔:有 call 没有 result,不编一个。
    expect(newInspection.resultPreview).toBeUndefined()
    expect(newInspection.resultTime).toBeUndefined()
  })

  it('找不到 callId 时交回 null,不抛错', async () => {
    const { dispatchRpc, registerSessionEventsRpcDomain } = await loadDomain()
    unregister = registerSessionEventsRpcDomain()

    const response = await dispatchRpc({
      domain: 'sessionEvents',
      method: 'inspectCall',
      payload: { sessionId: SESSION_ID, callId: 'nope' },
    })

    expect(response).toEqual({ ok: true, data: { inspection: null } })
  })

  it('带路径分隔符的 sessionId 打不穿会话库', async () => {
    // 信封里的 sessionId 在 server 上来自开放网络。写一份"库外"的日志,
    // 确认它读不到 —— 读到了就说明 `../` 能把读取器指到任意 events.jsonl。
    const outside = path.join(root, 'outside')
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(
      path.join(outside, 'events.jsonl'),
      event({ seq: 1, time: 1, type: 'request/start', data: { requestIndex: 1, messageId: 'x' } }),
      'utf8',
    )

    const { dispatchRpc, registerSessionEventsRpcDomain } = await loadDomain()
    unregister = registerSessionEventsRpcDomain()

    const response = await dispatchRpc({
      domain: 'sessionEvents',
      method: 'list',
      payload: { sessionId: '../outside' },
    })

    expect(response).toEqual({ ok: true, data: { events: [] } })
  })
})
