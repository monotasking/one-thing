import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { McpServer } from '@agentclientprotocol/sdk'
import { ACPClient } from '../client.js'
import { FileACPSessionLinkStore, type ACPSessionLinkStore } from '../session-links.js'
import type { ACPAgentConfig } from '../types.js'

/**
 * A4-b:`mcpServers` 由开会话的人递进来(连接器 → `ACPManager.openSession` → `ACPClient`),
 * 不再读 agent 配置上的 `mcpServers` 格。真子进程夹具把收到的非空名册记进 calls.log。
 */

const AGENT = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url))

let root: string
let agentDir: string
let cwd: string
let links: ACPSessionLinkStore

const HOST_ENTRY: McpServer = {
  name: 'onething',
  command: '/usr/bin/node',
  args: ['/x/acp-mcp-bridge.cjs'],
  env: [{ name: 'ONETHING_MCP_TOKEN', value: 'tok-1' }],
}

function client(caps: 'load' | 'resume' | 'none', extra: Record<string, unknown> = {}): ACPClient {
  const config = {
    id: 'fake',
    name: 'Fake',
    enabled: true,
    command: process.execPath,
    args: [AGENT],
    env: { FAKE_AGENT_DIR: agentDir, FAKE_AGENT_CAPS: caps },
    connectTimeoutMs: 10_000,
    ...extra,
  } as ACPAgentConfig
  return new ACPClient(config, { getSessionLinks: () => links })
}

function calls(): Array<{ method: string; mcpServers?: unknown[] }> {
  try {
    return readFileSync(join(agentDir, 'calls.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  } catch {
    return []
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'acp-mcp-servers-'))
  agentDir = join(root, 'agent')
  cwd = join(root, 'work')
  links = new FileACPSessionLinkStore(() => join(root, 'store', 'acp', 'session-links.json'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('ACPClient — mcpServers 由开会话的人递(A4-b)', () => {
  it('session/new 带上递进来的名册;配置上退役的 mcpServers 格不再透传', async () => {
    const c = client('load', { mcpServers: [{ name: 'legacy', command: 'nope', args: [], env: [] }] })
    try {
      await c.openLocalSession('local-1', cwd, { mcpServers: [HOST_ENTRY] })
      const opened = calls().filter(call => call.method === 'new')
      expect(opened).toHaveLength(1)
      expect(opened[0]!.mcpServers).toEqual([HOST_ENTRY])
    } finally {
      await c.disconnect()
    }
  })

  it('选项面板先开(没人递名册)→ 连接器带着名册再开:重开一次,经 load 把名册递过去', async () => {
    const c = client('load')
    try {
      await c.getSessionOptions('local-2', cwd)
      await c.openLocalSession('local-2', cwd, { mcpServers: [HOST_ENTRY] })
      // 之后每一轮再带同一份名册都不重开。
      await c.openLocalSession('local-2', cwd, { mcpServers: [HOST_ENTRY] })
      const sessionCalls = calls().filter(call => ['new', 'load', 'resume'].includes(call.method))
      expect(sessionCalls.map(call => call.method)).toEqual(['new', 'load'])
      expect(sessionCalls[0]!.mcpServers).toBeUndefined()
      expect(sessionCalls[1]!.mcpServers).toEqual([HOST_ENTRY])
    } finally {
      await c.disconnect()
    }
  })

  it('断线重连后恢复会话:resume 带的是这一次递进来的名册(新钥匙),不是上一次的', async () => {
    const first = client('resume')
    await first.openLocalSession('local-3', cwd, { mcpServers: [HOST_ENTRY] })
    await first.disconnect()
    const fresh = { ...HOST_ENTRY, env: [{ name: 'ONETHING_MCP_TOKEN', value: 'tok-2' }] } as McpServer
    const second = client('resume')
    try {
      await second.openLocalSession('local-3', cwd, { mcpServers: [fresh] })
      const resumed = calls().filter(call => call.method === 'resume')
      expect(resumed).toHaveLength(1)
      expect(resumed[0]!.mcpServers).toEqual([fresh])
    } finally {
      await second.disconnect()
    }
  })
})
