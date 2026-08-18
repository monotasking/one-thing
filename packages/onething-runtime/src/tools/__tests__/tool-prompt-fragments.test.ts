/**
 * `ToolInfo.prompt` → `OnethingToolRegistry.getPromptFragments(surface)`.
 *
 * The registry is a catalog; the caller hands it the turn's surface. Register
 * a tool with a prompt → its fragments come back for that id; unregister →
 * nothing; a registered tool that is not in the surface says nothing.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Tool } from '../tool.js'
import { createOnethingToolRegistry } from '../registry.js'
import { EDIT_TOOL_PROMPT } from '../builtin/edit.js'
import { VARIABLE_TOOL_PROMPT } from '../builtin/variable.js'
import { WRITE_TOOL_PROMPT } from '../builtin/write.js'

const quiet = { logger: { warn() {}, error() {}, log() {} } as unknown as Console }

function stub(id: string, prompt?: Tool.Info['prompt']) {
  return Tool.define(id, {
    name: id,
    description: id,
    category: 'builtin',
    parameters: z.object({}),
    prompt,
    async execute() {
      return { title: id, output: '', metadata: {} }
    },
  })
}

describe('OnethingToolRegistry.getPromptFragments', () => {
  it('returns the fragments of the surfaced tools, in surface order, once per id', () => {
    const registry = createOnethingToolRegistry(quiet)
    registry.registerTool(stub('variable', VARIABLE_TOOL_PROMPT))
    registry.registerTool(stub('edit', EDIT_TOOL_PROMPT))
    registry.registerTool(stub('read'))

    const fragments = registry.getPromptFragments(['edit', 'variable', 'read', 'edit'])
    expect(fragments.map(f => `${f.source} ${f.slot} ${f.id}`)).toEqual([
      'tool:edit guidelines edit:guideline:0',
      'tool:variable workspace-rules variable:workspace-rule:0',
      'tool:variable section context-variables',
    ])
    for (const f of fragments) expect(f.requiresTools).toEqual([f.source.slice('tool:'.length)])
  })

  it('a registered tool that is off the surface says nothing; an unregistered one is gone', () => {
    const registry = createOnethingToolRegistry(quiet)
    registry.registerTool(stub('write', WRITE_TOOL_PROMPT))
    expect(registry.getPromptFragments(['read'])).toEqual([])
    expect(registry.getPromptFragments(['write'])).toHaveLength(1)
    registry.unregisterTool('write')
    expect(registry.getPromptFragments(['write'])).toEqual([])
  })

  it('reads the declaration of async tools without initializing them', () => {
    const registry = createOnethingToolRegistry(quiet)
    let inited = 0
    registry.registerTool(Tool.define('lazy', {
      name: 'lazy',
      category: 'builtin',
      prompt: { sections: [{ content: 'lazy says hi' }] },
    }, async () => {
      inited += 1
      return {
        description: 'lazy',
        parameters: z.object({}),
        async execute() {
          return { title: 'lazy', output: '', metadata: {} }
        },
      }
    }))
    const fragments = registry.getPromptFragments(['lazy'])
    expect(fragments.map(f => [f.id, f.content])).toEqual([['lazy', 'lazy says hi']])
    expect(inited).toBe(0)
  })

  it('the builtin file tools declare their prompt where the tool is defined', () => {
    // These are the exact strings the prompt used to hard-code in
    // prompts/content/tool-guidelines.md / tool-workspace-rules.md.
    expect(EDIT_TOOL_PROMPT.guidelines).toEqual(['使用edit来修改文件，禁止使用bash工具来修改文件'])
    expect(WRITE_TOOL_PROMPT.guidelines).toEqual(['使用write来重写或创建文件'])
    expect(VARIABLE_TOOL_PROMPT.workspaceRules[0]).toContain('call `variable` with action="set", name="workdir"')
    expect(VARIABLE_TOOL_PROMPT.sections[0].id).toBe('context-variables')
    expect(VARIABLE_TOOL_PROMPT.sections[0].content).toMatch(/^<context-variables>\n[\s\S]+\n<\/context-variables>$/)
  })
})
