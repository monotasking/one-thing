import { describe, expect, it } from 'vitest'
import type { MCPSettings } from '@shared/mcp/types'
import {
  CODEX_COMPUTER_USE_SERVER_ID,
  KNOWN_MCP_SERVERS,
  codexComputerUseServerConfig,
  dismissKnownMCPServer,
  isKnownMCPServerId,
  seedKnownMCPServers,
  type KnownMCPServerProbe,
} from '../mcp-known-servers.js'

const LAUNCHER = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
const HOME = '/Users/me'
const CLIENT = `${HOME}/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient`

function probe(overrides: Partial<KnownMCPServerProbe> & { files?: string[] } = {}): KnownMCPServerProbe {
  const files = new Set(overrides.files ?? [LAUNCHER, CLIENT])
  return {
    platform: overrides.platform ?? 'darwin',
    env: overrides.env ?? {},
    homeDir: overrides.homeDir ?? HOME,
    exists: overrides.exists ?? (filePath => files.has(filePath)),
  }
}

const EMPTY: MCPSettings = { enabled: true, servers: [] }

describe('known MCP servers: Codex Computer Use', () => {
  it('fills the signed-launcher recipe in when ChatGPT.app and the Computer Use client are installed', () => {
    const result = seedKnownMCPServers(EMPTY, probe())
    expect(result.added).toEqual([CODEX_COMPUTER_USE_SERVER_ID])
    expect(result.settings.servers).toEqual([codexComputerUseServerConfig(`${HOME}/.codex`)])
    const config = result.settings.servers[0]
    expect(config.command).toBe(LAUNCHER)
    expect(config.args).toEqual(['sandbox', '-c', 'sandbox_mode="danger-full-access"', '--', CLIENT, 'mcp'])
    expect(config.cwd).toBe(`${HOME}/.codex/computer-use`)
    expect(config.env).toEqual({ CODEX_HOME: `${HOME}/.codex` })
    expect(config.enabled).toBe(true)
  })

  it('honours CODEX_HOME', () => {
    const home = '/elsewhere/codex-home'
    const client = `${home}/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient`
    const result = seedKnownMCPServers(EMPTY, probe({ env: { CODEX_HOME: home }, files: [LAUNCHER, client] }))
    expect(result.added).toEqual([CODEX_COMPUTER_USE_SERVER_ID])
    expect(result.settings.servers[0].cwd).toBe(`${home}/computer-use`)
  })

  it.each([
    ['not macOS', probe({ platform: 'linux' })],
    ['launcher missing', probe({ files: [CLIENT] })],
    ['client missing', probe({ files: [LAUNCHER] })],
  ])('leaves settings untouched when %s', (_label, p) => {
    const result = seedKnownMCPServers(EMPTY, p)
    expect(result.added).toEqual([])
    expect(result.settings).toBe(EMPTY)
  })

  it('does not add a second copy when the server is already configured (even disabled)', () => {
    const existing: MCPSettings = {
      enabled: true,
      servers: [{ ...codexComputerUseServerConfig(`${HOME}/.codex`), enabled: false }],
    }
    const result = seedKnownMCPServers(existing, probe())
    expect(result.added).toEqual([])
    expect(result.settings).toBe(existing)
  })

  it('does not come back after the person removed it', () => {
    const removed = dismissKnownMCPServer({ enabled: true, servers: [] }, CODEX_COMPUTER_USE_SERVER_ID)
    expect(removed.dismissedKnownServers).toEqual([CODEX_COMPUTER_USE_SERVER_ID])
    const result = seedKnownMCPServers(removed, probe())
    expect(result.added).toEqual([])
    expect(result.settings).toBe(removed)
  })

  it('dismissal only records known ids, and only once', () => {
    const untouched = dismissKnownMCPServer(EMPTY, 'my-own-server')
    expect(untouched).toBe(EMPTY)
    const once = dismissKnownMCPServer(EMPTY, CODEX_COMPUTER_USE_SERVER_ID)
    expect(dismissKnownMCPServer(once, CODEX_COMPUTER_USE_SERVER_ID)).toBe(once)
    expect(isKnownMCPServerId(CODEX_COMPUTER_USE_SERVER_ID)).toBe(true)
    expect(isKnownMCPServerId('my-own-server')).toBe(false)
  })

  it('the table has unique ids', () => {
    expect(new Set(KNOWN_MCP_SERVERS.map(server => server.id)).size).toBe(KNOWN_MCP_SERVERS.length)
  })
})
