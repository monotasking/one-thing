import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ACPAgentConfig, ACPAgentState } from '@shared/ipc/acp'

const runScript = vi.fn(async () => undefined)
vi.mock('../../terminal/run-script', () => ({ runScriptInTerminal: (...args: unknown[]) => runScript(...(args as [])) }))
const reveal = vi.fn()
vi.mock('../../terminal-launcher', () => ({ revealTerminal: (id: string) => reveal(id) }))
const openPage = vi.fn()
vi.mock('../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store')>()),
  openSettingsPage: (id: string) => openPage(id),
}))

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
    authenticate: async () => ({ ok: true }),
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

/**
 * A3-d:登录与权限两节。
 *  ① 登录四态由 `auth` 推出来(不知道 / 未登录带原话 / 已登录),rail 那颗点跟着变;
 *  ② 一种方式 = 一颗钮:终端型答回 terminalId → 把那一格终端摆出来 + 就地一句;
 *     agent 型答 ok → 就地「登录好了」;失败按机器码查字典;
 *  ③ 几种方式 = 点开一张小菜单,选哪种发哪种;
 *  ④ 「没人回应时自动允许」发出去的是生效配置 ⊕ { unattended },一句警告在旁边;
 *  ⑤ 「查看已授权」跳权限页。
 */
describe('AgentsSettings · 登录与权限(A3-d)', () => {
  const TERMINAL = { id: 'claude-ai-login', name: 'Claude 订阅', type: 'terminal' as const }
  const AGENT = { id: 'claude-login', name: 'Claude 自己登录', type: 'agent' as const }

  it('① 登录态:缺席 = 连上之后才知道,不画钮;required = 未登录 + 原话', async () => {
    configureAcpAgentsPort(fakePort([row('gemini')]))
    const view = render(<AgentsSettings />)
    expect((await screen.findByTestId('agent-login-state')).textContent).toBe(t('agents.loginUnknown'))
    expect(screen.queryByTestId('agent-login-button')).toBeNull()
    view.unmount()
    resetAcpAgentsSource()
    configureAcpAgentsPort(fakePort([row('gemini', { auth: { methods: [TERMINAL], required: true, label: 'not logged in' } })]))
    render(<AgentsSettings />)
    const fact = await screen.findByTestId('agent-login-state')
    expect(fact.textContent).toBe(t('agents.loginRequiredSaid', { said: 'not logged in' }))
    expect(fact.getAttribute('data-login-required')).toBe('true')
    expect(screen.getByTestId('agent-login-button').textContent).toBe(t('agents.login'))
  })

  it('② 终端型:答回 terminalId → 那一格终端摆出来,旁边一句「在终端里走完」', async () => {
    const fake = fakePort([row('gemini', { auth: { methods: [TERMINAL], required: true } })])
    const asked: unknown[] = []
    fake.authenticate = async (request) => {
      asked.push(request)
      return { ok: true, terminalId: 'term-9' }
    }
    configureAcpAgentsPort(fake)
    render(<AgentsSettings />)
    fireEvent.click(await screen.findByTestId('agent-login-button'))
    await waitFor(() => expect(reveal).toHaveBeenCalledWith('term-9'))
    expect(asked).toEqual([{ agentId: 'gemini', methodId: 'claude-ai-login' }])
    expect((await screen.findByTestId('agent-login-outcome')).getAttribute('data-outcome')).toBe('terminal')
  })

  it('② agent 型成功就地「登录好了」;失败按机器码说人话', async () => {
    const fake = fakePort([row('gemini', { auth: { methods: [AGENT], required: true } })])
    let answer: import('@shared/ipc/acp').ACPAuthenticateResponse = { ok: true }
    fake.authenticate = async () => answer
    configureAcpAgentsPort(fake)
    render(<AgentsSettings />)
    fireEvent.click(await screen.findByTestId('agent-login-button'))
    expect((await screen.findByTestId('agent-login-outcome')).textContent).toBe(t('agents.loginDone'))
    answer = { ok: false, code: 'no-terminal', error: 'x' }
    fireEvent.click(screen.getByTestId('agent-login-button'))
    await waitFor(() => expect(screen.getByTestId('agent-login-outcome').textContent).toBe(t('agents.loginErrNoTerminal')))
    expect(screen.getByTestId('agent-login-outcome').getAttribute('data-outcome')).toBe('failed')
  })

  it('③ 几种方式 = 一张小菜单,选哪种发哪种', async () => {
    const fake = fakePort([row('gemini', { auth: { methods: [TERMINAL, AGENT], required: false } })])
    const asked: string[] = []
    fake.authenticate = async (request) => {
      asked.push(request.methodId)
      return { ok: true }
    }
    configureAcpAgentsPort(fake)
    render(<AgentsSettings />)
    expect((await screen.findByTestId('agent-login-state')).textContent).toBe(t('agents.loginOk'))
    fireEvent.click(screen.getByTestId('agent-login-button'))
    fireEvent.click(await screen.findByRole('menuitem', { name: AGENT.name }))
    await waitFor(() => expect(asked).toEqual(['claude-login']))
  })

  it('④ 无人值守开关:发出去的是生效配置 ⊕ { unattended: allow },旁边一句警告', async () => {
    const fake = fakePort([row('gemini')])
    configureAcpAgentsPort(fake)
    render(<AgentsSettings />)
    const toggle = await screen.findByRole('switch', { name: t('agents.unattended') })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText(t('agents.unattendedHint'))).toBeTruthy()
    fireEvent.click(toggle)
    await waitFor(() => expect(fake.updates).toHaveLength(1))
    expect(fake.updates[0]).toMatchObject({ id: 'gemini', unattended: 'allow', command: 'gemini-bin' })
    // 只改了这一格:启用开关不因它禁着(忙态按格分)。
    expect(screen.getByRole('switch', { name: t('agents.enable') }).hasAttribute('disabled')).toBe(false)
  })

  it('⑤ 「查看已授权」跳权限页', async () => {
    configureAcpAgentsPort(fakePort([row('gemini')]))
    /*
     * 先把 `../store` 那张模块图热起来:组件点击时 `import('./store')` 是动态的,第一次要现编
     * (mock 的 importOriginal 会把页表整张拖进来),单跑这个文件时那一下能超过 `waitFor` 的
     * 1000ms 缺省 —— 量到过 1018ms 的红。热过之后组件那一发命中模块缓存,断言只等一个微任务。
     */
    await import('../store')
    render(<AgentsSettings />)
    fireEvent.click(await screen.findByTestId('agent-view-grants'))
    await waitFor(() => expect(openPage).toHaveBeenCalledWith('permissions'))
  })
})
