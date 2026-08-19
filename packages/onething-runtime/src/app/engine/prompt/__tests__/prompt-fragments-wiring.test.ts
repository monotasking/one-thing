/**
 * Assembly-layer wiring of prompt fragments (`turnFragments`):
 * what the tools **on the turn's surface** declare + what runtime features
 * registered on `promptFragments`, both read fresh on every build.
 *
 * Plug: register a tool with `prompt` → its paragraph is in the next prompt.
 * Unplug: unregister the tool, or leave it off the surface → the paragraph is
 * gone. Same for a registered fragment and its disposer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Catalog, Intent, Tool as ToolkitTool } from '@onething/core/toolkit'
import type { Result, ToolSpec } from '@onething/core/toolkit'
import { promptFragments, registerPromptFragment } from '@onething/runtime/prompts'
import { configureToolkitCatalog } from '@onething/runtime/toolkit'

/**
 * R4b:工具的那一半读源从旧注册表换成了目录(`toolkitPromptSource`)。钉的语义
 * 一个字没变 —— 在面上才说话、摘掉就没了。
 */
class DemoTool extends ToolkitTool<Record<string, never>, undefined> {
  readonly spec: ToolSpec = {
    id: 'demo_tool',
    title: 'demo_tool',
    description: 'demo',
    input: { type: 'object', properties: {} },
    effects: [],
    presentation: { kind: 'text', shell: 'default' },
    concurrency: 'parallel',
    prompt: {
      guidelines: ['prefer demo_tool for demos'],
      sections: [{ content: '# Demo\nThis tool demos things.' }],
    },
  }

  async plan(): Promise<Intent<undefined>> {
    return Intent.none(undefined)
  }

  async apply(): Promise<Result> {
    return { content: [{ type: 'text', text: '' }] }
  }
}

const catalog = new Catalog()
configureToolkitCatalog(catalog)

vi.mock('../../../agents/index.js', () => ({
  findAgent: () => undefined,
  defaultAgent: () => ({ id: 'default', name: 'Default Agent', systemPrompt: '' }),
  DEFAULT_AGENT_ID: 'default',
}))

const { buildSystemPrompt } = await import('../system-prompt.js')

function build(toolNames: string[]) {
  return buildSystemPrompt({
    hasTools: toolNames.length > 0,
    skills: [],
    activeProject: { hasActive: false },
    knownProjects: { hasAny: false, entries: [] },
    toolNames,
    mcpToolNames: [],
    workingDirectory: '/repo',
  })
}

const whole = async (toolNames: string[]) => {
  const { system, developer } = await build(toolNames)
  return [system, ...developer].join('\n\n')
}

afterEach(() => {
  promptFragments.clear()
  catalog.unregister('demo_tool')
})

describe('prompt fragments — assembly wiring', () => {
  it('a registered tool talks only while it is on the surface; unregistering silences it', async () => {
    catalog.register(new DemoTool())

    const on = await whole(['read', 'demo_tool'])
    expect(on).toContain('- prefer demo_tool for demos')
    expect(on).toContain('# Demo\nThis tool demos things.')

    const off = await whole(['read'])
    expect(off).not.toContain('demo_tool')

    catalog.unregister('demo_tool')
    const gone = await whole(['read', 'demo_tool'])
    expect(gone).not.toContain('This tool demos things')
  })

  it('a runtime-registered fragment is read on every build and leaves with its disposer', async () => {
    const dispose = registerPromptFragment({
      id: 'feature-note',
      slot: 'section',
      source: 'feature:demo',
      requiresTools: ['read'],
      content: '# Feature\nA runtime feature speaks here.',
    })
    expect(await whole(['read'])).toContain('A runtime feature speaks here.')
    // requires `read` — off the surface, silent
    expect(await whole(['bash'])).not.toContain('A runtime feature speaks here.')
    dispose()
    expect(await whole(['read'])).not.toContain('A runtime feature speaks here.')
  })
})
