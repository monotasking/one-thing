import { describe, expect, it } from 'vitest'
import {
  buildOnethingPrompt,
  buildOnethingSystemPrompt,
} from '../builder.js'
import { ONETHING_DEFAULT_SYSTEM_PROMPT } from '../system-prompt.js'
import { testPromptComposer } from './fixtures/tool-prompts.js'

const host = {
  getAgent: () => ({
    name: 'Review Agent',
    systemPrompt: 'Keep answers concise.',
  }),
  getHomeDir: () => '/Users/tester',
  getPlatform: () => 'darwin',
  getMacOSAutomationDocsPath: () => '/Applications/onething/docs/macos-automation.md',
}

describe('onething prompt builder', () => {
  it('injects onething defaults and host supplied agent context', async () => {
    const prompt = await buildOnethingSystemPrompt({
      hasTools: false,
      skills: [],
      host,
    })

    expect(prompt.system).toContain(ONETHING_DEFAULT_SYSTEM_PROMPT)
    expect(prompt.developer.join('\n')).toContain('Keep answers concise.')
    expect(prompt.developer.join('\n')).toContain('/Applications/onething/docs/macos-automation.md')
  })

  it('uses separate developer messages for Codex provider calls', async () => {
    const prompt = await buildOnethingPrompt({
      providerId: 'codex',
      model: 'gpt-5-codex',
      hasTools: false,
      skills: [],
      host,
      historyMessages: [
        { role: 'user', content: 'hello' },
      ],
    })

    expect(prompt.messages.map(message => message.role)).toEqual([
      'system',
      'developer',
      'developer',
      'developer',
      // context-update-convention section (always-on constant)
      'developer',
      'user',
    ])
    expect(prompt.messages.some(message => (
      message.role === 'developer' &&
      String(message.content).includes('Provider ID: codex') &&
      String(message.content).includes('Model ID: gpt-5-codex')
    ))).toBe(true)
  })

  it('keeps non-Codex providers on a merged system prompt', async () => {
    const prompt = await buildOnethingPrompt({
      providerId: 'deepseek',
      providerConfig: { model: 'deepseek-v4-flash' },
      hasTools: false,
      skills: [],
      host,
      historyMessages: [
        { role: 'user', content: 'hello' },
      ],
    })

    expect(prompt.messages.map(message => message.role)).toEqual(['system', 'user'])
    expect(String(prompt.messages[0]?.content)).toContain('Keep answers concise.')
    expect(String(prompt.messages[0]?.content)).toContain('Provider ID: deepseek')
    expect(String(prompt.messages[0]?.content)).toContain('Model ID: deepseek-v4-flash')
  })

  // The prompt naming the file is what scopes the AI todo to a session: a
  // session can only name its own path, so two sessions cannot collide.
  describe('todo section', () => {
    const todoHost = { ...host, getTodoPlanDirectory: () => '/Users/tester/.onething/todo-plan' }

    it('points the session at its own AI todo file and the shared user notes', async () => {
      // The todo section rides the turn channel: it names a per-session path,
      // so it must never be part of the shared system prefix.
      const { developer, turn } = await buildOnethingSystemPrompt({
        sessionId: 'session-abc',
        hasTools: true,
        toolNames: ['read', 'edit', 'write'],
        skills: [],
        host: todoHost,
      })

      expect(developer.find(section => section.startsWith('# Todo'))).toBeUndefined()
      const todo = turn.find(block => block.id === 'todo')?.content
      expect(todo).toContain('~/.onething/todo-plan/sessions/session-abc/ai-todo.md')
      expect(todo).toContain('~/.onething/todo-plan/user-notes')
    })

    it('gives two sessions different todo paths', async () => {
      const build = (sessionId: string) => buildOnethingSystemPrompt({
        sessionId,
        hasTools: true,
        toolNames: ['read', 'edit', 'write'],
        skills: [],
        host: todoHost,
      })

      const a = (await build('session-a')).turn.find(b => b.id === 'todo')?.content
      const b = (await build('session-b')).turn.find(b => b.id === 'todo')?.content

      expect(a).toContain('sessions/session-a/ai-todo.md')
      expect(a).not.toContain('session-b')
      expect(b).toContain('sessions/session-b/ai-todo.md')
      expect(b).not.toContain('session-a')
    })

    it('is omitted without a session, without tools, or without any file tool to operate it', async () => {
      const noSession = await buildOnethingSystemPrompt({
        hasTools: true,
        toolNames: ['read', 'edit', 'write'],
        skills: [],
        host: todoHost,
      })
      const noTools = await buildOnethingSystemPrompt({
        sessionId: 'session-abc',
        hasTools: false,
        skills: [],
        host: todoHost,
      })
      // The todo instructions say "read / edit / write it"; a surface without
      // any of those tools cannot follow them, so the section stays out.
      const noFileTools = await buildOnethingSystemPrompt({
        sessionId: 'session-abc',
        hasTools: true,
        toolNames: ['variable', 'web_search'],
        skills: [],
        host: todoHost,
      })

      expect(noSession.turn.find(b => b.id === 'todo')).toBeUndefined()
      expect(noTools.turn.find(b => b.id === 'todo')).toBeUndefined()
      expect(noFileTools.turn.find(b => b.id === 'todo')).toBeUndefined()
    })
  })
  /**
   * §R.4:这一段退化成一句常量指路,不再装任何变量值 —— 因此 system 前缀永远
   * 不再因为写变量而失效。
   */
  describe('the <context-variables> section', () => {
    // The section is the `variable` tool's own (`VARIABLE_TOOL_PROMPT`); it
    // reaches the prompt through the tools source, gated by the turn's surface.
    const withTools = (toolNames: string[]) => buildOnethingSystemPrompt({
      hasTools: true,
      skills: [],
      toolNames,
      host,
    }, testPromptComposer)

    it('carries no variable values at all — only the two read actions and the block below', async () => {
      const prompt = await withTools(['read', 'variable'])
      const section = prompt.developer.join('\n\n')
        .match(/<context-variables>[\s\S]*?<\/context-variables>/)?.[0]

      expect(section).toBeDefined()
      // 值一个都不在前缀里 —— 这是「写变量永远不打穿 system+tools 缓存」的凭据。
      expect(section).not.toMatch(/<var\s/)
      expect(section).toContain('<context-update>')

      // 分工:这一段只说"板在哪",两种条目形状与怎么把隐藏的值读回来,
      // 由 context-update-convention 那一段讲(就在块自己旁边)。
      const convention = prompt.developer.join('\n\n')
      expect(convention).toContain('variable(action="get", name=…)')
      // 两种条目靠 `state` 属性显式区分,不靠形状让模型自己推。
      expect(convention).toContain('state="true"')
      expect(convention).toContain('state="false"')
    })

    it('renders the same bytes no matter what the session holds (it takes no input)', async () => {
      const first = await withTools(['read', 'variable'])
      const second = await withTools(['variable', 'read', 'bash'])
      const sectionOf = (p: { developer: string[] }) => p.developer
        .find(s => s.startsWith('<context-variables>'))
      expect(sectionOf(second)).toBe(sectionOf(first))
    })

    it('is omitted when the variable tool is not on the surface — the sentence would be a lie', async () => {
      const noVariableTool = await withTools(['read', 'bash'])
      const noTools = await buildOnethingSystemPrompt({
        hasTools: false,
        skills: [],
        toolNames: ['variable'],
        host,
      }, testPromptComposer)
      expect(noVariableTool.developer.find(s => s.startsWith('<context-variables>'))).toBeUndefined()
      expect(noTools.developer.find(s => s.startsWith('<context-variables>'))).toBeUndefined()
    })
  })
})
