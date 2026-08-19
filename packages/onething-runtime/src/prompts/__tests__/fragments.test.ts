/**
 * Prompt composition from fragments (`docs/design/prompt-composition-2026-08.md`).
 *
 * The builder is filter → sort → render over one list: builtin table +
 * `ctx.fragments` (tool contributions, host/feature registrations) + plugin
 * context. These tests pin the composition rules; what the builtin table says
 * is pinned by the golden scenes.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { CorePromptFragment } from '@onething/core/engine'
import {
  BUILTIN_PROMPT_FRAGMENTS,
  buildOnethingSystemPrompt,
  defaultOnethingPromptComposer,
} from '../builder.js'
import {
  PROMPT_BLOCK_TOOL_GUIDELINES,
  PROMPT_BLOCK_TOOL_WORKSPACE_RULES,
  PromptComposer,
  StaticPromptSource,
} from '../composer.js'
import { PromptFragmentRegistry, promptFragments, registerPromptFragment } from '../fragments.js'
import { clearAllPromptContextProviders, registerPromptContextProvider } from '../plugin-context.js'
import { builtinToolPromptSource, testPromptComposer } from './fixtures/tool-prompts.js'

const host = { getHomeDir: () => '/Users/tester', getPlatform: () => 'linux' }

const section = (id: string, content: string, over: Partial<CorePromptFragment> = {}): CorePromptFragment => ({
  id,
  slot: 'section',
  source: 'test',
  content,
  ...over,
})

/** Build with the given extra fragments as one more source (after builtin + registry + plugins). */
async function build(over: Record<string, unknown> = {}, ...extra: CorePromptFragment[]) {
  const composer = extra.length
    ? defaultOnethingPromptComposer.with(new StaticPromptSource('test', extra))
    : defaultOnethingPromptComposer
  return buildOnethingSystemPrompt({
    hasTools: true,
    skills: [],
    toolNames: ['read', 'edit', 'variable'],
    workingDirectory: '/Users/tester/proj',
    host,
    ...over,
  } as Parameters<typeof buildOnethingSystemPrompt>[0], composer)
}

afterEach(() => {
  promptFragments.clear()
  clearAllPromptContextProviders()
})

describe('composition', () => {
  it('the builtin table is a fixed order of named sections; nothing in it names a tool except through requires*', () => {
    const sections = BUILTIN_PROMPT_FRAGMENTS.filter(f => f.slot === 'section').map(f => f.id)
    expect(sections).toEqual([
      'agent', 'voice', 'runtime-context', 'context-update-convention',
      'references', 'active-project', 'known-projects', 'skills', 'os', 'todo',
      'agents-md',
    ])
    const orders = BUILTIN_PROMPT_FRAGMENTS.filter(f => f.slot === 'section').map(f => f.order ?? 0)
    expect([...orders].sort((a, b) => a - b)).toEqual(orders)
  })

  // The channel split is the whole point of prompt-channels-2026-08: the prefix
  // must be identical for every session of one agent, so anything that reads a
  // session/turn fact leaves it.
  it('splits the builtin table by channel — static prefix vs per-turn block', () => {
    const byChannel = (channel: 'system' | 'turn') =>
      BUILTIN_PROMPT_FRAGMENTS.filter(f => f.slot === 'section' && (f.channel ?? 'system') === channel)
        .map(f => f.id)
    expect(byChannel('system')).toEqual([
      'agent', 'runtime-context', 'context-update-convention', 'references', 'os',
    ])
    expect(byChannel('turn')).toEqual([
      'voice', 'active-project', 'known-projects', 'skills', 'todo', 'agents-md',
    ])
  })

  it('turn fragments land in `turn`, never in system / developer / sections', async () => {
    const result = await build({
      sessionId: 's1',
      voiceConversation: true,
      activeProject: { hasActive: true, path: '/p', displayPath: '~/p' },
    })
    expect(result.turn.map(block => block.id)).toEqual(['voice', 'active-project'])
    expect(result.system).not.toContain('Voice Speak Mode')
    expect(result.developer.join('\n')).not.toContain('# Active Project')
    expect(result.sections.map(s => s.name)).not.toContain('active-project')
  })

  it('a section fragment lands after the builtin sections by default and honours `order` to move earlier', async () => {
    const tail = await build({}, section('mine', '# Mine\nhello'))
    const names = tail.developer.map(s => s.split('\n')[0])
    expect(names.indexOf('# Mine')).toBe(names.length - 1)

    const early = await build({}, section('mine', '# Mine\nhello', { order: 250 }))
    const earlyNames = early.developer.map(s => s.split('\n')[0])
    // 250 sits before the workspace-rules block (500).
    expect(earlyNames.indexOf('# Mine')).toBeGreaterThanOrEqual(0)
    expect(earlyNames.indexOf('# Mine')).toBeLessThan(earlyNames.indexOf('## Tool Workspace Rules'))
  })

  it('tool requirements gate every contributor the same way — including host fragments', async () => {
    const needsEdit = section('needs-edit', 'only with edit', { requiresTools: ['edit'] })
    const withEdit = await build({}, needsEdit)
    expect(withEdit.developer).toContain('only with edit')

    const withoutEdit = await build({ toolNames: ['read'] }, needsEdit)
    expect(withoutEdit.developer).not.toContain('only with edit')

    const noTools = await build({ hasTools: false }, needsEdit)
    expect(noTools.developer).not.toContain('only with edit')
  })

  it('guideline bullets go into the core system block; workspace-rule bullets into their own section; identical text is stated once', async () => {
    const composer = testPromptComposer.with(new StaticPromptSource('host', [
      { id: 'dup', slot: 'guidelines', source: 'test', content: '使用edit来修改文件，禁止使用bash工具来修改文件' },
      { id: 'extra', slot: 'workspace-rules', source: 'test', content: 'never leave the repo' },
    ]))
    const result = await buildOnethingSystemPrompt({
      hasTools: true, skills: [], toolNames: ['read', 'edit', 'variable'], workingDirectory: '/Users/tester/proj', host,
    }, composer)
    // The system block ends on the guideline list — there is no `Current date:`
    // line any more (it changed daily and took the whole prefix with it).
    expect(result.system.endsWith('Tool Guidelines:\n- 使用edit来修改文件，禁止使用bash工具来修改文件')).toBe(true)
    const rules = result.developer.find(s => s.startsWith('## Tool Workspace Rules'))!
    // builtin file-tools rule (order 100) first, then the tool's, then the host's
    expect(rules).toMatch(/- read and edit use the current work directory by default\.\n- To change the work directory[^\n]*\n- never leave the repo$/)
  })

  it('no bullets → no `Tool Guidelines:` list and no `## Tool Workspace Rules` heading', async () => {
    const result = await build({ toolNames: ['web_search'] })
    expect(result.system).not.toContain('Tool Guidelines:')
    expect(result.developer.join('\n')).not.toContain('Tool Workspace Rules')
  })

  it('the file-tools rule names exactly the file tools on the surface', async () => {
    const one = await build({ toolNames: ['bash'] })
    expect(one.developer.join('\n')).toContain('- bash uses the current work directory by default.')
    const four = await build({ toolNames: ['bash', 'write', 'edit', 'read'] })
    expect(four.developer.join('\n')).toContain('- read, edit, write, and bash use the current work directory by default.')
  })

  it('disabledSections drops a section by id, and the two composite blocks by their block names', async () => {
    const ctx = { hasTools: true, skills: [], toolNames: ['read', 'edit', 'variable'], workingDirectory: '/Users/tester/proj', host }
    const all = await buildOnethingSystemPrompt(ctx, testPromptComposer)
    expect(all.system).toContain('Tool Guidelines:')
    expect(all.developer.some(s => s.startsWith('<context-variables>'))).toBe(true)

    const trimmed = await buildOnethingSystemPrompt({
      ...ctx,
      disabledSections: [PROMPT_BLOCK_TOOL_GUIDELINES, PROMPT_BLOCK_TOOL_WORKSPACE_RULES, 'context-variables', 'os'],
    }, testPromptComposer)
    expect(trimmed.system).not.toContain('Tool Guidelines:')
    expect(trimmed.developer.join('\n')).not.toContain('Tool Workspace Rules')
    expect(trimmed.developer.some(s => s.startsWith('<context-variables>'))).toBe(false)
    expect(trimmed.developer.some(s => s.startsWith('You are running on'))).toBe(false)
  })

  it('plugin prompt context rides the turn channel — one block per provider, still switched off by `plugins`', async () => {
    registerPromptContextProvider('p1', 'a', () => 'from p1')
    registerPromptContextProvider('p2', 'b', () => [{ role: 'developer', content: 'from p2' }])
    const result = await build()
    // Provider output is recomputed every turn; it must not sit in the prefix.
    expect(result.developer).not.toContain('from p1')
    expect(result.sections.map(s => s.name)).not.toContain('plugins')
    // Per-provider ids: a chatty provider does not force a quiet one to re-send.
    expect(result.turn).toEqual([
      { id: 'plugin:p1/a', content: 'from p1' },
      { id: 'plugin:p2/b', content: 'from p2' },
    ])

    const off = await build({ disabledSections: ['plugins'] })
    expect(off.turn.some(block => block.id.startsWith('plugin:'))).toBe(false)
  })
})

describe('PromptComposer', () => {
  it('is built from sources; `with` returns a new composer and leaves the original alone', () => {
    const base = new PromptComposer([builtinToolPromptSource])
    const more = base.with(new StaticPromptSource('extra', []))
    expect(base.sourceNames).toEqual(['tools'])
    expect(more.sourceNames).toEqual(['tools', 'extra'])
    expect(defaultOnethingPromptComposer.sourceNames).toEqual(['builtin', 'registry', 'plugins'])
  })

  it('asks every source per build and honours source order on ties', async () => {
    const calls: string[] = []
    const src = (name: string, content: string) => ({
      name,
      collect: () => { calls.push(name); return [section(name, content, { source: name })] },
    })
    const composer = new PromptComposer([src('a', 'A'), src('b', 'B')])
    const first = await composer.compose({ hasTools: false, skills: [] })
    expect(first.developer).toEqual(['A', 'B'])
    await composer.compose({ hasTools: false, skills: [] })
    expect(calls).toEqual(['a', 'b', 'a', 'b'])
  })
})

describe('PromptFragmentRegistry', () => {
  it('register returns an idempotent disposer; same source+id replaces; clearSource sweeps a contributor', () => {
    const registry = new PromptFragmentRegistry()
    const dispose = registry.register(section('a', 'v1', { source: 'feature:x' }))
    registry.register(section('a', 'v2', { source: 'feature:x' }))
    registry.register(section('b', 'v3', { source: 'feature:y' }))
    expect(registry.list().map(f => f.content)).toEqual(['v2', 'v3'])

    dispose() // the v1 registration was already replaced — must not remove v2
    dispose()
    expect(registry.list().map(f => f.content)).toEqual(['v2', 'v3'])

    expect(registry.clearSource('feature:x')).toBe(1)
    expect(registry.list().map(f => f.content)).toEqual(['v3'])
  })

  it('the shared registry is what a runtime feature plugs into (the assembly layer reads it every build)', () => {
    const dispose = registerPromptFragment(section('feature-note', 'hi', { source: 'feature:demo' }))
    expect(promptFragments.list()).toHaveLength(1)
    dispose()
    expect(promptFragments.list()).toHaveLength(0)
  })
})
