/**
 * Workspace store: the single owner of "which sessions are open, in which
 * split panel, with which tab active".
 *
 * Replaces the previous three-way split of this state (per-ChatWindow
 * `useTabs`, ChatContainer-local `usePanelLayout`, and reverse watches on
 * `sessionsStore.currentSessionId`), which produced last-writer-wins
 * persistence between split panels, tab loss on component unmount, and
 * stale/duplicate tabs on restore. See docs/design/workspace-store.md.
 *
 * Data flow is one-way: user actions mutate this store; a single effect
 * follows `activeSessionId` and drives `sessionsStore.switchSession` (which
 * owns data loading and `currentSessionId`). Components render from here and
 * never hold tab state of their own.
 *
 * 多页签于 2026-08-05 (U2) 整套退役 —— 一格恰好一条会话,分栏保留。
 * 同日 (U3b) 又升了一层:**每个形态各一棵树**。形态 = 一个完整的工作现场,切
 * 形态时会话与分栏布局一起换,切回来原样还在。见
 * docs/design/product-two-forms-chatgpt-shell.md D4 / D7。
 *
 * 形态的**归属在这里**,不在 Sidebar —— 它决定主区显示哪条会话,早就不是侧栏的
 * 本机视图偏好了(D7 修正了 D6 的这一句)。落点仍是 localStorage。
 *
 * 2026-08-14(批 B5)再升一层:**每个空间 × 每个形态一棵树**。切空间 = 换树
 * (`setSpace`),切走的那棵原样寄存在 `parkedSpaces` 里,切回来还在。形态本身
 * **保持全局**(「我现在想看哪类活」不随空间走),所以每个空间存的是两棵树。
 * 切空间**不 abort 任何活跃流** —— 树只是 UI 布局,会话/流的生命周期不归它管
 * (Arc 语义,docs/design/workspace-spaces-2026-08.md §2)。
 *
 * Invariants (maintained by every mutation):
 * - I1: 每个 leaf 恰好一条会话;只有空工作区那唯一一格允许 sessionId === ''。
 * - I2: `activeLeafId` points at an existing leaf.
 * - I3: split nodes have ≥2 children; degenerate splits collapse.
 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { platformApi } from '@/platform'
import { getLogger } from '@/services/log'
import { useSessionsStore } from './sessions'
import {
  SIDEBAR_FORM_MODE_STORAGE_KEY,
  formModeForSessionKind,
  resolveFormMode,
  resolveFormModes,
  type SidebarFormMode,
} from './form-mode'
import {
  activeSessionOf,
  closeLeaf as closeLeafInTree,
  collectLeaves,
  createLeaf,
  equalizeSiblings as equalizeSiblingsInTree,
  findLeaf,
  MAIN_LEAF_ID,
  splitLeaf as splitLeafInTree,
  type SplitDirection,
  type WorkspaceLeaf,
  type WorkspaceNode,
} from './workspace-tree'
import {
  rebuildFromLegacyTabs,
  rebuildWorkspace,
  serializeWorkspace,
  serializeWorkspaceArchive,
  splitWorkspaceArchive,
  type LegacyPersistedTab,
  type PersistedWorkspace,
  type PersistedWorkspaceSpaceEntry,
  type PersistedWorkspaceV4,
  type RebuildFormResult,
} from './workspace-persistence'
import {
  DEFAULT_SPACE_ID,
  currentSpaceId as readCurrentSpaceId,
  sessionBelongsToSpace,
} from './spaces'

export interface WorkspaceHydrationSource {
  currentSessionId?: string
  openTabs?: LegacyPersistedTab[]
  activeTabIndex?: number
  workspace?: PersistedWorkspace
}

export interface CloseLeafResult {
  /** Sessions that the closed leaf held and no surviving leaf still shows. */
  releasedSessionIds: string[]
}

const log = getLogger('renderer.workspace-store')

const PERSIST_DEBOUNCE_MS = 150

const FORM_IDS: readonly SidebarFormMode[] = ['chat', 'collab']

export const useWorkspaceStore = defineStore('workspace', () => {
  // ── 形态与它的两棵树 ────────────────────────────────────────────────────
  const availableFormModes = computed(() =>
    resolveFormModes({ roomsEnabled: platformApi?.capabilities?.collabRooms !== false }))

  function readStored(key: string): string | null {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  }

  const formMode = ref<SidebarFormMode>(resolveFormMode(
    readStored(SIDEBAR_FORM_MODE_STORAGE_KEY),
    readStored('onething:sidebar-rail-category'),
    resolveFormModes({ roomsEnabled: platformApi?.capabilities?.collabRooms !== false }),
  ))

  const roots = ref<Record<SidebarFormMode, WorkspaceNode>>({
    chat: createLeaf(MAIN_LEAF_ID, 100),
    collab: createLeaf(MAIN_LEAF_ID, 100),
  })
  const activeLeafIds = ref<Record<SidebarFormMode, string>>({
    chat: MAIN_LEAF_ID,
    collab: MAIN_LEAF_ID,
  })
  const hydrated = ref(false)

  // ── 空间(批 B5)─────────────────────────────────────────────────────────
  //
  // `roots` / `activeLeafIds` 永远是**当前空间**那两棵树 —— 组件、分栏操作、
  // 形态切换全都不必知道空间这回事。别的空间寄存在 `parkedSpaces` 里。
  // currentSpaceId 是 window 级状态(localStorage 即真相),所以初值直接读它,
  // 不必等 spaces store 装配好。

  interface SpaceTrees {
    roots: Record<SidebarFormMode, WorkspaceNode>
    activeLeafIds: Record<SidebarFormMode, string>
  }

  function emptyTrees(): SpaceTrees {
    return {
      roots: { chat: createLeaf(MAIN_LEAF_ID, 100), collab: createLeaf(MAIN_LEAF_ID, 100) },
      activeLeafIds: { chat: MAIN_LEAF_ID, collab: MAIN_LEAF_ID },
    }
  }

  const spaceId = ref<string>(readCurrentSpaceId() || DEFAULT_SPACE_ID)
  /** 非当前空间的那些树。切回去要原样还在,所以只是寄存,不是丢弃。 */
  const parkedSpaces = ref<Record<string, SpaceTrees>>({})

  /** 当前空间 + 所有寄存空间。删会话、写盘这类"要扫全部"的动作走这一个出口。 */
  function allSpaceTrees(): Array<[string, SpaceTrees]> {
    const current: SpaceTrees = { roots: roots.value, activeLeafIds: activeLeafIds.value }
    return [
      [spaceId.value, current],
      ...Object.entries(parkedSpaces.value).filter(([id]) => id !== spaceId.value),
    ]
  }

  /** 当前形态那棵树 —— 组件一律读这两个,不直接碰 `roots`。 */
  const root = computed<WorkspaceNode>({
    get: () => roots.value[formMode.value],
    set: (next) => { roots.value[formMode.value] = next },
  })
  const activeLeafId = computed<string>({
    get: () => activeLeafIds.value[formMode.value],
    set: (next) => { activeLeafIds.value[formMode.value] = next },
  })

  const leaves = computed(() => collectLeaves(root.value))
  const activeLeaf = computed<WorkspaceLeaf | undefined>(
    () => findLeaf(root.value, activeLeafId.value) ?? leaves.value[0],
  )
  const activeSessionId = computed(() => activeSessionOf(activeLeaf.value))
  const hasAnySession = computed(() => leaves.value.some(leaf => !!leaf.sessionId))
  const openSessionIds = computed(() => {
    const ids = new Set<string>()
    for (const leaf of leaves.value) {
      if (leaf.sessionId) ids.add(leaf.sessionId)
    }
    return ids
  })
  /**
   * 屏幕上真的看得见的那些会话(docs/design/agent-im-dm.md P4)。
   *
   * 多页签在时它与 `openSessionIds` 不同:后台页签开着但被盖住,已读水位不该
   * 替用户往前推。U2 之后没有后台页签了,两者恒等 —— 名字都留着,因为读它们的
   * 两处问的是不同的问题(「还开着吗」vs「有人在看吗」)。
   */
  const visibleSessionIds = openSessionIds

  function leafById(leafId: string | undefined): WorkspaceLeaf | undefined {
    return leafId ? findLeaf(root.value, leafId) : undefined
  }

  function activeSessionIdOf(leafId: string): string {
    return activeSessionOf(leafById(leafId))
  }

  // ── persistence ─────────────────────────────────────────────────────────

  let persistTimer: ReturnType<typeof setTimeout> | null = null

  /** 整份存档(v5):每个空间一份 v4 快照。 */
  function snapshotArchive(): Record<string, PersistedWorkspaceV4> {
    // Draft-ness is session-store state (unmaterialized session), so the
    // skip-drafts predicate is injected here rather than inferred from the
    // id — draft ids are ordinary UUIDs.
    const sessionsStore = useSessionsStore()
    const isDraft = (id: string) => sessionsStore.isNewChatDraftId(id)
    const out: Record<string, PersistedWorkspaceV4> = {}
    for (const [id, trees] of allSpaceTrees()) {
      out[id] = serializeWorkspace(
        {
          chat: { root: trees.roots.chat, activeLeafId: trees.activeLeafIds.chat },
          collab: { root: trees.roots.collab, activeLeafId: trees.activeLeafIds.collab },
        },
        isDraft,
      )
    }
    return out
  }

  function writeArchiveNow(): void {
    if (!platformApi?.saveUIState) return
    platformApi
      .saveUIState({ workspace: serializeWorkspaceArchive(snapshotArchive()) })
      .catch(() => {})
  }

  function persist() {
    // Before hydration finishes there is nothing worth writing (and writing
    // would clobber the saved state we are about to restore from).
    if (!hydrated.value || !platformApi?.saveUIState) return
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      writeArchiveNow()
    }, PERSIST_DEBOUNCE_MS)
  }

  /**
   * 把 debounce 窗口里挂着的那一击立刻写掉。
   *
   * 切空间必须先 flush:换树本身会改掉 `roots`,挂着的那次写盘醒来时看到的已经
   * 是新空间的树 —— 最后一次分栏操作就这么无声无息地丢了。
   */
  function flushPersist(): void {
    if (!persistTimer) return
    clearTimeout(persistTimer)
    persistTimer = null
    writeArchiveNow()
  }

  function hydrate(appState: WorkspaceHydrationSource | null | undefined): void {
    if (hydrated.value) return
    const sessionsStore = useSessionsStore()
    if (sessionsStore.isLoading) {
      // Rebuilding needs the session list to validate targets; restoring
      // against a half-loaded list would silently drop sessions.
      log.error('hydrate called while sessions are still loading, starting empty')
    }
    // Drafts are never persisted and never in the session list, so plain
    // membership covers them.
    //
    // 批 B5:合法还要求**属于这个空间** —— 会话被挪走/删掉之后,别的空间那棵树
    // 里留下的引用走的就是这条既有的"无效叶清理"路(整格丢掉、空分栏收起),
    // 不另起一套。
    const validIn = (space: string) => (sessionId: string) =>
      sessionsStore.sessions.some(s => s.id === sessionId && sessionBelongsToSpace(s, space))
    const isValidSessionId = validIn(spaceId.value)

    /** 老存档(v2/v3 单树)整棵认领给谁 —— 按它当前会话的 kind 判。 */
    const claimLegacyBy = (sessionIds: string[]): SidebarFormMode => {
      for (const sessionId of sessionIds) {
        const wanted = formOfSession(sessionId)
        if (wanted) return wanted
      }
      return 'chat'
    }

    // v5 → 每空间一份分片;v4 及更老的整份归 default 空间(其他空间无树)。
    const archive = splitWorkspaceArchive(appState?.workspace, DEFAULT_SPACE_ID)

    // 别的空间先按存档还原好寄存起来 —— 切过去才有东西可换。
    for (const [id, entry] of Object.entries(archive)) {
      if (id === spaceId.value) continue
      const trees = rebuildWorkspace(entry, validIn(id), claimLegacyBy)
      parkedSpaces.value[id] = {
        roots: { chat: trees.chat.root, collab: trees.collab.root },
        activeLeafIds: { chat: trees.chat.activeLeafId, collab: trees.collab.activeLeafId },
      }
    }

    let rebuilt: Record<SidebarFormMode, RebuildFormResult> | null = null
    /**
     * 老存档(v1/v2/v3 单树、或只有 `currentSessionId`)没有形态这个概念 ——
     * 那棵树就是用户上次在看的东西,所以形态要跟着它走,否则一进来落在一个空
     * 形态上,「我的会话呢」。v4 存档自己带形态,不走这一条。
     */
    let claimedForm: SidebarFormMode | null = null
    const persisted: PersistedWorkspaceSpaceEntry | undefined = archive[spaceId.value]
    // v5 / v4 / v3 / v2 都读得进来(`splitWorkspaceArchive` 已按版本白名单筛过)。
    // 版本号不匹配就静默清空工作区,那是迁移最容易踩的坑,所以必须认全
    // (product-two-forms-chatgpt-shell.md §6.2)。
    if (persisted) {
      rebuilt = rebuildWorkspace(persisted, isValidSessionId, (ids) => {
        const claimed = claimLegacyBy(ids)
        claimedForm = claimed
        return claimed
      })
    } else if (appState?.openTabs?.length) {
      const legacy = rebuildFromLegacyTabs(appState.openTabs, appState.activeTabIndex, isValidSessionId)
      const claimed = claimLegacyBy(collectLeaves(legacy.root).map(leaf => leaf.sessionId).filter(Boolean))
      claimedForm = claimed
      rebuilt = claimed === 'collab'
        ? { chat: emptyForm(), collab: legacy }
        : { chat: legacy, collab: emptyForm() }
    }

    if (rebuilt && !FORM_IDS.some(id => collectLeaves(rebuilt![id].root).some(leaf => !!leaf.sessionId))) {
      rebuilt = null
    }
    if (!rebuilt && appState?.currentSessionId && isValidSessionId(appState.currentSessionId)) {
      const leaf = createLeaf(MAIN_LEAF_ID, 100, appState.currentSessionId)
      const claimed = formOfSession(appState.currentSessionId) ?? 'chat'
      claimedForm = claimed
      const seeded: RebuildFormResult = { root: leaf, activeLeafId: MAIN_LEAF_ID }
      rebuilt = claimed === 'collab'
        ? { chat: emptyForm(), collab: seeded }
        : { chat: seeded, collab: emptyForm() }
    }

    if (rebuilt) {
      roots.value = { chat: rebuilt.chat.root, collab: rebuilt.collab.root }
      activeLeafIds.value = { chat: rebuilt.chat.activeLeafId, collab: rebuilt.collab.activeLeafId }
      if (claimedForm && availableFormModes.value.includes(claimedForm)) {
        formMode.value = claimedForm
      }
    }
    // 停在一个不可用的形态(web 端存了 collab)会让左栏与主区都空着 —— 落回可用的。
    if (!availableFormModes.value.includes(formMode.value)) {
      formMode.value = availableFormModes.value[0] ?? 'chat'
    }
    hydrated.value = true
  }

  // ── 形态 ────────────────────────────────────────────────────────────────

  function emptyForm(): RebuildFormResult {
    return { root: createLeaf(MAIN_LEAF_ID, 100), activeLeafId: MAIN_LEAF_ID }
  }

  /** 某个形态那棵树(持久化与测试用;组件一律读 `root` / `activeLeafId`)。 */
  function rootOf(mode: SidebarFormMode): WorkspaceNode {
    return roots.value[mode]
  }

  function activeLeafIdOf(mode: SidebarFormMode): string {
    return activeLeafIds.value[mode]
  }

  /**
   * 这条会话属于哪个形态 —— 房归协作,其余归对话。
   *
   * `kind` **缺省即 `'chat'`**(shared/ipc/chat.ts:137 的零回归设计:老会话没有
   * 这个字段)。所以"查得到会话但没有 kind"要判成对话形态,不能判成 null ——
   * 判成 null 就是"别动",老直聊会被留在协作那棵树上。
   *
   * 只有**真的查无此会话**才返回 null(一次读不到的抖动不该把工作区整棵换掉);
   * 草稿是个例外:它不在会话表里,但一定是直聊。
   */
  function formOfSession(sessionId: string): SidebarFormMode | null {
    const sessionsStore = useSessionsStore()
    const session = sessionsStore.getSessionItem?.(sessionId)
      ?? sessionsStore.sessions.find(item => item.id === sessionId)
    if (!session) {
      return sessionsStore.isNewChatDraftId?.(sessionId) ? 'chat' : null
    }
    return formModeForSessionKind(session.kind ?? 'chat', availableFormModes.value)
  }

  /**
   * 切形态 = 换整个工作现场:左栏、主区那条会话、分栏布局一起换(D7)。
   *
   * 目标形态一条会话都没有时主区落**空态屏** —— 不凭空替用户拉一条进来
   * (那还会顺手把它标成已读)。
   */
  function setFormMode(next: SidebarFormMode): void {
    if (!availableFormModes.value.includes(next) || next === formMode.value) return
    formMode.value = next
    try {
      localStorage.setItem(SIDEBAR_FORM_MODE_STORAGE_KEY, next)
    } catch {
      // 存不下就只在本次会话里生效,不该因此把切形态这个动作也废掉。
    }
    persist()
  }

  // ── 空间 ────────────────────────────────────────────────────────────────

  /**
   * 切空间 = 换树(批 B5)。
   *
   * 当前这两棵原样寄存,目标空间那两棵取回来;目标空间从没开过东西就给空树 ——
   * 主叶由调用方按"校正激活会话"的口径落位(Sidebar 手上才有按空间过滤好的
   * 会话表)。
   *
   * **不 abort 任何活跃流**:树只是 UI 布局。A 空间在跑的那条流切走后继续跑,
   * 切回来还在原位(Arc 语义)。
   *
   * 形态**不跟着换** —— 「我现在想看哪类活」是全局偏好,每个空间存的是两棵树。
   */
  function setSpace(next: string): void {
    const target = next || DEFAULT_SPACE_ID
    if (target === spaceId.value) return
    // 换树会改掉 `roots`,挂着的那次写盘醒来就写错空间了。
    flushPersist()
    parkedSpaces.value[spaceId.value] = {
      roots: roots.value,
      activeLeafIds: activeLeafIds.value,
    }
    const parked = parkedSpaces.value[target] ?? emptyTrees()
    delete parkedSpaces.value[target]
    roots.value = parked.roots
    activeLeafIds.value = parked.activeLeafIds
    spaceId.value = target
    persist()
  }

  // ── session mutations ───────────────────────────────────────────────────

  function setActiveLeaf(leafId: string) {
    if (activeLeafId.value === leafId || !leafById(leafId)) return
    activeLeafId.value = leafId
    persist()
  }

  /**
   * The single "open this session" entry point: seat it in the target leaf
   * (replacing whatever sat there) and focus that leaf. Idempotent.
   *
   * U2 之前这里是「找到同会话的页签就激活,否则追加一个」;一格一条之后它就是
   * **换靶子**。同一条会话仍然可以同时坐在多个分栏里。
   */
  function openSession(sessionId: string, opts?: { leafId?: string }) {
    if (!sessionId) return
    // 先认形态:打开一条房就该在协作那棵树上落座,而不是把房塞进对话形态。
    // 这一步同时兜住了所有入口(搜索窗、唤醒、openAgentSpace、建完私聊后导航)——
    // `openSession` 是"打开会话"的唯一入口,跟随判定挂在这里就不会漏。
    const wanted = formOfSession(sessionId)
    if (wanted && wanted !== formMode.value) setFormMode(wanted)

    const leaf = leafById(opts?.leafId) ?? activeLeaf.value
    if (!leaf) return
    if (leaf.sessionId === sessionId && activeLeafId.value === leaf.id) return
    leaf.sessionId = sessionId
    activeLeafId.value = leaf.id
    persist()
  }

  /**
   * 把 `sessionId` 从工作区里摘掉(可限定只摘某一格),空掉的分栏跟着关闭。
   * 会话被删除 / 归档 / 挪到别的分栏时调用。
   *
   * 唯一那格允许留空 —— 那就是空工作区态(activeSessionId '' → 空态屏)。
   * 「关掉最后一条会话就关窗口」的旧行为已随 U2 取消(D5):窗口的去留归 ⌘W /
   * 主进程菜单管,不归会话逻辑管。
   */
  function closeSession(sessionId: string, opts?: { onlyLeafId?: string }) {
    let changed = false
    // **每个空间的两棵树都要扫**:会话删了/归档了,不能在别处留一个指向不存在
    // 会话的格子 —— 切过去才发现是个空壳。(寄存的空间里那份同理:留着它等
    // 下次 rebuild 去清也行,但那要等到重启,中间那次切换就是空壳。)
    for (const [, trees] of allSpaceTrees()) {
      for (const id of FORM_IDS) {
        const formLeaves = collectLeaves(trees.roots[id])
        const emptiedLeafIds: string[] = []
        for (const leaf of formLeaves) {
          if (opts?.onlyLeafId && leaf.id !== opts.onlyLeafId) continue
          if (leaf.sessionId !== sessionId) continue
          leaf.sessionId = ''
          changed = true
          emptiedLeafIds.push(leaf.id)
        }
        for (const leafId of emptiedLeafIds) {
          if (collectLeaves(trees.roots[id]).length > 1) {
            const result = closeLeafInTree(trees.roots[id], leafId, trees.activeLeafIds[id])
            trees.roots[id] = result.root
            trees.activeLeafIds[id] = result.activeLeafId
          }
          // 唯一那格允许留空 —— 那就是这个形态的空工作区态。
        }
      }
    }
    if (changed) persist()
  }

  // ── panel mutations ─────────────────────────────────────────────────────

  function splitLeaf(leafId: string, sessionId: string, direction: SplitDirection): string | undefined {
    const result = splitLeafInTree(root.value, leafId, sessionId, direction)
    if (!result) return undefined
    root.value = result.root
    activeLeafId.value = result.newLeafId
    persist()
    return result.newLeafId
  }

  function closeLeaf(leafId: string): CloseLeafResult | undefined {
    const leaf = leafById(leafId)
    if (!leaf || leaves.value.length <= 1) return undefined
    const closedSessionIds = leaf.sessionId ? [leaf.sessionId] : []
    const result = closeLeafInTree(root.value, leafId, activeLeafId.value)
    root.value = result.root
    activeLeafId.value = result.activeLeafId
    persist()
    return {
      releasedSessionIds: closedSessionIds.filter(id => !openSessionIds.value.has(id)),
    }
  }

  function equalizeSiblings(leafId: string) {
    equalizeSiblingsInTree(root.value, leafId)
    persist()
  }

  // ── the one effect ──────────────────────────────────────────────────────

  // Single follower of the workspace's active session: every mutation that
  // changes which session the focused panel shows funnels through here into
  // session activation/data loading. Guarded until hydration so store setup
  // and tests don't trigger spurious switches.
  watch(activeSessionId, (sessionId) => {
    if (!hydrated.value) return
    const sessionsStore = useSessionsStore()
    if (sessionId) {
      void sessionsStore.switchSession(sessionId)
    } else {
      sessionsStore.clearCurrentSession()
    }
  })

  return {
    root,
    activeLeafId,
    hydrated,
    leaves,
    activeLeaf,
    activeSessionId,
    hasAnySession,
    openSessionIds,
    visibleSessionIds,
    leafById,
    activeSessionIdOf,
    formMode,
    availableFormModes,
    setFormMode,
    spaceId,
    setSpace,
    rootOf,
    activeLeafIdOf,
    hydrate,
    setActiveLeaf,
    openSession,
    closeSession,
    splitLeaf,
    closeLeaf,
    equalizeSiblings,
  }
})
