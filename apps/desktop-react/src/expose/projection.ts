import { DEFAULT_AGENT_ID } from '@shared/ipc/agents'
import { DEFAULT_SPACE_ID } from '../workspace/types'
import type { SessionMeta } from '@shared/ipc/chat'
import type { SessionSegment } from '@shared/ipc/toc'
import type { UserMessageMarker } from '@shared/ipc/chat'
import type { ChatMessage } from '@shared/ipc/chat'
import type {
  ProjectSummary,
  SessionChapter,
  SessionGroup,
  SessionKind,
  SessionMarker,
  SessionPreviewMessage,
  SessionSummary,
} from './types'

/**
 * 线上形状 → 屏幕形状的**唯一**一条投影。
 *
 * 这个文件取代了 D0 时的 expose/data.ts(那张静态 mock 表)。它只做映射与分组,
 * 不认识 React、不发一条请求 —— 请求在 data/sessions-source.ts,组件在 components/。
 * 所以「后端字段怎么变成卡面上的一格」这件事只有一个产地,能被单测钉死。
 */

/** 合成组的 id。它们不对应任何项目,所以 id 只能是约定值 —— 只此一处。 */
export const COLLAB_GROUP_ID = 'collab'
export const LOOSE_GROUP_ID = 'loose'

/** 协作形态:这几档从项目组里被摘出来,单独成一组(与旧 mock 的读法逐字相同)。 */
const COLLAB_KINDS: SessionKind[] = ['room', 'dm']

/**
 * 工作目录归一:去掉末尾斜杠。**不做别的**(不解析 `~`、不 resolve 相对路径)——
 * 那要认识文件系统,而这里只有一个字符串;归一得太聪明反而会把两个不同目录并成一组。
 */
export function normalizeWorkingDirectory(dir: string | undefined): string | null {
  const trimmed = (dir ?? '').trim()
  if (!trimmed) return null
  const withoutTail = trimmed.replace(/\/+$/, '')
  return withoutTail || '/'
}

/** 项目名 = 路径末段。根目录没有末段,就用它自己。 */
export function projectNameOf(dir: string): string {
  const at = dir.lastIndexOf('/')
  const tail = at < 0 ? dir : dir.slice(at + 1)
  return tail || dir
}

/**
 * kind 的五档口径。后端的 `SessionKind` 是四档,私聊是 `room` 上的一条标记
 * —— 屏幕要分五档,所以在这里摊平一次,别处不许再判 `room.dm`。
 */
export function sessionKindOf(meta: SessionMeta): SessionKind {
  const kind = meta.kind ?? 'chat'
  if (kind === 'room') return meta.room?.dm === true ? 'dm' : 'room'
  if (kind === 'work' || kind === 'agent') return kind
  return 'chat'
}

/**
 * 上一轮跑的模型。空串与缺席一样读作 null —— 「有这一格但它是空的」在屏幕上
 * 分不出来,却会让渲染层多画一个空徽。
 */
export function sessionModelOf(meta: SessionMeta): string | null {
  const model = (meta.lastModel ?? '').trim()
  return model || null
}

/**
 * 上一轮那个模型是哪一家的。与 `sessionModelOf` 同一手:空串读作 null ——
 * 「有这一格但它是空的」在下游(上行 / 查窗口)与缺席是同一件事。
 */
export function sessionProviderOf(meta: SessionMeta): string | null {
  const provider = (meta.lastProvider ?? '').trim()
  return provider || null
}

/**
 * 绑定的 agent。`DEFAULT_AGENT_ID` 在这里被读成 null:默认 agent 是**没有选择**
 * 而不是一个选择,给它出一枚徽等于每条会话都挂一句废话。
 */
export function sessionAgentIdOf(meta: SessionMeta): string | null {
  const agentId = (meta.agentId ?? '').trim()
  if (!agentId || agentId === DEFAULT_AGENT_ID) return null
  return agentId
}

/**
 * 会话摘要 = 最后一条消息的预览。空串与缺席一样读作 null:后端只从共享层读侧
 * 补齐那一批之后才写这一格,存量老会话没有它 —— 缺席时卡面**不画节点**,
 * 而不是画一行空的(见 SessionSummary.digest 的注释)。
 */
export function sessionDigestOf(meta: SessionMeta): string | null {
  const digest = (meta.lastMessagePreview ?? '').trim()
  return digest || null
}

/**
 * 消息条数。**0 与缺席在这里是两件事**:0 是「这条会话真的一条消息都没有」,
 * 缺席是「后端没算过这一格」——所以只有后者读作 null。
 * 非有限数 / 负数一律当没算过:它们不是一个能画在屏幕上的条数。
 */
export function sessionMessageCountOf(meta: SessionMeta): number | null {
  const count = meta.messageCount
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return null
  return Math.floor(count)
}

/**
 * 列表**不陈列**的两档(08-31 用户拍板:「只保留私聊和普通的聊天」)——
 * `agent` 是协作房间派生的执行会话(agent-exec-*,机器开的工作台,不是人开的
 * 对话),`room` 是群房本体。两档都只是**投影过滤**:数据原样在 store 里,
 * 检索/账本/引擎一概不受影响,想翻案删掉这张表就回来了。
 * `dm`(私聊)与 `chat` 照常;`work` 未被点名,保留待问(记档)。
 */
const HIDDEN_SESSION_KINDS: SessionKind[] = ['agent', 'room']

/** 这条会话该不该出现在列表投影里。单产地 —— 列表、分组、方向键序列同吃。 */
export function isListedSession(session: SessionSummary): boolean {
  return !HIDDEN_SESSION_KINDS.includes(session.kind)
}

/**
 * 这条会话属不属于某个工作区。**判据单产地** —— 列表过滤、检索、Quick Look、
 * 「切过去之后焦点该落在谁身上」全吃这一条,与 Vue 壳
 * `stores/spaces.ts` 的 `sessionBelongsToSpace` 逐字同义。
 *
 * 两边都缺省成 `'default'`:老会话的 `workspaceId` 是空的(后端零迁移),
 * 而 `spaceId` 传空串的调用方指的也是默认空间 —— 少一边缺省,老库切到默认
 * 工作区就会一条会话都不剩。
 */
export function sessionBelongsToSpace(session: SessionSummary, spaceId: string): boolean {
  return (session.workspaceId || DEFAULT_SPACE_ID) === (spaceId || DEFAULT_SPACE_ID)
}

/** 一条 SessionMeta → 一条列表事实。缺席的格一律给出诚实的空值,不编。 */
export function toSessionSummary(meta: SessionMeta): SessionSummary {
  return {
    id: meta.id,
    title: meta.name,
    kind: sessionKindOf(meta),
    projectId: normalizeWorkingDirectory(meta.workingDirectory),
    preview: meta.previewText ?? '',
    digest: sessionDigestOf(meta),
    messageCount: sessionMessageCountOf(meta),
    updatedAt: meta.updatedAt,
    model: sessionModelOf(meta),
    provider: sessionProviderOf(meta),
    agentId: sessionAgentIdOf(meta),
    workspaceId: meta.workspaceId || DEFAULT_SPACE_ID,
  }
}

/**
 * 项目名册 = 会话带的工作目录去重。**没有会话的项目在这里不存在** ——
 * 那需要 project-dirs 名册(Vue 壳接了,新壳还没),不是本批的事。
 *
 * 次序:按组内最新会话的 updatedAt 倒序 —— 「最近在动的项目排前面」是列表的
 * 阅读次序,也是方向键序列的拼接次序,只由这一处决定。
 */
export function buildProjects(sessions: SessionSummary[]): ProjectSummary[] {
  const newest = new Map<string, number>()
  for (const session of sessions) {
    if (!session.projectId) continue
    if (COLLAB_KINDS.includes(session.kind)) continue
    const seen = newest.get(session.projectId) ?? 0
    if (session.updatedAt > seen) newest.set(session.projectId, session.updatedAt)
  }
  return [...newest.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([dir]) => ({ id: dir, name: projectNameOf(dir), path: dir }))
}

/**
 * 组 = 总览的一行分区。三种,次序即阅读次序:
 * 项目组(按最近活动倒序)→ 协作组 → 独立会话组。
 *
 * 归属是**互斥且完备**的:协作形态(room / dm)一律进协作组(哪怕它带着工作目录),
 * 其余按工作目录进项目组,没有工作目录的进独立组。空组不出现在表里
 * —— 一个「0 会话」的分区在总览上没有任何可看的东西。
 */
export function buildGroups(
  projects: ProjectSummary[],
  sessions: SessionSummary[],
): SessionGroup[] {
  const isCollab = (s: SessionSummary) => COLLAB_KINDS.includes(s.kind)
  const byRecency = (a: SessionSummary, b: SessionSummary) => b.updatedAt - a.updatedAt

  const groups: SessionGroup[] = projects.map((project) => ({
    id: project.id,
    name: project.name,
    path: project.path,
    projectId: project.id,
    sessions: sessions
      .filter((s) => !isCollab(s) && s.projectId === project.id)
      .sort(byRecency),
  }))

  const collab = sessions.filter(isCollab).sort(byRecency)
  if (collab.length > 0) {
    groups.push({
      id: COLLAB_GROUP_ID,
      nameKey: 'expose.groupCollab',
      pathKey: 'expose.groupCollabPath',
      projectId: null,
      sessions: collab,
    })
  }

  const loose = sessions.filter((s) => !isCollab(s) && !s.projectId).sort(byRecency)
  if (loose.length > 0) {
    groups.push({
      id: LOOSE_GROUP_ID,
      nameKey: 'expose.groupLoose',
      pathKey: 'expose.groupLoosePath',
      projectId: null,
      sessions: loose,
    })
  }

  return groups.filter((group) => group.sessions.length > 0)
}

/* ── 取数(纯查表,不发请求) ─────────────────────────────────────────── */

export function findSession(
  sessions: SessionSummary[],
  id: string | null,
): SessionSummary | undefined {
  if (!id) return undefined
  return sessions.find((s) => s.id === id)
}

export function findGroup(groups: SessionGroup[], id: string): SessionGroup | undefined {
  return groups.find((g) => g.id === id)
}

/**
 * list 视图的取数:**按组**,不按项目。
 * 组自己就带着 sessions(groups 是唯一那份分组事实),所以这里不重新 filter 一遍 ——
 * 重新 filter 就是第二份分组规则,协作组和独立组当年正是这样被合成一坨的。
 */
export function sessionsOfGroup(groups: SessionGroup[], groupId: string): SessionSummary[] {
  return findGroup(groups, groupId)?.sessions ?? []
}

/* ── 会话内部的两份按需数据 ──────────────────────────────────────────── */

/** `sessions.getSegments` 的一条 → 一章。kind 如实转述,不合并。 */
export function toSessionChapter(segment: SessionSegment): SessionChapter {
  return {
    id: segment.id,
    title: segment.title,
    detail: segment.detail,
    kind: segment.kind,
    startMessageId: segment.startMessageId,
  }
}

/** `sessions.getUserMarkers` 的一条 → 一枚键的锚点。 */
export function toSessionMarker(marker: UserMessageMarker): SessionMarker {
  return { id: marker.id, preview: marker.preview }
}

/**
 * `sessions.getMessagesPage` 的一条 → 预览行。
 *
 * D1 只取 `content`:`contentParts` / `toolCalls` / `steps` 是 D3(富渲染 + 流式)
 * 的事。正文为空的消息(纯工具轮)在这里就是空字符串,由渲染层决定要不要画 ——
 * 投影不替它编一句「(工具调用)」,那是界面文案,不是事实。
 */
export function toPreviewMessage(message: ChatMessage): SessionPreviewMessage {
  const role: SessionPreviewMessage['role'] =
    message.role === 'user' || message.role === 'assistant' || message.role === 'system'
      ? message.role
      : 'error'
  return { id: message.id, role, text: message.content ?? '' }
}
