import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureRuntimeLogs } from '@onething/runtime/logging'
import { ONETHING_DEFAULT_SYSTEM_PROMPT } from '@onething/runtime/prompts'
import type { BuildPromptContextOptions } from '../system-prompt.js'
import {
  buildPrompt,
  loadAgentsMdInstructions,
  registerPromptContextProvider,
} from '../index.js'

const agentStoreMock = vi.hoisted(() => ({
  findAgent: vi.fn(),
}))

vi.mock('../../../agents/index.js', () => ({
  findAgent: agentStoreMock.findAgent,
  defaultAgent: () => agentStoreMock.findAgent(undefined),
  DEFAULT_AGENT_ID: 'default',
}))

const tempDirs: string[] = []

function baseOptions(overrides: Partial<BuildPromptContextOptions> = {}): BuildPromptContextOptions {
  return {
    hasTools: true,
    skills: [],
    workingDirectory: undefined,
    activeProject: { hasActive: false },
    knownProjects: { hasAny: false, entries: [] },
    toolNames: ['read'],
    mcpToolNames: [],
    ...overrides,
  }
}

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-context-'))
  tempDirs.push(dir)
  return dir
}

beforeEach(() => {
  agentStoreMock.findAgent.mockImplementation((agentId?: string) => ({
    id: agentId || 'default',
    name: agentId ? 'Custom Agent' : 'Default Agent',
    systemPrompt: '',
    isDefault: !agentId || undefined,
    createdAt: 1,
    updatedAt: 1,
  }))
})

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('Pi-style prompt builder', () => {
  it('builds a full prompt directly without fragment diff state', async () => {
    const result = await buildPrompt({
      ...baseOptions({
        workingDirectory: '/repo',
        workingDirectoryRoots: ['/repo', '/other'],
        toolNames: ['read', 'edit', 'bash'],
      }),
      providerId: 'openai',
      historyMessages: [{ role: 'user', content: 'hello' }],
    })

    expect(result.systemPrompt).toContain(ONETHING_DEFAULT_SYSTEM_PROMPT)
    expect(result.systemPrompt).not.toContain('Available tools:')
    expect(result.systemPrompt).not.toContain('- read:')
    // Neither the working directory nor the date is in the prefix any more
    // (prompt-channels 2026-08-18): the path is a session fact carried by the
    // `workdir` variable on the board, and the date by `datetime`.
    expect(result.systemPrompt).not.toContain('Current work directory')
    expect(result.systemPrompt).not.toContain('Current date:')
    expect(result.systemPrompt).toContain('## Tool Workspace Rules')
    expect(result.messages[0].role).toBe('system')
    expect(result.messages[result.messages.length - 1]).toEqual({ role: 'user', content: 'hello' })
  })

  it('does not inject todo autonomy or tool usage guidance', async () => {
    const result = await buildPrompt({
      ...baseOptions({
        workingDirectory: '/repo',
        toolNames: ['read', 'todo'],
      }),
      providerId: 'openai',
      historyMessages: [],
    })
    const serialized = JSON.stringify(result.messages)

    expect(serialized).not.toContain('Todo / Notes Autonomy')
    expect(serialized).not.toContain('## Tool Usage')
  })

  it('injects custom Agent system prompts as developer context', async () => {
    agentStoreMock.findAgent.mockReturnValueOnce({
      id: 'agent-research',
      name: 'Research Lead',
      systemPrompt: 'Prioritize crisp, source-backed reasoning.',
      createdAt: 1,
      updatedAt: 1,
    })

    const result = await buildPrompt({
      ...baseOptions({ agentId: 'agent-research' }),
      providerId: 'codex',
      historyMessages: [],
    })

    expect(result.messages.some(message => (
      message.role === 'developer' &&
      String(message.content).includes('Prioritize crisp, source-backed reasoning.')
    ))).toBe(true)
  })

  it('injects speak mode guidance only for voice conversations', async () => {
    const voice = await buildPrompt({
      ...baseOptions({ speakMode: true, voiceConversation: true }),
      providerId: 'codex',
      historyMessages: [],
    })
    const text = await buildPrompt({
      ...baseOptions({ voiceConversation: false }),
      providerId: 'codex',
      historyMessages: [],
    })

    // Speak mode is a per-turn fact — it rides the turn block, not the prefix.
    expect(JSON.stringify(voice.messages)).not.toContain('Voice Speak Mode')
    expect(JSON.stringify(voice.turn)).toContain('Voice Speak Mode')
    expect(JSON.stringify(text.turn)).not.toContain('Voice Speak Mode')
  })

  it('includes plugin prompt providers as their own turn blocks', async () => {
    const seen: Array<{ providerId?: string; model?: string }> = []
    const unregister = registerPromptContextProvider('test-plugin', 'memory', async context => {
      seen.push({ providerId: context.providerId, model: context.model })
      return {
      role: 'developer',
      source: 'plugins/test-plugin/memory',
      content: 'Plugin memory context',
      }
    })
    const result = await buildPrompt({
      ...baseOptions(),
      providerId: 'codex',
      model: 'gpt-5-codex',
      historyMessages: [],
    })
    unregister()

    expect(result.turn).toEqual([
      { id: 'plugin:test-plugin/memory', content: 'Plugin memory context' },
    ])
    expect(seen).toEqual([{ providerId: 'codex', model: 'gpt-5-codex' }])
  })

  it('keeps plugin context out of the user history — it is a turn block, never a user message', async () => {
    const unregister = registerPromptContextProvider('note-skills', 'graph-profile', async () => ({
      role: 'user',
      source: 'plugins/note-skills/graph-profile',
      content: 'Graph memory context',
    }))
    const result = await buildPrompt({
      ...baseOptions(),
      providerId: 'codex',
      historyMessages: [{ role: 'user', content: 'real user message' }],
    })
    unregister()

    expect(result.messages.filter(message => message.role === 'user')).toEqual([{ role: 'user', content: 'real user message' }])
    expect(result.turn).toEqual([
      { id: 'plugin:note-skills/graph-profile', content: 'Graph memory context' },
    ])
  })

  it('loads AGENTS instructions from project root to work directory with override priority', () => {
    const root = makeTempProject()
    const nested = path.join(root, 'packages', 'app')
    fs.mkdirSync(path.join(root, '.git'), { recursive: true })
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'root instructions')
    fs.writeFileSync(path.join(nested, 'AGENTS.md'), 'nested normal instructions')
    fs.writeFileSync(path.join(nested, 'AGENTS.override.md'), 'nested override instructions')

    const content = loadAgentsMdInstructions(nested)

    expect(content).toContain('<project_context>')
    expect(content).toContain('<project_instructions path=')
    expect(content).toContain('root instructions')
    expect(content).toContain('nested override instructions')
    expect(content).not.toContain('nested normal instructions')
    expect(content!.indexOf('root instructions')).toBeLessThan(content!.indexOf('nested override instructions'))
  })

  /**
   * 止血 5(2026-08-11):`CLAUDE.md` 进候选名。在此之前一个只写了 CLAUDE.md 的
   * 仓库(包括本仓)在 onething 里等于**没有项目纪律** —— 文件躺在那儿,没有任何
   * 一条读取路径指向它。
   */
  it('loads CLAUDE.md as a project instruction file', () => {
    const root = makeTempProject()
    fs.mkdirSync(path.join(root, '.git'), { recursive: true })
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'claude discipline')

    const content = loadAgentsMdInstructions(root)

    expect(content).toContain('<project_context>')
    expect(content).toContain('claude discipline')
  })

  /**
   * 候选次序:override > AGENTS > CLAUDE,同层只取先命中的一份。通用的那份
   * (AGENTS.md,写给任何 agent)压过专用的那份(CLAUDE.md,写给某一个 agent);
   * 不合并 —— 两份并存时它们几乎总是同一份内容的副本。
   */
  it('prefers AGENTS.override.md > AGENTS.md > CLAUDE.md within one directory', () => {
    const root = makeTempProject()
    fs.mkdirSync(path.join(root, '.git'), { recursive: true })
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'claude copy')
    expect(loadAgentsMdInstructions(root)).toContain('claude copy')

    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'agents copy')
    const withAgents = loadAgentsMdInstructions(root)
    expect(withAgents).toContain('agents copy')
    expect(withAgents).not.toContain('claude copy')

    fs.writeFileSync(path.join(root, 'AGENTS.override.md'), 'override copy')
    const withOverride = loadAgentsMdInstructions(root)
    expect(withOverride).toContain('override copy')
    expect(withOverride).not.toContain('agents copy')
    expect(withOverride).not.toContain('claude copy')
  })

  /**
   * 上限 64KB(本仓 CLAUDE.md 41.7KB,旧的 32KB 口径下每一轮都被砍掉后 1/4)。
   * 截断仍然发生,但从此在日志里说出来。
   */
  it('injects a 41.7KB discipline file whole and warns only past 64KB', () => {
    const root = makeTempProject()
    fs.mkdirSync(path.join(root, '.git'), { recursive: true })
    // 截断告警已经是一条 `LogRecord`(L4),不再是 console 的副作用。
    const logs = captureRuntimeLogs()

    const tail = 'TAIL-MARKER'
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), `${'x'.repeat(42 * 1024)}\n${tail}`)
    expect(loadAgentsMdInstructions(root)).toContain(tail)
    expect(loadAgentsMdInstructions(root)).not.toContain('truncated')
    expect(logs.ofLevel('warn')).toHaveLength(0)

    fs.writeFileSync(path.join(root, 'CLAUDE.md'), `${'x'.repeat(70 * 1024)}\n${tail}`)
    const truncated = loadAgentsMdInstructions(root)
    expect(truncated).not.toContain(tail)
    expect(truncated).toContain('AGENTS instructions truncated')
    expect(logs.ofLevel('warn').map(record => record.msg))
      .toContain('project instructions truncated')

    logs.restore()
  })

  it('uses only the current directory when no project root is found', () => {
    const root = makeTempProject()
    const nested = path.join(root, 'packages', 'app')
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'root instructions')
    fs.writeFileSync(path.join(nested, 'AGENTS.md'), 'nested instructions')

    const content = loadAgentsMdInstructions(nested)

    expect(content).toContain('nested instructions')
    expect(content).not.toContain('root instructions')
  })

  it('preserves Codex base/developer/user layering', async () => {
    const result = await buildPrompt({
      ...baseOptions({ workingDirectory: '/repo' }),
      providerId: 'codex',
      historyMessages: [{ role: 'user', content: 'hello' }],
    })

    expect(result.messages[0].role).toBe('system')
    expect(result.messages.some(message => message.role === 'developer')).toBe(true)
    expect(result.messages.some(message => message.role === 'developer' && String(message.content).includes('Tool Workspace Rules'))).toBe(true)
    expect(result.messages.filter(message => message.role === 'user')).toEqual([{ role: 'user', content: 'hello' }])
    expect(result.messages[result.messages.length - 1]).toEqual({ role: 'user', content: 'hello' })
  })

  it('folds developer sections into system for regular providers', async () => {
    const result = await buildPrompt({
      ...baseOptions({ workingDirectory: '/repo' }),
      providerId: 'openai',
      historyMessages: [{ role: 'user', content: 'hello' }],
    })

    expect(result.messages.some(message => message.role === 'developer')).toBe(false)
    expect(result.messages[0].role).toBe('system')
    expect(String(result.messages[0].content)).not.toContain('Permission Context')
    expect(result.messages[result.messages.length - 1]).toEqual({ role: 'user', content: 'hello' })
  })
})
