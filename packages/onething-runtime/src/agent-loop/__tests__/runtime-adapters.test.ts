import { describe, expect, it, vi } from 'vitest'
import { createOnethingAgentLoopRuntimeAdapters } from '../stream-runtime.js'

describe('createOnethingAgentLoopRuntimeAdapters', () => {
  it('owns onething adapter wiring for skills, prompt refs, and injected message events', async () => {
    const skill = {
      id: 'skill-1',
      name: 'Skill One',
      description: 'Useful skill',
      source: 'runtime-test',
      path: '/skills/skill-one/SKILL.md',
      directoryPath: '/skills/skill-one',
      enabled: true,
      instructions: 'Use carefully.',
    }
    const initializedSkills: unknown[] = []
    const promptRefCalls: unknown[] = []
    const persisted: unknown[] = []
    const emitted: unknown[] = []

    const adapters = createOnethingAgentLoopRuntimeAdapters({
      getSession: () => ({
        id: 'session-1',
        name: 'Session',
        messages: [],
        workingDirectory: '/workspace',
      }),
      getSkillsForSession: vi.fn(() => [skill]),
      initializeTools: (skills: unknown[]) => {
        initializedSkills.push(...skills)
      },
      buildProjectPromptVars: () => ({}),
      buildPrompt: async () => ({
        systemPrompt: 'system',
        messages: [],
      }),
      buildHistoryMessages: () => [],
      listSessionMessages: () => [],
      resolvePromptReferences: (content: string, input: { skills: unknown[] }) => {
        promptRefCalls.push(input)
        return {
          modelContent: `${content}:${input.skills.length}`,
          contentParts: [],
        }
      },
      persistInjectedChatMessage: (_sessionId: string, message: unknown) => {
        persisted.push(message)
      },
      executeToolDirectly: async () => ({ content: [] }),
      compactSessionContext: async () => ({ messages: [] }),
      emitEvent: async (sessionId: string, event: unknown) => {
        emitted.push({ sessionId, event })
      },
      logger: console,
    } as any)

    await adapters.initializeTools?.([skill as any])
    expect(initializedSkills).toMatchObject([{
      id: 'skill-1',
      name: 'Skill One',
      instructions: 'Use carefully.',
    }])

    expect(adapters.resolvePromptReferences('hello', {
      session: { workingDirectory: '/workspace' },
      settings: { skills: { enableSkills: true } },
    } as any)).toEqual({
      modelContent: 'hello:1',
      contentParts: [],
    })
    expect(adapters.resolvePromptReferences('hello', {
      session: { workingDirectory: '/workspace' },
      settings: { skills: { enableSkills: false } },
    } as any)).toEqual({
      modelContent: 'hello:0',
      contentParts: [],
    })
    expect(promptRefCalls).toHaveLength(2)

    const injectedMessage = { id: 'message-1', role: 'user', content: 'hi' }
    await adapters.persistInjectedChatMessage('session-1', injectedMessage as any)
    await adapters.emitInjectedUserMessage?.('session-1', injectedMessage as any)

    expect(persisted).toEqual([injectedMessage])
    expect(emitted).toEqual([{
      sessionId: 'session-1',
      event: {
        type: 'message:user-created',
        message: injectedMessage,
      },
    }])
  })
})
