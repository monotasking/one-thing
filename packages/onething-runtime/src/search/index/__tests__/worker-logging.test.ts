/**
 * Worker 的日志出口与宿主那一侧的重发(2026-09-17)。
 *
 * 病历:这条线程里 `setRuntimeLoggerRoot()` 从来没有人调过,于是产品层的兜底 root
 * 生效 —— 一只 200 条的内存环,线程一死就没了。09-17 用户真机上
 * `semantic recall turned itself off` 那句话就是这么丢的,而设置页正写着「原因在
 * 日志里」。四条判据一条对一段。
 */

import { describe, expect, it } from 'vitest'
import type { LogRecord } from '@onething/core/logging'

import { captureRuntimeLogs, getLogger } from '../../../logging/index.js'
import type { IndexEndpoint } from '../worker-core.js'
import { IndexWorkerHost, type IndexWorkerHandle } from '../worker-host.js'
import {
  WORKER_LOG_MESSAGE_TYPE,
  WORKER_LOG_THREAD_FIELD,
  createWorkerLogSink,
  installWorkerLogging,
  isWorkerLogMessage,
  workerLogLevelOf,
} from '../worker-logging.js'

describe('Worker 侧的 postMessage sink', () => {
  it('① 一条记录整条发出去,`err` 与 `fields` 都在', () => {
    const sent: unknown[] = []
    const restore = installWorkerLogging(value => { sent.push(value) })
    try {
      getLogger('search.index.vector').warn(
        'semantic recall turned itself off',
        undefined,
        new TypeError('fetch failed'),
      )
    } finally {
      restore()
    }

    expect(sent.length).toBe(1)
    const frame = sent[0]
    expect(isWorkerLogMessage(frame)).toBe(true)
    if (!isWorkerLogMessage(frame)) return
    expect(frame.record.ns).toBe('search.index.vector')
    expect(frame.record.level).toBe('warn')
    expect(frame.record.msg).toBe('semantic recall turned itself off')
    expect(frame.record.err?.message).toBe('fetch failed')
  })

  it('② Worker 侧不过滤:`debug` 也发得出去(等级由宿主那一份 spec 说了算)', () => {
    const sent: unknown[] = []
    const restore = installWorkerLogging(value => { sent.push(value) })
    try {
      getLogger('search.index.worker').debug('a quiet line')
    } finally {
      restore()
    }
    expect(sent.length).toBe(1)
  })

  it('③ 结构化克隆过不去的 fields 不许把这条记录弄丢', () => {
    const sent: unknown[] = []
    let firstAttempt = true
    const sink = createWorkerLogSink(value => {
      if (firstAttempt) { firstAttempt = false; throw new DOMException('could not be cloned') }
      sent.push(value)
    })
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    sink.write({ time: 1, level: 'warn', ns: 'search.index.worker', msg: 'x', fields: cyclic })

    expect(sent.length).toBe(1)
    const frame = sent[0]
    expect(isWorkerLogMessage(frame)).toBe(true)
    if (!isWorkerLogMessage(frame)) return
    expect(typeof frame.record.fields?.serialized).toBe('string')
  })

  it('④ 守卫逐格验,不是只看 type', () => {
    expect(isWorkerLogMessage({ type: 'log', record: { ns: 'a', msg: 'b', level: 'warn', time: 0 } })).toBe(true)
    expect(isWorkerLogMessage({ type: 'log' })).toBe(false)
    expect(isWorkerLogMessage({ type: 'log', record: { ns: 'a', msg: 'b', level: 'shout', time: 0 } })).toBe(false)
    expect(isWorkerLogMessage({ id: 1, ok: true, result: null })).toBe(false)
    expect(isWorkerLogMessage(undefined)).toBe(false)
    expect(workerLogLevelOf({ time: 0, level: 'error', ns: 'a', msg: 'b' })).toBe('error')
    expect(workerLogLevelOf({ time: 0, level: 'shout' as LogRecord['level'], ns: 'a', msg: 'b' })).toBe('info')
  })
})

/** 一只只认「收消息」的假 Worker:把宿主装上去的监听交出来,由用例手动喂帧。 */
function fakeHandle(): { handle: IndexWorkerHandle; emit: (value: unknown) => void } {
  const listeners: Array<(value: unknown) => void> = []
  const endpoint: IndexEndpoint = {
    postMessage: () => undefined,
    on: (_event, listener) => { listeners.push(listener) },
  }
  return {
    handle: {
      endpoint,
      onError: () => undefined,
      onExit: () => undefined,
      terminate: () => undefined,
    },
    emit: value => { for (const listener of listeners) listener(value) },
  }
}

describe('宿主侧重发', () => {
  it('⑤ 日志帧按原 ns / 级别 / err 重发,多一格 thread;不被当成没人等的答复扔掉', () => {
    const worker = fakeHandle()
    const host = new IndexWorkerHost(() => worker.handle)
    host.start()

    const logs = captureRuntimeLogs()
    try {
      worker.emit({
        type: WORKER_LOG_MESSAGE_TYPE,
        record: {
          time: 1,
          level: 'warn',
          ns: 'search.index.vector',
          msg: 'semantic recall turned itself off',
          fields: { docs: 3 },
          err: { name: 'TypeError', message: 'fetch failed' },
        } satisfies LogRecord,
      })
      const warns = logs.ofLevel('warn')
      const relayed = warns.find(record => record.msg === 'semantic recall turned itself off')
      expect(relayed).toBeDefined()
      expect(relayed?.ns).toBe('search.index.vector')
      expect(relayed?.fields?.thread).toBe(WORKER_LOG_THREAD_FIELD)
      expect(relayed?.fields?.docs).toBe(3)
      expect(relayed?.err?.message).toBe('fetch failed')
    } finally {
      logs.restore()
      void host.dispose()
    }
  })

  it('⑥ 反证:摘掉日志帧认领,那条记录就掉在地上(旧行为)', () => {
    const worker = fakeHandle()
    const host = new IndexWorkerHost(() => worker.handle)
    host.start()

    const logs = captureRuntimeLogs()
    try {
      // 不带 `type: 'log'` 的一帧 = 旧世界里 Worker 说的每一句话在宿主眼里的样子:
      // 没有 `id`,于是 `inFlight.get(undefined)` 落空,`return` —— 一行都不会出现。
      worker.emit({
        record: { time: 1, level: 'warn', ns: 'search.index.vector', msg: 'dropped on the floor' },
      })
      expect(logs.records().some(record => record.msg === 'dropped on the floor')).toBe(false)
    } finally {
      logs.restore()
      void host.dispose()
    }
  })
})
