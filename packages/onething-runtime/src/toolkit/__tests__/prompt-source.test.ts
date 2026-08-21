/**
 * R4b —— 工具自带的提示词片段,读源换成目录之后的同一组语义。
 *
 * 这三条钉的是旧 `tools/__tests__/tool-prompt-fragments.test.ts` 逐条钉过的东西
 * (只是读源从 `OnethingToolRegistry` 换成了 `Catalog`):面上的工具才说话、
 * 每个 id 只算一次、次序不依赖注册次序、摘掉就没了;外加 `PromptSource` 那一层的
 * `hasTools` 门与"模型面名字 → 目录 id"的还原。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Catalog, Intent, Tool as ToolkitTool } from '@onething/core/toolkit'
import type { Result, ToolSpec } from '@onething/core/toolkit'
import type { CoreBuildPromptContextOptions, CoreToolPromptContribution } from '@onething/core/engine'
import {
  configureToolkitCatalog,
  EDIT_TOOL_PROMPT,
  VARIABLE_TOOL_PROMPT,
  WRITE_TOOL_PROMPT,
} from '../index.js'
import { toolkitPromptFragments, toolkitPromptSource } from '../prompt-source.js'

class StubTool extends ToolkitTool<Record<string, never>, undefined> {
  readonly spec: ToolSpec

  constructor(id: string, prompt?: CoreToolPromptContribution) {
    super()
    this.spec = {
      id,
      title: id,
      description: id,
      input: { type: 'object', properties: {} },
      effects: [],
      presentation: { kind: 'text', shell: 'default' },
      concurrency: 'parallel',
      ...(prompt ? { prompt } : {}),
    }
  }

  async plan(): Promise<Intent<undefined>> {
    return Intent.none(undefined)
  }

  async apply(): Promise<Result> {
    return { content: [{ type: 'text', text: '' }] }
  }
}

function catalogWith(...tools: ToolkitTool[]): Catalog {
  const catalog = new Catalog()
  for (const tool of tools) catalog.register(tool)
  configureToolkitCatalog(catalog)
  return catalog
}

afterEach(() => configureToolkitCatalog(undefined))

describe('toolkitPromptFragments', () => {
  it('returns the fragments of the surfaced tools, in surface order, once per id', () => {
    catalogWith(
      new StubTool('variable', VARIABLE_TOOL_PROMPT),
      new StubTool('edit', EDIT_TOOL_PROMPT),
      new StubTool('read'),
    )

    const fragments = toolkitPromptFragments(['edit', 'variable', 'read', 'edit'])
    expect(fragments.map(f => `${f.source} ${f.slot} ${f.id}`)).toEqual([
      'tool:edit guidelines edit:guideline:0',
      'tool:variable workspace-rules variable:workspace-rule:0',
      'tool:variable section context-variables',
    ])
    for (const f of fragments) expect(f.requiresTools).toEqual([f.source.slice('tool:'.length)])
  })

  it('a catalogued tool that is off the surface says nothing; an unregistered one is gone', () => {
    const catalog = catalogWith(new StubTool('write', WRITE_TOOL_PROMPT))
    expect(toolkitPromptFragments(['read'])).toEqual([])
    expect(toolkitPromptFragments(['write'])).toHaveLength(1)
    catalog.unregister('write')
    expect(toolkitPromptFragments(['write'])).toEqual([])
  })

  it('says nothing at all when no catalog is configured', () => {
    configureToolkitCatalog(undefined)
    expect(toolkitPromptFragments(['edit', 'write'])).toEqual([])
  })
})

describe('toolkitPromptSource', () => {
  const ctx = (over: Partial<CoreBuildPromptContextOptions>) =>
    ({ hasTools: true, ...over }) as CoreBuildPromptContextOptions

  it('is silent when the turn has no tools', () => {
    catalogWith(new StubTool('edit', EDIT_TOOL_PROMPT))
    expect(toolkitPromptSource.collect(ctx({ hasTools: false, toolNames: ['edit'] }))).toEqual([])
  })

  it('resolves model-facing names back to catalog ids and sorts them', () => {
    catalogWith(
      new StubTool('variable', VARIABLE_TOOL_PROMPT),
      new StubTool('edit', EDIT_TOOL_PROMPT),
    )
    const fragments = toolkitPromptSource.collect(
      ctx({ toolNames: ['variable', 'edit'] }),
    ) as readonly { source: string }[]
    // sorted by id: edit before variable — the rendered bytes must not depend
    // on the order the turn happened to list them in.
    expect(fragments.map(f => f.source)).toEqual(['tool:edit', 'tool:variable', 'tool:variable'])
  })

  it('the three builtin contributions are the ones the tools carry', () => {
    expect(EDIT_TOOL_PROMPT.guidelines).toEqual(['使用edit来修改文件，禁止使用bash工具来修改文件'])
    expect(WRITE_TOOL_PROMPT.guidelines).toEqual(['使用write来重写或创建文件'])
    expect(VARIABLE_TOOL_PROMPT.workspaceRules?.[0]).toContain('call `variable` with action="set", name="workdir"')
    expect(VARIABLE_TOOL_PROMPT.sections?.[0]?.id).toBe('context-variables')
  })
})
