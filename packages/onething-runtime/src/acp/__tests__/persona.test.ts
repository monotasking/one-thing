import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ACPClient, acpPersonaBlock } from '../client.js'
import { FileACPSessionLinkStore, type ACPSessionLinkStore } from '../session-links.js'
import type { ACPAgentConfig } from '../types.js'

/**
 * persona 怎么进 ACP agent(A2-a,方案 §3.4)。夹具是真子进程的假 agent,
 * `FAKE_AGENT_RECORD_PROMPT=1` 让它把每轮收到的内容块记下来,`session/new` 的 `_meta` 也记。
 *
 *  - 通用档:会话**第一条** prompt 的第一个 text 块是 `<persona>…</persona>`,第二条起没有;
 *  - 恢复(load)出来的会话:agent 自己有历史,不再送;
 *  - 怪癖档(`quirks.systemPromptMeta: 'claude-agent-acp'`):`session/new._meta.systemPrompt.append`,
 *    首条 prompt 不再带头块。
 */

const AGENT = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url))
const PERSONA = '# Agent: Iris\n\na designer with sharp taste'

let root: string
let agentDir: string
let cwd: string
let links: ACPSessionLinkStore

function config(quirk = false): ACPAgentConfig {
  return {
    id: 'fake',
    name: 'Fake',
    enabled: true,
    command: process.execPath,
    args: [AGENT],
    env: { FAKE_AGENT_DIR: agentDir, FAKE_AGENT_CAPS: 'load', FAKE_AGENT_RECORD_PROMPT: '1' },
    connectTimeoutMs: 10_000,
    ...(quirk ? { quirks: { systemPromptMeta: 'claude-agent-acp' as const } } : {}),
  }
}

async function say(c: ACPClient, localSessionId: string, prompt: string): Promise<void> {
  for await (const _ of c.streamPrompt({ localSessionId, prompt, cwd, persona: PERSONA })) {
    // drain
  }
}

interface Call { method: string; turn?: number; meta?: unknown; blocks?: Array<{ type: string; text?: string }> }

function calls(): Call[] {
  try {
    return readFileSync(join(agentDir, 'calls.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Call)
  } catch {
    return []
  }
}

const promptBlocks = () => calls().filter(call => call.method === 'prompt-blocks').map(call => call.blocks ?? [])

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'acp-persona-'))
  agentDir = join(root, 'agent')
  cwd = join(root, 'work')
  mkdirSync(cwd, { recursive: true })
  links = new FileACPSessionLinkStore(() => join(root, 'store', 'acp', 'session-links.json'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('ACP persona', () => {
  it('新会话:第一条 prompt 以 persona 头块打头,第二条不再带', async () => {
    const client = new ACPClient(config(), { getSessionLinks: () => links })
    try {
      await say(client, 'local-1', 'hello')
      await say(client, 'local-1', 'again')
    } finally {
      await client.disconnect()
    }
    const [first, second] = promptBlocks()
    expect(first).toEqual([
      { type: 'text', text: acpPersonaBlock(PERSONA) },
      { type: 'text', text: 'hello' },
    ])
    expect(second).toEqual([{ type: 'text', text: 'again' }])
    expect(calls().find(call => call.method === 'new')?.meta).toBeUndefined()
  })

  it('恢复(load)出来的会话不再送 persona', async () => {
    const first = new ACPClient(config(), { getSessionLinks: () => links })
    await say(first, 'local-1', 'hello')
    await first.disconnect()
    const second = new ACPClient(config(), { getSessionLinks: () => links })
    try {
      await say(second, 'local-1', 'after restart')
    } finally {
      await second.disconnect()
    }
    expect(calls().map(call => call.method)).toContain('load')
    expect(promptBlocks().at(-1)).toEqual([{ type: 'text', text: 'after restart' }])
  })

  it('claude-agent-acp 怪癖:persona 走 session/new 的 _meta.systemPrompt.append,首条 prompt 不带头块', async () => {
    const client = new ACPClient(config(true), { getSessionLinks: () => links })
    try {
      await say(client, 'local-q', 'hello')
    } finally {
      await client.disconnect()
    }
    expect(calls().find(call => call.method === 'new')?.meta).toEqual({ systemPrompt: { append: PERSONA } })
    expect(promptBlocks()[0]).toEqual([{ type: 'text', text: 'hello' }])
  })
})
