import { create } from 'zustand'
import type { AppSettings, ProxySettings, TestProxyResponse } from '@shared/ipc/settings'
import { DEFAULT_NETWORK_SETTINGS } from '@shared/defaults/settings'
import { createMutation, createQuery } from './kernel'
import { networkSettingsPort } from './network-settings-port'
import { t, type MessageKey } from '../i18n'

export const PROXY_SAVE_DELAY_MS = 500

export function proxyValidation(proxy: ProxySettings): MessageKey | undefined {
  // Switching off must always work, even with an unfinished address.
  if (!proxy.enabled) return undefined
  if (!proxy.url.trim()) return 'network.urlRequired'
  try {
    const url = new URL(proxy.url.trim())
    if (!['http:', 'https:', 'socks5:'].includes(url.protocol)) return 'network.urlProtocol'
    if (!url.hostname) return 'network.urlInvalid'
  } catch {
    return 'network.urlInvalid'
  }
  return undefined
}

export function toProxySettings(settings: Pick<AppSettings, 'network'>): ProxySettings {
  return { ...DEFAULT_NETWORK_SETTINGS.proxy, ...settings.network?.proxy }
}

export const networkSettingsQuery = createQuery('networkSettings', async () => {
  const response = await (await networkSettingsPort()).readSettings()
  if (!response.success || !response.settings) throw new Error(response.error || t('network.loadFailed'))
  return toProxySettings(response.settings)
})

interface ProxyEditor {
  draft: ProxySettings | undefined
  testResult: TestProxyResponse | undefined
}

// Drafts and the debounce belong to the data source: navigating away must not
// discard an edit or cancel a scheduled save. Only successful writes clear them.
export const useProxyEditor = create<ProxyEditor>(() => ({ draft: undefined, testResult: undefined }))
let timer: ReturnType<typeof setTimeout> | undefined
let editRevision = 0

function sameProxy(a: ProxySettings, b: ProxySettings): boolean {
  return a.enabled === b.enabled && a.url === b.url && (a.bypassRules ?? '') === (b.bypassRules ?? '')
}

export const saveNetworkProxyMutation = createMutation<ProxySettings, ProxySettings>('networkSettings.save', {
  run: async (proxy) => {
    const invalid = proxyValidation(proxy)
    if (invalid) throw new Error(t(invalid))
    const port = await networkSettingsPort()
    // Read immediately before each serialized write; preserve every other setting.
    const current = await port.readSettings()
    if (!current.success || !current.settings) throw new Error(current.error || t('network.loadFailed'))
    const normalized = { ...proxy, url: proxy.url.trim(), bypassRules: proxy.bypassRules?.trim() }
    const response = await port.saveSettings({
      ...current.settings,
      network: { ...current.settings.network, proxy: normalized },
    })
    if (!response.success) throw new Error(response.error || t('network.saveFailed'))
    return response.settings ? toProxySettings(response.settings) : normalized
  },
  settle: (saved, submitted) => {
    networkSettingsQuery.patch(saved)
    if (useProxyEditor.getState().draft === submitted) useProxyEditor.setState({ draft: undefined })
    else scheduleSave()
  },
  onError: (_error, submitted) => {
    // A newer edit is still eligible; do not automatically retry the failed draft.
    if (useProxyEditor.getState().draft !== submitted) scheduleSave()
  },
})

function scheduleSave(): void {
  clearTimeout(timer)
  timer = setTimeout(() => { void flushNetworkProxy() }, PROXY_SAVE_DELAY_MS)
}

export function editNetworkProxy(patch: Partial<ProxySettings>, immediate = false): void {
  const current = useProxyEditor.getState().draft ?? networkSettingsQuery.get().data
  if (!current) return
  const next = { ...current, ...patch }
  if (sameProxy(next, current)) return
  editRevision += 1
  useProxyEditor.setState({ draft: next, testResult: undefined })
  if (!saveNetworkProxyMutation.isPending()) saveNetworkProxyMutation.reset()
  clearTimeout(timer)
  if (immediate) void flushNetworkProxy()
  else scheduleSave()
}

export async function flushNetworkProxy(): Promise<void> {
  clearTimeout(timer)
  const draft = useProxyEditor.getState().draft
  if (!draft || proxyValidation(draft) || saveNetworkProxyMutation.isPending()) return
  const saved = networkSettingsQuery.get().data
  if (saved && sameProxy(draft, saved) && !saveNetworkProxyMutation.get().error) {
    useProxyEditor.setState({ draft: undefined })
    return
  }
  await saveNetworkProxyMutation.run(draft)
}

export const testNetworkProxyMutation = createMutation<void, void>('networkSettings.test', {
  run: async () => {
    const proxy = networkSettingsQuery.get().data
    if (!proxy?.enabled || proxyValidation(proxy) || useProxyEditor.getState().draft) return
    const revision = editRevision
    useProxyEditor.setState({ testResult: undefined })
    let result: TestProxyResponse
    try {
      result = await (await networkSettingsPort()).testProxy(proxy)
    } catch (error) {
      result = { success: false, error: error instanceof Error ? error.message : String(error) }
    }
    // Even edit → undo invalidates the old test; it tested a previous revision.
    if (revision === editRevision) useProxyEditor.setState({ testResult: result })
  },
})

export function resetNetworkSettings(): void {
  clearTimeout(timer)
  editRevision += 1
  networkSettingsQuery.reset()
  saveNetworkProxyMutation.reset()
  testNetworkProxyMutation.reset()
  useProxyEditor.setState({ draft: undefined, testResult: undefined })
}

if (import.meta.hot) import.meta.hot.dispose(resetNetworkSettings)
