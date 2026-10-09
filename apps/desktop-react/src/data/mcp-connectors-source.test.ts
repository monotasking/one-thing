import { describe, expect, it } from 'vitest'
import { MCP_SERVER_REDACTED_SECRET, type MCPServerState } from '@shared/mcp/types'
import {
  connectorDraftToConfig,
  connectorDraftValidation,
  connectorsStillSettling,
  draftFromRow,
  emptyConnectorDraft,
  parseEnvText,
  splitCommandLine,
  toConnectorRows,
} from './mcp-connectors-source'

function state(partial: Partial<MCPServerState['config']> & { id: string }, status: MCPServerState['status'] = 'connected'): MCPServerState {
  return {
    config: { name: partial.id, transport: 'stdio', enabled: true, ...partial },
    status,
    tools: [],
    resources: [],
    prompts: [],
  }
}

describe('splitCommandLine', () => {
  it('splits on whitespace and honours quotes', () => {
    expect(splitCommandLine('npx -y some-mcp@latest --flag')).toEqual(['npx', '-y', 'some-mcp@latest', '--flag'])
    expect(splitCommandLine('"/Applications/My App.app/bin" mcp \'a b\'')).toEqual(['/Applications/My App.app/bin', 'mcp', 'a b'])
    expect(splitCommandLine('a "x \\"y\\" z"')).toEqual(['a', 'x "y" z'])
    expect(splitCommandLine('   ')).toEqual([])
  })
})

describe('parseEnvText', () => {
  it('reads KEY=VALUE per line or semicolon, ignores junk', () => {
    expect(parseEnvText('A=1\nB = two ; C=x=y;junk')).toEqual({ A: '1', B: 'two', C: 'x=y' })
    expect(parseEnvText('')).toEqual({})
  })
})

describe('toConnectorRows', () => {
  it('projects status, tools, url and oauth, sorted by name', () => {
    const rows = toConnectorRows([
      { ...state({ id: 'b', name: 'Zed', transport: 'http', url: 'https://x' }, 'error'), error: 'boom', oauth: { status: 'required', authorizationUrl: 'https://login' } },
      { ...state({ id: 'a', name: 'Alpha' }), tools: [{ name: 't1', serverId: 'a', inputSchema: { type: 'object' } }] },
    ])
    expect(rows.map((row) => row.id)).toEqual(['a', 'b'])
    expect(rows[0]).toMatchObject({ name: 'Alpha', status: 'connected', toolCount: 1, enabled: true })
    expect(rows[1]).toMatchObject({ name: 'Zed', status: 'error', error: 'boom', url: 'https://x', oauth: { status: 'required' } })
    expect(connectorsStillSettling(rows)).toBe(false)
    expect(connectorsStillSettling([{ ...rows[0]!, status: 'connecting' }])).toBe(true)
  })
})

describe('connector drafts', () => {
  it('a new stdio draft needs a name and a command; http needs a valid url', () => {
    expect(connectorDraftValidation(emptyConnectorDraft())).toBe('connectors.nameRequired')
    expect(connectorDraftValidation({ ...emptyConnectorDraft(), name: 'x' })).toBe('connectors.commandRequired')
    expect(connectorDraftValidation({ ...emptyConnectorDraft(), name: 'x', commandLine: 'npx a' })).toBeUndefined()
    expect(connectorDraftValidation({ ...emptyConnectorDraft(), name: 'x', transport: 'http' })).toBe('connectors.urlRequired')
    expect(connectorDraftValidation({ ...emptyConnectorDraft(), name: 'x', transport: 'http', url: 'ftp://x' })).toBe('connectors.urlInvalid')
    expect(connectorDraftValidation({ ...emptyConnectorDraft(), name: 'x', transport: 'sse', url: 'https://x/sse' })).toBeUndefined()
  })

  it('turns a new stdio draft into command + args + cwd + env', () => {
    const config = connectorDraftToConfig({ ...emptyConnectorDraft(), name: ' Tools ', commandLine: 'npx -y a@1 --x', cwd: ' /w ', env: 'K=v' })
    expect(config).toMatchObject({ name: 'Tools', transport: 'stdio', enabled: true, command: 'npx', args: ['-y', 'a@1', '--x'], cwd: '/w', env: { K: 'v' } })
    expect(config.id).toBeTruthy()
  })

  it('editing an existing stdio row with the private fields left empty keeps them (the redaction sentinel goes back untouched)', () => {
    const existing = {
      id: 's1', name: 'Old', transport: 'stdio' as const, enabled: false,
      command: MCP_SERVER_REDACTED_SECRET, args: MCP_SERVER_REDACTED_SECRET as unknown as string[],
      cwd: MCP_SERVER_REDACTED_SECRET, env: MCP_SERVER_REDACTED_SECRET as unknown as Record<string, string>,
    }
    const row = toConnectorRows([{ ...state(existing), status: 'disconnected' }])[0]!
    const draft = draftFromRow(row)
    expect(draft).toMatchObject({ id: 's1', name: 'Old', transport: 'stdio', commandLine: '', cwd: '', env: '', url: '' })
    expect(connectorDraftValidation(draft)).toBeUndefined()
    const config = connectorDraftToConfig({ ...draft, name: 'New name' }, existing)
    expect(config).toEqual({ ...existing, name: 'New name' })
  })

  it('editing with a new command line replaces the command and args', () => {
    const existing = { id: 's1', name: 'Old', transport: 'stdio' as const, enabled: true, command: MCP_SERVER_REDACTED_SECRET, args: [] }
    const config = connectorDraftToConfig({ id: 's1', name: 'Old', transport: 'stdio', commandLine: 'node server.js', cwd: '', env: '', url: '' }, existing)
    expect(config).toMatchObject({ id: 's1', command: 'node', args: ['server.js'], enabled: true })
    expect(config.cwd).toBeUndefined()
  })

  it('switching to http drops the stdio fields', () => {
    const existing = { id: 's1', name: 'Old', transport: 'stdio' as const, enabled: true, command: 'x', args: ['y'] }
    const config = connectorDraftToConfig({ id: 's1', name: 'Old', transport: 'http', commandLine: '', cwd: '', env: '', url: 'https://h/mcp' }, existing)
    expect(config).toEqual({ id: 's1', name: 'Old', transport: 'http', enabled: true, url: 'https://h/mcp' })
  })
})
