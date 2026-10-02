import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { InitializeResponse } from '@agentclientprotocol/sdk'
import type { AgentTurnStreamEvent } from '@onething/backend/runtime/agent-loop/loop-primitives'
import { capabilitiesFromHandshake, createAcpConnector, type AcpConnectorDeps } from '../acp-connector.js'
import { createExternalAgentProvider } from '../provider.js'
import type { ACPWireStreamEvent } from '../../acp/translate.js'
import type { ACPPromptStreamOptions } from '../../acp/types.js'
import type { ExternalAgentEvent, ExternalAgentSessionLink } from '../types.js'

async function* replay(events: ACPWireStreamEvent[]): AsyncGenerator<ACPWireStreamEvent, void, void> {
  for (const event of events) yield event
}

function fakeDeps(events: ACPWireStreamEvent[], overrides: Partial<AcpConnectorDeps> = {}) {
  const prompts: { agentId: string; options: ACPPromptStreamOptions }[] = []
  const deps: AcpConnectorDeps = {
    openSession: vi.fn(async (_agentId: string, _localSessionId: string, cwd: string) => ({ acpSessionId: 'acp-1', cwd })),
    streamPrompt: (agentId, options) => {
      prompts.push({ agentId, options })
      return replay(events)
    },
    cancelSession: vi.fn(async () => {}),
    handshake: () => undefined,
    prepare: vi.fn(async () => {}),
    ...overrides,
  }
  return { deps, prompts }
}

function update(u: Record<string, unknown>): ACPWireStreamEvent {
  return { type: 'update', notification: { update: u as never } }
}

/** 一条真实目录:外部 agent 包装器会拒绝不存在的工作目录。 */
function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acp-connector-'))
  mkdirSync(dir, { recursive: true })
  return dir
}

async function runProvider(events: ACPWireStreamEvent[], model = 'claude-code') {
  const { deps, prompts } = fakeDeps(events)
  const links: ExternalAgentSessionLink[] = []
  const cwd = workdir()
  const provider = createExternalAgentProvider({
    providerId: 'acp',
    connector: createAcpConnector(deps),
    localSessionId: 'local-acp-session',
    workingDirectory: cwd,
    onSessionLink: link => links.push(link),
  })
  const out: AgentTurnStreamEvent[] = []
  for await (const event of provider.streamTurn!({
    model,
    messages: [
      { role: 'system', content: 'project notes' },
      { role: 'user', content: 'run checks' },
    ],
    turn: 7,
  })) out.push(event)
  return { out, prompts, links, cwd, deps }
}

describe('AcpConnector — 翻译(原 agent-loop/providers/acp.ts 的回放,改经连接器)', () => {
  it('message / thought / warning / finish 与从前逐字相同', async () => {
    const { out, prompts } = await runProvider([
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } }),
      { type: 'warning', message: 'heads up' },
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } }),
      { type: 'finish', stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } },
    ])
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.agentId).toBe('claude-code')
    expect(prompts[0]!.options).toMatchObject({ localSessionId: 'local-acp-session', prompt: 'run checks' })
    expect(out).toEqual([
      { type: 'reasoning-delta', turn: 7, delta: 'thinking' },
      { type: 'reasoning-delta', turn: 7, delta: 'heads up' },
      { type: 'text-delta', turn: 7, delta: 'hello' },
      { type: 'finish', turn: 7, finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } },
    ])
  })

  it('tool_call 映射成外部执行的结构化工具事件,未收尾的在 finish 前结算', async () => {
    const { out } = await runProvider([
      update({ sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Run ls', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } }),
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', content: [{ type: 'content', content: { type: 'text', text: 'file-a' } }] }),
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed' }),
      update({ sessionUpdate: 'tool_call', toolCallId: 'tc-2', title: 'Edit file', kind: 'edit', status: 'in_progress' }),
      { type: 'finish', stopReason: 'end_turn' },
    ])
    const ls = { id: 'tc-1', name: 'execute', arguments: '{"command":"ls"}', externallyExecuted: true }
    const edit = { id: 'tc-2', name: 'edit', arguments: '{}', externallyExecuted: true }
    expect(out).toEqual([
      { type: 'tool-call-start', turn: 7, toolCallId: 'tc-1', toolName: 'execute' },
      { type: 'tool-call-done', turn: 7, toolCall: ls },
      { type: 'tool-metadata', turn: 7, toolCall: ls, update: { title: 'Run ls', metadata: { output: '', kind: 'execute', status: 'pending' } } },
      { type: 'tool-partial-result', turn: 7, toolCall: ls, update: { content: [{ type: 'text', text: 'file-a' }] } },
      { type: 'tool-result', turn: 7, toolCall: ls, result: { content: 'file-a', data: { output: 'file-a', metadata: { kind: 'execute' } } } },
      { type: 'tool-call-start', turn: 7, toolCallId: 'tc-2', toolName: 'edit' },
      { type: 'tool-call-done', turn: 7, toolCall: edit },
      { type: 'tool-metadata', turn: 7, toolCall: edit, update: { title: 'Edit file', metadata: { output: '', kind: 'edit', status: 'in_progress' } } },
      { type: 'tool-result', turn: 7, toolCall: edit, result: { content: '', data: { output: '', metadata: { kind: 'edit' } } } },
      { type: 'finish', turn: 7, finishReason: 'stop', usage: undefined },
    ])
  })

  it('取消的回合把没收尾的工具结算成 aborted;max_tokens 映射成 length', async () => {
    const { out } = await runProvider([
      update({ sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Slow command', kind: 'execute', status: 'in_progress' }),
      { type: 'finish', stopReason: 'cancelled' },
    ])
    expect(out.find(event => event.type === 'tool-result')).toMatchObject({
      result: { aborted: true, error: 'Tool call cancelled' },
    })
    const { out: length } = await runProvider([{ type: 'finish', stopReason: 'max_tokens' }])
    expect(length).toEqual([{ type: 'finish', turn: 7, finishReason: 'length', usage: undefined }])
  })
})

describe('AcpConnector — 会话与能力', () => {
  it('先开会话、交出链接(带 agent id),再发 prompt', async () => {
    const { links, cwd, deps } = await runProvider([{ type: 'finish', stopReason: 'end_turn' }], 'pi')
    expect(deps.openSession).toHaveBeenCalledWith('pi', 'local-acp-session', cwd, {})
    expect(links).toEqual([expect.objectContaining({
      localSessionId: 'local-acp-session',
      connectorId: 'acp',
      agentId: 'pi',
      externalSessionId: 'acp-1',
      cwd,
    })])
  })

  it('未绑工作目录 = 不开会话,走包装器那句人话(与 Claude 路同一套)', async () => {
    const { deps } = fakeDeps([])
    const provider = createExternalAgentProvider({ providerId: 'acp', connector: createAcpConnector(deps) })
    const out: AgentTurnStreamEvent[] = []
    for await (const event of provider.streamTurn!({ model: 'pi', messages: [{ role: 'user', content: 'hi' }], turn: 1 })) out.push(event)
    expect(out.at(-1)).toEqual({ type: 'finish', turn: 1, finishReason: 'error' })
    expect(deps.openSession).not.toHaveBeenCalled()
  })

  it('能力由握手自述:没握过手时保守,握过之后按那台 agent 的话改写', () => {
    expect(capabilitiesFromHandshake(undefined)).toMatchObject({ steer: false, imagesIn: false, resume: false })
    const handshake = {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
      _meta: { steering: { supported: true } },
    } as unknown as InitializeResponse
    expect(capabilitiesFromHandshake(handshake)).toEqual({
      streamingText: true,
      thinking: true,
      toolSteps: true,
      permissionBridge: 'rpc',
      resume: true,
      fork: false,
      steer: true,
      imagesIn: true,
      mcpInjection: 'config',
      concurrentSessions: 'multiplexed',
    })
    const resumeOnly = { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } } as unknown as InitializeResponse
    expect(capabilitiesFromHandshake(resumeOnly).resume).toBe(true)

    const { deps } = fakeDeps([], { handshake: agentId => (agentId === 'pi' ? handshake : undefined) })
    const connector = createAcpConnector(deps)
    expect(connector.capabilitiesFor!('pi').imagesIn).toBe(true)
    expect(connector.capabilitiesFor!('other').imagesIn).toBe(false)
  })

  it('握手说接得住图 → 图片作为内容块跟在文本后面送进去', async () => {
    const handshake = { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } } as unknown as InitializeResponse
    const { deps, prompts } = fakeDeps([{ type: 'finish', stopReason: 'end_turn' }], { handshake: () => handshake })
    const connector = createAcpConnector(deps)
    const events: ExternalAgentEvent[] = []
    for await (const event of connector.streamTurn({
      localSessionId: 's',
      prompt: 'look',
      images: [{ image: 'data:image/jpeg;base64,AAAA' }, { image: 'https://x.test/a.png?q=1' }],
      cwd: '/tmp',
      model: 'pi',
      turn: 1,
    })) events.push(event)
    expect(prompts[0]!.options.extraContent).toEqual([
      { type: 'image', mimeType: 'image/jpeg', data: 'AAAA' },
      { type: 'resource_link', uri: 'https://x.test/a.png?q=1', name: 'a.png' },
    ])
  })

  it('interrupt 走 session/cancel;没有 agent id 的回合当场说清', async () => {
    const { deps } = fakeDeps([])
    const connector = createAcpConnector(deps)
    await connector.interrupt('session-9')
    expect(deps.cancelSession).toHaveBeenCalledWith('session-9')
    await expect(async () => {
      for await (const _ of connector.streamTurn({ localSessionId: 's', prompt: 'x', cwd: '/tmp', turn: 1 })) {
        // drain
      }
    }).rejects.toThrow('ACP agent id is missing')
  })
})

describe('AcpConnector — 工具保真(A2-a)', () => {
  const path = '/work/rich.txt'
  const rich: ACPWireStreamEvent[] = [
    update({ sessionUpdate: 'tool_call', toolCallId: 'e1', title: 'Edit rich.txt', name: 'edit_file', kind: 'edit', status: 'pending', locations: [{ path, line: 3 }], rawInput: { path } }),
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'e1', status: 'in_progress' }),
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'e1', status: 'completed', content: [{ type: 'diff', path, oldText: 'alpha\nbeta\ngamma\n', newText: 'alpha\nBETA\ngamma\ndelta\n' }] }),
    update({ sessionUpdate: 'tool_call', toolCallId: 'x1', title: 'Run echo', kind: 'execute', status: 'in_progress', content: [{ type: 'terminal', terminalId: 'term-42' }] }),
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'x1', status: 'completed' }),
    update({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'cmp-1', content: { type: 'text', text: 'Earlier we edited. ' } }),
    update({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'cmp-1', content: { type: 'text', text: 'Then ran echo.' } }),
    { type: 'finish', stopReason: 'end_turn' },
  ]

  it('name 当工具名;kind / locations / 状态序列 / diff / terminalId 都走 tool-metadata', async () => {
    const { out } = await runProvider(rich)
    const starts = out.filter(event => event.type === 'tool-call-start')
    expect(starts.map(event => event.type === 'tool-call-start' && event.toolName)).toEqual(['edit_file', 'execute'])

    const editMeta = out.flatMap(event => (event.type === 'tool-metadata' && event.toolCall.id === 'e1' ? [event.update.metadata!] : []))
    expect(editMeta.map(meta => meta.status)).toEqual(['pending', 'in_progress', 'in_progress'])
    expect(editMeta[0]).toMatchObject({ kind: 'edit', locations: [{ path, line: 3 }] })
    const withDiff = editMeta.at(-1)!
    expect(withDiff).toMatchObject({ path, additions: 2, deletions: 1 })
    expect(String(withDiff.diff)).toContain('-beta')
    expect(String(withDiff.diff)).toContain('+BETA')
    expect(String(withDiff.diff)).toContain('+delta')

    const execMeta = out.find(event => event.type === 'tool-metadata' && event.toolCall.id === 'x1')
    expect(execMeta).toMatchObject({ update: { metadata: { kind: 'execute', status: 'in_progress', terminalId: 'term-42' } } })

    // 收尾的 `data` 是会话重开后还在卡上的那几格。
    const results = out.filter(event => event.type === 'tool-result')
    expect(results.map(event => event.type === 'tool-result' && event.result.data)).toEqual([
      { output: `[diff] ${path}`, metadata: { kind: 'edit', locations: [{ path, line: 3 }] } },
      { output: '', metadata: { kind: 'execute', terminalId: 'term-42' } },
    ])
    // diff 的 metadata 排在它那次收尾之前(记录器在 tool/result 那一刻才把 changes 落账)。
    const diffAt = out.findIndex(event => event.type === 'tool-metadata' && Boolean(event.update.metadata?.diff))
    const settleAt = out.findIndex(event => event.type === 'tool-result' && event.toolCall.id === 'e1')
    expect(diffAt).toBeGreaterThan(-1)
    expect(diffAt).toBeLessThan(settleAt)
  })

  it('compaction_summary_chunk 攒成一条 provider-data', async () => {
    const { out } = await runProvider(rich)
    const data = out.filter(event => event.type === 'provider-data')
    expect(data).toEqual([{
      type: 'provider-data',
      turn: 7,
      providerData: { provider: 'acp', kind: 'compaction-summary', compactionId: 'cmp-1', text: 'Earlier we edited. Then ran echo.' },
    }])
    expect(out.at(-1)).toMatchObject({ type: 'finish' })
  })
})

describe('AcpConnector — persona 与首轮能力(A2-a)', () => {
  it('persona: prepend 的执行器只收 persona 段,不收整份 system prompt', async () => {
    const { deps, prompts } = fakeDeps([{ type: 'finish', stopReason: 'end_turn' }])
    const cwd = workdir()
    const provider = createExternalAgentProvider({ providerId: 'acp', connector: createAcpConnector(deps), localSessionId: 'p', workingDirectory: cwd })
    for await (const _ of provider.streamTurn!({
      model: 'pi',
      messages: [
        { role: 'system', content: '# Agent: Iris\n\nsharp designer\n\nTool Guidelines:\n- use edit' },
        { role: 'user', content: 'hi' },
      ],
      persona: '# Agent: Iris\n\nsharp designer',
      turn: 1,
    })) {
      // drain
    }
    expect(deps.openSession).toHaveBeenCalledWith('pi', 'p', cwd, { persona: '# Agent: Iris\n\nsharp designer' })
    expect(prompts[0]!.options.persona).toBe('# Agent: Iris\n\nsharp designer')
    expect(JSON.stringify(prompts[0]!.options)).not.toContain('Tool Guidelines')
  })

  it('先 prepare(握手)再问能力:首轮带图就送得出去,没有「图片未送达」', async () => {
    const handshake = { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } } as unknown as InitializeResponse
    let connected = false
    const { deps, prompts } = fakeDeps([{ type: 'finish', stopReason: 'end_turn' }], {
      handshake: () => (connected ? handshake : undefined),
      prepare: vi.fn(async () => { connected = true }),
    })
    const provider = createExternalAgentProvider({ providerId: 'acp', connector: createAcpConnector(deps), localSessionId: 'img', workingDirectory: workdir() })
    const out: AgentTurnStreamEvent[] = []
    for await (const event of provider.streamTurn!({
      model: 'pi',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', image: 'data:image/png;base64,AAAA', mediaType: 'image/png' }] }],
      turn: 1,
    })) out.push(event)
    expect(deps.prepare).toHaveBeenCalledWith('pi')
    expect(out.some(event => event.type === 'text-delta' && event.delta.includes('未送达'))).toBe(false)
    expect(prompts[0]!.options.extraContent).toEqual([{ type: 'image', mimeType: 'image/png', data: 'AAAA' }])
  })
})

describe('AcpConnector — 宿主工具面(A4-b)', () => {
  const stdioEntry = { name: 'onething', command: '/usr/bin/node', args: ['/x/acp-mcp-bridge.cjs'], env: [{ name: 'ONETHING_MCP_TOKEN', value: 't' }] }

  async function drain(connector: ReturnType<typeof createAcpConnector>, messageId = 'msg-1', abortSignal?: AbortSignal) {
    const events: ExternalAgentEvent[] = []
    for await (const event of connector.streamTurn({
      model: 'pi',
      localSessionId: 'host-tools',
      cwd: workdir(),
      prompt: 'hi',
      messageId,
      ...(abortSignal ? { abortSignal } : {}),
      turn: 1,
    } as never)) events.push(event)
    return events
  }

  it('握手 → 问名册(带 mcpCapabilities)→ 开会话带 mcpServers;这一轮挂上又摘掉', async () => {
    const order: string[] = []
    let connected = false
    const handshake = { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: false, sse: false } } } as unknown as InitializeResponse
    const endTurn = vi.fn(() => { order.push('endTurn') })
    const hostMcp = {
      serversFor: vi.fn(async () => { order.push('serversFor'); return [stdioEntry] }),
      beginTurn: vi.fn(() => { order.push('beginTurn'); return endTurn }),
    }
    const { deps } = fakeDeps([{ type: 'finish', stopReason: 'end_turn' }], {
      handshake: () => (connected ? handshake : undefined),
      prepare: vi.fn(async () => { order.push('prepare'); connected = true }),
      openSession: vi.fn(async (_a: string, _l: string, cwd: string) => { order.push('openSession'); return { acpSessionId: 'acp-1', cwd } }),
      streamPrompt: () => { order.push('streamPrompt'); return replay([{ type: 'finish', stopReason: 'end_turn' }]) },
      hostMcp,
    })
    const abort = new AbortController()
    await drain(createAcpConnector(deps), 'msg-7', abort.signal)
    expect(order).toEqual(['prepare', 'serversFor', 'openSession', 'beginTurn', 'streamPrompt', 'endTurn'])
    expect(hostMcp.serversFor).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'pi', localSessionId: 'host-tools', mcpCapabilities: { http: false, sse: false },
    }))
    expect(deps.openSession).toHaveBeenCalledWith('pi', 'host-tools', expect.any(String), { mcpServers: [stdioEntry] })
    expect(hostMcp.beginTurn).toHaveBeenCalledWith('pi', 'host-tools', { messageId: 'msg-7', abortSignal: abort.signal })
  })

  it('这一轮抛错也摘掉;名册组不出来不炸回合(开会话不带 mcpServers)', async () => {
    const endTurn = vi.fn()
    const failing = fakeDeps([], {
      streamPrompt: () => (async function* (): AsyncGenerator<ACPWireStreamEvent> { yield* replay([]); throw new Error('agent died') })(),
      hostMcp: { serversFor: () => [stdioEntry], beginTurn: () => endTurn },
    })
    await expect(drain(createAcpConnector(failing.deps))).rejects.toThrow('agent died')
    expect(endTurn).toHaveBeenCalledTimes(1)

    const broken = fakeDeps([{ type: 'finish', stopReason: 'end_turn' }], {
      hostMcp: { serversFor: () => { throw new Error('no bridge') }, beginTurn: vi.fn(() => () => undefined) },
    })
    await drain(createAcpConnector(broken.deps))
    expect(broken.deps.openSession).toHaveBeenCalledWith('pi', 'host-tools', expect.any(String), {})
    expect(broken.deps.hostMcp!.beginTurn).not.toHaveBeenCalled()
  })

  it('没装端口 = 旧行为:开会话不带 mcpServers,不 prepare', async () => {
    const { deps } = fakeDeps([{ type: 'finish', stopReason: 'end_turn' }])
    await drain(createAcpConnector(deps))
    expect(deps.openSession).toHaveBeenCalledWith('pi', 'host-tools', expect.any(String), {})
    expect(deps.prepare).not.toHaveBeenCalled()
  })
})
