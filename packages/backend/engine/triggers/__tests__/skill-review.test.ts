import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAgentLoop, type AgentLoopOptions, type AgentLoopResult } from '@onething/core/agent-loop'
import { createAgentProviderFromRuntime } from '../../../wiring/agent-loop/index.js'
import { getUserSkillsPath } from '../../../wiring/skills/index.js'
import { executeSkillManage } from '../../../wiring/skills/manage.js'
import { invalidateSessionSkillsCache as invalidateSkillsCache } from '../../../wiring/skills/session-skills.js'
import { configureAppSkillsLoader } from '../../../wiring/skills/loader.js'
import { configureAppSkillManage } from '../../../wiring/skills/manage.js'

// Adapter wiring is an explicit assembly step now (no import-time config).
configureAppSkillsLoader()
configureAppSkillManage()

import { createDefaultSettings } from '@shared/defaults/settings.js'
import type { ChatMessage, ProviderConfig } from '@shared/ipc.js'
import {
  resetSpaceCredentialsCacheForTests,
  upsertSpaceProviderApiKey,
} from '@onething/runtime/spaces/credentials'
import { Catalog } from '@onething/core/toolkit'
import {
  configureToolkitCatalog,
  createEditTool,
  createReadTool,
  createWriteTool,
} from '@onething/runtime/toolkit'
import { createSkillReviewTrigger } from '../skill-review.js'
import { clearSkillReviewState } from '../skill-review-state.js'
import type { TriggerContext } from '../index.js'

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn() },
  shell: { openPath: vi.fn() },
}))

vi.mock('../../../wiring/agent-loop/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../wiring/agent-loop/index.js')>()
  return {
    ...actual,
    createAgentProviderFromRuntime: vi.fn(() => ({
      id: 'tool-provider',
      capabilities: {
        capabilities: ['text-input', 'text-output', 'streaming', 'tool-calls', 'structured-tool-results'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
        supportsStructuredToolResults: true,
        supportsStreaming: true,
      },
      runTurn: vi.fn(),
    })),
  }
})

vi.mock('@onething/core/agent-loop', async importOriginal => {
  const actual = await importOriginal<typeof import('@onething/core/agent-loop')>()
  return {
    ...actual,
    runAgentLoop: vi.fn(),
  }
})

const originalEnv = { ...process.env }
let tmpDir: string

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key]
  }
  Object.assign(process.env, originalEnv)
}

beforeEach(() => {
  restoreEnv()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-skill-review-'))
  process.env.HOME = tmpDir
  vi.mocked(createAgentProviderFromRuntime).mockClear()
  vi.mocked(createAgentProviderFromRuntime).mockReturnValue({
    id: 'tool-provider',
    capabilities: {
      capabilities: ['text-input', 'text-output', 'streaming', 'tool-calls', 'structured-tool-results'],
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsTools: true,
      supportsStructuredToolResults: true,
      supportsStreaming: true,
    },
    runTurn: vi.fn(),
  })
  vi.mocked(runAgentLoop).mockReset()
  // C1:凭证住在**空间的凭证池**里,不再是 `settings.ai.providers[*].apiKey`。
  // 工具 provider 走的是同一条解析链,所以这里得把那把 key 放进 default 池,
  // 否则它会被诚实拦成「本空间未配置」。
  resetSpaceCredentialsCacheForTests()
  upsertSpaceProviderApiKey('default', 'deepseek', {
    apiKey: 'deepseek-key',
    baseUrl: 'https://deepseek.test',
  })
  /*
   * R4b:三只文件工具从**目录**取(旧路直接 import `ReadTool`/`WriteTool`/
   * `EditTool` 三个对象,那条路随旧树删除)。三只缺一就整组不给 —— 那正是
   * readonly 档该有的行为,所以这里必须把它们摆上。
   */
  configureToolkitCatalog(
    new Catalog()
      .register(createReadTool({}))
      .register(createWriteTool({ getFileMutationsDir: () => path.join(tmpDir, '.audit') }))
      .register(createEditTool({ getFileMutationsDir: () => path.join(tmpDir, '.audit') })),
  )
})

afterEach(() => {
  configureToolkitCatalog(undefined)
  invalidateSkillsCache()
  clearSkillReviewState()
  resetSpaceCredentialsCacheForTests()
  fs.rmSync(tmpDir, { recursive: true, force: true })
  restoreEnv()
})

function deepseekProviderConfig(): ProviderConfig {
  return {
    apiKey: 'deepseek-key',
    baseUrl: 'https://deepseek.test',
    model: 'deepseek-v4-pro',
    selectedModels: ['deepseek-v4-pro'],
  }
}

function triggerContext(): TriggerContext {
  const messages: ChatMessage[] = [
    { id: 'u1', role: 'user', content: 'Remember this reusable review workflow.', timestamp: 1 },
    { id: 'a1', role: 'assistant', content: 'I will apply that workflow.', timestamp: 2 },
  ]
  const settings = createDefaultSettings()
  settings.tools.toolCallModel = {
    providerId: 'deepseek',
    model: 'deepseek-v4-pro',
    thinking: true,
    thinkingEffort: 'medium',
  }
  settings.ai.providers.deepseek = deepseekProviderConfig()

  return {
    sessionId: 's1',
    session: {
      id: 's1',
      name: 'Skill Review',
      createdAt: 1,
      updatedAt: 1,
      workingDirectory: tmpDir,
      messages,
    },
    messages,
    lastUserMessage: 'Remember this reusable review workflow.',
    lastAssistantMessage: 'I will apply that workflow.',
    providerId: 'mock-provider',
    providerConfig: { model: 'mock-model', selectedModels: ['mock-model'] },
    settings,
    toolIterations: 10,
    skillManageCalled: false,
    enabledToolNames: ['write', 'edit'],
  }
}

function createExistingSkill(name = 'review-workflow'): string {
  const content = [
    '---',
    `name: "${name}"`,
    'description: "Existing review workflow skill."',
    '---',
    '',
    'Original durable instruction that must survive automatic review.',
    '',
  ].join('\n')
  const result = executeSkillManage({
    action: 'create',
    name,
    content,
  }, { workingDirectory: tmpDir })
  expect(result.success).toBe(true)
  invalidateSkillsCache()
  return content
}

function agentLoopResult(
  options: { messages: AgentLoopOptions['messages'] },
  text: string,
  toolResults: AgentLoopResult['toolResults'] = [],
): AgentLoopResult {
  return {
    messages: options.messages,
    text,
    reasoning: 'reviewed',
    finishReason: 'stop',
    turns: 1,
    toolResults,
  }
}

function mockTargetThenAgent(
  target: { action: 'none' | 'create' | 'update'; name?: string },
  runAgent: (options: Parameters<typeof runAgentLoop>[0]) => Promise<ReturnType<typeof agentLoopResult>>,
): void {
  vi.mocked(runAgentLoop)
    .mockImplementationOnce(async options => {
      expect(options.tools).toEqual([])
      expect(options.messages[0].content).toContain('skill-review planner')
      return agentLoopResult(options, JSON.stringify(target))
    })
    .mockImplementationOnce(runAgent as never)
}

describe('Hermes skill review trigger', () => {
  it('uses the configured tool provider and creates a complete skill package with file tools', async () => {
    mockTargetThenAgent({ action: 'create', name: 'agent-workflow' }, async options => {
      expect(options.model).toBe('deepseek-v4-pro')
      expect(options.thinking).toBe('enabled')
      expect(options.reasoningEffort).toBe('high')
      expect(options.selectedToolNames).toEqual(['read', 'write', 'edit'])
      expect(options.tools?.map(tool => tool.name)).toEqual(['read', 'write', 'edit'])
      expect(options.messages[0].content).toContain('Do not create background-review-update.md')

      const writeTool = options.tools?.find(tool => tool.name === 'write')
      const skillDir = path.join(getUserSkillsPath(), 'agent-workflow')
      const skillResult = await writeTool?.execute({
        path: path.join(skillDir, 'SKILL.md'),
        content: [
          '---',
          'name: "agent-workflow"',
          'description: "Use when preserving agent-created review workflows."',
          '---',
          '',
          'Capture the reusable workflow from the recent conversation.',
          '',
        ].join('\n'),
      }, {
        sessionId: 's1',
        messageId: 'm1',
        toolCallId: 'call_1',
        workingDirectory: tmpDir,
      })
      const supportResult = await writeTool?.execute({
        path: path.join(skillDir, 'references', 'procedure.md'),
        content: '# Procedure\n\nCapture the reusable workflow from the recent conversation.',
      }, {
        sessionId: 's1',
        messageId: 'm1',
        toolCallId: 'call_2',
        workingDirectory: tmpDir,
      })

      expect(skillResult?.error).toBeUndefined()
      expect(supportResult?.error).toBeUndefined()
      return agentLoopResult(options, '{"changed":true}', [
        { toolCall: { id: 'call_1', name: 'write', arguments: '{}' }, result: skillResult! },
        { toolCall: { id: 'call_2', name: 'write', arguments: '{}' }, result: supportResult! },
      ])
    })

    await createSkillReviewTrigger().execute(triggerContext())

    expect(createAgentProviderFromRuntime).toHaveBeenCalledWith(
      'deepseek',
      expect.objectContaining({
        apiKey: 'deepseek-key',
        baseUrl: 'https://deepseek.test',
        model: 'deepseek-v4-pro',
      }),
      expect.objectContaining({
        workingDirectory: tmpDir,
        localSessionId: 's1',
      }),
    )
    expect(runAgentLoop).toHaveBeenCalledTimes(2)

    const skillDir = path.join(getUserSkillsPath(), 'agent-workflow')
    const skillMarkdown = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8')
    const procedure = fs.readFileSync(path.join(skillDir, 'references', 'procedure.md'), 'utf-8')

    expect(skillMarkdown).toContain('references/procedure.md')
    expect(procedure).toContain('Capture the reusable workflow')
  })

  it('uses provider per-model thinking settings when the tool model does not override them', async () => {
    const ctx = triggerContext()
    ctx.settings.tools.toolCallModel = {
      providerId: 'deepseek',
      model: 'deepseek-v4-pro',
    }
    ctx.settings.ai.providers.deepseek = {
      ...deepseekProviderConfig(),
      thinkingByModel: { 'deepseek-v4-pro': true },
      thinkingEffortByModel: { 'deepseek-v4-pro': 'max' },
    }

    mockTargetThenAgent({ action: 'create', name: 'thinking-workflow' }, async options => {
      expect(options.thinking).toBe('enabled')
      expect(options.reasoningEffort).toBe('max')
      return agentLoopResult(options, '{"changed":false}')
    })

    await createSkillReviewTrigger().execute(ctx)

    expect(runAgentLoop).toHaveBeenCalledTimes(2)
    expect(vi.mocked(runAgentLoop).mock.calls[0]?.[0].thinking).toBeUndefined()
  })

  it('completes an agent-created skill package when the agent omits supporting files', async () => {
    mockTargetThenAgent({ action: 'create', name: 'fallback-workflow' }, async options => {
      const writeTool = options.tools?.find(tool => tool.name === 'write')
      const skillDir = path.join(getUserSkillsPath(), 'fallback-workflow')
      const skillResult = await writeTool?.execute({
        path: path.join(skillDir, 'SKILL.md'),
        content: [
          '---',
          'name: "fallback-workflow"',
          'description: "Use when preserving a small reusable workflow."',
          '---',
          '',
          'Follow the compact workflow every time.',
          '',
        ].join('\n'),
      }, {
        sessionId: 's1',
        messageId: 'm1',
        toolCallId: 'call_1',
        workingDirectory: tmpDir,
      })

      expect(skillResult?.error).toBeUndefined()
      return agentLoopResult(options, '{"changed":true}', [
        { toolCall: { id: 'call_1', name: 'write', arguments: '{}' }, result: skillResult! },
      ])
    })

    await createSkillReviewTrigger().execute(triggerContext())

    const skillDir = path.join(getUserSkillsPath(), 'fallback-workflow')
    const skillMarkdown = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8')
    const procedure = fs.readFileSync(path.join(skillDir, 'references', 'procedure.md'), 'utf-8')

    expect(skillMarkdown).toContain('references/procedure.md')
    expect(procedure).toContain('fallback-workflow')
  })

  it('updates an existing skill source file through the tool provider agent without creating background update files', async () => {
    const original = createExistingSkill('review-workflow')
    mockTargetThenAgent({ action: 'update', name: 'review-workflow' }, async options => {
      const readTool = options.tools?.find(tool => tool.name === 'read')
      const editTool = options.tools?.find(tool => tool.name === 'edit')
      const skillPath = path.join(getUserSkillsPath(), 'review-workflow', 'SKILL.md')
      const readResult = await readTool?.execute({
        path: skillPath,
      }, {
        sessionId: 's1',
        messageId: 'm1',
        toolCallId: 'call_1',
        workingDirectory: tmpDir,
      })
      const editResult = await editTool?.execute({
        path: skillPath,
        edits: [{
          oldText: 'Original durable instruction that must survive automatic review.',
          newText: 'Original durable instruction that must survive automatic review.\n\nNew reusable detail captured by automatic review.',
        }],
      }, {
        sessionId: 's1',
        messageId: 'm1',
        toolCallId: 'call_2',
        workingDirectory: tmpDir,
      })

      expect(readResult?.error).toBeUndefined()
      expect(editResult?.error).toBeUndefined()
      return agentLoopResult(options, '{"changed":true}', [
        { toolCall: { id: 'call_1', name: 'read', arguments: '{}' }, result: readResult! },
        { toolCall: { id: 'call_2', name: 'edit', arguments: '{}' }, result: editResult! },
      ])
    })

    await createSkillReviewTrigger().execute(triggerContext())

    const skillDir = path.join(getUserSkillsPath(), 'review-workflow')
    const skillMarkdown = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8')

    expect(skillMarkdown).toContain(original.trim())
    expect(skillMarkdown).toContain('New reusable detail captured by automatic review.')
    expect(fs.existsSync(path.join(skillDir, 'references', 'background-review-update.md'))).toBe(false)
    expect(fs.readdirSync(skillDir, { recursive: true }).join('\n')).not.toContain('background-review-update')
  })

  it('requires read before editing an existing skill file', async () => {
    createExistingSkill('review-workflow')
    mockTargetThenAgent({ action: 'update', name: 'review-workflow' }, async options => {
      const editTool = options.tools?.find(tool => tool.name === 'edit')
      const skillPath = path.join(getUserSkillsPath(), 'review-workflow', 'SKILL.md')
      const editResult = await editTool?.execute({
        path: skillPath,
        edits: [{
          oldText: 'Original durable instruction that must survive automatic review.',
          newText: 'New text',
        }],
      }, {
        sessionId: 's1',
        messageId: 'm1',
        toolCallId: 'call_1',
        workingDirectory: tmpDir,
      })

      expect(editResult?.error).toContain('must read a file before editing')
      return agentLoopResult(options, '{"changed":false}', [
        { toolCall: { id: 'call_1', name: 'edit', arguments: '{}' }, result: editResult! },
      ])
    })

    await createSkillReviewTrigger().execute(triggerContext())

    const skillMarkdown = fs.readFileSync(path.join(getUserSkillsPath(), 'review-workflow', 'SKILL.md'), 'utf-8')
    expect(skillMarkdown).toContain('Original durable instruction')
  })

  it('rejects background review file tools outside the selected target skill root', async () => {
    const original = createExistingSkill('agent-workflow')
    const outsidePath = path.join(os.tmpdir(), `outside-skill-review-${path.basename(tmpDir)}.md`)
    mockTargetThenAgent({ action: 'update', name: 'agent-workflow' }, async options => {
      const writeTool = options.tools?.find(tool => tool.name === 'write')
      const toolResult = await writeTool?.execute({
        path: outsidePath,
        content: 'This write must be blocked.',
      }, {
        sessionId: 's1',
        messageId: 'm1',
        toolCallId: 'call_1',
        workingDirectory: tmpDir,
      })

      expect(toolResult?.error).toContain('can only access mutable skill directories')
      return agentLoopResult(options, '{"changed":false}', [
        { toolCall: { id: 'call_1', name: 'write', arguments: '{}' }, result: toolResult! },
      ])
    })

    await createSkillReviewTrigger().execute(triggerContext())

    const skillMarkdown = fs.readFileSync(path.join(getUserSkillsPath(), 'agent-workflow', 'SKILL.md'), 'utf-8')
    expect(skillMarkdown).toBe(original)
    expect(fs.existsSync(outsidePath)).toBe(false)
  })

  it('skips review when the tool provider is not configured', async () => {
    const ctx = triggerContext()
    ctx.settings.tools.toolCallModel = {
      providerId: '',
      model: '',
      thinking: false,
      thinkingEffort: 'medium',
    }

    await createSkillReviewTrigger().execute(ctx)

    expect(createAgentProviderFromRuntime).not.toHaveBeenCalled()
    expect(runAgentLoop).not.toHaveBeenCalled()
  })
})
