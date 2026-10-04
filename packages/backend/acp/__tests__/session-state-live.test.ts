import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ACPClient } from '../acp-client.js'
import { MemoryACPSessionLinkStore } from '../acp-session-links.js'
import type { ACPAgentConfig, ACPAgentState, AcpSessionState } from '@shared/contracts/acp.js'

/**
 * 会话状态不靠 prompt 队列(A0-2,§3.3)。夹具是真子进程的 ACP agent;`FAKE_AGENT_PUSH_COMMANDS=1`
 * 让它在 `session/new` 答完之后、**没有任何 prompt 在飞时**推一条 `available_commands_update`。
 * 从前这条通知在「没有队列」那一步被扔掉;现在它得出现在 `getSessionState` 里,并广播一次。
 */

const AGENT = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url))

let root: string
let agentDir: string

function config(): ACPAgentConfig {
  return {
    id: 'fake',
    name: 'Fake',
    enabled: true,
    command: process.execPath,
    args: [AGENT],
    env: { FAKE_AGENT_DIR: agentDir, FAKE_AGENT_CAPS: 'none', FAKE_AGENT_PUSH_COMMANDS: '1' },
    connectTimeoutMs: 10_000,
  } as ACPAgentConfig
}

function pushedCommands(): boolean {
  try {
    return readFileSync(join(agentDir, 'calls.log'), 'utf8').includes('"pushed-commands"')
  } catch {
    return false
  }
}

async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'acp-state-'))
  agentDir = join(root, 'agent')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('ACP 会话状态(prompt 之外的通知)', () => {
  it('session/new 之后推来的命令表折进状态,不等任何 prompt', async () => {
    const client = new ACPClient(config(), { getSessionLinks: () => new MemoryACPSessionLinkStore() })
    const broadcasts: AcpSessionState[] = []
    const agentStates: ACPAgentState[] = []
    client.onSessionStateChanged(state => broadcasts.push(state))
    client.onAgentStateChanged(state => agentStates.push(state))
    try {
      await client.openLocalSession('local-1', root)
      // agent 写完「已推」那一行时通知已经发出;再给读循环一小段时间处理完。
      await until(pushedCommands)
      await until(() => (client.getSessionState('local-1')?.commands.length ?? 0) > 0)

      const state = client.getSessionState('local-1')!
      expect(state.commands).toEqual([{ name: 'review', description: 'Review the diff', inputHint: 'path' }])
      // 会话答复里带的初值也在:模式与选项。
      expect(state.modes?.current).toBe('ask')
      expect(state.configOptions.map(option => option.id)).toEqual(['model'])
      expect(state.process.status).toBe('connected')
      expect(typeof state.process.pid).toBe('number')
      expect(broadcasts.at(-1)).toBe(state)
      expect(agentStates.map(s => s.status)).toContain('connected')
    } finally {
      await client.disconnect()
    }
    // 断开:状态表留着,进程格改成 disconnected,并各广播一次。
    expect(client.getSessionState('local-1')?.process).toEqual({ status: 'disconnected' })
    expect(agentStates.at(-1)?.status).toBe('disconnected')
  })
})
