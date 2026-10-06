import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CredentialsStatusPayload } from '@shared/ipc/spaces'
import { CredentialsSettings } from '../CredentialsSettings'
import { configureCredentialsPort } from '../../../data/credentials-port'
import type { CredentialsPort } from '../../../data/credentials-port'
import { receiveCredentialsStatus, stopCredentialsLock } from '../../../data/credentials-lock-source'
import { useStageStore } from '../../../stage/store'
import { useNotifyStore } from '../../../services/notify-store'

/**
 * 设置 ·「工作区」页的凭证一节(第④步批 0)。钉住:
 *  ① 两颗钮与档位说明的文案逐字是派工单那几句;`keychain` 档不画说明;
 *  ② 导出:口令为空确认钮不可点;填了口令 → 端口收到口令 → 文件交给浏览器下载 → 对话框关;
 *  ③ 口令不对(后端答失败)→ 口令框标红、对话框不关;
 *  ④ 锁着时「导出」不可用(锁着读到的是空池),「导入」照旧可用(那是恢复的那条路);
 *  ⑤(第④步批 1 补的文案)口令不对框下一行「口令不对。」;导出 / 导入成功各一条轻提示;钥匙还在读时
 *     档位那一行说「正在读取钥匙串。」。
 */
const status = (over: Partial<CredentialsStatusPayload>): CredentialsStatusPayload => ({
  tier: 'keychain',
  state: 'ready',
  encryption: 'master-key',
  ...over,
})

function fakePort(over: Partial<CredentialsPort> = {}): CredentialsPort {
  return {
    ready: async () => undefined,
    status: async () => ({ success: true, status: status({}) }),
    unlock: async () => ({ success: true, status: status({}) }),
    exportCredentials: async () => ({ success: true, fileName: 'onething-credentials-2026-10-06.json', data: '{}', entries: 1 }),
    importCredentials: async () => ({ success: true, imported: 1, skippedSpaces: [] }),
    onLockPush: () => () => undefined,
    ...over,
  }
}

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
})

afterEach(() => {
  stopCredentialsLock()
  configureCredentialsPort(undefined)
  vi.restoreAllMocks()
})

describe('凭证一节', () => {
  it('① 文案逐字;档位说明按档位选,钥匙串档不画', () => {
    act(() => receiveCredentialsStatus(status({ tier: 'file' })))
    const { rerender } = render(<CredentialsSettings />)
    expect(screen.getByRole('button', { name: '导出凭证' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '导入凭证' })).toBeTruthy()
    expect(screen.getByText('这台电脑上凭证密钥存在本地文件里。')).toBeTruthy()

    act(() => receiveCredentialsStatus(status({ tier: 'none', encryption: 'none' })))
    rerender(<CredentialsSettings />)
    expect(screen.getByText('凭证没有加密。')).toBeTruthy()

    act(() => receiveCredentialsStatus(status({ tier: 'keychain' })))
    rerender(<CredentialsSettings />)
    expect(screen.queryByText('凭证没有加密。')).toBeNull()
    expect(screen.queryByText('这台电脑上凭证密钥存在本地文件里。')).toBeNull()
  })

  it('② 导出:空口令不可点;填了 → 端口收到口令 → 交给浏览器下载 → 对话框关', async () => {
    const exportCredentials = vi.fn(async () => ({ success: true, fileName: 'onething-credentials-2026-10-06.json', data: '{"x":1}', entries: 1 }))
    configureCredentialsPort(fakePort({ exportCredentials }))
    const createObjectURL = vi.fn(() => 'blob:x')
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    render(<CredentialsSettings />)

    fireEvent.click(screen.getByRole('button', { name: '导出凭证' }))
    expect(screen.getByText('导出文件用这个口令加密,导入时要输入同一个口令。')).toBeTruthy()
    const confirm = screen.getByTestId('credentials-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)

    fireEvent.change(screen.getByTestId('credentials-passphrase'), { target: { value: 'pw' } })
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    await waitFor(() => expect(exportCredentials).toHaveBeenCalledWith('pw'))
    await waitFor(() => expect(click).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByTestId('credentials-confirm')).toBeNull())
    vi.unstubAllGlobals()
  })

  it('③ 口令不对:口令框标红,对话框不关', async () => {
    configureCredentialsPort(fakePort({ importCredentials: async () => ({ success: false, code: 'WRONG_PASSPHRASE' }) }))
    render(<CredentialsSettings />)
    const text = '{"format":"onething-credentials-export"}'
    const file = new File([text], 'export.json', { type: 'application/json' })
    /* 这一档 jsdom 的 `File` 没有 `text()`(真机上 Electron 与浏览器都有),补一格(同 keymap-settings.test)。 */
    Object.defineProperty(file, 'text', { value: async () => text })
    fireEvent.change(screen.getByTestId('credentials-import-file'), { target: { files: [file] } })
    await waitFor(() => expect(screen.getByTestId('credentials-confirm')).toBeTruthy())

    fireEvent.change(screen.getByTestId('credentials-passphrase'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByTestId('credentials-confirm'))
    await waitFor(() => expect(screen.getByTestId('credentials-passphrase').getAttribute('aria-invalid')).toBe('true'))
    expect(screen.getByTestId('credentials-confirm')).toBeTruthy()
    // ⑤ 框下一行(按错误码判,不认英文报错串)。
    expect(screen.getByText('口令不对。')).toBeTruthy()
  })

  it('⑤ 导出 / 导入成功各一条轻提示;钥匙还在读时档位那一行说「正在读取钥匙串。」', async () => {
    useNotifyStore.setState({ items: [] })
    configureCredentialsPort(fakePort({ importCredentials: async () => ({ success: true, imported: 3, skippedSpaces: [] }) }))
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const { rerender } = render(<CredentialsSettings />)

    fireEvent.click(screen.getByRole('button', { name: '导出凭证' }))
    fireEvent.change(screen.getByTestId('credentials-passphrase'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByTestId('credentials-confirm'))
    await waitFor(() => expect(useNotifyStore.getState().items.map((x) => [x.level, x.title])).toContainEqual(['success', '凭证已导出。']))

    const text = '{"format":"onething-credentials-export"}'
    const file = new File([text], 'export.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: async () => text })
    fireEvent.change(screen.getByTestId('credentials-import-file'), { target: { files: [file] } })
    await waitFor(() => expect(screen.getByTestId('credentials-confirm')).toBeTruthy())
    fireEvent.change(screen.getByTestId('credentials-passphrase'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByTestId('credentials-confirm'))
    await waitFor(() => expect(useNotifyStore.getState().items.map((x) => x.title)).toContain('已导入 3 个凭证。'))
    vi.unstubAllGlobals()

    act(() => receiveCredentialsStatus(status({ state: 'loading' })))
    rerender(<CredentialsSettings />)
    expect(screen.getByText('正在读取钥匙串。')).toBeTruthy()
  })

  it('④ 锁着:导出不可用,导入照旧可用', () => {
    act(() => receiveCredentialsStatus(status({ state: 'locked', reason: 'key-missing' })))
    render(<CredentialsSettings />)
    expect((screen.getByRole('button', { name: '导出凭证' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '导入凭证' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
