import { describe, expect, it, vi } from 'vitest'
import {
  MCP_CONSENT_PERMISSION_TYPE,
  answerMCPElicitation,
  mcpConsentPattern,
  type MCPElicitationPorts,
} from '../mcp-elicitation.js'
import type { MCPInFlightToolCall } from '../kernel/mcp-kernel-client-runtime.js'

const MESSAGE = 'Allow ChatGPT to use Calculator?'
const FORM = { type: 'object', properties: {} }

const inFlight: MCPInFlightToolCall = {
  toolName: 'get_app_state',
  args: { app: 'Calculator' },
  caller: {
    sessionId: 'session-1',
    messageId: 'message-1',
    callId: 'call-1',
    workingDirectory: '/work/project',
    principal: { kind: 'user', userId: 'me' },
  },
}

function ports(overrides: Partial<MCPElicitationPorts> = {}): MCPElicitationPorts & { ask: ReturnType<typeof vi.fn>; matchGrant: ReturnType<typeof vi.fn> } {
  return {
    ask: vi.fn(async () => 'once' as const),
    matchGrant: vi.fn(() => undefined),
    ...overrides,
  } as never
}

describe('answerMCPElicitation', () => {
  it('asks the permission card with the server message and the in-flight call coordinates, accept on once', async () => {
    const p = ports()
    const answer = await answerMCPElicitation(
      { serverId: 'codex-cu', serverName: 'Codex 电脑操控', params: { message: MESSAGE, requestedSchema: FORM }, inFlight },
      p,
    )
    expect(answer).toEqual({ action: 'accept', content: {} })
    expect(p.ask).toHaveBeenCalledTimes(1)
    const asked = p.ask.mock.calls[0][0]
    expect(asked).toMatchObject({
      type: MCP_CONSENT_PERMISSION_TYPE,
      title: MESSAGE,
      pattern: mcpConsentPattern('codex-cu', MESSAGE),
      sessionId: 'session-1',
      messageId: 'message-1',
      callId: 'call-1',
      workingDirectory: '/work/project',
      principal: { kind: 'user', userId: 'me' },
      metadata: { serverId: 'codex-cu', serverName: 'Codex 电脑操控', toolName: 'get_app_state', message: MESSAGE },
    })
  })

  it.each(['session', 'workdir', 'always', undefined] as const)('accepts on %s', async response => {
    const p = ports({ ask: vi.fn(async () => response) })
    const answer = await answerMCPElicitation(
      { serverId: 's', serverName: 'S', params: { message: MESSAGE, requestedSchema: FORM }, inFlight },
      p,
    )
    expect(answer.action).toBe('accept')
  })

  it('declines when the person rejects (the ask throws)', async () => {
    const p = ports({ ask: vi.fn(async () => { throw new Error('rejected') }) })
    const answer = await answerMCPElicitation(
      { serverId: 's', serverName: 'S', params: { message: MESSAGE, requestedSchema: FORM }, inFlight },
      p,
    )
    expect(answer).toEqual({ action: 'decline' })
  })

  it('accepts straight from a remembered grant without showing a card', async () => {
    const p = ports({ matchGrant: vi.fn(() => ({ id: 'grant-1' })) })
    const answer = await answerMCPElicitation(
      { serverId: 'codex-cu', serverName: 'S', params: { message: MESSAGE, requestedSchema: FORM }, inFlight },
      p,
    )
    expect(answer.action).toBe('accept')
    expect(p.ask).not.toHaveBeenCalled()
    expect(p.matchGrant).toHaveBeenCalledWith({
      type: MCP_CONSENT_PERMISSION_TYPE,
      pattern: mcpConsentPattern('codex-cu', MESSAGE),
      sessionId: 'session-1',
      workspaceRoot: '/work/project',
    })
  })

  it('declines without asking when no call is in flight (server asked on its own)', async () => {
    const p = ports()
    const answer = await answerMCPElicitation(
      { serverId: 's', serverName: 'S', params: { message: MESSAGE, requestedSchema: FORM }, inFlight: null },
      p,
    )
    expect(answer).toEqual({ action: 'decline' })
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('declines url-mode and form-with-fields elicitations without asking', async () => {
    const p = ports()
    expect(await answerMCPElicitation(
      { serverId: 's', serverName: 'S', params: { mode: 'url', message: MESSAGE, url: 'https://x', elicitationId: 'e' }, inFlight },
      p,
    )).toEqual({ action: 'decline' })
    expect(await answerMCPElicitation(
      { serverId: 's', serverName: 'S', params: { message: MESSAGE, requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } }, inFlight },
      p,
    )).toEqual({ action: 'decline' })
    expect(await answerMCPElicitation({ serverId: 's', serverName: 'S', params: { nope: true }, inFlight }, p))
      .toEqual({ action: 'decline' })
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('pattern folds whitespace so the same question is one grant', () => {
    expect(mcpConsentPattern('s', '  Allow  ChatGPT\nto use Calculator? ')).toBe('s:Allow ChatGPT to use Calculator?')
  })
})
