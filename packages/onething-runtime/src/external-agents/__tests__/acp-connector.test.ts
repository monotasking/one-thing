import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { InitializeResponse } from '@agentclientprotocol/sdk'
import type { AgentTurnStreamEvent } from '@onething/core/agent-loop'
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
      { type: 'tool-metadata', turn: 7, toolCall: ls, update: { title: 'Run ls' } },
      { type: 'tool-partial-result', turn: 7, toolCall: ls, update: { content: [{ type: 'text', text: 'file-a' }] } },
      { type: 'tool-result', turn: 7, toolCall: ls, result: { content: 'file-a' } },
      { type: 'tool-call-start', turn: 7, toolCallId: 'tc-2', toolName: 'edit' },
      { type: 'tool-call-done', turn: 7, toolCall: edit },
      { type: 'tool-metadata', turn: 7, toolCall: edit, update: { title: 'Edit file' } },
      { type: 'tool-result', turn: 7, toolCall: edit, result: { content: '' } },
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
    expect(deps.openSession).toHaveBeenCalledWith('pi', 'local-acp-session', cwd)
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
