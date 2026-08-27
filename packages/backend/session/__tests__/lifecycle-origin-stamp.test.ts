/**
 * **`session/created` 的产地印章落在写侧**(§17.7 #2+#1)。
 *
 * 核心那半边(指纹是路径的纯函数、三栏判定)在
 * `core/session/__tests__/session-origin.test.ts`。这里只问写侧的三件:
 *
 *  1. 印章**真的落进了事件**(单门之后它必经写入口,所以没有"另一扇门没盖章"的缝);
 *  2. **四条泳道各自正确** —— 换一个 store 就换一个印章(desktop / server / 夹具
 *     store 在真机上就是三个不同的路径,battery 的临时 store 是第四个);
 *  3. vitest 进程带 `host:'test'` —— 夹具沉积最大的来源,写侧零接线就认得出来。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatSession } from '@shared/ipc.js'
import { sessionOriginFingerprint } from '@onething/core/session'

const state = vi.hoisted(() => ({ storePath: '', written: [] as { type: string; data: unknown }[] }))

vi.mock('@onething/runtime/storage', () => ({
  getOnethingStorePath: () => state.storePath,
  getOnethingLogDir: () => state.storePath,
}))

vi.mock('../event-writer.js', () => ({
  writeSessionEvent: (_sessionId: string, type: string, data: unknown) => {
    state.written.push({ type, data })
    return state.written.length
  },
}))

vi.mock('../event-surface.js', () => ({
  isSessionTranslationEnabled: () => true,
  sessionSurface: () => ({ order: () => [], seqOf: () => undefined }),
}))

const { sessionLifecycleEvents } = await import('../lifecycle-events.js')

function session(id: string): ChatSession {
  return { id, name: id, messages: [], createdAt: 0, updatedAt: 0 } as unknown as ChatSession
}

function stampOf(): { store?: string; host?: string } | undefined {
  const created = state.written.find(entry => entry.type === 'session/created')
  return (created?.data as { origin?: { store?: string; host?: string } } | undefined)?.origin
}

beforeEach(() => {
  state.written = []
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('session/created 的产地印章', () => {
  it('印章落进事件,而且是那个 store 路径的指纹', () => {
    state.storePath = '/Users/someone/.onething'
    sessionLifecycleEvents.sessionCreated(session('s1'))

    expect(stampOf()?.store).toBe(sessionOriginFingerprint('/Users/someone/.onething'))
    // **不写路径进账本**:整条事件里认不出家目录的任何一段。
    expect(JSON.stringify(state.written)).not.toContain('someone')
  })

  it('四条泳道:换一个 store 就换一个印章(缓存按路径分,不是每进程一次)', () => {
    const lanes = [
      '/Users/someone/.onething',
      '/srv/onething-store',
      '/var/folders/2m/T/onething-shadow-battery-abc',
      '/var/folders/2m/T/onething-fixture-xyz',
    ]
    const stamps = lanes.map(lane => {
      state.written = []
      state.storePath = lane
      sessionLifecycleEvents.sessionCreated(session('s1'))
      return stampOf()?.store
    })

    expect(stamps).toEqual(lanes.map(sessionOriginFingerprint))
    expect(new Set(stamps).size).toBe(lanes.length)
  })

  it('vitest 进程带 host:test —— 夹具的产地零接线就认得出来', () => {
    state.storePath = '/Users/someone/.onething'
    sessionLifecycleEvents.sessionCreated(session('s1'))
    expect(stampOf()?.host).toBe('test')
  })
})
