import { computed, nextTick, onScopeDispose, ref, watch, type Ref } from 'vue'
import type { BrowserTabInfo, MessageAttachment, SkillDefinition } from '@/types'
import type { PaletteItem, PaletteItemType } from '@/types/palette'
import { filterPaletteItems } from '@/services/palette'
import { refreshPluginCommands } from '@/services/commands'
import { useSettingsStore } from '@/stores/settings'
import { useBrowserStore } from '@/stores/browser'
import { useSessionsStore } from '@/stores/sessions'
import { useAgentsStore } from '@/stores/agents'
import type { EditorHandle, EditorSelection, EditorTransaction } from '@/editor'
import { applyTriggerReplacement, parseEditorTrigger, type EditorTrigger } from '@/editor'
import { usePromptsStore } from '@/stores/prompts'
import { createFileToken, createMemberToken, createPageToken, createPromptToken, createSkillToken, extractMemberTokens, extractPageTokens, FILE_REF_PATTERN, PAGE_REF_PATTERN } from '@shared/prompt-references'
import { COLLAB_MENTION_ALL_LABELS } from '@onething/runtime/collab'
import { platformApi } from '@/platform'
import { variablesApi } from '@/platform/variables-client'
import { getLogger } from '@/services/log'

const log = getLogger('renderer.picker')

export type ComposerExtensionType = 'none' | 'palette' | 'files' | 'paths' | 'pages' | 'members'
export type ComposerExtensionItemKind = PaletteItemType | 'file' | 'directory' | 'path' | 'browser-page' | 'agent-member'

interface FileSearchEntry {
  path: string
  type: 'file' | 'directory'
  source?: 'workdir' | 'downloads' | 'note'
  label?: string
}

export interface ComposerExtensionItem {
  id: string
  kind: ComposerExtensionItemKind
  title: string
  description?: string
  meta?: string
  value?: string
  paletteItem?: PaletteItem
}

/**
 * A file picked via `@`. The draft keeps a hidden `{{file:…}}` token where the
 * user typed it — this is just the chip projection of that token.
 */
export interface ComposerFileReference {
  id: string
  path: string
  label: string
  from: number
  to: number
  /** Short chip marker; page references use it to read as WEB, not a file. */
  badge?: string
}

/**
 * A browser page picked via `@`. The draft keeps a hidden `{{page:…}}` token;
 * this chip projection labels it live from the browser mirror store, and the
 * token resolves to the tab's then-current URL/title at send time.
 */
export interface ComposerPageReference {
  id: string
  tabId: string
  url: string
  label: string
  from: number
  to: number
}

export interface ComposerExtensionState {
  type: ComposerExtensionType
  query: string
  trigger: EditorTrigger | null
  items: ComposerExtensionItem[]
  loading: boolean
  error: string | null
  selectedIndex: number
  paletteTypes?: PaletteItemType[]
}

interface NoteRoot {
  path: string
  label: string
}

function emptyExtension(): ComposerExtensionState {
  return {
    type: 'none',
    query: '',
    trigger: null,
    items: [],
    loading: false,
    error: null,
    selectedIndex: 0,
  }
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\/+$/, '')
}

function basename(filePath: string): string {
  return normalizePath(filePath).split('/').filter(Boolean).pop() || filePath
}

function dirname(filePath: string): string {
  const normalized = normalizePath(filePath)
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length <= 1) return normalized.startsWith('/') ? '/' : ''
  return `${normalized.startsWith('/') ? '/' : ''}${parts.slice(0, -1).join('/')}`
}

function isPathInsideRoot(filePath: string, root: string): boolean {
  const normalizedRoot = normalizePath(root)
  return filePath === normalizedRoot || filePath.startsWith(`${normalizedRoot}/`)
}

/**
 * 「所有人」伪成员行的 pick 值(docs/design/collab-room-clear-and-mention-all.md A1)。
 *
 * 它不是任何 agent 的 id,所以刻意长成不像 id 的样子 —— 走错分支的话
 * `{{member:…}}` 会带着它落进草稿,而那种 token 在发送时会被静默丢掉。
 */
export const COMPOSER_MENTION_ALL_VALUE = '__collab_all__'

/** 选中「所有人」插入的字面量。后端只认这几种写法,取第一种当规范形。 */
export const COMPOSER_MENTION_ALL_LABEL = COLLAB_MENTION_ALL_LABELS[0]

/** 这一行能被什么查询词命中(与后端认读的写法对齐,外加两种 ASCII)。 */
const MENTION_ALL_ALIASES = [...COLLAB_MENTION_ALL_LABELS, 'all', 'everyone']

/**
 * 伪成员没有头像。给一个固定图形而不是随便挑个 emoji:它要一眼看出"这一行
 * 不是某个人",而不是看起来像一位取了奇怪头像的同事。
 */
const MENTION_ALL_GLYPH = '⊕'

/**
 * 房间成员候选行的组装(纯函数,便于单测)。
 *
 * 「所有人」置顶,且**只在群房出现**:dm 房里没有第三个人,那一行等于把唯一
 * 那位同事换了个说法。
 */
export function buildCollabMemberPickerItems(options: {
  query: string
  members: ReadonlyArray<{ id: string; name: string; title?: string; description?: string; avatar?: string }>
  /** 私聊房(单成员托管私聊 / 双成员同事私聊)。 */
  dm?: boolean
}): ComposerExtensionItem[] {
  const q = options.query.trim().toLowerCase()
  const items: ComposerExtensionItem[] = options.members
    .filter(agent =>
      !q ||
      agent.name.toLowerCase().includes(q) ||
      (agent.title || '').toLowerCase().includes(q))
    .map(agent => ({
      id: `member:${agent.id}`,
      kind: 'agent-member' as const,
      title: `${agent.avatar ? `${agent.avatar} ` : ''}${agent.name}`,
      description: agent.title || agent.description,
      meta: '成员',
      // W14a: the pick carries the AGENT ID. It becomes a `{{member:<id>}}`
      // token in the draft (painted as @名字) and materializes at send into
      // plain `@名字` text plus an id in mentions[] — a mention picked here
      // survives a rename and stays exact when two members share a name.
      value: agent.id,
    }))

  const allMatches = !q || MENTION_ALL_ALIASES.some(alias => alias.toLowerCase().includes(q))
  if (!options.dm && options.members.length > 0 && allMatches) {
    items.unshift({
      id: 'member:all',
      kind: 'agent-member',
      title: `${MENTION_ALL_GLYPH} ${COMPOSER_MENTION_ALL_LABEL}`,
      description: `提醒全部 ${options.members.length} 位成员`,
      meta: '全体',
      value: COMPOSER_MENTION_ALL_VALUE,
    })
  }
  return items
}

function makeNoteLabel(value: string, name: string): string {
  const dirName = basename(value)
  if (dirName && dirName !== '/') return `notes/${dirName}`
  if (name === 'work_note_dir') return 'notes/work'
  return 'notes/personal'
}

/**
 * Composer 形态注入(docs/design/agent-im-chat-ui.md §2.2)。messenger 形态的
 * 输入框收窄的是**触发路径**,不是把弹层画出来再藏起来 —— 关掉的补全既不弹,
 * 也不在文本里留下别的语义。两项都默认开,直聊(engineering)因此零变化。
 */
export interface PickerOrchestrationOptions {
  /** `/` 命令面 + `/cd` 路径选择器。messenger 形态关掉,`/` 就是普通文本。 */
  slashCommands?: Ref<boolean>
  /**
   * bare-`@` 补全(房里是成员、别处是文件)。单成员 dm 房关掉:房里没有第三
   * 个人,@ 无意义;关掉后 bare-`@` 也不许掉进文件选择器,否则"不弹"变成"弹
   * 了另一个"。显式的 `@files` / `@prompts` 关键词不受影响。
   */
  atMentions?: Ref<boolean>
}

export function usePickerOrchestration(
  messageInput: Ref<string>,
  workingDirectory: Ref<string>,
  editorRef: Ref<EditorHandle | null>,
  adjustHeight: () => void,
  checkHistoryEdit: (newValue: string) => void,
  sessionId?: Ref<string | undefined>,
  options: PickerOrchestrationOptions = {},
) {
  const promptsStore = usePromptsStore()
  const settingsStore = useSettingsStore()
  const browserStore = useBrowserStore()
  const embeddedBrowserAvailable = platformApi.capabilities.embeddedBrowser
  if (embeddedBrowserAvailable) {
    // Idempotent app-wide hydrate. Without it the mirror stays empty until the
    // browser panel first mounts, and every page row/chip would render blind.
    void browserStore.ensureLoaded().catch(() => {})
  }
  const availableSkills = ref<SkillDefinition[]>([])
  const activeExtension = ref<ComposerExtensionState>(emptyExtension())
  const activeTrigger = ref<EditorTrigger | null>(null)
  const variableWorkdir = ref('')
  const noteRoots = ref<NoteRoot[]>([])
  let suppressedTriggerValue: string | null = null
  let fileDebounceTimer: ReturnType<typeof setTimeout> | null = null
  let pathDebounceTimer: ReturnType<typeof setTimeout> | null = null
  let fileRequestRun = 0
  let pathRequestRun = 0

  const effectiveSessionId = computed(() => sessionId?.value || '')

  // ── Collab room member mentions (docs/design/multi-agent-collab.md §8) ──
  // In rooms, bare `@` completes MEMBER names: activation requires an exact
  // name match, so blind typing is the feature's worst UX. Files stay
  // reachable via the explicit `@files` keyword. Store access is lazy and
  // guarded: composable unit tests mount without these stores.
  const activeRoomMeta = computed(() => {
    const id = effectiveSessionId.value
    if (!id) return undefined
    try {
      const meta = useSessionsStore().sessions.find(s => s.id === id)
      return meta?.kind === 'room' ? meta : undefined
    } catch {
      return undefined
    }
  })
  const activeRoomMembers = computed(() => {
    const meta = activeRoomMeta.value
    if (!meta) return []
    try {
      const agents = useAgentsStore().agents
      const memberIds = meta.room?.memberAgentIds ?? []
      return memberIds
        .map(agentId => agents.find(agent => agent.id === agentId))
        .filter((agent): agent is NonNullable<typeof agent> => Boolean(agent))
    } catch {
      return []
    }
  })
  /** 私聊房(标记即身份,与 RoomSettingsDialog 同一判据)。 */
  const activeRoomIsDm = computed(() => activeRoomMeta.value?.room?.dm === true)
  const slashCommandsEnabled = computed(() => options.slashCommands?.value !== false)
  const atMentionsEnabled = computed(() => options.atMentions?.value !== false)
  const memberTriggerAvailable = computed(
    () => atMentionsEnabled.value && activeRoomMembers.value.length > 0,
  )

  // Cold-opening a room before anything loaded the agents store would leave
  // activeRoomMembers empty and bare-@ falling back to the file picker —
  // prefetch on room entry (the store self-guards against duplicate loads).
  watch(effectiveSessionId, id => {
    if (!id) return
    try {
      const meta = useSessionsStore().sessions.find(s => s.id === id)
      if (meta?.kind === 'room') {
        void Promise.resolve(useAgentsStore().loadAgents()).catch(() => {})
      }
    } catch {
      // stores unavailable (tests) — member completion simply stays off
    }
  }, { immediate: true })

  function triggerParseOptions() {
    return {
      pageTrigger: embeddedBrowserAvailable,
      memberTrigger: memberTriggerAvailable.value,
    }
  }

  const enabledSkills = computed(() => {
    return availableSkills.value.filter(s => s.enabled)
  })

  async function loadSkills() {
    try {
      const response = await platformApi.getSkills(workingDirectory.value || undefined)
      if (response.success && response.skills) {
        availableSkills.value = response.skills
      }
    } catch (error) {
      log.error('skills load failed', {}, error)
    }
  }

  async function loadPrompts() {
    await promptsStore.loadPrompts()
    refreshPaletteItems()
  }

  async function loadPluginCommands() {
    await refreshPluginCommands()
    refreshPaletteItems()
  }

  watch([workingDirectory, effectiveSessionId], () => {
    loadSkills()
    if (activeExtension.value.type === 'files') {
      scheduleFileFetch(0)
    }
  })

  const anyPickerVisible = computed(() => activeExtension.value.type !== 'none')
  const activeExtensionVisible = anyPickerVisible

  const showCommandPicker = computed(() => activeExtension.value.type === 'palette')
  const commandQuery = computed(() => activeExtension.value.type === 'palette' ? activeExtension.value.query : '')
  const commandPickerTypes = computed(() => activeExtension.value.type === 'palette'
    ? activeExtension.value.paletteTypes
    : undefined)
  const showFilePicker = computed(() => activeExtension.value.type === 'files')
  const fileQuery = computed(() => activeExtension.value.type === 'files' ? activeExtension.value.query : '')
  const showPathPicker = computed(() => activeExtension.value.type === 'paths')
  const pathQuery = computed(() => activeExtension.value.type === 'paths' ? activeExtension.value.query : '')
  const showSkillPicker = computed(() => false)
  const skillTriggerQuery = computed(() => '')

  function clampSelectedIndex(index = activeExtension.value.selectedIndex, items = activeExtension.value.items): number {
    if (items.length === 0) return 0
    return Math.max(0, Math.min(items.length - 1, index))
  }

  function setActiveExtension(next: Partial<ComposerExtensionState> & { type: ComposerExtensionType }) {
    activeExtension.value = {
      ...emptyExtension(),
      ...next,
      selectedIndex: clampSelectedIndex(next.selectedIndex ?? 0, next.items ?? []),
    }
  }

  function patchActiveExtension(patch: Partial<ComposerExtensionState>) {
    const nextItems = patch.items ?? activeExtension.value.items
    activeExtension.value = {
      ...activeExtension.value,
      ...patch,
      selectedIndex: clampSelectedIndex(patch.selectedIndex ?? activeExtension.value.selectedIndex, nextItems),
    }
  }

  function closeAllPickers() {
    suppressedTriggerValue = null
    activeTrigger.value = null
    clearFileTimer()
    clearPathTimer()
    setActiveExtension({ type: 'none' })
  }

  function clearFileTimer() {
    if (fileDebounceTimer) {
      clearTimeout(fileDebounceTimer)
      fileDebounceTimer = null
    }
  }

  function clearPathTimer() {
    if (pathDebounceTimer) {
      clearTimeout(pathDebounceTimer)
      pathDebounceTimer = null
    }
  }

  onScopeDispose(() => {
    clearFileTimer()
    clearPathTimer()
  })

  function getQuickCommandIds(): Set<string> {
    const quickCommands = settingsStore.settings.general?.quickCommands || []
    return new Set(
      quickCommands
        .filter(command => command.enabled)
        .map(command => command.commandId),
    )
  }

  function toPaletteExtensionItem(item: PaletteItem, quickCommandIds: Set<string>): ComposerExtensionItem {
    const isQuick = !!item.command && quickCommandIds.has(item.command.id)
    return {
      id: item.id,
      kind: item.type,
      title: item.title,
      description: item.description,
      meta: isQuick ? 'Quick' : item.usage || item.type,
      paletteItem: item,
    }
  }

  function buildPaletteExtensionItems(query: string, types?: PaletteItemType[]): ComposerExtensionItem[] {
    const items = filterPaletteItems(query, enabledSkills.value, promptsStore.prompts, types)
    const quickCommandIds = getQuickCommandIds()
    const shouldPromoteQuickCommands = !query.trim() && (!types || types.includes('command'))
    const orderedItems = shouldPromoteQuickCommands
      ? [
          ...items.filter(item => item.command && quickCommandIds.has(item.command.id)),
          ...items.filter(item => !item.command || !quickCommandIds.has(item.command.id)),
        ]
      : items

    return orderedItems.map(item => toPaletteExtensionItem(item, quickCommandIds))
  }

  function refreshPaletteItems() {
    if (activeExtension.value.type !== 'palette') return
    const items = buildPaletteExtensionItems(activeExtension.value.query, activeExtension.value.paletteTypes)
    const includesPrompts = !activeExtension.value.paletteTypes || activeExtension.value.paletteTypes.includes('prompt')
    patchActiveExtension({
      items,
      loading: includesPrompts ? promptsStore.isLoading : false,
      error: promptsStore.error,
    })
  }

  async function loadNoteRoots() {
    const sid = effectiveSessionId.value
    if (!sid) {
      variableWorkdir.value = ''
      noteRoots.value = []
      return
    }

    try {
      const result = await variablesApi.list({ sessionId: sid })
      if (!result.success || !result.variables) {
        variableWorkdir.value = ''
        noteRoots.value = []
        return
      }

      const noteNames = new Set(['user_note_dir', 'work_note_dir'])
      const seen = new Set<string>()
      variableWorkdir.value = result.variables.find(variable => variable.name === 'workdir')?.value || ''
      noteRoots.value = result.variables
        .filter(variable => noteNames.has(variable.name) && variable.value)
        .map(variable => ({
          path: normalizePath(variable.value),
          label: makeNoteLabel(variable.value, variable.name),
        }))
        .filter(root => {
          if (seen.has(root.path)) return false
          seen.add(root.path)
          return true
        })
        .sort((a, b) => b.path.length - a.path.length)
    } catch (error) {
      log.error('note roots load failed', {}, error)
      variableWorkdir.value = ''
      noteRoots.value = []
    }
  }

  function getRelativeFileLabel(absolutePath: string): string {
    const workdir = variableWorkdir.value || workingDirectory.value
    if (workdir && absolutePath.startsWith(workdir)) {
      let relativePath = absolutePath.slice(workdir.length)
      if (relativePath.startsWith('/')) relativePath = relativePath.slice(1)
      return relativePath || absolutePath
    }

    const noteRoot = noteRoots.value.find(root => isPathInsideRoot(absolutePath, root.path))
    if (noteRoot) {
      let relativePath = absolutePath.slice(noteRoot.path.length)
      if (relativePath.startsWith('/')) relativePath = relativePath.slice(1)
      return relativePath ? `${noteRoot.label}/${relativePath}` : noteRoot.label
    }

    return absolutePath
  }

  function toFileExtensionItem(fileInput: string | FileSearchEntry): ComposerExtensionItem {
    const filePath = typeof fileInput === 'string' ? fileInput : fileInput.path
    const type = typeof fileInput === 'string' ? 'file' : fileInput.type
    const title = typeof fileInput === 'string'
      ? getRelativeFileLabel(filePath)
      : fileInput.label || getRelativeFileLabel(filePath)
    const parent = dirname(filePath)
    return {
      id: `${type}:${filePath}`,
      kind: type,
      title,
      description: title === filePath ? parent : filePath,
      meta: type === 'directory' ? 'Directory' : 'File',
      value: filePath,
    }
  }

  function toPathExtensionItem(path: string): ComposerExtensionItem {
    return {
      id: `path:${path}`,
      kind: 'path',
      title: basename(path),
      description: path,
      meta: 'Directory',
      value: path,
    }
  }

  function hostFromUrl(url: string): string {
    try {
      return new URL(url).host || url
    } catch {
      return url
    }
  }

  function pageLabel(tab: Pick<BrowserTabInfo, 'title' | 'url'>): string {
    return tab.title.trim() || hostFromUrl(tab.url)
  }

  /**
   * Exact generic terms that surface the pinned page row under a bare `@`
   * query. Deliberately not prefix-matched: 'we' must keep targeting web.ts,
   * not hijack Enter onto the page row.
   */
  const PAGE_QUERY_KEYWORDS = ['page', 'pages', 'tab', 'browser', 'web', '页面', '网页', '当前', '浏览', '标签']

  function tabMatchesQuery(tab: Pick<BrowserTabInfo, 'title' | 'url'>, query: string): boolean {
    const q = query.trim().toLowerCase()
    if (!q) return true
    return tab.title.toLowerCase().includes(q) || tab.url.toLowerCase().includes(q)
  }

  function toPageExtensionItem(tab: BrowserTabInfo, isActive: boolean): ComposerExtensionItem {
    return {
      id: `page:${tab.id}`,
      kind: 'browser-page',
      title: pageLabel(tab),
      description: tab.url,
      meta: isActive ? 'Current page' : 'Tab',
      value: tab.id,
    }
  }

  function buildPageExtensionItems(query: string): ComposerExtensionItem[] {
    if (!embeddedBrowserAvailable) return []
    const active = browserStore.activeTab
    const ordered = [
      ...(active ? [active] : []),
      ...browserStore.tabs.filter(tab => tab.id !== active?.id),
    ]
    return ordered
      .filter(tab => !!tab.url && tabMatchesQuery(tab, query))
      .map(tab => toPageExtensionItem(tab, tab.id === active?.id))
  }

  /** The pinned "current page" row surfaced at the top of the bare-`@` picker. */
  function currentPageFileRow(query: string): ComposerExtensionItem[] {
    if (!embeddedBrowserAvailable) return []
    const active = browserStore.activeTab
    if (!active?.url) return []
    const matches = tabMatchesQuery(active, query) ||
      PAGE_QUERY_KEYWORDS.includes(query.trim().toLowerCase())
    if (!matches) return []
    return [toPageExtensionItem(active, true)]
  }

  function pageItemsSignature(items: ComposerExtensionItem[]): string {
    return items
      .map(item => `${item.id}\u0000${item.title}\u0000${item.description}\u0000${item.meta}`)
      .join('\u0001')
  }

  function scheduleFileFetch(delay = 150) {
    clearFileTimer()
    if (activeExtension.value.type !== 'files') return
    patchActiveExtension({ loading: true, error: null })
    fileDebounceTimer = setTimeout(() => {
      fetchFiles()
    }, delay)
  }

  function schedulePathFetch(delay = 150) {
    clearPathTimer()
    if (activeExtension.value.type !== 'paths') return
    patchActiveExtension({ loading: true, error: null })
    pathDebounceTimer = setTimeout(() => {
      fetchDirs()
    }, delay)
  }

  async function fetchFiles() {
    const run = ++fileRequestRun
    const query = activeExtension.value.type === 'files' ? activeExtension.value.query : ''
    patchActiveExtension({ loading: true, error: null })

    try {
      await loadNoteRoots()
      const cwd = variableWorkdir.value || workingDirectory.value

      const result = await platformApi.listFiles({
        cwd,
        query,
        limit: 50,
        // 接入目录是 per-space 的,按**会话归属**解析;宿主不认识「当前空间」,
        // 所以会话号必须由这里带上去(批 B2)。
        sessionId: effectiveSessionId.value || undefined,
      })

      if (
        run !== fileRequestRun ||
        activeExtension.value.type !== 'files' ||
        activeExtension.value.query !== query
      ) return
      if (result.success) {
        const entries = result.entries?.length
          ? result.entries
          : (result.files || []).map(path => ({ path, type: 'file' as const }))
        patchActiveExtension({
          items: [...currentPageFileRow(query), ...entries.map(toFileExtensionItem)],
          loading: false,
          error: null,
        })
      } else {
        patchActiveExtension({
          items: [],
          loading: false,
          error: result.error || 'Failed to list files',
        })
      }
    } catch (error) {
      if (run !== fileRequestRun || activeExtension.value.type !== 'files') return
      patchActiveExtension({
        items: [],
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to list files',
      })
    }
  }

  async function fetchDirs() {
    const run = ++pathRequestRun
    const query = activeExtension.value.type === 'paths' ? activeExtension.value.query : ''
    const pathToSearch = query.trim() || '~'
    patchActiveExtension({ loading: true, error: null })

    try {
      const result = await platformApi.listDirs({
        basePath: pathToSearch,
        limit: 50,
      })

      if (run !== pathRequestRun || activeExtension.value.type !== 'paths' || activeExtension.value.query !== query) return
      if (result.success) {
        patchActiveExtension({
          items: (result.dirs || []).map(toPathExtensionItem),
          loading: false,
          error: null,
        })
      } else {
        patchActiveExtension({
          items: [],
          loading: false,
          error: result.error || 'Failed to list directories',
        })
      }
    } catch (error) {
      if (run !== pathRequestRun || activeExtension.value.type !== 'paths') return
      patchActiveExtension({
        items: [],
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to list directories',
      })
    }
  }

  function showPalette(trigger: EditorTrigger, types: PaletteItemType[]) {
    setActiveExtension({
      type: 'palette',
      query: trigger.query,
      trigger,
      paletteTypes: types,
      items: buildPaletteExtensionItems(trigger.query, types),
      loading: types.includes('prompt') ? promptsStore.isLoading : false,
      error: types.includes('prompt') ? promptsStore.error : null,
    })
    loadSkills()
    if (types.includes('prompt')) {
      void loadPrompts()
    }
    if (types.includes('command')) {
      void loadPluginCommands()
    }
  }

  function showFiles(trigger: EditorTrigger) {
    setActiveExtension({
      type: 'files',
      query: trigger.query,
      trigger,
      // The page row needs no fetch — show it before the file list arrives.
      items: currentPageFileRow(trigger.query),
      loading: true,
    })
    scheduleFileFetch()
  }

  function showPages(trigger: EditorTrigger) {
    if (!embeddedBrowserAvailable) {
      // Unreachable in practice: the parser only produces 'page' triggers
      // when the capability is on. Kept as a safety net.
      closeAllPickers()
      return
    }
    const items = buildPageExtensionItems(trigger.query)
    setActiveExtension({
      type: 'pages',
      query: trigger.query,
      trigger,
      items,
      // An empty mirror may just mean hydration hasn't landed yet — show the
      // spinner instead of a misleading "No open pages".
      loading: items.length === 0 && browserStore.tabs.length === 0,
    })
    void browserStore.ensureLoaded()
      .catch(() => {})
      .then(() => {
        if (activeExtension.value.type !== 'pages') return
        patchActiveExtension({
          items: buildPageExtensionItems(activeExtension.value.query),
          loading: false,
        })
      })
  }

  function buildMemberExtensionItems(query: string): ComposerExtensionItem[] {
    return buildCollabMemberPickerItems({
      query,
      members: activeRoomMembers.value,
      dm: activeRoomIsDm.value,
    })
  }

  function showMembers(trigger: EditorTrigger) {
    setActiveExtension({
      type: 'members',
      query: trigger.query,
      trigger,
      items: buildMemberExtensionItems(trigger.query),
    })
  }

  async function handleMemberPickerSelect(agentId: string) {
    // 「所有人」走**纯文本**:展开成全体点名是 ingress 的事(单一真源),
    // 所以这里不造 token、不写 mentions[] —— 手打 `@所有人` 与从面板选出来的
    // 因此逐字一致,不存在"两种 @所有人"。
    const replacement = agentId === COMPOSER_MENTION_ALL_VALUE
      ? `@${COMPOSER_MENTION_ALL_LABEL} `
      // The trailing space is part of the insertion (same as every other
      // picker): it separates the mention from what the user types next, and it
      // is the space the token carries with it when the member turns out to be
      // gone.
      : `${createMemberToken(agentId)} `
    replaceActiveTrigger(replacement, 'member')
    await nextTick()
    adjustHeight()
    editorRef.value?.focus()
  }

  function showPaths(trigger: EditorTrigger) {
    setActiveExtension({
      type: 'paths',
      query: trigger.query,
      trigger,
      loading: true,
    })
    schedulePathFetch()
  }

  function refreshTriggerState(value = messageInput.value, cursor?: number) {
    if (suppressedTriggerValue !== null) {
      if (value === suppressedTriggerValue) {
        closeAllPickers()
        return
      }
      suppressedTriggerValue = null
    }

    const trigger = parseEditorTrigger(
      value,
      cursor ?? editorRef.value?.getSelection().from ?? value.length,
      triggerParseOptions(),
    )
    activeTrigger.value = trigger

    // messenger 形态:`/` 与 `@` 的补全在这里断掉,activeTrigger 也不算数
    // (确认/替换都以它为准),所以文本原样留在草稿里当普通字发出去。
    if (trigger && !slashCommandsEnabled.value && (trigger.type === 'command' || trigger.type === 'path')) {
      activeTrigger.value = null
      closeAllPickers()
      return
    }
    if (trigger && !atMentionsEnabled.value && trigger.type === 'file' && !trigger.explicit) {
      activeTrigger.value = null
      closeAllPickers()
      return
    }

    if (trigger?.type === 'command') {
      showPalette(trigger, ['command', 'skill', 'prompt'])
      return
    }

    if (trigger?.type === 'path') {
      showPaths(trigger)
      return
    }

    if (trigger?.type === 'file') {
      showFiles(trigger)
      return
    }

    if (trigger?.type === 'member') {
      showMembers(trigger)
      return
    }

    if (trigger?.type === 'page') {
      showPages(trigger)
      return
    }

    if (trigger?.type === 'prompt') {
      showPalette(trigger, ['prompt'])
      return
    }

    if (trigger?.type === 'skill') {
      showPalette(trigger, ['skill'])
      return
    }

    closeAllPickers()
  }

  watch(messageInput, (newValue) => {
    checkHistoryEdit(newValue)
    refreshTriggerState(newValue)
  })

  watch(
    () => [
      promptsStore.prompts.length,
      enabledSkills.value.length,
      promptsStore.isLoading,
    ],
    () => {
      refreshPaletteItems()
    },
  )

  // Keep open pickers honest while tabs navigate/close underneath them — the
  // pages list AND the page row pinned into the files picker. The signature
  // check keeps loading-flag churn from resetting the list identity per flush.
  watch(
    () => [browserStore.tabs, browserStore.activeTabId] as const,
    () => {
      const state = activeExtension.value
      if (state.type !== 'pages' && state.type !== 'files') return
      const nextRows = state.type === 'pages'
        ? buildPageExtensionItems(state.query)
        : currentPageFileRow(state.query)
      const currentRows = state.type === 'pages'
        ? state.items
        : state.items.filter(item => item.kind === 'browser-page')
      if (pageItemsSignature(nextRows) === pageItemsSignature(currentRows)) return
      const rest = state.type === 'pages'
        ? []
        : state.items.filter(item => item.kind !== 'browser-page')
      patchActiveExtension({ items: [...nextRows, ...rest] })
    },
    { deep: true },
  )

  function moveActiveSelection(delta: number): boolean {
    const { items, selectedIndex } = activeExtension.value
    if (activeExtension.value.type === 'none' || items.length === 0) return false
    patchActiveExtension({ selectedIndex: selectedIndex + delta })
    return true
  }

  function setActiveSelection(index: number): boolean {
    if (activeExtension.value.type === 'none' || activeExtension.value.items.length === 0) return false
    patchActiveExtension({ selectedIndex: index })
    return true
  }

  function pageActiveSelection(direction: 1 | -1, pageSize = 5): boolean {
    const { items, selectedIndex } = activeExtension.value
    if (activeExtension.value.type === 'none' || items.length === 0) return false
    patchActiveExtension({ selectedIndex: selectedIndex + direction * Math.max(1, pageSize) })
    return true
  }

  function highlightActiveSelection(index: number): boolean {
    if (activeExtension.value.type === 'none') return false
    patchActiveExtension({ selectedIndex: index })
    return true
  }

  async function confirmActiveExtension(): Promise<boolean> {
    const state = activeExtension.value
    const item = state.items[state.selectedIndex]
    if (!item) return false

    if (state.type === 'palette' && item.paletteItem) {
      await handleCommandSelect(item.paletteItem)
      return true
    }

    // Before the generic files branch: a page row in the files picker carries
    // a tab id in item.value, which must never reach the file-token path.
    if (item.kind === 'browser-page' && item.value) {
      await handlePagePickerSelect(item.value, state.type === 'files' ? 'file' : 'page')
      return true
    }

    if (state.type === 'files' && item.value) {
      await handleFilePickerSelect(item.value)
      return true
    }

    if (state.type === 'members' && item.value) {
      await handleMemberPickerSelect(item.value)
      return true
    }

    if (state.type === 'paths' && item.value) {
      await handlePathPickerSelect(item.value)
      return true
    }

    return false
  }

  async function handleSkillSelect(skill: SkillDefinition) {
    replaceActiveTrigger(
      `${createSkillToken(skill.id)} `,
      activeTrigger.value?.type === 'skill' ? 'skill' : 'command',
    )
    await nextTick()
    adjustHeight()
    editorRef.value?.focus()
  }

  function handleSkillPickerClose() {
    closeAllPickers()
  }

  async function handleCommandSelect(item: PaletteItem) {
    if (item.type === 'skill' && item.skill) {
      await handleSkillSelect(item.skill)
      return
    }

    if (item.type === 'command' && item.command) {
      replaceActiveTrigger(item.command.insertText || `/${item.command.id} `, 'command')
    }

    if (item.type === 'prompt' && item.prompt) {
      replaceActiveTrigger(
        `${createPromptToken(item.prompt.id)} `,
        activeTrigger.value?.type === 'prompt' ? 'prompt' : 'command',
      )
    }

    await nextTick()
    adjustHeight()
    editorRef.value?.focus()
  }

  function handleCommandPickerClose() {
    closeAllPickers()
  }

  async function handleFilePickerSelect(filePath: string) {
    // The token replaces the `@query` in place — the editor hides it and the
    // composer shows a chip, but the position survives for send time.
    replaceActiveTrigger(createFileToken(filePath), 'file')
    await nextTick()
    adjustHeight()
    editorRef.value?.focus()
  }

  function handleFilePickerClose() {
    closeAllPickers()
  }

  /** The docked chips, derived from the hidden tokens in the draft. */
  const fileReferences = computed<ComposerFileReference[]>(() => {
    const references: ComposerFileReference[] = []
    FILE_REF_PATTERN.lastIndex = 0
    for (const match of messageInput.value.matchAll(FILE_REF_PATTERN)) {
      const from = match.index ?? 0
      const filePath = match[1]
      references.push({
        id: `fileref-${from}-${filePath}`,
        path: filePath,
        label: getRelativeFileLabel(filePath),
        from,
        to: from + match[0].length,
      })
    }
    return references
  })

  function removeFileReference(id: string) {
    const reference = fileReferences.value.find(entry => entry.id === id)
    if (!reference) return
    const next = `${messageInput.value.slice(0, reference.from)}${messageInput.value.slice(reference.to)}`
    if (editorRef.value) {
      editorRef.value.replaceRange(reference.from, reference.to, '')
    } else {
      messageInput.value = next
    }
  }

  /**
   * Insert a page token for the picked tab. `triggerType` names the trigger
   * being replaced: 'page' from the @page picker, 'file' when the row was
   * picked out of the bare-@ file picker.
   */
  async function handlePagePickerSelect(tabId: string, triggerType: EditorTrigger['type'] = 'page') {
    // Trailing space: the token is hidden, so without it the user's next
    // words would sit flush against the URL the token expands to at send.
    replaceActiveTrigger(`${createPageToken(tabId)} `, triggerType)
    await nextTick()
    adjustHeight()
    editorRef.value?.focus()
  }

  /** Chip projections of the hidden {{page:…}} tokens, labeled live from the mirror. */
  const pageReferences = computed<ComposerPageReference[]>(() => {
    const references: ComposerPageReference[] = []
    PAGE_REF_PATTERN.lastIndex = 0
    for (const match of messageInput.value.matchAll(PAGE_REF_PATTERN)) {
      const from = match.index ?? 0
      const tabId = match[1]
      const tab = browserStore.tabs.find(entry => entry.id === tabId) ?? null
      references.push({
        id: `pageref-${from}-${tabId}`,
        tabId,
        url: tab?.url ?? '',
        label: tab ? pageLabel(tab) : 'Closed page',
        from,
        to: from + match[0].length,
      })
    }
    return references
  })

  function removePageReference(id: string) {
    const reference = pageReferences.value.find(entry => entry.id === id)
    if (!reference) return
    if (editorRef.value) {
      editorRef.value.replaceRange(reference.from, reference.to, '')
    } else {
      messageInput.value = `${messageInput.value.slice(0, reference.from)}${messageInput.value.slice(reference.to)}`
    }
  }

  /**
   * Send-time resolution: each {{page:…}} token is stripped from the text
   * and becomes a zero-byte provenance attachment (sourceUrl/sourceTitle) —
   * the shape core buildMessageContent already renders as an
   * `<attachment source_url>` text part without any engine change. The bubble
   * shows the attachment chip, never a raw URL. Resolving against the mirror
   * NOW is the point: the message carries what the tab shows at send, and the
   * materialized attachment then persists immutably with the message (history
   * rebuilds must never re-fetch). Tokens whose tab is gone just vanish.
   */
  function materializePageReferences(text: string): { text: string; attachments: MessageAttachment[] } {
    if (!text.includes('{{page:')) return { text, attachments: [] }
    const { text: expanded, pages } = extractPageTokens(text, tabId => {
      const tab = browserStore.tabs.find(entry => entry.id === tabId)
      return tab ? { url: tab.url, title: tab.title } : null
    })
    const attachments = pages.map(page => ({
      id: `page-ref-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      fileName: page.title.trim() || hostFromUrl(page.url),
      mimeType: 'text/plain',
      size: 0,
      mediaType: 'file' as const,
      sourceUrl: page.url,
      sourceTitle: page.title,
    }))
    return { text: expanded, attachments }
  }

  /**
   * Send-time resolution of member tokens (W14a): `{{member:<agentId>}}` turns
   * back into the plain `@名字` the room reads, and the id leaves alongside it
   * in `mentions` — activation, projection and the bubble then all agree on WHO
   * was addressed even after a rename, and two members sharing a name stay
   * distinguishable (the text cannot tell them apart; the id can).
   *
   * The name comes from the roster NOW, at send: a member renamed while the
   * draft sat open is mentioned by its current name. A token whose member is
   * gone leaves entirely (with one trailing space) rather than shipping a raw
   * `{{member:…}}` into the transcript.
   */
  function materializeMemberReferences(
    text: string,
  ): { text: string; mentions: Array<{ agentId: string; label: string }> } {
    if (!text.includes('{{member:')) return { text, mentions: [] }
    const members = activeRoomMembers.value
    return extractMemberTokens(text, agentId => {
      const agent = members.find(member => member.id === agentId)
      return agent ? { name: agent.name } : null
    })
  }

  async function handlePathPickerSelect(selectedPath: string) {
    replaceActiveTrigger(`/cd ${selectedPath}`, 'path')
    await nextTick()
    adjustHeight()
    editorRef.value?.focus()
  }

  function handlePathPickerClose() {
    closeAllPickers()
  }

  function setEditorValue(value: string) {
    const editor = editorRef.value
    if (editor) {
      editor.setValue(value)
    } else {
      messageInput.value = value
    }
  }

  function replaceActiveTrigger(replacement: string, type: EditorTrigger['type']) {
    const cursor = editorRef.value?.getSelection().from ?? messageInput.value.length
    const currentTrigger = parseEditorTrigger(messageInput.value, cursor, triggerParseOptions())
    const trigger = currentTrigger?.type === type
      ? currentTrigger
      : activeTrigger.value?.type === type
      ? activeTrigger.value
      : null
    if (trigger?.type === type) {
      suppressedTriggerValue = applyTriggerReplacement(messageInput.value, trigger, replacement)
      editorRef.value?.replaceRange(trigger.from, trigger.to, replacement)
      if (!editorRef.value) {
        messageInput.value = suppressedTriggerValue
      }
      activeTrigger.value = null
      setActiveExtension({ type: 'none' })
      return
    }
    setEditorValue(replacement)
    activeTrigger.value = null
    setActiveExtension({ type: 'none' })
  }

  function handleEditorSelectionChange(selection: EditorSelection) {
    refreshTriggerState(messageInput.value, selection.from)
  }

  function handleEditorTransaction(transaction: EditorTransaction) {
    refreshTriggerState(transaction.value, transaction.selection.from)
  }

  return {
    activeExtension,
    activeExtensionVisible,
    moveActiveSelection,
    setActiveSelection,
    pageActiveSelection,
    highlightActiveSelection,
    confirmActiveExtension,
    enabledSkills,
    loadSkills,
    showSkillPicker,
    skillTriggerQuery,
    handleSkillSelect,
    handleSkillPickerClose,
    showCommandPicker,
    commandQuery,
    commandPickerTypes,
    handleCommandSelect,
    handleCommandPickerClose,
    showFilePicker,
    fileQuery,
    fileReferences,
    removeFileReference,
    handleFilePickerSelect,
    handleFilePickerClose,
    handlePagePickerSelect,
    handleMemberPickerSelect,
    pageReferences,
    removePageReference,
    materializePageReferences,
    materializeMemberReferences,
    activeRoomMembers,
    showPathPicker,
    pathQuery,
    handlePathPickerSelect,
    handlePathPickerClose,
    anyPickerVisible,
    refreshTriggerState,
    handleEditorSelectionChange,
    handleEditorTransaction,
    closeAllPickers,
  }
}
