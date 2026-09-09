/**
 * K5-a —— MCP 投影驱动这只 provider 的单测(假客户端,不起 backend、不连 server)。
 *
 * 跑的是**真管线**:`new ResourceTool(provider)` + `ToolRunner.run`,与模型经资源
 * 工具调它、界面经 `ResourceKernel.do` 调它是同一条路。假的只有那一只 `callTool`。
 *
 * 钉三件事:①一次 `do` 转成 `callTool(serverId, 真工具名, args)` 并把结果转成文本;
 * ②工具说不(两种)→ `Outcome.failed`;③单例地址给错了当场说不。
 */
import { describe, expect, it, vi } from 'vitest'
import { ToolRunner } from '@onething/core/toolkit'
import type { Outcome } from '@onething/core/toolkit'
import { ResourceTool } from '@onething/core/resource'
import type { MCPToolCallResult, MCPToolInfo } from '@onething/core/mcp'
import { ZodValidator } from '@onething/runtime/toolkit'
import { projectMcpResource } from '@onething/runtime/mcp/resource-spec'
import { allowAuthorizer, RecordingObserver } from '../../../../core/toolkit/__tests__/fakes.js'
import { McpResourceProvider, type McpResourceCallPort } from '../mcp-provider.js'

const SERVER_ID = 'srv-1'
const SCHEME = 'mcp-srv-1'

const TOOLS: MCPToolInfo[] = [
  {
    name: 'brave_web_search',
    description: 'Search the web.',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    serverId: SERVER_ID,
  },
]

function providerWith(callTool: McpResourceCallPort['callTool']): McpResourceProvider {
  const projection = projectMcpResource({ scheme: SCHEME, title: 'Brave', tools: TOOLS })
  return new McpResourceProvider(SERVER_ID, projection, { callTool })
}

interface Run {
  outcome: Outcome
  text: string
}

async function run(provider: McpResourceProvider, input: Record<string, unknown>): Promise<Run> {
  const runner = new ToolRunner({
    authorizer: allowAuthorizer,
    observer: new RecordingObserver(),
    validator: new ZodValidator(),
    session: () => ({ id: 'mcp-session' }),
  })
  const outcome = await runner.run(new ResourceTool(provider), {
    callId: 'mcp-call',
    toolId: SCHEME,
    input,
    sessionId: 'mcp-session',
    messageId: 'mcp-message',
    principal: { kind: 'user', userId: 'local' },
  })
  const text =
    outcome.kind === 'ok'
      ? outcome.result.content
          .filter(part => part.type === 'text')
          .map(part => part.text ?? '')
          .join('\n')
      : ''
  return { outcome, text }
}

function failureOf(outcome: Outcome): string {
  return outcome.kind === 'failed' ? outcome.message : `not failed: ${outcome.kind}`
}

const OK: MCPToolCallResult = { success: true, content: [{ type: 'text', text: 'two results' }] }

describe('mcp resource provider', () => {
  it('turns one `do` into callTool(serverId, 真工具名, args) and renders the result as text', async () => {
    const callTool = vi.fn(async () => OK)
    const done = await run(providerWith(callTool), {
      op: 'braveWebSearch',
      ref: `${SCHEME}:server`,
      q: 'onething',
    })

    expect(done.outcome.kind).toBe('ok')
    // op 名是归一过的,打出去的**必须**是 server 自己的那个名字。
    expect(callTool).toHaveBeenCalledWith(SERVER_ID, 'brave_web_search', { q: 'onething' })
    // 与 `McpTool.apply` 同一条渲染:`withMCPResultOutputText` 先填 `output`
    // (图片这类二进制部件被摘要,不把 base64 塞进正文再当图片附一遍)。
    expect(done.text).toContain('two results')
    expect(JSON.parse(done.text)).toMatchObject({ success: true, output: 'two results' })
  })

  it('addresses the singleton without a ref', async () => {
    const callTool = vi.fn(async () => OK)
    const done = await run(providerWith(callTool), { op: 'braveWebSearch', q: 'x' })
    expect(done.outcome.kind).toBe('ok')
    expect(callTool).toHaveBeenCalledWith(SERVER_ID, 'brave_web_search', { q: 'x' })
  })

  it('says no to an address that points at something else', async () => {
    const done = await run(providerWith(async () => OK), {
      op: 'braveWebSearch',
      ref: `${SCHEME}:other`,
      q: 'x',
    })
    expect(done.outcome.kind).toBe('failed')
    expect(failureOf(done.outcome)).toContain(`${SCHEME}:server`)
  })

  it('fails the call when the transport says no', async () => {
    const done = await run(
      providerWith(async () => ({ success: false, error: 'Server "srv-1" is not connected' })),
      { op: 'braveWebSearch', q: 'x' },
    )
    expect(done.outcome.kind).toBe('failed')
    expect(failureOf(done.outcome)).toBe('Server "srv-1" is not connected')
  })

  it('fails the call when the tool itself reports an error', async () => {
    // `isError: true` 是 MCP 协议里工具自报的失败。把它塞进一个 `ok` 里,账本上就
    // 会留下一次成功。
    const done = await run(
      providerWith(async () => ({
        success: true,
        isError: true,
        error: 'rate limited',
        content: [{ type: 'text', text: 'rate limited' }],
      })),
      { op: 'braveWebSearch', q: 'x' },
    )
    expect(done.outcome.kind).toBe('failed')
    expect(failureOf(done.outcome)).toBe('rate limited')
  })

  it('declares the mcp effect — the same one McpTool declares', async () => {
    const provider = providerWith(async () => OK)
    // 权限只认效果:两条路对同一台 server 说的必须是同一句话。
    expect(provider.spec.ops.braveWebSearch.effects).toEqual(['mcp'])
    expect(new ResourceTool(provider).spec.effects).toEqual(['mcp'])
  })

  it('has no reads at all', async () => {
    const provider = providerWith(async () => OK)
    expect(provider.spec.reads).toEqual({})
    // 两条读路都在进到实现之前被同一只校验挡住;实现这一侧留一句诚实的错。
    await expect(
      provider.read('anything', null, {}, {
        principal: { kind: 'user', userId: 'local' },
        sessionId: 'mcp-session',
        signal: new AbortController().signal,
        now: () => 0,
      }),
    ).rejects.toBeInstanceOf(TypeError)
  })
})
