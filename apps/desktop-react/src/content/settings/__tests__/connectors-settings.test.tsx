import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MCPServerConfig, MCPServerState } from '@shared/mcp/types'
import { ConnectorsSettings } from '../ConnectorsSettings'
import { configureMcpConnectorsPort, type McpConnectorsPort } from '../../../data/mcp-connectors-port'
import { resetConnectorsSettings } from '../../../data/mcp-connectors-source'
import { t } from '../../../i18n'

/**
 * 设置页「连接器」。钉住五件事:
 *  ① 列表从 `mcp.getServers` 来,每行有名字、状态、开关;
 *  ② 开关是乐观的,后端走 `updateServer`,传的是整条原配置只改 `enabled`;
 *  ③ 添加:表单 → `addServer`,命令行拆成 command + args;
 *  ④ 删除要确认,确认后 `removeServer` 且行当场消失;
 *  ⑤ 读不到时一行 alert + 重试。
 */

function state(config: Partial<MCPServerConfig> & { id: string }, status: MCPServerState['status'] = 'connected', error?: string): MCPServerState {
  return {
    config: { name: config.id, transport: 'stdio', enabled: true, command: 'x', ...config },
    status,
    ...(error ? { error } : {}),
    tools: status === 'connected' ? [{ name: 'a', serverId: config.id, inputSchema: { type: 'object' } }] : [],
    resources: [],
    prompts: [],
  }
}

function fakePort(initial: MCPServerState[]) {
  let servers = initial
  const fake = {
    ready: vi.fn(async () => undefined),
    getServers: vi.fn(async () => ({ success: true, servers })),
    addServer: vi.fn(async (config: MCPServerConfig) => {
      servers = [...servers, state(config, 'connecting')]
      return { success: true }
    }),
    updateServer: vi.fn(async (config: MCPServerConfig) => {
      servers = servers.map((row) => (row.config.id === config.id ? { ...row, config } : row))
      return { success: true }
    }),
    removeServer: vi.fn(async (serverId: string) => {
      servers = servers.filter((row) => row.config.id !== serverId)
      return { success: true }
    }),
    connectServer: vi.fn(async () => ({ success: true })),
    disconnectServer: vi.fn(async () => ({ success: true })),
    logoutServer: vi.fn(async () => ({ success: true })),
  } satisfies McpConnectorsPort
  configureMcpConnectorsPort(fake)
  return fake
}

async function mount() {
  let view!: ReturnType<typeof render>
  await act(async () => { view = render(<ConnectorsSettings />) })
  return view
}

beforeEach(() => { resetConnectorsSettings() })
afterEach(() => {
  cleanup()
  resetConnectorsSettings()
  configureMcpConnectorsPort(undefined)
})

describe('connectors settings', () => {
  it('lists the servers with name, status and an enable switch', async () => {
    fakePort([
      state({ id: 'codex-computer-use', name: 'Codex Computer Use' }),
      state({ id: 'broken', name: 'Broken' }, 'error', 'spawn failed'),
      state({ id: 'off', name: 'Off', enabled: false }, 'disconnected'),
    ])
    await mount()
    const rows = screen.getAllByTestId('connector-row')
    expect(rows.map((row) => row.getAttribute('data-connector-id'))).toEqual(['broken', 'codex-computer-use', 'off'])
    expect(rows[1]!.textContent).toContain(t('connectors.statusConnected'))
    expect(rows[1]!.textContent).toContain(t('connectors.tools', { count: 1 }))
    expect(rows[0]!.querySelector('[role="alert"]')!.textContent).toContain('spawn failed')
    expect(rows[2]!.textContent).toContain(t('connectors.statusDisabled'))
    expect(screen.getByRole('switch', { name: t('connectors.enable', { name: 'Off' }) }).getAttribute('aria-checked')).toBe('false')
  })

  it('toggles a server optimistically and saves the whole config with enabled flipped', async () => {
    const port = fakePort([state({ id: 's1', name: 'One', args: ['--a'], env: { K: 'v' } })])
    await mount()
    const toggle = screen.getByRole('switch', { name: t('connectors.enable', { name: 'One' }) })
    await act(async () => { fireEvent.click(toggle) })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await waitFor(() => expect(port.updateServer).toHaveBeenCalledTimes(1))
    expect(port.updateServer).toHaveBeenCalledWith({ id: 's1', name: 'One', transport: 'stdio', enabled: false, command: 'x', args: ['--a'], env: { K: 'v' } })
  })

  it('adds a connector from the dialog, splitting the command line', async () => {
    const port = fakePort([])
    await mount()
    expect(screen.getByText(t('connectors.empty'))).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByTestId('connectors-add')) })
    fireEvent.change(screen.getByLabelText(t('connectors.name')), { target: { value: 'Docs' } })
    fireEvent.change(screen.getByLabelText(t('connectors.commandLine')), { target: { value: 'npx -y docs-mcp@latest --port 1' } })
    await act(async () => { fireEvent.click(screen.getByTestId('connectors-save')) })
    await waitFor(() => expect(port.addServer).toHaveBeenCalledTimes(1))
    const config = port.addServer.mock.calls[0]![0] as MCPServerConfig
    expect(config).toMatchObject({ name: 'Docs', transport: 'stdio', enabled: true, command: 'npx', args: ['-y', 'docs-mcp@latest', '--port', '1'] })
    await waitFor(() => expect(screen.getByTestId('connector-row').getAttribute('data-connector-id')).toBe(config.id))
  })

  it('removes a connector after confirmation and the row disappears at once', async () => {
    const port = fakePort([state({ id: 's1', name: 'One' })])
    await mount()
    await act(async () => { fireEvent.click(screen.getByTestId('connector-remove')) })
    expect(screen.getByText(t('connectors.removeConfirmTitle', { name: 'One' }))).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByTestId('connectors-remove-confirm')) })
    expect(screen.queryByTestId('connector-row')).toBeNull()
    await waitFor(() => expect(port.removeServer).toHaveBeenCalledWith('s1'))
  })

  it('shows an alert with a retry when the list cannot be read', async () => {
    const port = fakePort([state({ id: 's1', name: 'One' })])
    port.getServers.mockImplementationOnce(async () => ({ success: false, error: 'offline', servers: [] }))
    await mount()
    expect(screen.getByRole('alert').textContent).toContain('offline')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('connectors.retry') })) })
    await waitFor(() => expect(screen.getByTestId('connector-row')).toBeTruthy())
  })
})
