/**
 * Embedded browser mirror store — the renderer half of Browser v2. The source
 * of truth is BrowserViewService in the main process (one WebContentsView per
 * web-tab); this store holds a mirror only, fed by a single coalesced
 * BROWSER_TABS_CHANGED batch. Mount protocol is pull-then-subscribe: hydrate()
 * pulls the full snapshot, then patches stream in (avoids "panel restored but
 * mirror empty" drift). NOT persisted — the main process owns durability.
 * See docs/design/browser-v2/p0-implementation.md §3.
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { resolveBrowserOmniboxInput, resolveBrowserSearchEngine } from '@shared/ipc'
import { platformApi } from '@/platform'
import type { BrowserTabInfo, BrowserTabsChangedEvent, PickedWebElement } from '@/types'

export const useBrowserStore = defineStore('browser', () => {
  const tabs = ref<BrowserTabInfo[]>([])
  const activeTabId = ref<string | null>(null)
  let unsubscribe: (() => void) | null = null
  let hydrated: Promise<void> | null = null

  const activeTab = computed(() => tabs.value.find(t => t.id === activeTabId.value) ?? null)

  function applyPatch(event: BrowserTabsChangedEvent): void {
    for (const patch of event.patch) {
      const existing = tabs.value.find(t => t.id === patch.id)
      if (existing) Object.assign(existing, patch)
      else tabs.value.push({
        id: patch.id,
        url: patch.url ?? '',
        title: patch.title ?? '',
        favicon: patch.favicon,
        loading: patch.loading ?? false,
        canGoBack: patch.canGoBack ?? false,
        canGoForward: patch.canGoForward ?? false,
        crashed: patch.crashed,
      })
    }
    if (event.removed) {
      tabs.value = tabs.value.filter(t => !event.removed!.includes(t.id))
    }
    if (event.order) {
      const byId = new Map(tabs.value.map(t => [t.id, t]))
      tabs.value = event.order.map(id => byId.get(id)).filter((t): t is BrowserTabInfo => !!t)
    }
    if (event.activeTabId !== undefined) activeTabId.value = event.activeTabId
  }

  /** Idempotent; pull full snapshot then subscribe to the incremental batch. */
  async function ensureLoaded(): Promise<void> {
    hydrated ??= (async () => {
      if (!unsubscribe) {
        unsubscribe = platformApi.onBrowserTabsChanged?.(applyPatch) ?? null
      }
      const snapshot = await platformApi.hydrateBrowser?.()
      if (snapshot?.success) {
        tabs.value = snapshot.tabs
        activeTabId.value = snapshot.activeTabId
      }
    })()
    return hydrated
  }

  /** 返回新 tab 的 id(主进程已将其置为活动 tab);调用方需要时可再显式 selectTab。 */
  async function openTab(url?: string): Promise<string | null> {
    const res = await platformApi.createBrowserTab?.({ url })
    return res?.success && res.tab ? res.tab.id : null
  }
  async function closeTab(tabId: string): Promise<void> {
    await platformApi.closeBrowserTab?.(tabId)
  }
  async function selectTab(tabId: string): Promise<void> {
    await platformApi.selectBrowserTab?.(tabId)
  }
  async function navigate(url: string): Promise<void> {
    if (activeTabId.value) await platformApi.navigateBrowser?.(activeTabId.value, url)
    else await openTab(url)
  }

  /**
   * Omnibox submit: URL-ish input navigates directly, anything else searches
   * with the selected engine. The selection is fetched from the main process
   * per submit (a user-action-rate IPC) so a change made in the settings
   * window applies immediately — no cross-window mirror to go stale.
   *
   * `engineOverride` is the start page's one-shot pick (Tab-cycled ring): it
   * applies to THIS search only and is never persisted, so the next new tab is
   * back on the default. Passing it also skips the IPC hop.
   */
  async function openFromInput(raw: string, engineOverride?: string): Promise<void> {
    const trimmed = raw.trim()
    if (!trimmed) return
    let engineId: string | undefined = engineOverride
    if (!engineId) {
      const res = await platformApi.getBrowserSearchEngine?.()
      engineId = res?.success ? res.engineId : undefined
    }
    const engine = resolveBrowserSearchEngine(engineId)
    const url = resolveBrowserOmniboxInput(trimmed, engine)
    if (url) await navigate(url)
  }
  async function goBack(): Promise<void> {
    if (activeTabId.value) await platformApi.browserGoBack?.(activeTabId.value)
  }
  async function goForward(): Promise<void> {
    if (activeTabId.value) await platformApi.browserGoForward?.(activeTabId.value)
  }
  async function reload(): Promise<void> {
    if (activeTabId.value) await platformApi.reloadBrowser?.(activeTabId.value)
  }
  async function stop(): Promise<void> {
    if (activeTabId.value) await platformApi.stopBrowser?.(activeTabId.value)
  }

  /**
   * True while the browser panel's own DOM (omnibox / start page / tab list) is
   * the focused surface. ⌘T/⌘W arrive as menu events, and the menu can only see
   * whether the *page* has focus — this covers the other half, where the user is
   * typing in our chrome and the native view holds no focus at all. Written by
   * BrowserPanel, read by App.vue's menu handlers.
   */
  const panelFocused = ref(false)
  function setPanelFocused(next: boolean): void {
    panelFocused.value = next
  }

  /** ⌘T / 面板内新建：一张起始页。 */
  async function newTab(): Promise<void> {
    await openTab()
  }

  /** ⌘W / chrome 上的 ✕：关掉当前标签（主进程会补一张起始页兜底）。 */
  async function closeActiveTab(): Promise<void> {
    if (activeTabId.value) await closeTab(activeTabId.value)
  }

  const picking = ref(false)

  /**
   * Enter element-pick mode on the active tab. Resolves with the picked element
   * (screenshot + excerpt + source) or null when the user cancels. The main
   * process owns the overlay + screenshot; this only brokers the round-trip.
   */
  async function pickElement(): Promise<PickedWebElement | null> {
    if (!activeTabId.value || picking.value) return null
    picking.value = true
    try {
      const res = await platformApi.pickBrowserElement?.(activeTabId.value)
      return res?.element ?? null
    } finally {
      picking.value = false
    }
  }

  function cancelPick(): void {
    if (activeTabId.value) void platformApi.cancelBrowserPick?.(activeTabId.value)
  }

  return {
    picking,
    pickElement,
    cancelPick,
    panelFocused,
    setPanelFocused,
    newTab,
    closeActiveTab,
    tabs,
    activeTabId,
    activeTab,
    ensureLoaded,
    openTab,
    closeTab,
    selectTab,
    navigate,
    openFromInput,
    goBack,
    goForward,
    reload,
    stop,
  }
})
