/**
 * Prompt fragments — the unit the system prompt is composed from
 * (`docs/design/prompt-composition-2026-08.md`).
 *
 * Three facts under test: a tool's declaration derives fragments that require
 * the tool itself; requirements are checked against the turn's tool surface
 * (and nothing else); the plugin-facing validator rejects only malformed
 * shapes and says why.
 */
import { describe, expect, it } from 'vitest'
import {
  CORE_PROMPT_ORDER_TOOL,
  describeToolPromptContributionProblem,
  isCorePromptFragmentActive,
  promptFragmentsFromToolContribution,
  renderCorePromptFragment,
} from '../prompt-fragments.js'
import { createCorePluginAPI } from '../../plugins/api-builder.js'
import type { CoreBuildPromptContextOptions } from '../system-prompt.js'

const ctx = (over: Partial<CoreBuildPromptContextOptions> = {}): CoreBuildPromptContextOptions => ({
  hasTools: true,
  skills: [],
  toolNames: ['read', 'variable'],
  ...over,
})

describe('promptFragmentsFromToolContribution', () => {
  it('derives one fragment per bullet/section, each requiring the tool', () => {
    const fragments = promptFragmentsFromToolContribution('variable', {
      guidelines: ['g1', 'g2'],
      workspaceRules: ['w1'],
      sections: [{ id: 'context-variables', content: 'board' }, { content: 'second' }],
    })
    expect(fragments.map(f => [f.slot, f.id])).toEqual([
      ['guidelines', 'variable:guideline:0'],
      ['guidelines', 'variable:guideline:1'],
      ['workspace-rules', 'variable:workspace-rule:0'],
      ['section', 'context-variables'],
      ['section', 'variable'], // section id defaults to the tool id
    ])
    for (const f of fragments) {
      expect(f.source).toBe('tool:variable')
      expect(f.requiresTools).toEqual(['variable'])
      expect(f.order).toBe(CORE_PROMPT_ORDER_TOOL)
    }
  })

  it('yields nothing without a declaration', () => {
    expect(promptFragmentsFromToolContribution('x', undefined)).toEqual([])
    expect(promptFragmentsFromToolContribution('x', {})).toEqual([])
  })
})

describe('isCorePromptFragmentActive', () => {
  const base = { id: 'f', slot: 'section' as const, source: 't', content: 'x' }

  it('requiresTools = every id on the surface; requiresAnyTools = at least one', () => {
    expect(isCorePromptFragmentActive({ ...base, requiresTools: ['read', 'variable'] }, ctx())).toBe(true)
    expect(isCorePromptFragmentActive({ ...base, requiresTools: ['read', 'edit'] }, ctx())).toBe(false)
    expect(isCorePromptFragmentActive({ ...base, requiresAnyTools: ['edit', 'variable'] }, ctx())).toBe(true)
    expect(isCorePromptFragmentActive({ ...base, requiresAnyTools: ['edit', 'bash'] }, ctx())).toBe(false)
  })

  it('a turn without tools has an empty surface even if toolNames were passed', () => {
    expect(
      isCorePromptFragmentActive({ ...base, requiresTools: ['read'] }, ctx({ hasTools: false })),
    ).toBe(false)
    // …and an unconditional fragment is unaffected.
    expect(isCorePromptFragmentActive(base, ctx({ hasTools: false }))).toBe(true)
  })

  it('`when` runs after the tool gate', () => {
    let called = 0
    const f = { ...base, requiresTools: ['edit'], when: () => { called += 1; return true } }
    expect(isCorePromptFragmentActive(f, ctx())).toBe(false)
    expect(called).toBe(0)
    expect(isCorePromptFragmentActive({ ...base, when: () => false }, ctx())).toBe(false)
  })

  it('render trims and drops empty output', () => {
    expect(renderCorePromptFragment({ ...base, content: '  hi \n' }, ctx())).toBe('hi')
    expect(renderCorePromptFragment({ ...base, content: () => '   ' }, ctx())).toBeUndefined()
    expect(renderCorePromptFragment({ ...base, content: () => undefined }, ctx())).toBeUndefined()
  })
})

describe('describeToolPromptContributionProblem', () => {
  it('accepts undefined and well-formed declarations', () => {
    expect(describeToolPromptContributionProblem(undefined)).toBeUndefined()
    expect(describeToolPromptContributionProblem({})).toBeUndefined()
    expect(describeToolPromptContributionProblem({
      guidelines: ['a'],
      workspaceRules: ['b'],
      sections: [{ id: 's', content: 'c', order: 5 }, { content: 'd' }],
    })).toBeUndefined()
  })

  it('names the offending key', () => {
    expect(describeToolPromptContributionProblem('x')).toMatch(/must be an object/)
    expect(describeToolPromptContributionProblem({ guidelines: 'a' })).toMatch(/guidelines/)
    expect(describeToolPromptContributionProblem({ workspaceRules: [''] })).toMatch(/workspaceRules/)
    expect(describeToolPromptContributionProblem({ sections: [{ content: '' }] })).toMatch(/content/)
    expect(describeToolPromptContributionProblem({ sections: [{ content: 'x', id: 3 }] })).toMatch(/id/)
    expect(describeToolPromptContributionProblem({ sections: [{ content: 'x', order: 'a' }] })).toMatch(/order/)
    expect(describeToolPromptContributionProblem({ prompt: 'x' })).toMatch(/unknown keys: prompt/)
  })
})

describe('plugin registerTool — prompt gate', () => {
  interface CapturedTool { name: string; prompt?: unknown }

  function createToolApi() {
    const registered: Array<{ toolId: string; tool: CapturedTool }> = []
    const errors: string[] = []
    const { api } = createCorePluginAPI<
      { registerTool(tool: CapturedTool): void },
      CapturedTool,
      () => void,
      { name: string },
      object,
      () => string,
      () => void,
      () => void,
      () => [],
      object,
      object
    >({
      pluginId: 'p',
      store: {},
      scheduler: {},
      logger: { log: () => {}, error: (message: string) => { errors.push(message) } },
      host: {
        registerTool: (_id, toolId, tool) => { registered.push({ toolId, tool }) },
        subscribeEvent: () => () => {},
        steer: () => {},
        followUp: () => {},
        notify: () => {},
        registerPromptContextProvider: () => () => {},
        registerBeforeContextCompactHook: () => () => {},
        registerAfterAssistantResponseHook: () => () => {},
        registerSkillRoot: () => () => {},
      },
    })
    return { api, registered, errors }
  }

  it('passes a well-formed prompt through untouched', () => {
    const { api, registered } = createToolApi()
    const prompt = { guidelines: ['prefer me'], sections: [{ content: 'about me' }] }
    api.registerTool({ name: 'ok', prompt })
    expect(registered).toHaveLength(1)
    expect(registered[0].tool.prompt).toBe(prompt)
  })

  it('rejects only the tool whose prompt is malformed, and says why', () => {
    const { api, registered, errors } = createToolApi()
    api.registerTool({ name: 'bad', prompt: { guidelines: 'not a list' } })
    api.registerTool({ name: 'fine' })
    expect(registered.map(r => r.tool.name)).toEqual(['fine'])
    expect(errors.some(e => e.includes('bad'))).toBe(true)
  })
})
