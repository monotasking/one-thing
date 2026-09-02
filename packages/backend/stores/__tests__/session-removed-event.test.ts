/**
 * **删会话的推送**(共享层读侧补齐 E 批)。
 *
 * 三件事各有一条用例,而且三条都不是"顺手加的断言" —— 每一条都对应一个真会把
 * 功能悄悄弄坏的做法:
 *
 * 1. **发在真正删之前**。web 侧的通配订阅逐条问"这条会话你读得到吗";删完再发,
 *    那把尺子只会回 false,推送等于发进黑洞。这条用例在收到事件的那一刻回头看
 *    会话还在不在。
 * 2. **级联的每个 id 各发一条**。归属判据是逐会话问的,合成一条会让被级联掉的
 *    子会话失去自己那次判定。
 * 3. **骑既有的 `session:event` 面**。它是一条**会话事件**(发在自己的 sessionId
 *    上),不是 `emitGlobal` —— 全局那条车道只有进程内的插件听得见,既不进
 *    IPCBridge 也不进 SSE。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_EVENT_TYPES } from '@onething/core/events'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

let previousHome: string | undefined
let tempHome: string
let loadedSessions: typeof import('../sessions.js') | null = null

interface Seen {
  sessionId: string
  event: { type: string; sessionId?: string; cascadedSessionIds?: readonly string[] }
  /** 收到这条的**那一刻**,这条会话还在不在。 */
  stillResolvable: boolean
}

async function loadIsolatedStores() {
  vi.resetModules()
  const paths = await import('@onething/runtime/storage')
  const sessions = await import('../sessions.js')
  const events = await import('../../events/index.js')
  // A2:`vi.resetModules()` 之后连"进程当前实例槽"也是新的一份,所以这里连
  // `current.js` 一起重新 import —— 装进旧那份模块实例的槽,`sessions.ts` 读的
  // 是新那份,`isEventSystemInitialized()` 会答"没有"。
  const current = await import('../../current.js')
  loadedSessions = sessions
  paths.ensureOnethingStoreDirs()
  const { eventBus, streamChannel } = events.createEventSystem()
  current.setCurrentBackend(current.createBackendHandle({ eventBus, streamChannel }))
  return { sessions, eventBus }
}

beforeEach(() => {
  previousHome = process.env.HOME
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-session-removed-test-'))
  process.env.HOME = tempHome
  loadedSessions = null
})

afterEach(async () => {
  await loadedSessions?.flushAllPendingSaves()
  const current = await import('../../current.js')
  current.setCurrentBackend(null)
  process.env.HOME = previousHome
  fs.rmSync(tempHome, { recursive: true, force: true })
})

describe('deleteSession 发 session:removed', () => {
  it('一条独苗:一条事件,发在自己的 sessionId 上,而且此刻会话还在', async () => {
    const { sessions, eventBus } = await loadIsolatedStores()
    sessions.createSession('s-alone', '要被删的')

    const seen: Seen[] = []
    const off = eventBus.onAnySessionAny(envelope => {
      const event = envelope.event as Seen['event']
      if (event.type !== SESSION_EVENT_TYPES.SESSION_REMOVED) return
      seen.push({
        sessionId: envelope.sessionId,
        event,
        stillResolvable: sessions.getSession(envelope.sessionId) !== undefined,
      })
    })

    sessions.deleteSession('s-alone')
    off()

    expect(seen).toHaveLength(1)
    expect(seen[0].sessionId).toBe('s-alone')
    expect(seen[0].event.sessionId).toBe('s-alone')
    expect(seen[0].event.cascadedSessionIds).toEqual(['s-alone'])
    // 这一条就是"必须发在删之前"的证据。
    expect(seen[0].stillResolvable).toBe(true)
  })

  it('级联删子会话:每个 id 各一条,每条都带完整的那批 id', async () => {
    const { sessions, eventBus } = await loadIsolatedStores()
    sessions.createSession('s-parent', '父')
    sessions.createSession('s-child', '子')
    sessions.patchSessionFields('s-child', { parentSessionId: 's-parent' }, meta => {
      ;(meta as { parentSessionId?: string }).parentSessionId = 's-parent'
    })

    const seen: Seen[] = []
    const off = eventBus.onAnySessionAny(envelope => {
      const event = envelope.event as Seen['event']
      if (event.type !== SESSION_EVENT_TYPES.SESSION_REMOVED) return
      seen.push({
        sessionId: envelope.sessionId,
        event,
        stillResolvable: sessions.getSession(envelope.sessionId) !== undefined,
      })
    })

    const result = sessions.deleteSession('s-parent')
    off()

    expect(new Set(result.deletedIds)).toEqual(new Set(['s-parent', 's-child']))
    expect(new Set(seen.map(item => item.sessionId))).toEqual(new Set(['s-parent', 's-child']))
    for (const item of seen) {
      expect(new Set(item.event.cascadedSessionIds)).toEqual(new Set(['s-parent', 's-child']))
      expect(item.stillResolvable).toBe(true)
    }
  })

  /**
   * 预告的那批 id 与 `deleteSession` 事后报的那批 **恒等** —— 两边算的是同一个
   * 纯函数(`collectSessionCascadeDeleteIds`)在同一份索引上的结果,中间没有
   * `await`。这条不变式比"别为不存在的会话发事件"更强,也更好守:真出现分岔时
   * (比如哪天级联规则改了而预告没跟上)它当场红。
   *
   * 顺带钉住那个看起来像 bug 的行为:删一条**根本不存在**的会话时两边**都**把
   * 它算进去(`deleteSession` 的 `deletedIds` 里也有它)。推送如实照搬,不自作
   * 主张多加一道"它存在吗"的过滤 —— 那会让两边不再恒等。
   */
  it('预告的 id 集合与 deleteSession 报的 deletedIds 恒等', async () => {
    const { sessions, eventBus } = await loadIsolatedStores()
    sessions.createSession('s-real', '真的')

    const announced: string[] = []
    const off = eventBus.onAnySessionAny(envelope => {
      if ((envelope.event as { type: string }).type === SESSION_EVENT_TYPES.SESSION_REMOVED) {
        announced.push(envelope.sessionId)
      }
    })

    const real = sessions.deleteSession('s-real')
    expect(new Set(announced)).toEqual(new Set(real.deletedIds))

    announced.length = 0
    const phantom = sessions.deleteSession('never-existed')
    expect(new Set(announced)).toEqual(new Set(phantom.deletedIds))
    off()
  })
})
