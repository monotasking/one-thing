import { computed, nextTick, onScopeDispose, ref, watch, type Ref } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import { getScrollTopForSearchResult } from './result-scroll'
import type { SearchCategory, SearchResult } from '@shared/ipc/search'
import { searchApi } from '@/platform/search-client'

const SEARCH_RESULT_LIMIT = 24
const SEARCH_DEBOUNCE_MS = 150

export function useSearchWindow(resultsRef: Ref<HTMLElement | null>) {
  const settingsStore = useSettingsStore()
  const activeTab = ref<SearchCategory>('all')
  const query = ref('')
  const results = ref<SearchResult[]>([])
  const selectedIndex = ref(0)
  const isLoading = ref(false)
  const searchError = ref('')

  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let searchSeq = 0
  let isResetting = false

  const tabs = computed<{ id: SearchCategory; label: string }[]>(() => {
    const items: { id: SearchCategory; label: string }[] = [
      { id: 'all', label: 'All' },
      { id: 'chats', label: 'Chats' },
    ]

    if (settingsStore.settings.general.dailyNotes?.enabled !== false) {
      items.push({ id: 'daily', label: 'Daily' })
    }

    items.push(
      { id: 'prompts', label: 'Prompts' },
      { id: 'files', label: 'Files' },
      { id: 'messages', label: 'Messages' },
      { id: 'actions', label: 'Actions' },
    )

    return items
  })

  const visibleResults = computed(() => results.value)
  const totalResults = computed(() => visibleResults.value.length)

  const inputPlaceholder = computed(() => {
    if (activeTab.value === 'actions') return 'Run command...'
    if (activeTab.value === 'prompts') return 'Search prompts...'
    if (activeTab.value === 'daily') return 'Search daily notes...'
    if (activeTab.value === 'files') return 'Search files...'
    if (activeTab.value === 'messages') return 'Search messages...'
    if (activeTab.value === 'chats') return 'Search chats...'
    return 'Search...'
  })

  const emptyText = computed(() => {
    if (query.value.trim()) return 'No results'
    if (activeTab.value === 'daily') return 'No daily notes'
    return 'Type to search'
  })

  function clearScheduledSearch() {
    if (!debounceTimer) return
    clearTimeout(debounceTimer)
    debounceTimer = null
  }

  async function doSearch() {
    const seq = ++searchSeq
    isLoading.value = true
    searchError.value = ''

    try {
      const response = await searchApi.query({
        query: query.value,
        category: activeTab.value,
        limit: SEARCH_RESULT_LIMIT,
      })

      if (seq !== searchSeq) return

      if (response.success) {
        results.value = response.results
        selectedIndex.value = 0
        await nextTick()
        if (resultsRef.value) resultsRef.value.scrollTop = 0
      } else {
        results.value = []
        searchError.value = 'Search failed'
      }
    } catch (error) {
      if (seq !== searchSeq) return
      results.value = []
      searchError.value = error instanceof Error ? error.message : 'Search failed'
    } finally {
      if (seq === searchSeq) isLoading.value = false
    }
  }

  function scheduleSearch() {
    clearScheduledSearch()
    selectedIndex.value = 0
    debounceTimer = setTimeout(doSearch, query.value ? SEARCH_DEBOUNCE_MS : 0)
  }

  function getResultByFlatIndex(index: number): SearchResult | undefined {
    return visibleResults.value[index]
  }

  function scrollResultIntoView(index: number) {
    nextTick(() => {
      const container = resultsRef.value
      if (!container) return
      const items = container.querySelectorAll<HTMLElement>('.search-result-item')
      const element = items[index]
      if (!element) return

      const containerRect = container.getBoundingClientRect()
      const elementRect = element.getBoundingClientRect()
      const itemTop = elementRect.top - containerRect.top + container.scrollTop
      const itemHeight = elementRect.height || element.offsetHeight

      container.scrollTop = getScrollTopForSearchResult({
        currentScrollTop: container.scrollTop,
        containerHeight: container.clientHeight,
        itemTop,
        itemHeight,
      })
    })
  }

  function moveSelection(delta: number) {
    if (totalResults.value === 0) return
    const nextIndex = (selectedIndex.value + delta + totalResults.value) % totalResults.value
    selectedIndex.value = nextIndex
    scrollResultIntoView(nextIndex)
  }

  function cycleTab(direction: number) {
    const index = tabs.value.findIndex(tab => tab.id === activeTab.value)
    const nextIndex = (index + direction + tabs.value.length) % tabs.value.length
    activeTab.value = tabs.value[nextIndex].id
  }

  function selectTabByShortcut(key: string): boolean {
    if (!/^[1-7]$/.test(key)) return false
    const tab = tabs.value[Number(key) - 1]
    if (!tab) return false
    activeTab.value = tab.id
    return true
  }

  function confirmSelectedResult(): SearchResult | undefined {
    return getResultByFlatIndex(selectedIndex.value)
  }

  function resetSearchWindow() {
    clearScheduledSearch()
    searchSeq += 1
    isResetting = true
    query.value = ''
    activeTab.value = 'all'
    selectedIndex.value = 0
    results.value = []
    searchError.value = ''
    isLoading.value = false

    nextTick(() => {
      isResetting = false
      void doSearch()
    })
  }

  watch([query, activeTab], () => {
    if (isResetting) return
    scheduleSearch()
  })

  onScopeDispose(() => {
    clearScheduledSearch()
    searchSeq += 1
  })

  return {
    settingsStore,
    tabs,
    activeTab,
    query,
    results,
    selectedIndex,
    isLoading,
    searchError,
    visibleResults,
    totalResults,
    inputPlaceholder,
    emptyText,
    moveSelection,
    cycleTab,
    selectTabByShortcut,
    confirmSelectedResult,
    doSearch,
    resetSearchWindow,
  }
}
