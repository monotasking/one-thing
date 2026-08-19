import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Catalog, Intent, Tool as ToolkitTool } from '@onething/core/toolkit'
import type { CoreToolPromptContribution } from '@onething/core/engine'
import type { Result, ToolSpec } from '@onething/core/toolkit'
import {
  configureToolkitCatalog,
  EDIT_TOOL_PROMPT,
  VARIABLE_TOOL_PROMPT,
  WRITE_TOOL_PROMPT,
} from '@onething/runtime/toolkit'
import type { BuildPromptContextOptions, PromptRequestMessage } from '../system-prompt.js'
import { buildPrompt } from '../index.js'

// Baseline snapshot lock: captures the exact assembled prompt TEXT for a range
// of scenarios so the single-file refactor can be proven byte-identical.
// Date is frozen so the "Current date" line stays stable across runs.

// 解析纪律(M4):生产代码走 `findAgent(id) ?? defaultAgent()`。夹具用同一个
// 实现顶两个口 —— 它对任何 id 都造得出一个 agent,`?? defaultAgent()` 这条腿
// 因此不会被走到,基线文本与旧 getAgent 夹具逐字相同。
const agentStoreMock = vi.hoisted(() => ({ findAgent: vi.fn() }))
vi.mock('../../../agents/index.js', () => ({
  findAgent: agentStoreMock.findAgent,
  defaultAgent: () => agentStoreMock.findAgent(undefined),
  DEFAULT_AGENT_ID: 'default',
}))

function baseOptions(overrides: Partial<BuildPromptContextOptions> = {}): BuildPromptContextOptions {
  return {
    hasTools: true,
    skills: [],
    activeProject: { hasActive: false },
    knownProjects: { hasAny: false, entries: [] },
    toolNames: ['read'],
    mcpToolNames: [],
    ...overrides,
  }
}

/**
 * The prompt a tool brings along is read off the **catalog** for the tools on
 * the turn's surface (`toolkitPromptSource`). The baseline registers stand-ins
 * that carry the real declarations of the builtin tools, so the snapshot shows
 * what the desktop sends without dragging the whole catalog (and its host
 * adapters) into this test.
 */
class PromptCarrierTool extends ToolkitTool<Record<string, never>, undefined> {
  readonly spec: ToolSpec

  constructor(id: string, prompt: CoreToolPromptContribution) {
    super()
    this.spec = {
      id,
      title: id,
      description: `${id} stand-in`,
      input: { type: 'object', properties: {} },
      effects: [],
      presentation: { kind: 'text', shell: 'default' },
      concurrency: 'parallel',
      prompt,
    }
  }

  async plan(): Promise<Intent<undefined>> {
    return Intent.none(undefined)
  }

  async apply(): Promise<Result> {
    return { content: [{ type: 'text', text: '' }] }
  }
}

const PROMPT_CARRIERS = [
  { id: 'edit', prompt: EDIT_TOOL_PROMPT },
  { id: 'write', prompt: WRITE_TOOL_PROMPT },
  { id: 'variable', prompt: VARIABLE_TOOL_PROMPT },
]

beforeAll(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-06-09T12:00:00Z'))
  const catalog = new Catalog()
  for (const { id, prompt } of PROMPT_CARRIERS) catalog.register(new PromptCarrierTool(id, prompt))
  configureToolkitCatalog(catalog)
})
afterAll(() => {
  vi.useRealTimers()
  configureToolkitCatalog(undefined)
})

beforeEach(() => {
  agentStoreMock.findAgent.mockImplementation((agentId?: string) => ({
    id: agentId || 'default',
    name: agentId ? 'Custom Agent' : 'Default Agent',
    systemPrompt: agentId === 'agent-x' ? 'Be precise and cite sources.' : '',
    isDefault: !agentId || undefined,
    createdAt: 1,
    updatedAt: 1,
  }))
})

function shape(messages: Array<Pick<PromptRequestMessage, 'role' | 'content'>>) {
  return messages.map(m => ({ role: m.role, content: m.content }))
}

describe('system prompt baseline', () => {
  it('openai full context', async () => {
    const result = await buildPrompt({
      ...baseOptions({
        workingDirectory: '/repo',
        workingDirectoryRoots: ['/repo', '/other'],
        toolNames: ['read', 'edit', 'bash'],
        mcpToolNames: ['mcp_search'],
        activeProject: { hasActive: true, path: '/repo', displayPath: '/repo', description: 'main repo' },
        knownProjects: { hasAny: true, entries: [{ path: '/p1', displayPath: '/p1', description: 'proj one' }] },
        skills: [{ name: 'demo', description: 'demo skill', source: 'builtin', directoryPath: '/skills/demo', files: [], instructions: 'do x' } as never],
      }),
      providerId: 'openai',
      historyMessages: [{ role: 'user', content: 'hello' }],
    })
    expect(result.systemPrompt).toMatchSnapshot('openai-systemPrompt')
    expect(shape(result.messages)).toMatchSnapshot('openai-messages')
    // The sections that left the prefix are still pinned — they moved channel,
    // they did not disappear.
    expect(result.turn).toMatchSnapshot('openai-turn')
  })

  it('codex full context (system/developer split)', async () => {
    const result = await buildPrompt({
      ...baseOptions({ workingDirectory: '/repo', toolNames: ['read', 'edit'] }),
      providerId: 'codex',
      historyMessages: [{ role: 'user', content: 'hello' }],
    })
    expect(result.systemPrompt).toMatchSnapshot('codex-systemPrompt')
    expect(shape(result.messages)).toMatchSnapshot('codex-messages')
  })

  it('no tools', async () => {
    const result = await buildPrompt({
      ...baseOptions({ hasTools: false, toolNames: [], workingDirectory: '/repo' }),
      providerId: 'openai',
      historyMessages: [],
    })
    expect(result.systemPrompt).toMatchSnapshot('no-tools-systemPrompt')
  })

  it('voice speak mode', async () => {
    const result = await buildPrompt({
      ...baseOptions({ speakMode: true, voiceConversation: true }),
      providerId: 'openai',
      historyMessages: [],
    })
    expect(result.systemPrompt).toMatchSnapshot('voice-systemPrompt')
  })

  it('custom agent prompt', async () => {
    const result = await buildPrompt({
      ...baseOptions({ agentId: 'agent-x' }),
      providerId: 'openai',
      historyMessages: [],
    })
    expect(result.systemPrompt).toMatchSnapshot('agent-systemPrompt')
  })

  it('includes XML skill index when read is available', async () => {
    const result = await buildPrompt({
      ...baseOptions({
        toolNames: ['read'],
        skills: [{
          id: 'user:writing/docs',
          name: 'docs-polish',
          description: 'Improve documentation writing',
          source: 'user',
          category: 'writing',
          tags: ['docs'],
          path: '/skills/writing/docs/SKILL.md',
          directoryPath: '/skills/writing/docs',
          enabled: true,
          instructions: 'Write clearly.',
          files: [],
        } as never],
      }),
      providerId: 'openai',
      historyMessages: [],
    })

    // The skill index is a session fact (it changes with the workdir and the
    // enable switches), so it rides the turn channel, not the system prefix.
    expect(result.systemPrompt).not.toContain('# Skills')
    const skills = result.turn?.find(block => block.id === 'skills')?.content ?? ''
    expect(skills).toContain('# Skills')
    expect(skills).toContain('<available_skills>')
    expect(skills).toContain('<name>docs-polish</name>')
    expect(skills).toContain('<description>Improve documentation writing</description>')
    expect(skills).toContain('<location>/skills/writing/docs/SKILL.md</location>')
    expect(skills).toContain('Use the read tool to load a skill file')
  })

  it('excludes skills marked disable-model-invocation from the automatic index', async () => {
    const result = await buildPrompt({
      ...baseOptions({
        toolNames: ['read'],
        skills: [
          {
            name: 'visible-skill',
            description: 'Visible to the model',
            source: 'user',
            path: '/skills/visible/SKILL.md',
            directoryPath: '/skills/visible',
            enabled: true,
            instructions: 'Use visible workflow.',
          } as never,
          {
            name: 'manual-only',
            description: 'Only explicit invocation',
            source: 'user',
            path: '/skills/manual/SKILL.md',
            directoryPath: '/skills/manual',
            enabled: true,
            disableModelInvocation: true,
            instructions: 'Use manual workflow.',
          } as never,
        ],
      }),
      providerId: 'openai',
      historyMessages: [],
    })

    const skills = result.turn?.find(block => block.id === 'skills')?.content ?? ''
    expect(skills).toContain('<name>visible-skill</name>')
    expect(skills).not.toContain('manual-only')
  })
})
