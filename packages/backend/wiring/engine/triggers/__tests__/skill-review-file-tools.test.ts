/**
 * R4b —— skill review 的三只文件工具改由**目录**供给之后的同一组语义。
 *
 * 旧测(`triggers/__tests__/skill-review-file-tools.test.ts`)钉的是
 * `createOnethingSkillReviewFileToolAdapters` 把 `Tool.Info` 包成适配器时
 * schema / parse / execute 三格对不对;那个工厂随旧树删除,同一组问题现在问的是
 * `toolkitFileToolAdapter`(目录里的 `Tool` → 同一张适配器),外加两条新语义:
 * 恒 allow 的授权者(后台触发不弹卡),以及"三只缺一整组不给"。
 */
import { describe, expect, it } from 'vitest'
import { Catalog, Intent, Tool as ToolkitTool } from '@onething/core/toolkit'
import type { Result, RunContext, ToolSpec } from '@onething/core/toolkit'
import { configureToolkitCatalog, createReadTool } from '@onething/runtime/toolkit'
import {
  createToolkitSkillReviewFileToolAdapters,
  toolkitFileToolAdapter,
} from '../skill-review.js'

class FileTool extends ToolkitTool<{ path: string }, { path: string }> {
  readonly spec: ToolSpec

  constructor(id: string) {
    super()
    this.spec = {
      id,
      title: id,
      description: `${id} file`,
      input: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      effects: [],
      presentation: { kind: 'file', shell: 'default' },
      concurrency: 'sequential',
    }
  }

  async plan(input: { path: string }): Promise<Intent<{ path: string }>> {
    return Intent.none({ path: input.path })
  }

  async apply(intent: Intent<{ path: string }>, ctx: RunContext): Promise<Result> {
    return {
      content: [{ type: 'text', text: `applied:${intent.payload.path}` }],
      details: { path: intent.payload.path, cwd: ctx.cwd ?? null },
    }
  }
}

const toolCtx = { sessionId: 'agent-loop', messageId: 'review', toolCallId: 'call-1' }

describe('skill review file tool adapters (toolkit)', () => {
  it('projects a catalog tool into the schema / parse / execute triple', async () => {
    const tool = new FileTool('edit')
    const adapter = toolkitFileToolAdapter(tool, (args, ctx) => ({
      callId: ctx.toolCallId,
      toolId: tool.spec.id,
      input: args as Record<string, unknown>,
      sessionId: 's1',
      messageId: 'm1',
      principal: undefined as never,
    }))

    expect(adapter.description).toBe('edit file')
    expect(adapter.parameters).toMatchObject({
      type: 'object',
      properties: { path: expect.any(Object) },
      required: ['path'],
    })
    // 契约表里查不到这份 schema(测试造的)→ 按 `contractForSchema` 的文档口径
    // 放行,校验交给工具自己的 plan。真工具查得到,下面那条钉的就是它。
    expect(adapter.parse({ path: 'note.md' })).toEqual({ success: true, data: { path: 'note.md' } })

    // 恒 allow 的授权者:一次后台触发不许弹一张没人点的卡。
    await expect(adapter.execute({ path: 'SKILL.md' }, toolCtx)).resolves.toMatchObject({
      output: 'applied:SKILL.md',
      metadata: { path: 'SKILL.md' },
    })
  })

  it('a real catalog tool gets its contract, so bad args are rejected before plan', () => {
    const read = createReadTool()
    const adapter = toolkitFileToolAdapter(read, args => ({
      callId: 'call-2',
      toolId: read.spec.id,
      input: args as Record<string, unknown>,
      sessionId: 's1',
      messageId: 'm1',
      principal: undefined as never,
    }))
    expect(adapter.parse({})).toMatchObject({ success: false })
    expect(adapter.parse({ path: 'note.md' })).toMatchObject({ success: true })
  })

  it('gives nothing at all when the catalog is missing one of the three', () => {
    const ctx = { sessionId: 's1', session: {} } as Parameters<
      typeof createToolkitSkillReviewFileToolAdapters
    >[0]

    configureToolkitCatalog(undefined)
    expect(createToolkitSkillReviewFileToolAdapters(ctx, [])).toBeUndefined()

    const partial = new Catalog().register(new FileTool('read')).register(new FileTool('write'))
    configureToolkitCatalog(partial)
    expect(createToolkitSkillReviewFileToolAdapters(ctx, [])).toBeUndefined()

    partial.register(new FileTool('edit'))
    expect(createToolkitSkillReviewFileToolAdapters(ctx, [])).toBeDefined()
    configureToolkitCatalog(undefined)
  })
})
