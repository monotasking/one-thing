import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ACPAgentConfig, ACPAgentState } from '@shared/ipc/acp'

const runScript = vi.fn(async () => undefined)
vi.mock('../../terminal/run-script', () => ({ runScriptInTerminal: (...args: unknown[]) => runScript(...(args as [])) }))

import { AgentsSettings } from '../AgentsSettings'
import { configureAcpAgentsPort, resetAcpAgentsSource, type AcpAgentsPort } from '../../../data/acp-agents-source'
import { t } from '../../../i18n'

/**
 * 设置页「Agent」那一页(A1-b)。钉六件:
 *  ① 首载一句话,不画骨架;读不到一句话 + 重试;名册空一句话 + 怎么装;
 *  ② 三组(内置 / 注册表 / 自定义)各归各的,名册行挂两颗状态点;
 *  ③ 打开这一页就探测一次(版本号只在探测时刷新);
 *  ④ 启用开关乐观翻过去、发出去的是生效配置 ⊕ { enabled };
 *  ⑤ 没装且有 npm 包 → 「装上」钮,按下去在终端里跑 `npm i -g <pkg>`;
 *  ⑥ 自定义那一台才有「删除」,种子那一台是「复制为自定义」。
 */

function row(id: string, over: Partial<ACPAgentState> = {}, config: Partial<ACPAgentConfig> = {}): ACPAgentState {
  return {
    config: { id, name: '', enabled: true, command: `${id}-bin`, ...config } as ACPAgentConfig,
    status: 'disconnected',
    sessionCount: 0,
    activePromptCount: 0,
    source: 'builtin',
    manifest: { id, name: id.toUpperCase(), launch: { command: `${id}-bin` }, configPaths: [`~/.${id}`] },
    detect: { installed: true, version: '1.2.3', path: `/usr/local/bin/${id}`, checkedAt: Date.now() },
    ...over,
  }
}

interface Fake extends AcpAgentsPort {
  rows: ACPAgentState[]
  calls: string[]
  updates: ACPAgentConfig[]
}

function fakePort(rows: ACPAgentState[], fail = false): Fake {
  const fake: Fake = {
    rows,
    calls: [],
    updates: [],
    ready: async () => undefined,
    getAgents: async () => (fail ? { success: false, error: 'nope' } : { success: true, agents: fake.rows }),
    detect: async () => {
      fake.calls.push('detect')
      return fail ? { success: false, error: 'nope' } : { success: true, agents: fake.rows }
    },
    refreshRegistry: async () => {
      fake.calls.push('refreshRegistry')
      return { success: true, agents: fake.rows }
    },
    addAgent: async () => ({ success: true }),
    updateAgent: async (config) => {
      fake.updates.push(config)
      return { success: true }
    },
    removeAgent: async () => ({ success: true }),
    onAgentState: () => () => undefined,
  }
  return fake
}

beforeEach(() => {
  resetAcpAgentsSource()
  runScript.mockClear()
})
afterEach(() => {
  resetAcpAgentsSource()
  configureAcpAgentsPort(undefined)
})

describe('AgentsSettings', () => {
  it('首载一句话;读不到一句话 + 重试', async () => {
    configureAcpAgentsPort(fakePort([], true))
    render(<AgentsSettings />)
    expect(screen.getByText(t('agents.loading'))).toBeTruthy()
    expect(await screen.findByText(t('agents.loadFailed'))).toBeTruthy()
    expect(screen.getByRole('button', { name: t('agents.retry') })).toBeTruthy()
  })

  it('名册空:一句话 + 怎么装', async () => {
    configureAcpAgentsPort(fakePort([]))
    render(<AgentsSettings />)
    expect(await screen.findAllByText(t('agents.emptyTitle'))).not.toHaveLength(0)
    expect(screen.getByText(t('agents.emptyHint'))).toBeTruthy()
  })

  it('三组各归各的,打开就探测一次,详情说出版本号', async () => {
    const fake = fakePort([
      row('gemini'),
      row('reg', { source: 'registry', detect: { installed: false, checkedAt: 1 } }),
      row('mine', { source: 'user', manifest: undefined }, { name: 'Mine' }),
    ])
    configureAcpAgentsPort(fake)
    render(<AgentsSettings />)
    expect(await screen.findByTestId('agent-row-gemini')).toBeTruthy()
    expect(screen.getByTestId('agent-row-reg')).toBeTruthy()
    expect(screen.getByTestId('agent-row-mine')).toBeTruthy()
    expect(screen.getAllByText(t('agents.groupBuiltin')).length).toBeGreaterThan(0)
    expect(screen.getAllByText(t('agents.groupRegistry')).length).toBeGreaterThan(0)
    expect(screen.getAllByText(t('agents.groupUser')).length).toBeGreaterThan(0)
    await waitFor(() => expect(fake.calls).toContain('detect'))
    // 开面落在第一台上。
    expect(screen.getByTestId('agent-detail-gemini')).toBeTruthy()
    expect(screen.getByTestId('agent-install-state').textContent).toContain(t('agents.installedVersion', { version: '1.2.3' }))
  })

  it('启用开关:乐观翻过去,发出去的是生效配置 ⊕ { enabled }', async () => {
    const fake = fakePort([row('gemini')])
    configureAcpAgentsPort(fake)
    render(<AgentsSettings />)
    const toggle = await screen.findByRole('switch', { name: t('agents.enable') })
    fireEvent.click(toggle)
    await waitFor(() => expect(fake.updates).toHaveLength(1))
    expect(fake.updates[0]).toMatchObject({ id: 'gemini', enabled: false, command: 'gemini-bin' })
  })

  it('没装且有 npm 包 → 「装上」在终端里跑 npm i -g', async () => {
    configureAcpAgentsPort(
      fakePort([
        row('codex', {
          detect: { installed: false, checkedAt: 1 },
          manifest: { id: 'codex', name: 'Codex', install: { npm: '@x/codex-acp' } },
        }),
      ]),
    )
    render(<AgentsSettings />)
    fireEvent.click(await screen.findByTestId('agent-install'))
    await waitFor(() => expect(runScript).toHaveBeenCalledTimes(1))
    expect(runScript.mock.calls[0]).toEqual([{ shell: 'bash', script: 'npm i -g @x/codex-acp' }])
  })

  it('没装且只有装法 → 画那句装法,不画钮', async () => {
    configureAcpAgentsPort(
      fakePort([row('kimi', { detect: { installed: false, checkedAt: 1 }, manifest: { id: 'kimi', name: 'Kimi', install: { hint: 'see releases' } } })]),
    )
    render(<AgentsSettings />)
    expect(await screen.findByText(t('agents.installHint', { hint: 'see releases' }))).toBeTruthy()
    expect(screen.queryByTestId('agent-install')).toBeNull()
  })

  it('种子那一台是「复制为自定义」,自定义那一台是「删除」', async () => {
    configureAcpAgentsPort(fakePort([row('gemini'), row('mine', { source: 'user' })]))
    render(<AgentsSettings />)
    expect(await screen.findByTestId('agent-duplicate')).toBeTruthy()
    expect(screen.queryByTestId('agent-remove')).toBeNull()
    fireEvent.click(screen.getByTestId('agent-row-mine'))
    expect(await screen.findByTestId('agent-remove')).toBeTruthy()
    expect(screen.queryByTestId('agent-duplicate')).toBeNull()
  })

  it('添加自定义:命令空着不发,就地一句', async () => {
    const fake = fakePort([row('gemini')])
    const add = vi.spyOn(fake, 'addAgent')
    configureAcpAgentsPort(fake)
    render(<AgentsSettings />)
    fireEvent.click(await screen.findByTestId('agent-add-custom'))
    fireEvent.click(await screen.findByTestId('agent-add-submit'))
    expect(await screen.findByText(t('agents.commandRequired'))).toBeTruthy()
    expect(add).not.toHaveBeenCalled()
  })
})
