import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ACPClient } from '../client.js'
import { MemoryACPSessionLinkStore } from '../session-links.js'
import type { ACPPromptStreamEvent } from '../types.js'
import type { ACPAgentConfig } from '@shared/contracts/acp.js'

/**
 * A2-b 的两件客户端事,对真子进程的假 agent:
 *  - 一轮的 `finish` 带着折好的用量(思考 / 缓存 / 这一轮的报价 / 类目 `acp`);累计成本第二轮只报增量。
 *  - `setSessionMode` 真发 `session/set_mode`,新模式立刻在状态表里,agent 推的回流不多发一帧。
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
    env: { FAKE_AGENT_DIR: agentDir, FAKE_AGENT_CAPS: 'none', FAKE_AGENT_USAGE: '1' },
    connectTimeoutMs: 10_000,
  } as ACPAgentConfig
}

function calls(): Array<Record<string, unknown>> {
  try {
    return readFileSync(join(agentDir, 'calls.log'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch {
    return []
  }
}

async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function finishOf(client: ACPClient, prompt: string): Promise<Extract<ACPPromptStreamEvent, { type: 'finish' }>> {
  let finish: Extract<ACPPromptStreamEvent, { type: 'finish' }> | undefined
  for await (const event of client.streamPrompt({ localSessionId: 'local-1', prompt, cwd: root })) {
    if (event.type === 'finish') finish = event
  }
  if (!finish) throw new Error('no finish')
  return finish
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'acp-a2b-'))
  agentDir = join(root, 'agent')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('ACP A2-b 客户端', () => {
  it('finish 带折好的用量;累计成本按增量报', async () => {
    const client = new ACPClient(config(), { getSessionLinks: () => new MemoryACPSessionLinkStore() })
    try {
      const first = await finishOf(client, '@usage one')
      expect(first.usage).toEqual({
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 150,
        reasoningTokens: 30,
        cacheReadTokens: 40,
        providerCostUSD: 0.25,
        usageSource: 'acp',
      })
      expect(client.getSessionState('local-1')?.usage).toEqual({ used: 1234, size: 200000, cost: { amount: 0.25, currency: 'USD' } })

      const second = await finishOf(client, '@usage two')
      expect(second.usage?.providerCostUSD).toBe(0.25)

      // 没带 usage 的一轮:没有用量,不编。
      const plain = await finishOf(client, 'hello')
      expect(plain.usage).toBeUndefined()
    } finally {
      await client.disconnect()
    }
  })

  it('setSessionMode 发 session/set_mode,新模式立刻折进状态表', async () => {
    const client = new ACPClient(config(), { getSessionLinks: () => new MemoryACPSessionLinkStore() })
    const modes: Array<string | undefined> = []
    client.onSessionStateChanged(state => modes.push(state.modes?.current))
    try {
      await client.openLocalSession('local-1', root)
      expect(client.getSessionState('local-1')?.modes?.current).toBe('ask')
      const state = await client.setSessionMode('local-1', root, 'code')
      expect(state?.modes).toEqual({ current: 'code', available: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }] })
      expect(calls().find(call => call.method === 'set-mode')).toMatchObject({ modeId: 'code' })
      // agent 随后推的 `current_mode_update` 与我们折的是同一格:不多发一帧。
      await until(() => calls().some(call => call.method === 'pushed-mode'))
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(modes.filter(mode => mode === 'code')).toHaveLength(1)
    } finally {
      await client.disconnect()
    }
  })
})
