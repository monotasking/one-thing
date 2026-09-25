import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ACPAgentConfig, ACPAgentState } from '@shared/ipc/acp'

const notify = vi.fn()
vi.mock('../../../services/notify', () => ({ notify: (...args: unknown[]) => notify(...args) }))
const requestDirectory = vi.fn()
vi.mock('../../files/open-dir-hub', () => ({ requestDirectory: (...args: unknown[]) => requestDirectory(...args) }))

import { AcpImportDialog } from '../AcpImportDialog'
import { useAcpImport } from '../import-hub'
import { AcpImportRow } from '../../../expose/components/AcpImportRow'
import { configureAcpAgentsPort, resetAcpAgentsSource, type AcpAgentsPort } from '../../../data/acp-agents-source'
import {
  configureAcpSessionsPort,
  resetAcpSessionsSource,
  type AcpListRemoteSessionsResponse,
  type AcpSessionsPort,
} from '../../../data/acp-sessions-source'
import { useExposeStore } from '../../../expose/store'
import { useSessionsSource } from '../../../data/sessions-source'
import { t } from '../../../i18n'

/**
 * 「从 Agent 导入…」(A5-b)。钉五态 + 入口:
 *  ① 不支持列会话 → 一句人话(原话在括号里),不是错误态;
 *  ② 空 → 一句「这个目录下没有」;
 *  ③ 有 → 行 = 标题 · 已认领的行尾「已导入」;
 *  ④ 点一条没认领的 → `adoptSession`(agent × 远端 id × 目录)→ 关窗、列表对账、进新会话、「已导入 N 条」;
 *  ⑤ 点一条已认领的 → 不再认领,直接进那条本地会话;
 *  ⑥ 入口那一行:没有候选不在场;一台候选写它的名字,点下去直接去挑目录。
 */

function agent(id: string, over: Partial<ACPAgentState> = {}): ACPAgentState {
  return {
    config: { id, name: id === 'gemini' ? 'Gemini CLI' : id, enabled: true, command: `${id}-bin` } as ACPAgentConfig,
    status: 'disconnected',
    sessionCount: 0,
    activePromptCount: 0,
    source: 'builtin',
    detect: { installed: true, checkedAt: 1 },
    ...over,
  }
}

function agentsPort(rows: ACPAgentState[]): AcpAgentsPort {
  return {
    ready: async () => undefined,
    getAgents: async () => ({ success: true, agents: rows }),
    detect: async () => ({ success: true, agents: rows }),
    refreshRegistry: async () => ({ success: true, agents: rows }),
    addAgent: async () => ({ success: true }),
    updateAgent: async () => ({ success: true }),
    removeAgent: async () => ({ success: true }),
    authenticate: async () => ({ ok: true }),
    onAgentState: () => () => undefined,
  }
}

function sessionsPort(list: AcpListRemoteSessionsResponse, adopt = vi.fn()): AcpSessionsPort & { adopt: typeof adopt } {
  return {
    adopt,
    ready: async () => undefined,
    listRemoteSessions: async () => list,
    adoptSession: async (input) => adopt(input),
    forkSession: async () => ({ ok: false, code: 'failed', error: '' }),
    reconnectAgent: async () => ({ ok: false, error: '' }),
  }
}

const enterSession = vi.fn()
const refresh = vi.fn(async () => undefined)

beforeEach(() => {
  resetAcpAgentsSource()
  resetAcpSessionsSource()
  notify.mockClear()
  requestDirectory.mockClear()
  enterSession.mockClear()
  refresh.mockClear()
  useExposeStore.setState({ enterSession })
  useSessionsSource.setState({ refresh })
  configureAcpAgentsPort(agentsPort([agent('gemini'), agent('codex')]))
})

afterEach(() => {
  // 挂着的组件还订着这几格:复位会让它们重渲一次,所以包在 act 里。
  act(() => {
    useAcpImport.getState().close()
    resetAcpAgentsSource()
    resetAcpSessionsSource()
  })
  configureAcpAgentsPort(undefined)
  configureAcpSessionsPort(undefined)
})

function openAt(agentId: string, cwd: string) {
  render(<AcpImportDialog />)
  act(() => useAcpImport.getState().showSessions(agentId, cwd))
}

describe('AcpImportDialog · 第二步五态', () => {
  it('① 不支持列会话 → 一句人话 + 原话', async () => {
    configureAcpSessionsPort(sessionsPort({ ok: false, code: 'unsupported', error: 'no session/list' }))
    openAt('gemini', '/work')
    const line = await screen.findByTestId('acp-import-refused')
    expect(line.getAttribute('data-code')).toBe('unsupported')
    expect(line.textContent).toContain('no session/list')
    expect(screen.queryByTestId('acp-import-error')).toBeNull()
  })

  it('② 空 → 「这个目录下没有」', async () => {
    configureAcpSessionsPort(sessionsPort({ ok: true, sessions: [] }))
    openAt('gemini', '/work')
    expect(await screen.findByTestId('acp-import-empty')).toBeTruthy()
  })

  it('③ 有 → 行 = 标题,已认领那一行尾「已导入」', async () => {
    configureAcpSessionsPort(
      sessionsPort({
        ok: true,
        sessions: [
          { acpSessionId: 'r1', cwd: '/work', title: 'Fix the parser', updatedAt: new Date().toISOString() },
          { acpSessionId: 'r2', cwd: '/work', title: 'Old one', adoptedSessionId: 'local-9' },
        ],
      }),
    )
    openAt('gemini', '/work')
    const first = await screen.findByTestId('acp-import-session-r1')
    expect(first.textContent).toContain('Fix the parser')
    expect(first.textContent).not.toContain(t('acpImport.adopted'))
    const second = screen.getByTestId('acp-import-session-r2')
    expect(second.getAttribute('data-adopted')).toBe('true')
    expect(second.textContent).toContain(t('acpImport.adopted'))
  })

  it('④ 点一条没认领的 → adoptSession → 关窗、对账、进会话、「已导入 N 条」', async () => {
    const adopt = vi.fn(async () => ({ ok: true as const, sessionId: 'local-1', imported: 4, alreadyAdopted: false }))
    configureAcpSessionsPort(sessionsPort({ ok: true, sessions: [{ acpSessionId: 'r1', cwd: '/work', title: 'T' }] }, adopt))
    openAt('gemini', '/work')
    fireEvent.click(await screen.findByTestId('acp-import-session-r1'))
    await waitFor(() => expect(enterSession).toHaveBeenCalledWith('local-1'))
    expect(adopt).toHaveBeenCalledWith({ agentId: 'gemini', acpSessionId: 'r1', cwd: '/work' })
    expect(refresh).toHaveBeenCalled()
    expect(useAcpImport.getState().open).toBe(false)
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ level: 'success', title: t('acpImport.done', { n: 4 }) }))
  })

  it('④′ 认领被拒 → 列表下一行原话,窗不关', async () => {
    const adopt = vi.fn(async () => ({ ok: false as const, code: 'failed' as const, error: 'load refused' }))
    configureAcpSessionsPort(sessionsPort({ ok: true, sessions: [{ acpSessionId: 'r1', cwd: '/work', title: 'T' }] }, adopt))
    openAt('gemini', '/work')
    fireEvent.click(await screen.findByTestId('acp-import-session-r1'))
    expect((await screen.findByTestId('acp-import-adopt-error')).textContent).toContain('load refused')
    expect(useAcpImport.getState().open).toBe(true)
    expect(enterSession).not.toHaveBeenCalled()
  })

  it('⑤ 点一条已认领的 → 不再认领,直接进那条本地会话', async () => {
    const adopt = vi.fn()
    configureAcpSessionsPort(
      sessionsPort({ ok: true, sessions: [{ acpSessionId: 'r2', cwd: '/work', title: 'Old', adoptedSessionId: 'local-9' }] }, adopt),
    )
    openAt('gemini', '/work')
    fireEvent.click(await screen.findByTestId('acp-import-session-r2'))
    await waitFor(() => expect(enterSession).toHaveBeenCalledWith('local-9'))
    expect(adopt).not.toHaveBeenCalled()
  })
})

describe('AcpImportRow(会话侧栏入口)', () => {
  it('没有候选 → 整行不在', async () => {
    configureAcpAgentsPort(agentsPort([agent('gemini', { capabilities: { sessionCapabilities: {} } })]))
    render(<AcpImportRow />)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.queryByTestId('expose-acp-import')).toBeNull()
  })

  it('一台候选 → 写它的名字,点下去直接去挑目录', async () => {
    configureAcpAgentsPort(
      agentsPort([agent('gemini', { capabilities: { sessionCapabilities: { list: {} } } }), agent('codex', { detect: { installed: false, checkedAt: 1 } })]),
    )
    render(<AcpImportRow />)
    const row = await screen.findByTestId('expose-acp-import')
    expect(row.textContent).toBe(t('acpImport.fromAgent', { name: 'Gemini CLI' }))
    fireEvent.click(row)
    expect(requestDirectory).toHaveBeenCalledTimes(1)
    expect(useAcpImport.getState().open).toBe(false)
  })

  it('几台候选 → 「从 Agent 导入…」,点下去开在挑 agent 那一步', async () => {
    render(
      <>
        <AcpImportRow />
        <AcpImportDialog />
      </>,
    )
    fireEvent.click(await screen.findByTestId('expose-acp-import'))
    expect(await screen.findByTestId('acp-import-agent-gemini')).toBeTruthy()
    expect(screen.getByTestId('acp-import-agent-codex')).toBeTruthy()
    fireEvent.click(screen.getByTestId('acp-import-agent-codex'))
    expect(requestDirectory).toHaveBeenCalledTimes(1)
    // 挑完目录开在第二步。
    const onPick = requestDirectory.mock.calls[0]![0] as (dir: string) => void
    configureAcpSessionsPort(sessionsPort({ ok: true, sessions: [] }))
    await act(async () => {
      onPick('/picked')
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(useAcpImport.getState().step).toEqual({ kind: 'sessions', agentId: 'codex', cwd: '/picked' })
  })
})
