import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultSettings } from '@shared/defaults/settings'
import type { AppSettings, SaveSettingsResponse, TestProxyResponse } from '@shared/ipc/settings'
import { NetworkSettings } from '../NetworkSettings'
import { configureNetworkSettingsPort, type NetworkSettingsPort } from '../../../data/network-settings-port'
import {
  editNetworkProxy,
  flushNetworkProxy,
  networkSettingsQuery,
  PROXY_SAVE_DELAY_MS,
  resetNetworkSettings,
  useProxyEditor,
} from '../../../data/network-settings-source'
import { t } from '../../../i18n'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function fakePort(enabled = false) {
  let settings = createDefaultSettings()
  settings.network!.proxy = { enabled, url: 'http://127.0.0.1:7890', bypassRules: 'localhost;*.local' }
  const port = {
    readSettings: vi.fn(async () => ({ success: true, settings })),
    saveSettings: vi.fn(async (next: AppSettings): Promise<SaveSettingsResponse> => {
      settings = next
      return { success: true, settings }
    }),
    testProxy: vi.fn(async (): Promise<TestProxyResponse> => ({ success: true, status: 204 })),
  } satisfies NetworkSettingsPort
  configureNetworkSettingsPort(port)
  return port
}

async function mount() {
  let view!: ReturnType<typeof render>
  await act(async () => { view = render(<NetworkSettings />) })
  return view
}

beforeEach(() => {
  vi.useFakeTimers()
  resetNetworkSettings()
})
afterEach(() => {
  cleanup()
  resetNetworkSettings()
  configureNetworkSettingsPort(undefined)
  vi.useRealTimers()
})

describe('network proxy settings', () => {
  it('disables controls until loaded, and offers a retry after a load failure', async () => {
    const loading = deferred<Awaited<ReturnType<NetworkSettingsPort['readSettings']>>>()
    const port = fakePort()
    port.readSettings.mockImplementationOnce(() => loading.promise as ReturnType<typeof port.readSettings>)
    await mount()
    expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(true)
    expect(screen.getByLabelText(t('network.url')).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(t('network.loading'))).toBeTruthy()
    await act(async () => { loading.resolve({ success: false, error: 'offline' }) })
    expect(screen.getByRole('alert').textContent).toContain('offline')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('network.retry') })) })
    expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(false)
  })

  it('updates the toggle immediately and shows saving until the backend acknowledges', async () => {
    const port = fakePort()
    const saving = deferred<SaveSettingsResponse>()
    port.saveSettings.mockImplementationOnce(() => saving.promise)
    await mount()
    await act(async () => { fireEvent.click(screen.getByRole('switch')) })
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText(t('common.saving'))).toBeTruthy()
    expect(screen.getByRole('button', { name: t('network.test') }).hasAttribute('disabled')).toBe(true)
    await act(async () => { saving.resolve({ success: true }) })
    expect(screen.getByText(t('network.enabledStatus'))).toBeTruthy()
  })

  it('debounces typing, preserves unrelated settings, and saves even after leaving the page', async () => {
    const port = fakePort(true)
    const view = await mount()
    const input = screen.getByLabelText(t('network.url'))
    fireEvent.change(input, { target: { value: 'http://127.0.0.1:8000' } })
    fireEvent.change(input, { target: { value: 'http://127.0.0.1:9000' } })
    expect(port.saveSettings).not.toHaveBeenCalled()
    view.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(PROXY_SAVE_DELAY_MS) })
    expect(port.saveSettings).toHaveBeenCalledTimes(1)
    const saved = port.saveSettings.mock.calls[0]![0]
    expect(saved.network?.proxy.url).toBe('http://127.0.0.1:9000')
    expect(saved.network?.proxy.bypassRules).toBe('localhost;*.local')
    expect(saved.general).toEqual(createDefaultSettings().general)
    await mount()
    expect((screen.getByLabelText(t('network.url')) as HTMLInputElement).value).toBe('http://127.0.0.1:9000')
  })

  it('flushes on Enter and blur without duplicate writes', async () => {
    const port = fakePort(true)
    await mount()
    const input = screen.getByLabelText(t('network.bypass'))
    fireEvent.change(input, { target: { value: 'localhost;example.com' } })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    await act(async () => { fireEvent.blur(input); await vi.advanceTimersByTimeAsync(600) })
    expect(port.saveSettings).toHaveBeenCalledTimes(1)
    expect(port.saveSettings.mock.calls[0]![0].network?.proxy.bypassRules).toBe('localhost;example.com')
  })

  it('blocks invalid enabled addresses, but always permits switching the proxy off', async () => {
    const port = fakePort(true)
    await mount()
    const input = screen.getByLabelText(t('network.url'))
    for (const value of ['', 'not a url', 'ftp://example.com']) {
      fireEvent.change(input, { target: { value } })
      await act(async () => { await vi.advanceTimersByTimeAsync(600) })
      expect(input.getAttribute('aria-invalid')).toBe('true')
    }
    expect(port.saveSettings).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('switch')) })
    expect(port.saveSettings.mock.calls[0]![0].network?.proxy.enabled).toBe(false)
    expect(screen.getByText(t('network.disabledStatus'))).toBeTruthy()
  })

  it('keeps failed edits visible, does not silently retry, and retries on request', async () => {
    const port = fakePort()
    port.saveSettings.mockResolvedValueOnce({ success: false, error: 'disk unavailable' })
    await mount()
    await act(async () => { fireEvent.click(screen.getByRole('switch')) })
    expect(screen.getByText(t('network.saveFailed'))).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('disk unavailable')
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(port.saveSettings).toHaveBeenCalledTimes(1)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('network.retrySave') })) })
    expect(port.saveSettings).toHaveBeenCalledTimes(2)
    expect(screen.getByText(t('network.enabledStatus'))).toBeTruthy()
  })

  it('serializes rapid changes and never replaces a newer draft with an older response', async () => {
    const port = fakePort(true)
    const first = deferred<SaveSettingsResponse>()
    port.saveSettings.mockImplementationOnce(() => first.promise)
    await mount()
    act(() => { editNetworkProxy({ url: 'http://127.0.0.1:8000' }) })
    let saving!: Promise<void>
    await act(async () => { saving = flushNetworkProxy() })
    act(() => { editNetworkProxy({ url: 'http://127.0.0.1:9000' }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(600) })
    expect(port.saveSettings).toHaveBeenCalledTimes(1)
    await act(async () => { first.resolve({ success: true }); await saving })
    expect((screen.getByLabelText(t('network.url')) as HTMLInputElement).value).toBe('http://127.0.0.1:9000')
    await act(async () => { await vi.advanceTimersByTimeAsync(600) })
    expect(port.saveSettings).toHaveBeenCalledTimes(2)
    expect(networkSettingsQuery.get().data?.url).toBe('http://127.0.0.1:9000')
    expect(useProxyEditor.getState().draft).toBeUndefined()
  })

  it('clears test results on edits and ignores results from an older configuration', async () => {
    const port = fakePort(true)
    await mount()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('network.test') })) })
    expect(screen.getByText(t('network.testSuccess'))).toBeTruthy()
    const slowTest = deferred<TestProxyResponse>()
    port.testProxy.mockImplementationOnce(() => slowTest.promise)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('network.test') })) })
    expect(screen.getByRole('button', { name: t('network.testing') }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText(t('network.url')), { target: { value: 'http://127.0.0.1:8000' } })
    expect(screen.queryByText(t('network.testSuccess'))).toBeNull()
    await act(async () => { slowTest.resolve({ success: true }) })
    expect(screen.queryByText(t('network.testSuccess'))).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(600) })
    port.testProxy.mockRejectedValueOnce(new Error('connection refused'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('network.test') })) })
    expect(screen.getByRole('alert').textContent).toContain('connection refused')
  })
})
