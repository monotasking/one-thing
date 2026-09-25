import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { OAuthStartResponse } from '@shared/ipc/oauth'
import { AuthFlowScreen } from '../AuthFlowScreen'
import { IDLE_AUTH_FLOW } from '../../auth'
import type { AuthFlowState } from '../../auth'
import { useProviderSettings } from '../../store'
import { configureProviderSettingsPort } from '../../../data/provider-settings-port'
import { fakeProviderPort } from '../../__tests__/fake-port'
import { COPY_FEEDBACK_MS } from '../../../components/motion'
import { useStageStore } from '../../../stage/store'

/**
 * 一屏三流(批 1,方案 §3.2)。守三件事:
 *  ① 行按事实显隐 —— 授权页行三流都有,用户码行只有设备码,贴码框只有贴码;
 *  ② 点链接 / 「打开」= `openExternal` **一次**,参数就是后端 `oauth.start` 交回的那个网址
 *     (走真 store:`startAuth` 落格 → 屏上点 → `openAuthPage` → 帮手);
 *  ③ 复制:点码本身与「复制」钮都复制,钮上的字换「已复制」,`COPY_FEEDBACK_MS` 后复原。
 */

const external = vi.hoisted(() => ({ open: vi.fn<(url: string) => Promise<undefined>>(async () => undefined) }))
vi.mock('../../../platform/open-external', () => ({
  openExternal: (url: string) => external.open(url),
  // jsdom 里没有桌面宿主:起流时不自动开,屏上那一下点击是唯一一次打开。
  hasDesktopHost: () => false,
}))

const clipboard = vi.hoisted(() => ({ copy: vi.fn<(text: string) => Promise<boolean>>(async () => true) }))
vi.mock('../../../services/clipboard', () => ({ copyText: (text: string) => clipboard.copy(text) }))

const BROWSER: OAuthStartResponse = { success: true, flowId: 'b1', authUrl: 'https://auth.openai.com/oauth/authorize?state=b1' }
const PASTE: OAuthStartResponse = {
  success: true,
  flowId: 'p1',
  requiresCodeEntry: true,
  state: 'st',
  instructions: '',
  authUrl: 'https://claude.ai/oauth/authorize?state=p1',
}
const DEVICE: OAuthStartResponse = {
  success: true,
  flowId: 'd1',
  userCode: 'WDJB-MJHT',
  verificationUri: 'https://accounts.x.ai/device?user_code=WDJB-MJHT',
}

/** 起一条真流(真 store + 假端口),再把这一坑的屏画出来,点击走 store 的 `openAuthPage`。 */
async function screenFor(providerId: string, started: OAuthStartResponse) {
  configureProviderSettingsPort(fakeProviderPort({ oauthStart: vi.fn(async () => started) }))
  await useProviderSettings.getState().startAuth(providerId)
  const flow = useProviderSettings.getState().authFlow[providerId]!
  const onCancel = vi.fn()
  const view = render(
    <AuthFlowScreen
      flow={flow}
      onOpen={() => void useProviderSettings.getState().openAuthPage(providerId)}
      onCode={vi.fn()}
      onSubmitCode={vi.fn()}
      onCancel={onCancel}
      onRetry={vi.fn()}
    />,
  )
  return { flow, onCancel, ...view }
}

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  useProviderSettings.getState().reset()
  external.open.mockReset().mockResolvedValue(undefined)
  clipboard.copy.mockReset().mockResolvedValue(true)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('AuthFlowScreen · 行按事实显隐', () => {
  it('浏览器回调流:授权页行(链接 + 打开 + 复制)+ 状态句;没有码行、没有贴码框', async () => {
    await screenFor('codex', BROWSER)
    const link = screen.getByTestId('auth-flow-url')
    expect(link.textContent).toBe(BROWSER.authUrl)
    expect(link.getAttribute('href')).toBe(BROWSER.authUrl)
    expect(screen.getByRole('button', { name: '打开' })).toBeTruthy()
    expect(screen.getByTestId('auth-flow-copy-url')).toBeTruthy()
    expect(screen.queryByTestId('auth-flow-user-code')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    // 没真打开(网页壳 / 打开失败):不许说「已打开授权页」。
    expect(screen.getByText('点「打开」去授权,完成后这里自动更新。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '取消登录' })).toBeTruthy()
  })

  it('贴码流:授权页行 + 贴码框;没有码行', async () => {
    await screenFor('claude-code', PASTE)
    expect(screen.getByTestId('auth-flow-url').textContent).toBe(PASTE.authUrl)
    expect(screen.getByRole('textbox')).toBeTruthy()
    expect(screen.queryByTestId('auth-flow-user-code')).toBeNull()
  })

  it('设备码流:授权页行(verification_uri_complete)+ 用户码行;没有贴码框', async () => {
    await screenFor('grok-oauth', DEVICE)
    expect(screen.getByTestId('auth-flow-url').textContent).toBe(DEVICE.verificationUri)
    expect(screen.getByTestId('auth-flow-user-code').textContent).toBe('WDJB-MJHT')
    expect(screen.getByTestId('auth-flow-copy-code')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('真打开了才说「已打开授权页」', () => {
    const flow: AuthFlowState = { ...IDLE_AUTH_FLOW, kind: 'browser', flowId: 'x', opened: true, browser: { authUrl: 'https://a' } }
    render(<AuthFlowScreen flow={flow} onOpen={vi.fn()} onCode={vi.fn()} onSubmitCode={vi.fn()} onCancel={vi.fn()} onRetry={vi.fn()} />)
    expect(screen.getByText('已打开授权页,完成后这里自动更新。')).toBeTruthy()
    expect(screen.queryByText('点「打开」去授权,完成后这里自动更新。')).toBeNull()
  })
})

describe('AuthFlowScreen · 打开授权页', () => {
  it.each([
    ['codex', BROWSER, BROWSER.authUrl],
    ['claude-code', PASTE, PASTE.authUrl],
    ['grok-oauth', DEVICE, DEVICE.verificationUri],
  ] as const)('%s:点链接 = openExternal 一次,参数是 oauth.start 交回的网址', async (pid, started, url) => {
    await screenFor(pid, started)
    fireEvent.click(screen.getByTestId('auth-flow-url'))
    await vi.waitFor(() => expect(external.open).toHaveBeenCalledTimes(1))
    expect(external.open).toHaveBeenCalledWith(url)
  })

  it('「打开」钮与链接是同一个动作', async () => {
    await screenFor('codex', BROWSER)
    fireEvent.click(screen.getByRole('button', { name: '打开' }))
    await vi.waitFor(() => expect(external.open).toHaveBeenCalledTimes(1))
    expect(external.open).toHaveBeenCalledWith(BROWSER.authUrl)
  })
})

describe('AuthFlowScreen · 复制', () => {
  it('点码本身也复制;钮上换「已复制」,COPY_FEEDBACK_MS 后复原', async () => {
    await screenFor('grok-oauth', DEVICE)
    vi.useFakeTimers()
    const copyBtn = screen.getByTestId('auth-flow-copy-code')
    expect(copyBtn.textContent).toBe('复制')
    await act(async () => {
      fireEvent.click(screen.getByTestId('auth-flow-user-code'))
    })
    expect(clipboard.copy).toHaveBeenCalledWith('WDJB-MJHT')
    expect(copyBtn.textContent).toBe('已复制')
    await act(async () => {
      vi.advanceTimersByTime(COPY_FEEDBACK_MS)
    })
    expect(copyBtn.textContent).toBe('复制')
  })

  it('复制授权页网址', async () => {
    await screenFor('codex', BROWSER)
    await act(async () => {
      fireEvent.click(screen.getByTestId('auth-flow-copy-url'))
    })
    expect(clipboard.copy).toHaveBeenCalledWith(BROWSER.authUrl)
    expect(screen.getByTestId('auth-flow-copy-url').textContent).toBe('已复制')
  })
})

describe('AuthFlowScreen · 终局', () => {
  const ended = (over: Partial<AuthFlowState>): AuthFlowState => ({
    ...IDLE_AUTH_FLOW,
    kind: 'device',
    flowId: 'd',
    device: { userCode: 'C', verificationUri: 'https://v' },
    ...over,
  })

  it('failed:「登录失败」+ 重试;码与链接已作废,不画', () => {
    const onRetry = vi.fn()
    render(
      <AuthFlowScreen
        flow={ended({ ended: 'failed', error: 'Token exchange failed: 400' })}
        onOpen={vi.fn()}
        onCode={vi.fn()}
        onSubmitCode={vi.fn()}
        onCancel={vi.fn()}
        onRetry={onRetry}
      />,
    )
    expect(screen.getByTestId('auth-flow-failed').textContent).toBe('登录失败')
    expect(screen.queryByTestId('auth-flow-url')).toBeNull()
    expect(screen.queryByTestId('auth-flow-user-code')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('access_denied 说「你在授权页拒绝了」', () => {
    render(
      <AuthFlowScreen flow={ended({ ended: 'failed', error: 'access_denied' })} onOpen={vi.fn()} onCode={vi.fn()} onSubmitCode={vi.fn()} onCancel={vi.fn()} onRetry={vi.fn()} />,
    )
    expect(screen.getByText('你在授权页拒绝了')).toBeTruthy()
  })

  it('expired:说超时,给重试', () => {
    render(
      <AuthFlowScreen flow={ended({ ended: 'expired', error: 'expired_token' })} onOpen={vi.fn()} onCode={vi.fn()} onSubmitCode={vi.fn()} onCancel={vi.fn()} onRetry={vi.fn()} />,
    )
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '取消登录' })).toBeTruthy()
  })
})
