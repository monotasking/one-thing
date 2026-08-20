/**
 * §13.10 M7:`POST /api/sessions/:id/agent` 走的 `sessions.update` 在账本上
 * **不是无声的**。
 *
 * 病根不是"忘了翻译",是**快照取晚了**:`applySessionPatch` 就地改那只会话对象,
 * 而真后端上它正是 app store 里的那一份 —— 等 `persistSession` →
 * `sessionCommands.patchSession` 再回头问"改之前是什么",问到的已经是改之后的
 * 值,于是 agent / model / workdir 三格一条事件都写不出来。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createLocalServerSessionStore,
  type OnethingServerRuntime,
} from '../runtime.js'
import { createTestServerRuntime } from './test-helpers.js'
import { flushSessionEventLog, resetSessionEventLogCache } from '@onething/app/session/event-log.js'
import { resetSessionSurfaceCache } from '@onething/app/session/event-surface.js'
import { resetSessionPrepareCache } from '@onething/app/session/prepare.js'

const runtimes: OnethingServerRuntime[] = []
const tempDirs: string[] = []
const originalOnethingStorePath = process.env.ONETHING_STORE_PATH

const SESSION = '0f1e2d3c-4b5a-4678-89ab-cdef01234567'

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onething-session-agent-event-'))
  tempDirs.push(dir)
  process.env.ONETHING_STORE_PATH = dir
  resetSessionEventLogCache()
  resetSessionSurfaceCache()
  resetSessionPrepareCache()
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

/**
 * 事件账本按"会话目录在不在"启用(`resolveEnabled`)。echo 后端的本地仓库走的是
 * legacy 单文件布局,所以这里把 jsonl 布局那个目录建出来 —— 这条会话因此**在**
 * 账本上,与桌面/真后端同一档。
 */
function enableLedger(): void {
  mkdirSync(join(process.env.ONETHING_STORE_PATH!, 'sessions', SESSION), { recursive: true })
  resetSessionEventLogCache(SESSION)
}

async function ledger(): Promise<Array<{ type: string; data: Record<string, unknown> }>> {
  // 事件写入口是排队的(保序但不同步),读文件之前先把队列刷干净。
  await flushSessionEventLog(SESSION)
  const file = join(process.env.ONETHING_STORE_PATH!, 'sessions', SESSION, 'events.jsonl')
  if (!existsSync(file)) return []
  const text = await readFile(file, 'utf8')
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line))
}

describe('§13.10 M7: sessions.update writes the agent switch to the ledger', () => {
  it('records session/agent-changed with the before value, not the mutated one', async () => {
    const runtime = await createRuntime()
    await runtime.sessions.create('Switch me', undefined, SESSION)
    enableLedger()

    await runtime.sessions.update!(SESSION, { agentId: 'claude-code-agent' })
    await runtime.sessions.update!(SESSION, { agentId: 'another-agent' })

    const changed = (await ledger()).filter(event => event.type === 'session/agent-changed')
    expect(changed.map(event => event.data.to)).toEqual(['claude-code-agent', 'another-agent'])
    // `from` 是**改之前**那一格 —— 快照取晚了的话这里会是 'claude-code-agent'
    // 自己(而整条事件根本不会被写出来)。
    expect(changed[1].data.from).toBe('claude-code-agent')
  })

  it('writes nothing for a patch that touches none of the three fields', async () => {
    const runtime = await createRuntime()
    await runtime.sessions.create('Switch me', undefined, SESSION)
    enableLedger()

    await runtime.sessions.update!(SESSION, { isArchived: true })

    expect((await ledger()).filter(event => event.type.startsWith('session/'))
      .map(event => event.type))
      .not.toContain('session/agent-changed')
  })
})
