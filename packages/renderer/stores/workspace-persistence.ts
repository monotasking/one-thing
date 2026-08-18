/**
 * Persisted (v3) wire format for the chat workspace, plus the pure
 * serialize/rebuild functions between it and the runtime tree.
 *
 * 版本史:
 * - v1 = 扁平的 `openTabs`/`activeTabIndex`,每个分栏各写各的(last-writer-wins);
 * - v2 = 整棵分栏树 + 每格一列页签 + 当前页签;
 * - v3 = 整棵分栏树 + **每格一条会话**(多页签于 2026-08-05 退役,U2);
 * - v4 = **每个形态一棵树**(U3b):形态 = 一个完整的工作现场,切形态时会话与
 *   分栏布局一起换。见 docs/design/product-two-forms-chatgpt-shell.md D7。
 * - v5 = **每个空间 × 每个形态一棵树**(批 B5):space 切换 = 换树。见
 *   docs/design/workspace-spaces-2026-08.md 批 B。
 *
 * **v1 / v2 / v3 / v4 都仍然读得进来**,只写 v5。这一条是硬要求:`hydrate` 若只认
 * 最新版本,老存档会静默清空整个工作区而且不报错(§6.2)。
 * - v2 存档每格取它当时的当前页签,其余丢弃;
 * - v3 那棵**单树**按它当前会话的 kind 认领到某一个形态,另一个形态从空开始;
 * - v4(及更老)的那份存档**整个归 default 空间**,其他空间从空开始 —— 用户在
 *   分空间之前开的东西本来就是在默认空间里开的。
 *
 * Serialization rules:
 * - 会话以裸 id 落盘;草稿(未落地的会话 —— 是一种状态而不是 id 格式,谓词由
 *   调用方注入)跳过,
 * - runtime leaf ids for new nodes are regenerated on rebuild; persisted
 *   leaf ids are kept so `activeLeafId` stays resolvable,
 * - rebuild validates every session id against the loaded session list
 *   (which never contains drafts), drops empty leaves, and collapses
 *   degenerate splits.
 */
import type { SplitterLayout } from '@/components/common/splitter'
import type { SidebarFormMode as WorkspaceFormMode } from './form-mode'
import {
  createLeaf,
  firstLeafId,
  findLeaf,
  genWorkspaceId,
  MAIN_LEAF_ID,
  type WorkspaceLeaf,
  type WorkspaceNode,
} from './workspace-tree'

export interface PersistedWorkspaceLeaf {
  type: 'leaf'
  id: string
  size: number
  /** v3:这一格坐着的那条会话。 */
  session?: string
  /** v2 遗留:一格一列页签。只读不写。 */
  sessions?: string[]
  /** v2 遗留:`sessions` 里的当前页签下标。只读不写。 */
  activeIndex?: number
}

export interface PersistedWorkspaceSplit {
  type: 'split'
  id: string
  orientation: SplitterLayout
  size: number
  children: PersistedWorkspaceNode[]
}

export type PersistedWorkspaceNode = PersistedWorkspaceLeaf | PersistedWorkspaceSplit

/** 一个形态的工作区(v4 里每个形态各一份)。 */
export interface PersistedWorkspaceForm {
  activeLeafId: string
  root: PersistedWorkspaceNode
}

export interface PersistedWorkspaceV4 {
  version: 4
  forms: Partial<Record<WorkspaceFormMode, PersistedWorkspaceForm>>
}

/** 一个空间的全部形态树(v5 里每个空间各一份)。 */
export interface PersistedWorkspaceSpace {
  forms: Partial<Record<WorkspaceFormMode, PersistedWorkspaceForm>>
}

/**
 * v5:每个空间 × 每个形态一棵树。
 *
 * key 是 `stores/spaces.ts` 的 spaceId;**缺席 = 那个空间还没开过任何分栏**
 * (不是"空树被删了")—— 所以 `splitWorkspaceArchive` 对缺席一律给空,不报错。
 */
export interface PersistedWorkspaceV5 {
  version: 5
  spaces: Record<string, PersistedWorkspaceSpace>
}

/** v2 / v3 的单树形状,只读不写。 */
export interface PersistedWorkspaceLegacyTree {
  version: 2 | 3
  activeLeafId: string
  root: PersistedWorkspaceNode
}

export type PersistedWorkspace =
  | PersistedWorkspaceV5
  | PersistedWorkspaceV4
  | PersistedWorkspaceLegacyTree

/** 每个空间那一份分片仍然是"能被 `rebuildWorkspace` 吃下去"的形状。 */
export type PersistedWorkspaceSpaceEntry = PersistedWorkspaceV4 | PersistedWorkspaceLegacyTree

/** v1 flat shape, read-only for migration. */
export interface LegacyPersistedTab {
  type: string
  sessionId?: string
}

// ── serialize ─────────────────────────────────────────────────────────────

function serializeNode(
  node: WorkspaceNode,
  isDraftSessionId: (sessionId: string) => boolean,
): PersistedWorkspaceNode {
  if (node.type === 'leaf') {
    const session = node.sessionId && !isDraftSessionId(node.sessionId) ? node.sessionId : ''
    return { type: 'leaf', id: node.id, size: node.size, session }
  }
  return {
    type: 'split',
    id: node.id,
    orientation: node.orientation,
    size: node.size,
    children: node.children.map(child => serializeNode(child, isDraftSessionId)),
  }
}

export function serializeWorkspace(
  forms: Record<WorkspaceFormMode, { root: WorkspaceNode; activeLeafId: string }>,
  isDraftSessionId: (sessionId: string) => boolean,
): PersistedWorkspaceV4 {
  return {
    version: 4,
    forms: {
      chat: {
        activeLeafId: forms.chat.activeLeafId,
        root: serializeNode(forms.chat.root, isDraftSessionId),
      },
      collab: {
        activeLeafId: forms.collab.activeLeafId,
        root: serializeNode(forms.collab.root, isDraftSessionId),
      },
    },
  }
}

/**
 * 每个空间一份 v4 快照 → 整份 v5 存档(**写盘只走这一个出口**)。
 *
 * 空间是显式列举的:一个空间没有任何树时干脆不写这一条,而不是写一份空壳 ——
 * 存档里的 key 因此永远等于"用户在这个空间里真的开过东西"。
 */
export function serializeWorkspaceArchive(
  spaces: Record<string, PersistedWorkspaceV4>,
): PersistedWorkspaceV5 {
  const out: Record<string, PersistedWorkspaceSpace> = {}
  for (const [spaceId, snapshot] of Object.entries(spaces)) {
    if (!spaceId || !snapshot) continue
    out[spaceId] = { forms: snapshot.forms ?? {} }
  }
  return { version: 5, spaces: out }
}

/**
 * 整份存档 → 每个空间一份分片。
 *
 * - v5:逐条拆开(每条包回 v4 形状,好让 `rebuildWorkspace` 原样吃下去);
 * - v4 / v3 / v2:**整份归 `defaultSpaceId`**,其他空间无树。分空间之前开的东西
 *   本来就是在默认空间里开的 —— 复制给每个空间会让新空间凭空长出别人的会话。
 *
 * 认不出的版本号返回空表(= 全新开始),与 `hydrate` 那边的版本白名单同一口径。
 */
export function splitWorkspaceArchive(
  persisted: PersistedWorkspace | null | undefined,
  defaultSpaceId: string,
): Record<string, PersistedWorkspaceSpaceEntry> {
  if (!persisted || typeof persisted !== 'object') return {}

  if (persisted.version === 5) {
    const spaces = persisted.spaces
    if (!spaces || typeof spaces !== 'object') return {}
    const out: Record<string, PersistedWorkspaceSpaceEntry> = {}
    for (const [spaceId, entry] of Object.entries(spaces)) {
      if (!spaceId || !entry || typeof entry !== 'object') continue
      out[spaceId] = { version: 4, forms: entry.forms ?? {} }
    }
    return out
  }

  if (persisted.version === 4 || persisted.version === 3 || persisted.version === 2) {
    return { [defaultSpaceId]: persisted }
  }
  return {}
}

// ── rebuild ───────────────────────────────────────────────────────────────

/**
 * 一格的还原。v3 读 `session`;v2 存档读 `sessions[activeIndex]` —— 迁移的口径是
 * **每格只留当时看得见的那一条**,后台页签就此丢弃(U2 取消的正是它们)。
 */
function buildLeaf(
  persisted: PersistedWorkspaceLeaf,
  isValidSessionId: (sessionId: string) => boolean,
): WorkspaceLeaf | null {
  let sessionId = ''
  if (typeof persisted.session === 'string') {
    sessionId = persisted.session
  } else if (Array.isArray(persisted.sessions) && persisted.sessions.length > 0) {
    const sessions = persisted.sessions
    const index = Number.isInteger(persisted.activeIndex)
      ? Math.min(Math.max(persisted.activeIndex as number, 0), sessions.length - 1)
      : sessions.length - 1
    sessionId = sessions[index] ?? ''
  }
  if (!sessionId || !isValidSessionId(sessionId)) return null

  return createLeaf(
    persisted.id || genWorkspaceId('panel'),
    Number.isFinite(persisted.size) && persisted.size > 0 ? persisted.size : 50,
    sessionId,
  )
}

function buildNode(
  persisted: PersistedWorkspaceNode,
  isValidSessionId: (sessionId: string) => boolean,
): WorkspaceNode | null {
  if (persisted.type === 'leaf') return buildLeaf(persisted, isValidSessionId)
  if (persisted.type !== 'split' || !Array.isArray(persisted.children)) return null

  const children = persisted.children
    .map(child => buildNode(child, isValidSessionId))
    .filter((child): child is WorkspaceNode => child !== null)
  if (children.length === 0) return null
  if (children.length === 1) {
    children[0].size = Number.isFinite(persisted.size) && persisted.size > 0 ? persisted.size : children[0].size
    return children[0]
  }
  return {
    type: 'split',
    id: persisted.id || genWorkspaceId('split'),
    orientation: persisted.orientation === 'vertical' ? 'vertical' : 'horizontal',
    size: Number.isFinite(persisted.size) && persisted.size > 0 ? persisted.size : 100,
    children,
  }
}

/** 一个形态的还原结果。 */
export interface RebuildFormResult {
  root: WorkspaceNode
  activeLeafId: string
}

export type RebuildAllResult = Record<WorkspaceFormMode, RebuildFormResult>

function emptyForm(): RebuildFormResult {
  return { root: createLeaf(MAIN_LEAF_ID, 100), activeLeafId: MAIN_LEAF_ID }
}

function rebuildForm(
  persisted: PersistedWorkspaceForm | undefined,
  isValidSessionId: (sessionId: string) => boolean,
): RebuildFormResult {
  const root = persisted?.root ? buildNode(persisted.root, isValidSessionId) : null
  if (!root) return emptyForm()
  const activeLeafId = persisted?.activeLeafId && findLeaf(root, persisted.activeLeafId)
    ? persisted.activeLeafId
    : firstLeafId(root)
  return { root, activeLeafId }
}

/**
 * 一个空间那份分片 → 两个形态各一棵树。
 *
 * v2 / v3 是**单树**存档:U3b 之前只有一个工作区。把它整棵认领给 `claimLegacyBy`
 * 说的那个形态(调用方按树里当前会话的 kind 判),另一个形态从空开始 —— 不是
 * 丢掉,是"那个形态还没被用过"。
 */
export function rebuildWorkspace(
  persisted: PersistedWorkspaceSpaceEntry,
  isValidSessionId: (sessionId: string) => boolean,
  claimLegacyBy: (sessionIds: string[]) => WorkspaceFormMode,
): RebuildAllResult {
  if (persisted.version === 4) {
    const forms = persisted.forms ?? {}
    return {
      chat: rebuildForm(forms.chat, isValidSessionId),
      collab: rebuildForm(forms.collab, isValidSessionId),
    }
  }

  const legacy = persisted as PersistedWorkspaceLegacyTree
  const tree = rebuildForm(
    legacy.root ? { activeLeafId: legacy.activeLeafId, root: legacy.root } : undefined,
    isValidSessionId,
  )
  const sessionIds = collectSessionIds(tree.root)
  if (sessionIds.length === 0) return { chat: emptyForm(), collab: emptyForm() }

  const claimed = claimLegacyBy(sessionIds)
  return claimed === 'collab'
    ? { chat: emptyForm(), collab: tree }
    : { chat: tree, collab: emptyForm() }
}

function collectSessionIds(node: WorkspaceNode, acc: string[] = []): string[] {
  if (node.type === 'leaf') {
    if (node.sessionId) acc.push(node.sessionId)
    return acc
  }
  node.children.forEach(child => collectSessionIds(child, acc))
  return acc
}

/**
 * v1 migration: flat `openTabs` + `activeTabIndex` → single-leaf tree。
 * 与 v2 同一口径:只留当时看得见的那一条。
 */
export function rebuildFromLegacyTabs(
  openTabs: LegacyPersistedTab[],
  activeTabIndex: number | undefined,
  isValidSessionId: (sessionId: string) => boolean,
): RebuildFormResult {
  const seen = new Set<string>()
  const sessions = openTabs
    .filter(tab => tab.type === 'chat')
    .map(tab => tab.sessionId ?? '')
    .filter((sessionId) => {
      if (!sessionId || !isValidSessionId(sessionId) || seen.has(sessionId)) return false
      seen.add(sessionId)
      return true
    })

  const index = Number.isInteger(activeTabIndex)
    ? Math.min(Math.max(activeTabIndex as number, 0), Math.max(sessions.length - 1, 0))
    : 0
  return {
    root: createLeaf(MAIN_LEAF_ID, 100, sessions[index] ?? ''),
    activeLeafId: MAIN_LEAF_ID,
  }
}
