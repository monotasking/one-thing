import { mcpApi } from '@/platform/mcp-client'
/**
 * useMCPServers - MCP 服务器管理 Composable
 *
 * 提供 MCP 服务器的 CRUD 操作、连接管理和配置解析功能
 */

import { ref, computed } from 'vue'
import type { MCPServerConfig, MCPServerState, MCPSettings, MCPTransportType } from '@/types'
import { v4 as uuidv4 } from 'uuid'
import { getLogger } from '@/services/log'

const log = getLogger('renderer.mcp')

export interface ServerForm {
  name: string
  transport: MCPTransportType
  command: string
  argsString: string
  cwd: string
  url: string
}

export function useMCPServers(
  settings: () => MCPSettings,
  emit: (event: 'update:settings', value: MCPSettings) => void
) {
  // Server state
  const servers = ref<MCPServerState[]>([])
  const expandedServers = ref<Set<string>>(new Set())
  const connectingServers = ref<Set<string>>(new Set())

  // Load servers from backend
  async function loadServers() {
    try {
      const response = await mcpApi.getServers({})
      if (response.success && response.servers) {
        servers.value = response.servers
      }
    } catch (error) {
      log.error('mcp servers load failed', {}, error)
    }
  }

  // Toggle server expanded state
  function toggleServerExpanded(serverId: string) {
    if (expandedServers.value.has(serverId)) {
      expandedServers.value.delete(serverId)
    } else {
      expandedServers.value.add(serverId)
    }
    expandedServers.value = new Set(expandedServers.value)
  }

  // Toggle server enabled state
  async function toggleServerEnabled(serverId: string, enabled: boolean) {
    const server = servers.value.find(s => s.config.id === serverId)
    if (!server) return

    const updatedConfig = { ...server.config, enabled }
    try {
      const response = await mcpApi.updateServer({ config: updatedConfig })
      if (response.success) {
        await loadServers()
        const updatedServers = settings().servers.map(s =>
          s.id === serverId ? updatedConfig : s
        )
        emit('update:settings', {
          ...settings(),
          servers: updatedServers,
        })
      }
    } catch (error) {
      log.error('mcp server toggle failed', { serverId }, error)
    }
  }

  /**
   * OAuth login: the backend already stashed the authorization URL when the
   * server answered 401. Open it (system browser on desktop via the
   * window-open interceptor, new tab on web), then poll until the callback
   * lands and the card flips from "required" — the backend reconnects itself.
   */
  function handleOAuthLogin(server: MCPServerState) {
    const url = server.oauth?.authorizationUrl
    if (!url) return
    window.open(url, '_blank')

    const serverId = server.config.id
    const startedAt = Date.now()
    const poll = async () => {
      await loadServers()
      const current = servers.value.find(s => s.config.id === serverId)
      if (current?.oauth?.status !== 'required') return // authorized (or flow dropped)
      if (Date.now() - startedAt > 10 * 60 * 1000) return // give up after 10 min
      setTimeout(poll, 3000)
    }
    setTimeout(poll, 3000)
  }

  // "重新授权": forget issuer-keyed credentials and disconnect
  async function handleOAuthLogout(serverId: string) {
    try {
      await mcpApi.logoutServer({ serverId })
    } catch (error) {
      log.error('mcp server logout failed', { serverId }, error)
    } finally {
      await loadServers()
    }
  }

  // Connect/disconnect server
  async function handleConnectToggle(server: MCPServerState) {
    const serverId = server.config.id
    connectingServers.value.add(serverId)

    try {
      if (server.status === 'connected') {
        await mcpApi.disconnectServer({ serverId })
      } else {
        await mcpApi.connectServer({ serverId })
      }
      await loadServers()
    } catch (error) {
      log.error('mcp connection toggle failed', { serverId }, error)
    } finally {
      connectingServers.value.delete(serverId)
    }
  }

  // Save server (add or update)
  async function saveServer(
    form: ServerForm,
    editingServer: MCPServerConfig | null
  ): Promise<{ success: boolean; error?: string }> {
    // Validate
    if (!form.name.trim()) {
      return { success: false, error: 'Server name is required' }
    }

    if (form.transport === 'stdio') {
      if (!form.command.trim()) {
        return { success: false, error: 'Command is required' }
      }
    } else {
      if (!form.url.trim()) {
        return { success: false, error: 'Server URL is required' }
      }
    }

    try {
      const config: MCPServerConfig = {
        id: editingServer?.id || uuidv4(),
        name: form.name.trim(),
        transport: form.transport,
        enabled: editingServer?.enabled ?? true,
      }

      if (form.transport === 'stdio') {
        config.command = form.command.trim()
        config.args = form.argsString.trim().split(/\s+/).filter(Boolean)
        if (form.cwd.trim()) {
          config.cwd = form.cwd.trim()
        }
      } else {
        config.url = form.url.trim()
      }

      let response
      if (editingServer) {
        response = await mcpApi.updateServer({ config })
      } else {
        response = await mcpApi.addServer({ config })
      }

      if (response.success) {
        await loadServers()
        const existingServers = settings().servers || []
        const updatedServers = editingServer
          ? existingServers.map(s => s.id === config.id ? config : s)
          : [...existingServers, config]
        emit('update:settings', {
          ...settings(),
          servers: updatedServers,
        })
        return { success: true }
      } else {
        return { success: false, error: response.error || 'Failed to save server' }
      }
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to save server' }
    }
  }

  // Delete server
  async function deleteServer(serverId: string): Promise<boolean> {
    try {
      const response = await mcpApi.removeServer({ serverId })
      if (response.success) {
        await loadServers()
        const updatedServers = settings().servers.filter(s => s.id !== serverId)
        emit('update:settings', {
          ...settings(),
          servers: updatedServers,
        })
        return true
      }
    } catch (error) {
      log.error('mcp server delete failed', { serverId }, error)
    }
    return false
  }

  // Import servers
  async function importServers(
    serversToImport: MCPServerConfig[],
    selectedIndexes: Set<number>
  ): Promise<{ successCount: number; errors: string[] }> {
    const toImport = serversToImport.filter((_, i) => selectedIndexes.has(i))
    let successCount = 0
    const errors: string[] = []

    for (const server of toImport) {
      try {
        const cleanServer = JSON.parse(JSON.stringify(server))
        const response = await mcpApi.addServer({ config: cleanServer })
        if (response.success) {
          successCount++
        } else {
          errors.push(`${server.name}: ${response.error}`)
        }
      } catch (error: any) {
        errors.push(`${server.name}: ${error.message}`)
      }
    }

    await loadServers()

    // Update parent settings
    const existingServers = settings().servers || []
    const importedServers = toImport.filter((_, i) => {
      const originalIndex = [...selectedIndexes][i]
      return !errors.some(e => e.startsWith(serversToImport[originalIndex]?.name))
    })
    emit('update:settings', {
      ...settings(),
      servers: [...existingServers, ...importedServers],
    })

    return { successCount, errors }
  }

  // Utility functions
  function getStatusText(status: string): string {
    switch (status) {
      case 'connected': return 'Connected'
      case 'connecting': return 'Connecting...'
      case 'disconnected': return 'Disconnected'
      case 'error': return 'Error'
      default: return status
    }
  }

  function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleString()
  }

  return {
    // State
    servers,
    expandedServers,
    connectingServers,

    // Actions
    loadServers,
    toggleServerExpanded,
    toggleServerEnabled,
    handleConnectToggle,
    handleOAuthLogin,
    handleOAuthLogout,
    saveServer,
    deleteServer,
    importServers,

    // Utilities
    getStatusText,
    formatTime,
  }
}

// ==================== Config Parsing Functions ====================

export function parseConfigFile(content: any): MCPServerConfig[] {
  const servers: MCPServerConfig[] = []

  // Format 1: Claude Desktop format { mcpServers: { name: config } }
  if (content.mcpServers && typeof content.mcpServers === 'object') {
    for (const [name, config] of Object.entries(content.mcpServers)) {
      servers.push(parseServerEntry(name, config as any))
    }
    return servers
  }

  // Format 2: Direct array of configs [{ name, command, args }]
  if (Array.isArray(content)) {
    for (const config of content) {
      if (config.name || config.command || config.url) {
        servers.push(parseServerEntry(config.name || 'Imported Server', config))
      }
    }
    return servers
  }

  // Format 3: Single server object { command, args }
  if (content.command || content.url) {
    servers.push(parseServerEntry('Imported Server', content))
    return servers
  }

  throw new Error('Unrecognized configuration format')
}

export function parseServerEntry(name: string, config: any): MCPServerConfig {
  // A url means a remote server: Streamable HTTP by default (the modern
  // transport); only an explicit `type: 'sse'` keeps the legacy SSE channel.
  // Claude-style configs declare this via their `type` field.
  const transport: MCPServerConfig['transport'] = config.command
    ? 'stdio'
    : config.type === 'sse'
      ? 'sse'
      : 'http'

  const server: MCPServerConfig = {
    id: uuidv4(),
    name: name,
    transport,
    enabled: true,
  }

  if (config.command) server.command = config.command
  if (config.args && config.args.length > 0) server.args = config.args
  if (config.env && Object.keys(config.env).length > 0) server.env = config.env
  if (config.cwd) server.cwd = config.cwd
  if (config.url) server.url = config.url
  if (config.headers && Object.keys(config.headers).length > 0) server.headers = config.headers

  return server
}

export function parseCommandLine(input: string): MCPServerConfig | null {
  const parts = parseCommandParts(input)
  if (parts.length === 0) return null

  const command = parts[0]
  const args = parts.slice(1)

  const validCommands = ['npx', 'node', 'python', 'python3', 'uvx', 'docker', 'deno', 'bun']
  const isAbsolutePath = command.startsWith('/') || command.startsWith('./')

  if (!validCommands.includes(command) && !isAbsolutePath) {
    return null
  }

  // Extract name from args
  let name = 'Imported Server'
  const packageArg = args.find(a => a.startsWith('@') || a.includes('server') || a.includes('mcp'))
  if (packageArg) {
    let extracted = packageArg.split('/').pop() || ''
    extracted = extracted
      .replace(/^(server-|mcp-)/i, '')
      .replace(/(-server|-mcp)$/i, '')
      .replace(/-/g, ' ')
    name = extracted
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
    if (!name.trim()) name = 'Imported Server'
  }

  const server: MCPServerConfig = {
    id: uuidv4(),
    name,
    transport: 'stdio',
    enabled: true,
    command,
  }

  if (args.length > 0) server.args = args

  return server
}

export function parseCommandParts(input: string): string[] {
  const parts: string[] = []
  let current = ''
  let inQuote = false
  let quoteChar = ''

  for (const char of input) {
    if ((char === '"' || char === "'") && !inQuote) {
      inQuote = true
      quoteChar = char
    } else if (char === quoteChar && inQuote) {
      inQuote = false
      quoteChar = ''
    } else if (char === ' ' && !inQuote) {
      if (current) {
        parts.push(current)
        current = ''
      }
    } else {
      current += char
    }
  }

  if (current) parts.push(current)
  return parts
}

export function getServerSummary(server: MCPServerConfig): string {
  if (server.transport !== 'stdio') {
    return server.url || ''
  }
  return `${server.command} ${(server.args || []).join(' ')}`
}
