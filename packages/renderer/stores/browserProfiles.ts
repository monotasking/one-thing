/**
 * Browser profiles mirror store — the renderer half of the Chrome-style profile
 * feature. Source of truth is the main process (profiles.json owned by
 * BrowserViewService); this store fetches on demand and re-applies the full
 * list returned by each mutation (list/add/remove/switch). Settings UI consumes
 * it. See docs/design/browser-v2.md and stores/browser.ts for the mirror pattern.
 */
import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { BrowserProfile, BrowserProfilesResponse } from '@shared/ipc/browser'
import { browserApi } from '@/platform/browser-client'

export const useBrowserProfilesStore = defineStore('browserProfiles', () => {
  const profiles = ref<BrowserProfile[]>([])
  const activeProfileId = ref<string>('default')
  const loading = ref(false)

  function apply(res?: BrowserProfilesResponse | null): void {
    if (res?.success) {
      profiles.value = res.profiles
      activeProfileId.value = res.activeProfileId
    }
  }

  async function load(): Promise<void> {
    loading.value = true
    try {
      apply(await browserApi.listProfiles({}))
    } finally {
      loading.value = false
    }
  }

  async function add(name: string): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) return
    apply(await browserApi.addProfile({ name: trimmed }))
  }

  async function remove(profileId: string): Promise<void> {
    apply(await browserApi.removeProfile({ profileId }))
  }

  async function switchTo(profileId: string): Promise<void> {
    if (profileId === activeProfileId.value) return
    apply(await browserApi.switchProfile({ profileId }))
  }

  return { profiles, activeProfileId, loading, load, add, remove, switchTo }
})
