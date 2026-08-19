/**
 * R3a 对拍 —— `PluginTool` / `McpTool`。
 *
 * R4b:插件那一半转成金标(旧包法 `Tool.define(...)+executeCorePluginTool` 随旧树
 * 删除;删除前对拍是绿的,所以快照里记的就是那份旧行为)。MCP 那一半**一个字不
 * 变** —— 它比的是新树复制过来的 `buildMcpPermissionPlan` 与 core 里那一份
 * (`@onething/core/engine` 的 `buildMCPPermissionPlan`),两份都还在,复制一份的
 * 代价就是这条测试,它保证两份不会分家。
 */

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { JsonObject } from '@onething/core'
import { executeCorePluginTool } from '@onething/core/plugins'
import { buildMCPPermissionPlan, isReadOnlyMCPRouterCall } from '@onething/core/engine'
import { zodToJsonSchema } from '../../contract.js'
import {
  buildMcpPermissionPlan,
  isReadOnlyMcpRouterCall,
  McpTool,
  mcpResultText,
  PluginTool,
  type McpToolBridge,
  type PluginToolDefinitionLike,
} from '../../families/external.js'
import { annotationsOf, modelTextOf, normalizeDetails, runNewTool } from '../support.js'

// ── 插件工具 ────────────────────────────────────────────────────────────────

const PluginParams = z.object({
  value: z.string().describe('what to echo'),
  times: z.number().int().min(1).max(3).optional(),
})

interface EchoMetadata extends JsonObject {
  echoed: string
}

function pluginDefinition(behaviour: 'ok' | 'throw' | 'terminate' | 'slow') {
  return {
    name: 'echo',
    description: 'Echo a value back.',
    parameters: PluginParams,
    executionMode: 'parallel' as const,
    async execute(args: { value: string; times?: number }, ctx: { metadata(input: { title?: string; metadata?: Partial<EchoMetadata> }): void; abortSignal?: AbortSignal }) {
      ctx.metadata({ title: 'echoing…', metadata: { echoed: args.value } })
      if (behaviour === 'throw') throw new Error('plugin blew up')
      if (behaviour === 'slow') {
        await new Promise<void>((resolve, reject) => {
          ctx.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }
      const output = args.value.repeat(args.times ?? 1)
      return {
        title: `Echoed ${args.value}`,
        output,
        metadata: { echoed: output } as EchoMetadata,
        ...(behaviour === 'terminate' ? { terminate: true } : {}),
      }
    },
  }
}

function newPluginTool(definition: ReturnType<typeof pluginDefinition>): PluginTool {
  return new PluginTool({
    toolId: 'plugin:demo:echo',
    definition: definition as PluginToolDefinitionLike,
    execute: (args, ctx) => executeCorePluginTool(definition as never, args as never, ctx as never) as never,
  })
}

describe('golden: PluginTool', () => {
  it('spec 钉住(描述 / 标题 / schema / 并发档),效果是一条 plugin_exec', () => {
    const definition = pluginDefinition('ok')
    const tool = newPluginTool(definition)
    expect(tool.spec.description).toBe('Echo a value back.')
    expect(tool.spec.title).toBe('echo')
    expect(tool.spec.input).toEqual(zodToJsonSchema(PluginParams))
    // N3:并发声明原样透传(不声明 = 屏障 = 插件工具今天的行为)。
    expect(tool.spec.concurrency).toBe('parallel')
    expect(newPluginTool({ ...definition, executionMode: undefined } as never).spec.concurrency).toBe('sequential')
    // 旧路写死的 `permissionGuard: 'permission-gated'` 在新树里由这条效果说出来。
    expect(tool.spec.effects).toEqual(['plugin_exec'])
  })

  const FIXTURES: Array<{ name: string; args: Record<string, unknown>; behaviour: 'ok' | 'terminate' }> = [
    { name: '正常:一次 echo', args: { value: 'hi' }, behaviour: 'ok' },
    { name: '边界:times 打到上限', args: { value: 'ab', times: 3 }, behaviour: 'ok' },
    { name: '边界:插件要求收束本回合(terminate)', args: { value: 'x' }, behaviour: 'terminate' },
  ]

  for (const fixture of FIXTURES) {
    it(`模型文本与渲染信息钉住:${fixture.name}`, async () => {
      const definition = pluginDefinition(fixture.behaviour)
      const run = await runNewTool(newPluginTool(definition), fixture.args)
      expect(run.outcome.kind).toBe('ok')
      expect(modelTextOf(run.outcome)).toMatchSnapshot('model text')
      // 插件 ctx.metadata() 的那一条与结果标题那一条都在
      expect(annotationsOf(run).map(entry => entry.title)).toMatchSnapshot('annotation titles')
      expect(normalizeDetails(annotationsOf(run).at(-1)?.details)).toMatchSnapshot('metadata')
      expect(run.outcome.kind === 'ok' && run.outcome.result.terminate)
        .toBe(fixture.behaviour === 'terminate' ? true : undefined)
    })
  }

  it('权限输入:每次调用一条 plugin_exec + 一份预览', async () => {
    const run = await runNewTool(newPluginTool(pluginDefinition('ok')), { value: 'x' })
    expect(run.intent.effects).toEqual([{
      kind: 'plugin_exec',
      resources: ['plugin:demo:echo'],
      barrier: true,
      metadata: { toolName: 'plugin:demo:echo', arguments: { value: 'x' } },
    }])
    expect(run.intent.preview?.title).toBe('Run plugin tool: echo')
  })

  it('错误:插件抛错原样回给模型', async () => {
    const run = await runNewTool(newPluginTool(pluginDefinition('throw')), { value: 'x' })
    expect(run.outcome.kind).toBe('failed')
    expect(run.outcome.kind === 'failed' && run.outcome.message).toMatchSnapshot('plugin failure')
  })

  it('错误:参数不合契约(times 越界)', async () => {
    const run = await runNewTool(newPluginTool(pluginDefinition('ok')), { value: 'x', times: 9 })
    expect(run.outcome.kind).toBe('invalid')
  })

  it('取消:等待中的插件被信号掐断,结局恒为 aborted', async () => {
    const controller = new AbortController()
    const promise = runNewTool(newPluginTool(pluginDefinition('slow')), { value: 'x' }, { signal: controller.signal })
    await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort()
    const run = await promise
    expect(run.outcome.kind).toBe('aborted')
  })

  it('失败隔离:上报口拿到成败(断路器的输入)', async () => {
    const reporter = { onFailure: vi.fn(), onSuccess: vi.fn() }
    const definition = pluginDefinition('ok')
    const tool = new PluginTool({
      toolId: 'plugin:demo:echo',
      definition: definition as PluginToolDefinitionLike,
      execute: (args, ctx) => executeCorePluginTool(definition as never, args as never, ctx as never) as never,
      isolation: { reporter },
    })
    await runNewTool(tool, { value: 'x' })
    expect(reporter.onSuccess).toHaveBeenCalledWith({ toolId: 'plugin:demo:echo', scope: 'tool:plugin:demo:echo' })
    expect(reporter.onFailure).not.toHaveBeenCalled()
  })
})

// ── MCP 工具 ────────────────────────────────────────────────────────────────

const MCP_ARG_FIXTURES: Array<{ name: string; toolName: string; args: JsonObject }> = [
  { name: '普通 MCP 工具', toolName: 'mcp_ctx7_get-docs', args: { topic: 'zod' } },
  { name: 'router:列目录(只读,不惊动人)', toolName: 'mcp_search', args: { action: 'list' } },
  { name: 'router:真调用', toolName: 'mcp_search', args: { action: 'call', tool: 'get-docs', topic: 'zod' } },
  { name: 'router:tool_function 形态', toolName: 'tool_function', args: { action: 'call', function: 'search' } },
  { name: 'router:action 缺席 = 只读', toolName: 'tool_function', args: {} },
]

describe('golden: McpTool —— 复制过来的权限计划与 core 那一份逐组相等', () => {
  for (const fixture of MCP_ARG_FIXTURES) {
    it(fixture.name, () => {
      const options = { resolveServerId: (ref: string) => `srv-${ref}` }
      expect(isReadOnlyMcpRouterCall(fixture.toolName, fixture.args))
        .toBe(isReadOnlyMCPRouterCall(fixture.toolName, fixture.args))
      const mine = buildMcpPermissionPlan(fixture.toolName, fixture.args, options)
      const theirs = buildMCPPermissionPlan(fixture.toolName, fixture.args, options)
      if (!theirs) {
        expect(mine).toBeNull()
        return
      }
      expect(mine?.resourceName).toBe(theirs.resourceName)
      expect(normalizeDetails(mine?.effects)).toEqual(normalizeDetails(theirs.effects))
      expect(normalizeDetails(mine?.preview)).toEqual(normalizeDetails(theirs.preview))
    })
  }

  it('没有 resolveServerId 时资源就是裸名字(与 core 同)', () => {
    expect(normalizeDetails(buildMcpPermissionPlan('mcp_x_y', {})?.effects))
      .toEqual(normalizeDetails(buildMCPPermissionPlan('mcp_x_y', {})?.effects))
  })
})

describe('golden: McpTool —— 工具壳', () => {
  function bridge(overrides: Partial<McpToolBridge> = {}): McpToolBridge {
    return {
      describe: () => ({
        id: 'mcp_ctx7_get-docs',
        name: 'get-docs',
        description: 'Fetch docs',
        parameterSchema: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] },
      }),
      execute: async () => ({ content: [{ type: 'text', text: 'docs' }] }),
      resolveServerId: ref => `srv-${ref}`,
      ...overrides,
    }
  }

  it('prepare 之前 spec 是空壳,prepare 之后拿到 schema(懒初始化归 Catalog 管)', async () => {
    const tool = new McpTool({ toolId: 'mcp_ctx7_get-docs', bridge: bridge() })
    expect(tool.spec.description).toBe('')
    expect(tool.spec.input).toEqual({ type: 'object', properties: {}, required: [] })
    await tool.prepare({})
    expect(tool.spec.description).toBe('Fetch docs')
    expect(tool.spec.title).toBe('get-docs')
    expect(tool.spec.effects).toEqual(['mcp'])
  })

  it('正常:结果文本与旧路 toolResultView 的口径一致(对象 → JSON.stringify)', async () => {
    const data = { content: [{ type: 'text', text: 'docs' }] }
    const tool = new McpTool({ toolId: 'mcp_ctx7_get-docs', bridge: bridge({ execute: async () => data }) })
    const run = await runNewTool(tool, { topic: 'zod' })
    expect(run.outcome.kind).toBe('ok')
    expect(modelTextOf(run.outcome)).toBe(JSON.stringify(data))
    expect(mcpResultText('plain')).toBe('plain')
    expect(mcpResultText(undefined)).toBe('')
  })

  it('边界:只读 router 调用不报效果', async () => {
    const tool = new McpTool({ toolId: 'mcp_search', bridge: bridge() })
    const run = await runNewTool(tool, { action: 'list' })
    expect(run.intent.effects).toEqual([])
  })

  it('边界:真调用报一条 mcp 效果(资源按服务器归属)', async () => {
    const tool = new McpTool({ toolId: 'mcp_search', bridge: bridge() })
    const run = await runNewTool(tool, { action: 'call', tool: 'get-docs' })
    expect(run.intent.effects.map(effect => effect.kind)).toEqual(['mcp'])
    expect(run.intent.effects[0]?.resources).toEqual(['mcp:srv-get-docs:get-docs'])
    expect(run.intent.preview?.title).toBe('Call MCP tool: get-docs')
  })

  it('边界:partial 走事件流,形状与旧 buildMCPPartialResultUpdate 一致', async () => {
    const tool = new McpTool({
      toolId: 'mcp_search',
      bridge: bridge({
        execute: async (_id, _args, options) => {
          options.onPartialResult?.('half', 'running')
          return 'done'
        },
      }),
    })
    const run = await runNewTool(tool, { action: 'call', function: 'search' })
    const partials = run.events.filter(event => event.type === 'partial')
    expect(partials).toHaveLength(1)
    expect(partials[0]).toMatchObject({
      result: {
        content: [{ type: 'text', text: 'half' }],
        details: { phase: 'running', toolName: 'mcp_search', functionName: 'search' },
      },
    })
  })

  it('错误:远端抛错 → failed', async () => {
    const tool = new McpTool({
      toolId: 'mcp_ctx7_get-docs',
      bridge: bridge({ execute: async () => { throw new Error('server gone') } }),
    })
    const run = await runNewTool(tool, { topic: 'zod' })
    expect(run.outcome.kind).toBe('failed')
    expect(run.outcome.kind === 'failed' && run.outcome.message).toBe('server gone')
  })

  it('取消:信号先响,结局恒为 aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const tool = new McpTool({ toolId: 'mcp_ctx7_get-docs', bridge: bridge() })
    const run = await runNewTool(tool, { topic: 'zod' }, { signal: controller.signal })
    expect(run.outcome.kind).toBe('aborted')
  })
})
