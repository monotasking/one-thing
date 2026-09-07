/**
 * 删会话的**盘上级联** —— 会话目录外面还住着东西。
 *
 * 轮次轨迹写在 `evals/traces/<sessionId>/<turnId>/round-<n>.json`,不在
 * `sessions/<id>/` 里,所以 `rmSync(sessions/<id>)` 收不掉它;而环形淘汰
 * (`pruneTraceRing`)只按年龄/体积赶人,永远不会因为「这个会话没了」而赶。
 * 不级联的后果不是"多占一点盘",而是**删掉的会话把完整请求体永久留在盘上**。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSessionTraceDir, getTurnTraceDir } from '@onething/runtime/evals/trace-store'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

let previousHome: string | undefined
let tempHome: string
let loadedSessions: typeof import('../sessions.js') | null = null
let sessionsDir = ''
let storeLayer: Awaited<ReturnType<typeof import('../../session/testing/store-layer.js').installStoreSessionLayerForTest>> | undefined

async function loadIsolatedStores(): Promise<typeof import('../sessions.js')> {
  vi.resetModules()
  const paths = await import('@onething/runtime/storage')
  const sessions = await import('../sessions.js')
  loadedSessions = sessions
  paths.ensureOnethingStoreDirs()
  sessionsDir = paths.getOnethingSessionsDir()
  const { installStoreSessionLayerForTest } = await import('../../session/testing/store-layer.js')
  storeLayer = await installStoreSessionLayerForTest()
  return sessions
}

beforeEach(() => {
  previousHome = process.env.HOME
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-delete-cascade-test-'))
  process.env.HOME = tempHome
  loadedSessions = null
})

afterEach(async () => {
  await storeLayer?.dispose()
  storeLayer = undefined
  process.env.HOME = previousHome
  fs.rmSync(tempHome, { recursive: true, force: true })
})

describe('deleteSession 的盘上级联', () => {
  it('会话目录与它的轨迹目录一起消失', async () => {
    const sessions = await loadIsolatedStores()
    sessions.createSession('s-doomed', '要被删的会话')

    const turnDir = getTurnTraceDir('s-doomed', 'turn-1')
    fs.mkdirSync(turnDir, { recursive: true })
    fs.writeFileSync(path.join(turnDir, 'round-1.json'), '{"v":1}', 'utf-8')

    expect(fs.existsSync(path.join(sessionsDir, 's-doomed'))).toBe(true)
    expect(fs.existsSync(turnDir)).toBe(true)

    const result = await storeLayer!.deleteSession('s-doomed')
    expect(result.deletedIds).toContain('s-doomed')

    // 轨迹是同步删的 —— 会话删完那一刻它已经不在了。
    expect(fs.existsSync(getSessionTraceDir('s-doomed'))).toBe(false)
    expect(fs.existsSync(path.join(sessionsDir, 's-doomed'))).toBe(false)
  })

  it('只收自己那一份:别的会话的轨迹原样留着', async () => {
    const sessions = await loadIsolatedStores()
    sessions.createSession('s-doomed', '要被删的会话')
    sessions.createSession('s-keeper', '留着的会话')

    for (const id of ['s-doomed', 's-keeper']) {
      const turnDir = getTurnTraceDir(id, 'turn-1')
      fs.mkdirSync(turnDir, { recursive: true })
      fs.writeFileSync(path.join(turnDir, 'round-1.json'), '{"v":1}', 'utf-8')
    }

    await storeLayer!.deleteSession('s-doomed')

    expect(fs.existsSync(getSessionTraceDir('s-doomed'))).toBe(false)
    expect(fs.existsSync(getTurnTraceDir('s-keeper', 'turn-1'))).toBe(true)
  })

  it('没写过轨迹的会话删起来照样不炸', async () => {
    const sessions = await loadIsolatedStores()
    sessions.createSession('s-plain', '没有轨迹')

    await expect(storeLayer!.deleteSession('s-plain')).resolves.toMatchObject({ deletedIds: ['s-plain'] })
    expect(fs.existsSync(getSessionTraceDir('s-plain'))).toBe(false)
  })
})
