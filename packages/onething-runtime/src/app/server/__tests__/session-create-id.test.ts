import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createLocalServerSessionStore,
  type OnethingServerRuntime,
} from '../runtime.js'
import { createTestServerRuntime } from './test-helpers.js'

// 方案 A 防回归:sessions.create 接受客户端指定的 session id(renderer 的
// draft id 即未来的正式 id),但只认纯 v4 UUID(id 会成为存储路径段),
// 且拒绝已存在的 id —— 不得静默改配新 id 或收养既有会话。

const runtimes: OnethingServerRuntime[] = []
const tempDirs: string[] = []
const originalOnethingStorePath = process.env.ONETHING_STORE_PATH

interface CreateResult {
  success: boolean
  error?: string
  session?: { id: string; name: string }
}

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onething-session-create-id-'))
  tempDirs.push(dir)
  process.env.ONETHING_STORE_PATH = dir
})

afterEach(async () => {
  await Promise.all(runtimes.map(runtime => runtime.shutdown()))
  runtimes.length = 0
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  if (originalOnethingStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = originalOnethingStorePath
})

async function createRuntime() {
  const sessionStore = createLocalServerSessionStore(process.env.ONETHING_STORE_PATH!)
  const serverRuntime = await createTestServerRuntime({ sessionStore })
  runtimes.push(serverRuntime)
  return serverRuntime.runtime
}

describe('sessions.create with a client-supplied id', () => {
  it('persists the session under the requested v4 UUID', async () => {
    const runtime = await createRuntime()
    const requested = '0f1e2d3c-4b5a-4678-89ab-cdef01234567'

    const created = await runtime.sessions.create('My Draft', undefined, requested) as CreateResult

    expect(created.success).toBe(true)
    expect(created.session?.id).toBe(requested)
  })

  it('refuses ids that are not plain v4 UUIDs', async () => {
    const runtime = await createRuntime()

    for (const bad of ['../escape', 'draft:abc', 'web-123', 'not-a-uuid', '0f1e2d3c-4b5a-1678-89ab-cdef01234567']) {
      const created = await runtime.sessions.create('My Draft', undefined, bad) as CreateResult
      expect(created.success, `id "${bad}" should be refused`).toBe(false)
    }
  })

  it('refuses an id that already exists instead of adopting the session', async () => {
    const runtime = await createRuntime()
    const requested = '0f1e2d3c-4b5a-4678-89ab-cdef01234567'

    const first = await runtime.sessions.create('First', undefined, requested) as CreateResult
    expect(first.success).toBe(true)

    const second = await runtime.sessions.create('Second', undefined, requested) as CreateResult
    expect(second.success).toBe(false)
  })

  it('still generates its own id when none is supplied', async () => {
    const runtime = await createRuntime()
    const created = await runtime.sessions.create('Plain') as CreateResult
    expect(created.success).toBe(true)
    expect(created.session?.id).toBeTruthy()
  })
})
