import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_ID } from '@shared/ipc.js'
import {
  agentExists,
  createAgent,
  defaultAgent,
  deleteAgent,
  displayAgent,
  findAgent,
  getAgent,
  initializeAgents,
  invalidateAgentsCache,
  listAgents,
  requireAgent,
  updateAgent,
} from '../store-bound.wiring.js'
import {
  getOnethingAgentsPath,
} from '@onething/runtime/storage'
import { captureRuntimeLogs } from '@onething/runtime/logging'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
  },
}))

let previousHome: string | undefined
let tempHome: string

beforeEach(() => {
  previousHome = process.env.HOME
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-agents-test-'))
  process.env.HOME = tempHome
  // The module is a process-wide singleton with a memory cache; each test
  // moves the store root, so the cache from the previous one must go.
  invalidateAgentsCache()
})

afterEach(() => {
  process.env.HOME = previousHome
  fs.rmSync(tempHome, { recursive: true, force: true })
})

describe('agent store', () => {
  it('initializes with a protected Default Agent', async () => {
    // Reads no longer write; the boot-time initialize is what lands the file.
    await initializeAgents()
    const agents = listAgents()

    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({
      id: DEFAULT_AGENT_ID,
      name: 'Default Agent',
      systemPrompt: '',
      isDefault: true,
    })
    expect(JSON.parse(fs.readFileSync(getOnethingAgentsPath(), 'utf-8')).agents[0]).toMatchObject({
      id: DEFAULT_AGENT_ID,
      isDefault: true,
    })
    expect(findAgent('missing')).toBeNull()
    expect(agentExists(DEFAULT_AGENT_ID)).toBe(true)
    expect(() => deleteAgent(DEFAULT_AGENT_ID)).toThrow('Default Agent cannot be deleted')
  })

  it('creates, updates, persists, and deletes custom agents', () => {
    const created = createAgent({
      id: 'agent-research',
      name: 'Research',
      systemPrompt: 'Prefer concise source-backed answers.',
    })

    expect(created.id).toBe('agent-research')
    expect(agentExists(created.id)).toBe(true)

    const updated = updateAgent({
      agentId: created.id,
      name: 'Research Lead',
      systemPrompt: 'Ask one clarifying question before deep research.',
    })

    expect(updated.name).toBe('Research Lead')
    expect(updated.systemPrompt).toContain('clarifying question')
    expect(JSON.parse(fs.readFileSync(getOnethingAgentsPath(), 'utf-8')).agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'agent-research',
          name: 'Research Lead',
        }),
      ]),
    )

    deleteAgent(created.id)

    expect(agentExists(created.id)).toBe(false)
    expect(listAgents().map(agent => agent.id)).toEqual([DEFAULT_AGENT_ID])
  })
})

/**
 * A1(M4):装配层的四个包装是每个 host 真正 import 的那一面 —— 这里只盯
 * 「转发对了、类型转换没把哪一态弄丢」,规则本身在产品层 store 的测试里。
 */
describe('agent store: 解析纪律三态 API', () => {
  it('findAgent / requireAgent:命中返回本人,查无此人 null 或 throw', () => {
    createAgent({ id: 'agent-a', name: 'A' })

    expect(findAgent('agent-a')?.name).toBe('A')
    expect(requireAgent('agent-a').name).toBe('A')
    expect(findAgent('ghost')).toBeNull()
    expect(findAgent(undefined)).toBeNull()
    expect(() => requireAgent('ghost')).toThrow(/ghost/)
  })

  it('displayAgent:未知 id 拿墓碑而不是 default 的名字', () => {
    expect(displayAgent('ghost')).toEqual({
      id: 'ghost',
      name: '已注销',
      kind: 'colleague',
      status: 'retired',
    })
    expect(displayAgent(DEFAULT_AGENT_ID).name).toBe('Default Agent')
  })

  it('defaultAgent:功能兜底显式化;deprecated getAgent 仍是 find ?? default', () => {
    // 埋点已经不是 console 的副作用,而是一条记录(L4)。
    const logs = captureRuntimeLogs()

    expect(defaultAgent().id).toBe(DEFAULT_AGENT_ID)
    expect(getAgent('ghost').id).toBe(DEFAULT_AGENT_ID)
    expect(logs.ofLevel('warn').length).toBeGreaterThan(0)

    logs.restore()
  })
})
