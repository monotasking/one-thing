import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { LogRecord, LogSink } from '@onething/core/logging'
import { MAX_LOG_MSG_LENGTH, MAX_LOG_RECORDS_PER_APPEND } from '@shared/ipc/logs.js'
import type { RpcDispatchContext } from '@shared/ipc/rpc.js'
import { getRootLogger } from '../../logging/index.js'
import { logsRpcHandlers } from '../domains/logs.js'

class CaptureSink implements LogSink {
  readonly records: LogRecord[] = []
  write(record: LogRecord): void {
    this.records.push(record)
  }
}

const HTTP_CONTEXT: RpcDispatchContext = {
  transport: 'http',
  ownerUid: 'owner-1',
  workspaceId: 'ws-1',
  sandboxRoot: '/tmp/ws',
}

describe('logs RPC domain', () => {
  let sink: CaptureSink
  let dispose: () => void

  beforeEach(() => {
    sink = new CaptureSink()
    dispose = getRootLogger().addSink(sink)
    getRootLogger().setLevelSpec('trace')
  })

  afterEach(() => {
    dispose()
    getRootLogger().setLevelSpec('info')
  })

  it('prefixes the namespace with renderer. and stamps src=renderer', async () => {
    const result = await logsRpcHandlers.append({
      records: [{ level: 'info', ns: 'chat-store', msg: 'session opened', fields: { sessionId: 's1' } }],
    })

    expect(result).toEqual({ accepted: 1, rejected: 0 })
    const record = sink.records.at(-1)!
    expect(record.ns).toBe('renderer.chat-store')
    expect(record.src).toBe('renderer')
    expect(record.msg).toBe('session opened')
    expect(record.fields).toMatchObject({ sessionId: 's1', transport: 'ipc' })
  })

  it('does not double-prefix a namespace that already says renderer', async () => {
    await logsRpcHandlers.append({ records: [{ level: 'info', ns: 'renderer.crash', msg: 'x' }] })
    expect(sink.records.at(-1)!.ns).toBe('renderer.crash')
  })

  it('stamps the caller from the dispatch context, never from the envelope', async () => {
    await logsRpcHandlers.append(
      // 信封里塞的 ownerUid 是攻击者可控的 —— 它只是普通 field,会被 context 覆盖。
      { records: [{ level: 'warn', ns: 'x', msg: 'y', fields: { ownerUid: 'spoofed', transport: 'ipc' } }] },
      HTTP_CONTEXT,
    )
    const record = sink.records.at(-1)!
    expect(record.fields).toMatchObject({ transport: 'http', ownerUid: 'owner-1', workspaceId: 'ws-1' })
  })

  it('rebuilds the error object rather than trusting a free-form field', async () => {
    await logsRpcHandlers.append({
      records: [{ level: 'error', ns: 'svc', msg: 'load failed', err: { name: 'TypeError', message: 'nope', stack: 'TypeError: nope\n  at x' } }],
    })
    const record = sink.records.at(-1)!
    expect(record.err).toEqual({ name: 'TypeError', message: 'nope', stack: 'TypeError: nope\n  at x' })
  })

  it('rejects records with an illegal level instead of guessing one', async () => {
    const result = await logsRpcHandlers.append({
      records: [
        { level: 'info', ns: 'a', msg: 'kept' },
        { level: 'shout' as never, ns: 'a', msg: 'dropped' },
      ],
    })
    expect(result).toEqual({ accepted: 1, rejected: 1 })
    expect(sink.records.map(record => record.msg)).toEqual(['kept'])
  })

  it('caps the batch and reports the rest as rejected', async () => {
    const records = Array.from({ length: MAX_LOG_RECORDS_PER_APPEND + 5 }, (_, index) => ({
      level: 'debug' as const,
      ns: 'flood',
      msg: `m${index}`,
    }))
    const result = await logsRpcHandlers.append({ records })
    expect(result).toEqual({ accepted: MAX_LOG_RECORDS_PER_APPEND, rejected: 5 })
  })

  it('truncates an oversized msg', async () => {
    await logsRpcHandlers.append({ records: [{ level: 'info', ns: 'a', msg: 'x'.repeat(MAX_LOG_MSG_LENGTH + 500) }] })
    const record = sink.records.at(-1)!
    expect(record.msg.length).toBeLessThan(MAX_LOG_MSG_LENGTH + 20)
    expect(record.msg.endsWith('[truncated]')).toBe(true)
  })

  it('sanitizes a hostile namespace down to dotted identifier chars', async () => {
    await logsRpcHandlers.append({ records: [{ level: 'info', ns: '../../etc/passwd', msg: 'x' }] })
    expect(sink.records.at(-1)!.ns).toBe('renderer.etcpasswd')
  })

  it('records backpressure loss as its own warn — dropping must never be silent', async () => {
    await logsRpcHandlers.append({ records: [{ level: 'info', ns: 'a', msg: 'kept' }], dropped: 7 })
    const warn = sink.records.at(-1)!
    expect(warn.level).toBe('warn')
    expect(warn.ns).toBe('renderer.log')
    expect(warn.fields).toMatchObject({ dropped: 7 })
  })

  it('tolerates a malformed envelope without throwing', async () => {
    await expect(logsRpcHandlers.append({ records: undefined as never })).resolves.toEqual({
      accepted: 0,
      rejected: 0,
    })
  })
})
