/**
 * Session Organizer Composable
 *
 * Manages hierarchical organization, collapse state, time formatting, etc. for sessions
 */

import { ref, watch } from 'vue'
import type { SessionMeta } from '@/types'
import { useSessionsStore } from '@/stores/sessions'
import { normalizeProjectDir } from '@/utils/project-dir'

// Base session type for organizer - compatible with both metadata-only and full sessions
// This allows the organizer to work with metadata loaded on startup (no messages)
type SessionBase = SessionMeta & {
  workingDirectory?: string
  summary?: string
  draftKind?: 'new-chat-draft'
}

// Extended session interface with branch information
export interface SessionWithBranches extends SessionBase {
  branches: SessionWithBranches[]
  depth: number
  hasBranches: boolean
  isCollapsed: boolean
  isLastChild: boolean
  branchCount: number
  isHidden: boolean
  lastBranchUpdate: number
  ancestorsLastChild: boolean[]
  // Temporal sub-header rendered above this row (未归类 桶内退回时间：今天/昨天/…)
  sectionLabel?: string
}

// A temporal (or pinned) section of the session list
export interface SessionGroup {
  key: string
  label: string
  /**
   * 这一组是什么(U4)。呈现层据此决定画不画文件夹图标 —— **不要去解析 `key`
   * 的前缀**:那是一个内部标识,不是分类依据。
   */
  kind: 'pinned' | 'project' | 'other'
  sessions: SessionWithBranches[]
  /**
   * 仅 `kind === 'project'`:这一组对应的工作目录(规范形)。
   * 呈现层要拿目录干事(在这个项目里新建会话、把它移出名册)时读这个字段,
   * **同样不要去解析 `key`** —— 与 `kind` 一个规矩。
   */
  projectPath?: string
  /**
   * 仅 `kind === 'project'`:这一组在项目名册里登记过(而不是纯从会话 cwd
   * 推导出来的)。移出名册这类动作只对登记过的项目有意义。
   */
  isRegistered?: boolean
}

/** 项目名册里的一条 —— 只取分组用得上的字段(见 stores/projects.ts)。 */
export interface RegisteredProjectDir {
  /** 主根(`paths[0]`)。 */
  path: string
  /** 全部根;多根项目的每个根都归到同一组。可缺省(等价于 `[path]`)。 */
  paths?: string[]
  lastUsedAt: number
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const DAY_MS = 86_400_000

function startOfToday(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Relative timestamp for a session row (supporting text).
 * 刚刚 → 14:20 (today) → 昨天 → 周二 (within 7 days) → 4月12日 (older)
 */
export function formatRelativeTime(ts: number): string {
  if (!ts) return ''
  const now = Date.now()
  const date = new Date(ts)

  if (now - ts < 60_000) return '刚刚'

  const todayStart = startOfToday()
  if (ts >= todayStart) {
    const h = String(date.getHours()).padStart(2, '0')
    const m = String(date.getMinutes()).padStart(2, '0')
    return `${h}:${m}`
  }
  if (ts >= todayStart - DAY_MS) return '昨天'
  if (ts >= todayStart - 6 * DAY_MS) return WEEKDAYS[date.getDay()]
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

// Bucket a root session's activity time into a temporal group key
function temporalKey(ts: number): 'today' | 'yesterday' | 'week' | 'older' {
  const todayStart = startOfToday()
  if (ts >= todayStart) return 'today'
  if (ts >= todayStart - DAY_MS) return 'yesterday'
  if (ts >= todayStart - 6 * DAY_MS) return 'week'
  return 'older'
}

function isNewChatDraft(session: SessionBase): boolean {
  return session.draftKind === 'new-chat-draft'
}

export function useSessionOrganizer() {
  const sessionsStore = useSessionsStore()

  // Collapsed parent sessions state (stores parent session IDs that are collapsed)
  const collapsedParents = ref<Set<string>>(new Set())

  // Track if initial collapse has been done
  const initialCollapseApplied = ref(false)

  // Check if a session has branches
  function hasBranches(sessionId: string): boolean {
    return sessionsStore.sessions.some(s => s.parentSessionId === sessionId)
  }

  // Get all ancestor IDs for a session
  function getAncestorIds(sessionId: string): string[] {
    const ancestors: string[] = []
    const session = sessionsStore.sessions.find(s => s.id === sessionId)
    if (!session) return ancestors

    let current = session
    while (current.parentSessionId) {
      ancestors.push(current.parentSessionId)
      const parent = sessionsStore.sessions.find(s => s.id === current.parentSessionId)
      if (!parent) break
      current = parent
    }
    return ancestors
  }

  // Initialize collapsed state - collapse all parent sessions on startup
  // But keep ancestors of the current session expanded
  function initializeCollapsedState() {
    if (initialCollapseApplied.value) return

    // Get ancestors of the current session (these should stay expanded)
    const currentSessionAncestors = new Set(getAncestorIds(sessionsStore.currentSessionId))

    const parentsWithBranches = sessionsStore.sessions
      .filter(s => !s.parentSessionId) // Root sessions only
      .filter(s => hasBranches(s.id))
      .filter(s => !currentSessionAncestors.has(s.id)) // Don't collapse ancestors of current session
      .map(s => s.id)

    if (parentsWithBranches.length > 0) {
      collapsedParents.value = new Set(parentsWithBranches)
    }
    initialCollapseApplied.value = true
  }

  // Watch for sessions to be loaded and apply initial collapse
  watch(
    () => sessionsStore.sessions.length,
    (newLength) => {
      if (newLength > 0 && !initialCollapseApplied.value) {
        initializeCollapsedState()
      }
    },
    { immediate: true }
  )

  // Watch for current session changes - expand ancestors when switching to a branch
  watch(
    () => sessionsStore.currentSessionId,
    (newSessionId) => {
      if (!newSessionId) return

      // Get ancestors of the new current session
      const ancestors = getAncestorIds(newSessionId)

      // Expand any collapsed ancestors
      let changed = false
      for (const ancestorId of ancestors) {
        if (collapsedParents.value.has(ancestorId)) {
          collapsedParents.value.delete(ancestorId)
          changed = true
        }
      }

      // Trigger reactivity if we made changes
      if (changed) {
        collapsedParents.value = new Set(collapsedParents.value)
      }
    }
  )

  // Toggle collapse state for a parent session
  function toggleCollapse(sessionId: string) {
    if (collapsedParents.value.has(sessionId)) {
      collapsedParents.value.delete(sessionId)
    } else {
      collapsedParents.value.add(sessionId)
    }
    // Trigger reactivity
    collapsedParents.value = new Set(collapsedParents.value)
  }

  // Check if a session is collapsed
  function isCollapsed(sessionId: string): boolean {
    return collapsedParents.value.has(sessionId)
  }

  // Check if any ancestor of a session is collapsed
  function isAncestorCollapsed(session: SessionBase): boolean {
    let current = session
    while (current.parentSessionId) {
      if (collapsedParents.value.has(current.parentSessionId)) {
        return true
      }
      const parent = sessionsStore.sessions.find(s => s.id === current.parentSessionId)
      if (!parent) break
      current = parent
    }
    return false
  }

  // Get branch depth (how deep the branch is)
  function getBranchDepth(session: SessionBase): number {
    let depth = 0
    let current = session
    while (current.parentSessionId) {
      depth++
      const parent = sessionsStore.sessions.find(s => s.id === current.parentSessionId)
      if (!parent) break
      current = parent
    }
    return depth
  }

  // Organize sessions with their branches into a hierarchical structure
  function organizeSessionsWithBranches(sessions: SessionBase[]): SessionWithBranches[] {
    const sessionMap = new Map<string, SessionWithBranches>()
    const rootSessions: SessionWithBranches[] = []

    // First pass: create SessionWithBranches objects
    for (const session of sessions) {
      sessionMap.set(session.id, {
        ...session,
        branches: [],
        depth: 0,
        hasBranches: false,
        isCollapsed: collapsedParents.value.has(session.id),
        isLastChild: false,
        branchCount: 0,
        isHidden: false,
        lastBranchUpdate: session.updatedAt,
        ancestorsLastChild: []
      })
    }

    // Second pass: organize into hierarchy
    for (const session of sessions) {
      const withBranches = sessionMap.get(session.id)!
      if (session.parentSessionId) {
        const parent = sessionMap.get(session.parentSessionId)
        if (parent) {
          withBranches.depth = getBranchDepth(session)
          parent.branches.push(withBranches)
          parent.hasBranches = true

          // Propagate branch update time to ancestors
          let current: SessionWithBranches | undefined = parent
          while (current) {
            if (withBranches.updatedAt > current.lastBranchUpdate) {
              current.lastBranchUpdate = withBranches.updatedAt
            }
            current = current.parentSessionId ? sessionMap.get(current.parentSessionId) : undefined
          }
        } else {
          rootSessions.push(withBranches)
        }
      } else {
        rootSessions.push(withBranches)
      }
    }

    // Third pass: mark last children and count branches
    function markLastChildren(sessions: SessionWithBranches[]) {
      for (const session of sessions) {
        session.branchCount = session.branches.length
        if (session.branches.length > 0) {
          session.branches[session.branches.length - 1].isLastChild = true
          markLastChildren(session.branches)
        }
      }
    }
    markLastChildren(rootSessions)

    // Flatten hierarchy for display
    // Always include all sessions, but mark hidden ones with isHidden flag
    // This keeps DOM stable for proper mouse event handling
    function flattenWithBranches(
      sessions: SessionWithBranches[],
      parentCollapsed: boolean = false,
      ancestorsLast: boolean[] = []
    ): SessionWithBranches[] {
      const result: SessionWithBranches[] = []

      // Sort branches by updatedAt descending within their parent
      // const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
      const sorted = sessions // 不排序，保持原始顺序

      for (let i = 0; i < sorted.length; i++) {
        const session = sorted[i]
        const isLast = (i === sorted.length - 1)
        session.isLastChild = isLast
        session.isHidden = parentCollapsed
        session.ancestorsLastChild = [...ancestorsLast]
        session.branchCount = session.branches.length

        result.push(session)

        if (session.branches.length > 0) {
          const shouldHideChildren = parentCollapsed || session.isCollapsed
          // 修复：根 session (depth=0) 不传递 isLast，因为根 session 上面没有需要画线的层级
          const nextAncestors = session.depth > 0
            ? [...ancestorsLast, isLast]
            : []
          result.push(...flattenWithBranches(session.branches, shouldHideChildren, nextAncestors))
        }
      }
      return result
    }

    // Pre-sort root sessions by their branch activity so they arrive correctly at groupedSessions
    // rootSessions.sort((a, b) => b.lastBranchUpdate - a.lastBranchUpdate)

    return flattenWithBranches(rootSessions)
  }

  /*
   * `getFlatSessions` 与 `getGroupedSessions`(纯时间分组:置顶/今天/昨天/过去
   * 7 天/更早)已于 2026-08-05 (U4) 删除 —— 生产唯一的分组口径是下面的
   * `getProjectGroupedSessions`,那两个只剩测试在引用,是死码。
   */


  // Project label = the last path segment of workingDirectory
  // (/Users/me/data/code/start-electron → start-electron).
  function projectLabel(dir: string): string {
    const trimmed = dir.replace(/[/\\]+$/, '')
    const base = trimmed.split(/[/\\]/).pop()
    return base && base.length > 0 ? base : trimmed
  }

  // A working directory only counts as a "project" if it's a real place the
  // user works. Transient tool sandboxes (the headless server's per-request
  // workspace, OS temp dirs) would otherwise mint meaningless groups like
  // "default" — route those to 未归类 instead.
  function isProjectDir(dir: string): boolean {
    if (/onething-server-workspaces/.test(dir)) return false
    if (/(^|\/)(private\/)?(tmp|var\/folders)\//.test(dir)) return false
    return true
  }

  // Group sessions by their working directory (project). Order:
  // 置顶 → 各项目(按最近活动降序) → 未归类(无 cwd + 草稿)。
  // Each root keeps its branch subtree together inside its section.
  //
  // 项目有两个来源,在这里并成一份:
  //  - **推导**:会话自己带的 workingDirectory 撞在一起就成一组(老口径);
  //  - **登记**:项目名册(`stores/projects`)里的目录 —— 它**不靠会话存在**,
  //    空项目照样占一格。「新建项目 → 在里面开第一个会话」这条路要的就是这个:
  //    项目先有,会话后有。
  // 并的键是目录的规范形,所以「登记过 + 已经有会话」不会裂成两组。
  function getProjectGroupedSessions(
    filteredSessions: SessionBase[],
    registeredProjects: readonly RegisteredProjectDir[] = [],
  ): SessionGroup[] {
    const organized = organizeSessionsWithBranches(filteredSessions)

    type Block = { root: SessionWithBranches; rows: SessionWithBranches[] }
    const blocks: Block[] = []
    for (const session of organized) {
      if (session.depth === 0) {
        blocks.push({ root: session, rows: [session] })
      } else {
        blocks[blocks.length - 1]?.rows.push(session)
      }
    }

    const pinnedBlocks: Block[] = []
    const draftBlocks: Block[] = []
    const uncategorized: Block[] = []
    // `dir` 是这一格的规范键(多根项目取主根);map 里每个根都指向同一个
    // entry 对象,会话按自己的 cwd 查表就自然落进正确的格。
    type ProjectEntry = { dir: string; label: string; blocks: Block[]; registeredAt?: number }
    const projects = new Map<string, ProjectEntry>()

    // 名册先落座 —— 空项目也要有一格,而且「登记过」这件事要在会话入座之前
    // 就已知(见下面 dir 的收留判据)。多根项目的每个根都指向同一格。
    for (const registered of registeredProjects) {
      const primary = normalizeProjectDir(registered.path)
      if (!primary) continue
      let entry = projects.get(primary)
      if (entry) {
        entry.registeredAt = registered.lastUsedAt
      } else {
        entry = { dir: primary, label: projectLabel(primary), blocks: [], registeredAt: registered.lastUsedAt }
        projects.set(primary, entry)
      }
      for (const root of registered.paths ?? []) {
        const normalized = normalizeProjectDir(root)
        if (normalized && !projects.has(normalized)) projects.set(normalized, entry)
      }
    }

    for (const block of blocks) {
      const root = block.root
      if (root.isPinned) { pinnedBlocks.push(block); continue }
      const dir = normalizeProjectDir(root.workingDirectory || '')
      // 草稿只有带上目录才进项目组 —— 它是「在这个项目里新建的会话」还没落盘的
      // 那一刻,该显示在用户刚点过的地方,而不是掉进未归类。裸草稿照旧。
      if (!dir) {
        if (isNewChatDraft(root)) draftBlocks.push(block)
        else uncategorized.push(block)
        continue
      }
      // 登记过的目录一律收留(那是用户显式挑的);没登记的还要过一遍启发式,
      // 免得工具沙箱、临时目录凭空长出一堆没意义的组。
      const registeredEntry = projects.get(dir)
      if (!registeredEntry && !isProjectDir(dir)) {
        if (isNewChatDraft(root)) draftBlocks.push(block)
        else uncategorized.push(block)
        continue
      }
      let entry = registeredEntry
      if (!entry) {
        entry = { dir, label: projectLabel(dir), blocks: [] }
        projects.set(dir, entry)
      }
      entry.blocks.push(block)
    }

    const byRecency = (a: Block, b: Block) => b.root.lastBranchUpdate - a.root.lastBranchUpdate
    // 项目组内草稿浮在最前:刚点「＋」开出来的那一条,不该按时间沉到旧会话之后。
    const draftFirstByRecency = (a: Block, b: Block) => {
      const aDraft = isNewChatDraft(a.root) ? 1 : 0
      const bDraft = isNewChatDraft(b.root) ? 1 : 0
      if (aDraft !== bDraft) return bDraft - aDraft
      return byRecency(a, b)
    }
    pinnedBlocks.sort(byRecency)
    uncategorized.sort(byRecency)
    draftBlocks.sort(byRecency)
    // 多根项目的各个根共享同一个 entry 对象 —— 去重后再排序/成组,免得
    // 一个项目排两次、画两格。
    const uniqueProjectEntries = [...new Set(projects.values())]
    for (const entry of uniqueProjectEntries) entry.blocks.sort(draftFirstByRecency)

    // Project sections ordered by their most recently active session.
    // 空的登记项目没有会话可比,退回名册的 lastUsedAt —— 刚加的项目 lastUsedAt
    // 是此刻,于是浮到最前(用户刚挑完目录,该看见它),久未使用的自然下沉。
    const projectSections = uniqueProjectEntries
      .map(entry => ({
        dir: entry.dir,
        label: entry.label,
        blocks: entry.blocks,
        registered: entry.registeredAt !== undefined,
        recency: entry.blocks[0]?.root.lastBranchUpdate ?? entry.registeredAt ?? 0,
      }))
      .sort((a, b) => b.recency - a.recency)

    const groups: SessionGroup[] = []
    if (pinnedBlocks.length > 0) {
      groups.push({ key: 'pinned', label: '置顶', kind: 'pinned', sessions: pinnedBlocks.flatMap(b => b.rows) })
    }
    for (const section of projectSections) {
      groups.push({
        key: `proj:${section.dir}`,
        label: section.label,
        kind: 'project',
        sessions: section.blocks.flatMap(b => b.rows),
        projectPath: section.dir,
        isRegistered: section.registered,
      })
    }
    // Drafts and cwd-less sessions share the 未归类 bucket; drafts float first.
    // Inside it, fall back to time (V7): tag the first root of each temporal
    // run so the list renders 今天 / 昨天 / 过去 7 天 / 更早 sub-headers.
    const miscBlocks = [...draftBlocks, ...uncategorized]
    if (miscBlocks.length > 0) {
      const temporalLabel: Record<string, string> = {
        today: '今天', yesterday: '昨天', week: '过去 7 天', older: '更早',
      }
      let lastKey = ''
      for (const block of miscBlocks) {
        const key = temporalKey(block.root.lastBranchUpdate)
        block.root.sectionLabel = key !== lastKey ? temporalLabel[key] : undefined
        lastKey = key
      }
      groups.push({ key: 'uncategorized', label: '未归类', kind: 'other', sessions: miscBlocks.flatMap(b => b.rows) })
    }
    return groups
  }

  // Get session preview text
  function getSessionPreview(session: SessionBase): string {
    return session.previewText || (session.messageCount ? '' : 'No messages yet')
  }

  // Format model ID for display (e.g. gpt-4o-2024-05-13 -> GPT-4o)
  function formatModelName(modelId?: string): string {
    if (!modelId) return ''

    // Custom mapping for common models
    const lower = modelId.toLowerCase()
    if (lower.includes('gpt-4o')) return 'GPT-4o'
    if (lower.includes('gpt-4-turbo')) return 'GPT-4T'
    if (lower.includes('gpt-4')) return 'GPT-4'
    if (lower.includes('gpt-3.5')) return 'GPT-3.5'
    if (lower.includes('claude-3-5-sonnet')) return 'Sonnet 3.5'
    if (lower.includes('claude-3-5')) return 'Claude 3.5'
    if (lower.includes('claude-3')) return 'Claude 3'
    if (lower.includes('deepseek-reasoner')) return 'DS Reasoner'
    if (lower.includes('deepseek-chat')) return 'DS Chat'
    if (lower.includes('deepseek')) return 'DeepSeek'
    if (lower.includes('gemini')) return 'Gemini'

    // Generic fallback: remove version dates and capitalize
    return modelId
      .replace(/-\d{4}-\d{2}-\d{2}$/, '')
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
  }

  return {
    // State
    collapsedParents,

    // Methods
    toggleCollapse,
    isCollapsed,
    isAncestorCollapsed,
    hasBranches,
    getAncestorIds,
    getBranchDepth,
    organizeSessionsWithBranches,
    getProjectGroupedSessions,
    getSessionPreview,
    formatModelName,
  }
}

export type SessionOrganizerReturn = ReturnType<typeof useSessionOrganizer>
