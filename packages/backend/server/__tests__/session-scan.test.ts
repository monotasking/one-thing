import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createLocalServerSessionStore,
  type OnethingServerRuntime,
} from '../runtime.js'
import { createTestServerRuntime } from './test-helpers.js'

// P1′ 防回归:server 运行时不允许在创建 / 列表 / 取会话路径上做
// 全量会话扫描(sessionStore.getSessions),会话列表必须走 index 元数据,
// 存量条目的所有权字段由 store 创建时一次性回填。

const runtimes: OnethingServerRuntime[] = []
const tempDirs: string[] = []
const originalOnethingStorePath = process.env.ONETHING_STORE_PATH

async function createTempStore(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'onething-session-scan-'))
  tempDirs.push(dir)
  return dir
}

beforeEach(async () => {
  process.env.ONETHING_STORE_PATH = await createTempStore()
})

afterEach(async () => {
  await Promise.all(runtimes.map(runtime => runtime.shutdown()))
  runtimes.length = 0
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  if (originalOnethingStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = originalOnethingStorePath
})

async function seedLegacySession(
  storePath: string,
  sessionId: string,
  owner?: { userId: string; workspaceId: string },
): Promise<void> {
  const sessionsDir = join(storePath, 'sessions')
  await mkdir(sessionsDir, { recursive: true })
  await writeFile(join(sessionsDir, `${sessionId}.json`), JSON.stringify({
    id: sessionId,
    name: `Session ${sessionId}`,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    messages: [],
    ...owner,
  }), 'utf-8')
}

async function seedIndex(storePath: string, sessionIds: string[]): Promise<void> {
  const sessionsDir = join(storePath, 'sessions')
  await mkdir(sessionsDir, { recursive: true })
  await writeFile(join(sessionsDir, 'index.json'), JSON.stringify(sessionIds.map(id => ({
    id,
    name: `Session ${id}`,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  }))), 'utf-8')
}

interface ListResult {
  success: boolean
  sessions: Array<{ id: string } & Record<string, unknown>>
}

interface SessionResult {
  success: boolean
  session?: { id: string }
}

describe('server session scan regression guards', () => {
  it('never calls the full getSessions scan during runtime creation, list, create, or get', async () => {
    const storePath = process.env.ONETHING_STORE_PATH!
    await seedLegacySession(storePath, 's-existing')
    await seedIndex(storePath, ['s-existing'])

    const sessionStore = createLocalServerSessionStore(storePath)
    const fullScanSpy = vi.spyOn(sessionStore, 'getSessions')

    const serverRuntime = await createTestServerRuntime({ sessionStore })
    runtimes.push(serverRuntime)
    const runtime = serverRuntime.runtime

    const list = await runtime.sessions.list() as ListResult
    expect(list.success).toBe(true)
    expect(list.sessions.map(session => session.id)).toContain('s-existing')

    const created = await runtime.sessions.create('新会话') as SessionResult
    expect(created.success).toBe(true)

    // P4c 第五批:`runtime.sessions.get` 随会话域迁走了(REST 那条路已删),
    // 但「按 id 取会话不许触发全量扫描」这条防回归仍然要守 —— 直接对着 store
    // 的取会话面问,它正是从前那个 facade 方法背后的同一条路。
    expect(sessionStore.getSession(created.session!.id)?.id).toBe(created.session!.id)
    expect(sessionStore.getSession('s-existing')?.id).toBe('s-existing')

    expect(fullScanSpy).not.toHaveBeenCalled()
  })

  it('backfills ownership into the index once and filters lists by owner metadata', async () => {
    const storePath = process.env.ONETHING_STORE_PATH!
    await seedLegacySession(storePath, 's-free')
    await seedLegacySession(storePath, 's-owned', { userId: 'u1', workspaceId: 'w1' })
    await seedIndex(storePath, ['s-free', 's-owned'])

    const sessionStore = createLocalServerSessionStore(storePath)
    const metas = sessionStore.getSessionsList() as Array<
      { id: string; userId?: string; workspaceId?: string; ownerVersion?: number }
    >
    expect(metas).toHaveLength(2)
    for (const meta of metas) expect(meta.ownerVersion).toBe(1)
    expect(metas.find(meta => meta.id === 's-owned')).toMatchObject({ userId: 'u1', workspaceId: 'w1' })
    expect(metas.find(meta => meta.id === 's-free')?.userId).toBeUndefined()

    // 回填只跑一次:重开 store 不再触发会话体读取。
    const secondStore = createLocalServerSessionStore(storePath)
    const secondSpy = vi.spyOn(secondStore, 'getSession')
    expect((secondStore.getSessionsList() as typeof metas).every(meta => meta.ownerVersion === 1)).toBe(true)
    expect(secondSpy).not.toHaveBeenCalled()

    // 默认上下文的列表只看到无主会话;u1 的会话被元数据过滤掉,且无需加载消息体。
    const serverRuntime = await createTestServerRuntime({ sessionStore: secondStore })
    runtimes.push(serverRuntime)
    const list = await serverRuntime.runtime.sessions.list() as ListResult
    expect(list.success).toBe(true)
    const ids = list.sessions.map(session => session.id)
    expect(ids).toContain('s-free')
    expect(ids).not.toContain('s-owned')
    const listedFree = list.sessions.find(session => session.id === 's-free') as Record<string, unknown>
    expect(listedFree.userId).toBeUndefined()
    expect(listedFree.ownerVersion).toBeUndefined()
  })
})
