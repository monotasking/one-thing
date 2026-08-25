/**
 * U0 的开关(`ONETHING_UI_STREAM`):默认档下 UI 事件**一条都不出生**。
 *
 * 这条门守的是"双发不是白发也不是乱发":legacy 是缺省,renderer 零感知、IPC
 * 流量一个字节都不多;`events` 才把同名同形的小批放上那条既有的流管。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { UiAssistantDeltaChunk } from '@onething/core/events'
import { getStreamChannel, initializeEventSystem, shutdownEventSystem } from '../index.js'
import { isUiEventStreamEnabled, onethingUiStreamMode, pushSessionUiStreamEvent } from '../ui-stream.js'

const SESSION_ID = 'ui-stream-switch'

const DELTA: UiAssistantDeltaChunk = {
  type: 'assistant/delta',
  runId: 'run-1',
  requestIndex: 1,
  messageId: 'assistant-1',
  partIndex: 0,
  kind: 'text',
  turnIndex: 1,
  text: 'hi',
}

let previous: string | undefined

beforeEach(() => {
  previous = process.env.ONETHING_UI_STREAM
  initializeEventSystem()
})

afterEach(() => {
  if (previous === undefined) delete process.env.ONETHING_UI_STREAM
  else process.env.ONETHING_UI_STREAM = previous
  shutdownEventSystem()
})

describe('ONETHING_UI_STREAM', () => {
  it('缺省 = legacy:一条 UI 事件都不推上流管', () => {
    delete process.env.ONETHING_UI_STREAM
    expect(onethingUiStreamMode()).toBe('legacy')
    expect(isUiEventStreamEnabled()).toBe(false)

    const seen: unknown[] = []
    getStreamChannel().subscribe(SESSION_ID, chunk => seen.push(chunk))
    pushSessionUiStreamEvent(SESSION_ID, DELTA)
    expect(seen).toEqual([])
  })

  it('events:与旧 chunk 流并行双发,走的还是那条 session:stream', () => {
    process.env.ONETHING_UI_STREAM = 'events'
    expect(onethingUiStreamMode()).toBe('events')

    const seen: unknown[] = []
    getStreamChannel().subscribe(SESSION_ID, chunk => seen.push(chunk))
    pushSessionUiStreamEvent(SESSION_ID, DELTA)
    expect(seen).toEqual([DELTA])
  })

  it('未知档位按 legacy 走(前向兼容:不认识就不发)', () => {
    process.env.ONETHING_UI_STREAM = 'something-new'
    expect(onethingUiStreamMode()).toBe('legacy')
  })
})
