/**
 * M0 / F4 —— 身份透传的第一处灌入点:**promptContext**
 * (docs/design/plugin-knowledge-worker-capabilities-2026-08.md §1 F4)。
 *
 * 钉的是"提示词里的身份与插件看到的身份是同一个" —— 两者若各自解析,
 * memory 的 agent scope 公式("自己的 scope + global")就会在群房里读到另一个
 * agent 的记忆,而且没有任何东西会红。
 *
 * 2026-10-04 随被测的 `plugin-prompt-context.ts` 从 `prompt/__tests__/plugin-context-agent-id.test.ts`
 * 搬到这里(越层清零 C1;与 `plugin-prompt-context-timeout.test.ts` 同址同理)。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  PluginPromptContextSource,
  clearAllPromptContextProviders,
  registerPromptContextProvider,
  type OnethingPluginPromptContext,
} from '../plugin-prompt-context.js'
import { buildOnethingSystemPrompt as buildWithComposer, defaultOnethingPromptComposer } from '@onething/backend/prompt'

/**
 * 缺省 composer 2026-10-04 起不再内置插件提示词源(越层清零 C1),
 * 这里显式补上同一份源,验收的仍是「拼提示词时交给插件的 agentId」。
 */
const pluginComposer = defaultOnethingPromptComposer.with(new PluginPromptContextSource())
const buildOnethingSystemPrompt = (options: Parameters<typeof buildWithComposer>[0]) =>
  buildWithComposer(options, pluginComposer)

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
