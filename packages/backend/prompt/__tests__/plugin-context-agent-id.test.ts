/**
 * M0 / F4 —— 身份透传的第一处灌入点:**promptContext**
 * (docs/design/plugin-knowledge-worker-capabilities-2026-08.md §1 F4)。
 *
 * 钉的是"提示词里的身份与插件看到的身份是同一个" —— 两者若各自解析,
 * memory 的 agent scope 公式("自己的 scope + global")就会在群房里读到另一个
 * agent 的记忆,而且没有任何东西会红。
 *
 * 住产品层(不是 app/plugins/__tests__):collectPluginPromptContext 是 prompts
 * 的注册表,装配层的测试不该伸手进产品层(与 plugin-context-timeout.test.ts 同址同理)。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearAllPromptContextProviders,
  registerPromptContextProvider,
  type OnethingPluginPromptContext,
} from '../index.js'
import { buildOnethingSystemPrompt } from '../builder.js'

const host = {
  getAgent: (agentId: string | undefined) =>
    (agentId ? { name: `Agent ${agentId}`, systemPrompt: `I am ${agentId}.` } : undefined),
  getHomeDir: () => '/Users/tester',
  getPlatform: () => 'darwin',
}

afterEach(() => {
  clearAllPromptContextProviders()
})

function captureContexts(): OnethingPluginPromptContext[] {
  const seen: OnethingPluginPromptContext[] = []
  registerPromptContextProvider('memory', 'hot-cards', context => {
    seen.push(context)
    return null
  })
  return seen
}

describe('F4 — promptContext carries the turn agentId', () => {
  it('hands the plugin the same agentId the persona was resolved from', async () => {
    const seen = captureContexts()

    const prompt = await buildOnethingSystemPrompt({
      hasTools: false,
      skills: [],
      host,
      agentId: 'researcher',
    })

    expect(seen).toHaveLength(1)
    expect(seen[0].agentId).toBe('researcher')
    // 同一个值也确实是 persona 的依据 —— 两处不是各查各的。
    expect(prompt.developer.join('\n')).toContain('I am researcher.')
  })

  it('leaves agentId undefined when the session has no agent bound (a correct degrade, not an error)', async () => {
    const seen = captureContexts()

    await buildOnethingSystemPrompt({ hasTools: false, skills: [], host })

    expect(seen).toHaveLength(1)
    expect(seen[0].agentId).toBeUndefined()
  })
})
