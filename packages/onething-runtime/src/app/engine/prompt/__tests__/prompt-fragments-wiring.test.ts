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
import { z } from 'zod'
import { Tool } from '@onething/runtime/tools'
import { promptFragments, registerPromptFragment } from '@onething/runtime/prompts'
import { registerTool, unregisterTool } from '../../../tools/registry.js'

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
  unregisterTool('demo_tool')
})

describe('prompt fragments — assembly wiring', () => {
  it('a registered tool talks only while it is on the surface; unregistering silences it', async () => {
    registerTool(Tool.define('demo_tool', {
      name: 'demo_tool',
      description: 'demo',
      category: 'custom',
      parameters: z.object({}),
      prompt: {
        guidelines: ['prefer demo_tool for demos'],
        sections: [{ content: '# Demo\nThis tool demos things.' }],
      },
      async execute() {
        return { title: 'demo', output: '', metadata: {} }
      },
    }))

    const on = await whole(['read', 'demo_tool'])
    expect(on).toContain('- prefer demo_tool for demos')
    expect(on).toContain('# Demo\nThis tool demos things.')

    const off = await whole(['read'])
    expect(off).not.toContain('demo_tool')

    unregisterTool('demo_tool')
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
