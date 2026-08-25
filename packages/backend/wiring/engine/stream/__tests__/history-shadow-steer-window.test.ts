/**
 * §15.15:**历史影子的 steer 窗口闸。**
 *
 * `rotateAssistantWriterIdentity` 在 boundary 的同步点就换掉身份,而上一条
 * assistant 的 `isStreaming` 要等消费侧那一半才落成 false。这中间的窗口里,真相侧
 * 现算的 `buildHistoryMessages` 会把上一条 assistant 整条滤掉(`isStreaming`),
 * 投影侧不认这个派生态 —— 比出来差一整轮而**投影没错**。那是窗口的假红。
 *
 * 与 run 断言的 `EndSessionRunInput.shadowGate` 同一条判例:窗口里不比。
 * 记一笔 `skipped['history-steer-window']`(报告打印、不进门),既不算 mismatch
 * 也不算 `historyChecks` —— 这一次请求根本没比。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ sessionsDir: '', storeDir: '' }))

vi.mock('@onething/runtime/storage', async importOriginal => {
  const actual = await importOriginal<typeof import('@onething/runtime/storage')>()
  return {
    ...actual,
    getOnethingSessionsDir: () => state.sessionsDir,
    getOnethingLogDir: () => path.join(state.storeDir, 'log'),
  }
})

const { readSessionShadowStats, resetSessionEventStatsCache } = await import(
  '../../../../session/event-stats.js'
)
const { checkSessionHistoryShadowForRequest } = await import('../history-shadow.js')

const SESSION_ID = 'history-steer-window'

beforeEach(() => {
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-history-steer-'))
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  fs.mkdirSync(path.join(state.sessionsDir, SESSION_ID), { recursive: true })
  fs.writeFileSync(path.join(state.sessionsDir, SESSION_ID, 'meta.json'), '{}')
  resetSessionEventStatsCache()
})

afterEach(() => {
  fs.rmSync(state.storeDir, { recursive: true, force: true })
})

describe('历史影子的 steer 窗口闸(§15.15)', () => {
  it('换锚点还挂着时跳过本次比对,并记一笔 history-steer-window', () => {
    checkSessionHistoryShadowForRequest(SESSION_ID, 'run-1', {
      pendingAssistantRotation: true,
    })

    const stats = readSessionShadowStats()
    expect(stats.skipped['history-steer-window']).toBe(1)
    // 跳过 ≠ 比过:这一次请求既不算 check,也不可能算 mismatch。
    expect(stats.historyChecks).toBe(0)
    expect(stats.mismatches).toBe(0)
  })

  it('窗口之外照常走比对(这条会话没有事件 = 无可比,不记这笔账)', () => {
    checkSessionHistoryShadowForRequest(SESSION_ID, 'run-1')
    checkSessionHistoryShadowForRequest(SESSION_ID, 'run-1', {
      pendingAssistantRotation: false,
    })

    const stats = readSessionShadowStats()
    expect(stats.skipped['history-steer-window']).toBeUndefined()
    expect(stats.mismatches).toBe(0)
  })
})
