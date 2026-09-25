import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ACPClient } from '../client.js'
import type { ACPAgentConfig } from '../types.js'

/**
 * 连接断了、进程却没退(A0-1 反证锚):agent 关掉自己的 stdout 之后还活着,客户端必须凭
 * `connection.closed` 就收尾 —— 状态变 error、在飞的 prompt 失败 —— 而不是干等进程 exit。
 * 把 `client.ts` 里 `connection.closed` 那条监听挖掉,这条用例就红(状态停在 connected)。
 */

const AGENT = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url))

let root: string
let agentDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'acp-closed-'))
  agentDir = join(root, 'agent')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function agentPid(): number | undefined {
  try {
    const lines = readFileSync(join(agentDir, 'calls.log'), 'utf8').trim().split('\n')
    const entry = lines.map(line => JSON.parse(line)).find(call => call.method === 'close-on-prompt')
    return entry?.pid
  } catch {
    return undefined
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('agent 关掉连接但进程不退', () => {
  it('状态变 error、在飞的 prompt 失败,不等进程退出', async () => {
    const c = new ACPClient({
      id: 'fake',
      name: 'Fake',
      enabled: true,
      command: process.execPath,
      args: [AGENT],
      env: { FAKE_AGENT_DIR: agentDir, FAKE_AGENT_CAPS: 'load', FAKE_AGENT_CLOSE_ON_PROMPT: '1' },
      connectTimeoutMs: 10_000,
    } as ACPAgentConfig)

    try {
      const startedAt = Date.now()
      const drained = (async () => {
        for await (const _event of c.streamPrompt({ localSessionId: 'local-1', prompt: 'hi', cwd: root })) {
          // 这一轮不会有正文:agent 一收到 prompt 就断了连接。
        }
      })()

      await expect(drained).rejects.toThrow()
      await expect.poll(() => c.status, { timeout: 3000 }).toBe('error')
      expect(c.state.error).toContain('closed its connection')

      // 夹具进程要 10s 后才退;此刻它还活着,说明收尾靠的是连接关闭,不是 exit。
      const pid = agentPid()
      expect(pid).toBeTypeOf('number')
      expect(Date.now() - startedAt).toBeLessThan(5000)
      // 收尾之后客户端会把那个说不上话的进程收掉;给它一点时间,确认没留下孤儿。
      await expect.poll(() => isAlive(pid as number), { timeout: 3000 }).toBe(false)
    } finally {
      await c.disconnect()
    }
  })
})
