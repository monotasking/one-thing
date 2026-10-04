/**
 * 09-02 收紧:`store.renameSession` 把仓层那句「改到了没有」交出来。
 *
 * 仓库里那条布尔只有一个含义 —— `applied: false` ⟺ **查无此会话**
 * (`session/session-store-helpers.ts` 的 `applySessionMetadataMutationWithAdapters`
 * 拿不到 session 就直接回 false,别的分支一条也不产生 false)。从前
 * `session/session-store.ts` 把它吞了,于是「改一条不存在的会话」与「真改了」在上层
 * 完全无法分辨:投影一路回 success,RPC 域据此往总线上推一条 `session:renamed`,
 * 别的客户端就显示一个不存在的名字。
 *
 * 这条用例守的是**布尔本身**(域那一层的用例桩掉了整个仓,吞回去它不会红,
 * 只有这里会)。真店真盘:临时 store、真建一条会话、再改一条不存在的。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ storeDir: '', sessionsDir: '' }))

vi.mock('@onething/backend/storage', async () => {
  const actual = await vi.importActual<typeof import('@onething/backend/storage')>('@onething/backend/storage')
  return {
    ...actual,
    getOnethingSessionsDir: () => state.sessionsDir,
    getOnethingSessionPath: (sessionId: string) => path.join(state.sessionsDir, `${sessionId}.json`),
    getOnethingLogDir: () => path.join(state.storeDir, 'log'),
  }
})

const { createSessionWithoutFocus, flushAllPendingSaves, getSession, getSessionsList, renameSession } =
  await import('../session-store.js')

const SESSION = '9a7b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d'
const MISSING = '00000000-1111-4222-8333-444444444444'
let fixture: Awaited<ReturnType<typeof import('../testing/session-testing-store-layer.js').installStoreSessionLayerForTest>>

beforeEach(async () => {
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-rename-applied-'))
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  fs.mkdirSync(state.sessionsDir, { recursive: true })
  fixture = await (await import('../testing/session-testing-store-layer.js')).installStoreSessionLayerForTest()
})

afterEach(async () => {
  // 建会话会排一次节流异步写;删目录排在它之后,不然就是在跟自己的在途写赛跑
  // (与 sessions-delete-cascade.test.ts 同一句收尾)。
  await flushAllPendingSaves()
  await fixture?.dispose()
  fs.rmSync(state.storeDir, { recursive: true, force: true })
})

describe('store.renameSession 交出「改到了没有」', () => {
  it('改到了回 true,盘上的名字也真的换了', () => {
    createSessionWithoutFocus(SESSION, '旧名字')

    expect(renameSession(SESSION, '新名字')).toBe(true)
    expect(getSession(SESSION)?.name).toBe('新名字')
  })

  it('查无此会话回 false(而不是默默成功)', () => {
    expect(renameSession(MISSING, '新名字')).toBe(false)
    expect(getSession(MISSING)).toBeUndefined()
  })
})

/**
 * ACP A2-b:标题来源 `titleSource`。显式改名的入口递 `'user'`,自动起题的递 `'auto'`,
 * 名字与来源同一趟落进会话体(meta.json 是「除 messages 之外的全部」),列表索引的名字也跟着换。
 * 不递 = 旧行为,不动来源那一格。
 */
describe('store.renameSession 的标题来源(A2-b)', () => {
  it('记下来源,名字照样进列表;不递来源不动那一格', async () => {
    createSessionWithoutFocus(SESSION, '旧名字')
    expect(getSession(SESSION)?.titleSource).toBeUndefined()

    expect(renameSession(SESSION, '人起的', 'user')).toBe(true)
    expect(getSession(SESSION)).toMatchObject({ name: '人起的', titleSource: 'user' })
    expect(getSessionsList().find(meta => meta.id === SESSION)?.name).toBe('人起的')

    expect(renameSession(SESSION, '引擎起的')).toBe(true)
    expect(getSession(SESSION)).toMatchObject({ name: '引擎起的', titleSource: 'user' })

    expect(renameSession(SESSION, 'agent 起的', 'auto')).toBe(true)
    expect(getSession(SESSION)).toMatchObject({ name: 'agent 起的', titleSource: 'auto' })

    await flushAllPendingSaves()
    const meta = JSON.parse(fs.readFileSync(path.join(state.sessionsDir, SESSION, 'meta.json'), 'utf-8'))
    expect(meta).toMatchObject({ name: 'agent 起的', titleSource: 'auto' })
  })

  it('查无此会话仍回 false', () => {
    expect(renameSession(MISSING, 'x', 'user')).toBe(false)
  })
})
