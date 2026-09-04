import { DEFAULT_AGENT_ID } from '@shared/ipc/agents'
import { DEFAULT_SPACE_ID } from '../workspace/types'
import type { SessionMeta } from '@shared/ipc/chat'
import type { SessionSegment } from '@shared/ipc/toc'
import type { UserMessageMarker } from '@shared/ipc/chat'
import type { ChatMessage } from '@shared/ipc/chat'
import { isRoomChildKind, isRoomKind } from './row-kinds'
import type {
  ProjectSummary,
  SessionChapter,
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

/*
 * ── 09-04 P2:分组三件套已删 ─────────────────────────────────────────────
 * `COLLAB_GROUP_ID` / `LOOSE_GROUP_ID` / `COLLAB_KINDS` / `SessionGroup` /
 * `buildGroups` 随方向 A 一起退役 —— 分组不再是投影的事(列表模型是
 * `list-model.buildListModel`,项目降级成侧栏的一格范围 `scopes.SCOPE_SPECS`)。
 * 「这条会话算不算协作」只剩**一张表**:`row-kinds.isRoomKind`(它认得 `swap`,
 * 那份手抄的 COLLAB_KINDS 名单不认得,两份名单必然分叉)。
 */

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
 * kind 的**六档**口径。后端的 `SessionKind` 是四档,私聊是 `room` 上的一条标记
 * —— 屏幕要分六档,所以在这里摊平一次,别处不许再判 `room.dm`。
 *
 * 私聊拆两档的判据是**成员数**,产地是契约自己那句话(`@shared/ipc/chat.ts`
 * 的 `RoomConfig.dm`:「单成员 = 人 ↔ agent;双成员 = agent ↔ agent 私聊」):
 * 两位成员的私聊里没有用户,是两个 agent 在对话(`swap`),行首那一格该画 ⇄
 * 而不是一枚人像首字。成员数不是我们发明的启发式,是那份契约写着的语义。
 */
export function sessionKindOf(meta: SessionMeta): SessionKind {
  const kind = meta.kind ?? 'chat'
  if (kind === 'room') {
    if (meta.room?.dm !== true) return 'room'
    return (meta.room.memberAgentIds?.length ?? 0) === 2 ? 'swap' : 'dm'
  }
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

/*
 * ── `HIDDEN_SESSION_KINDS` / `isListedSession` 09-04 退役 ──────────────────
 * 08-31 那张「只保留私聊和普通聊天」的名单把群房与执行会话整个滤出了列表 ——
 * 那是卡网格时代的权宜:一张网格铺不下层级,于是干脆不铺。
 *
 * 方向 A 把层级铺开了(用户 09-03 裁决 5):房间(群房 / 私聊 / agent 私聊)
 * 与聊天走同一条时间轴,`work`(派工)与 `agent`(执行)不占顶层、挂在父房间下
 * 可展开,孤儿回顶层。于是**没有一档需要被藏**,这张名单连同它的判据一起删。
 *
 * 层级不是投影的事:`list-model.ts` 的 `attachChildren` 才是那份判据的家
 * (它要同时知道父在不在集合里),投影只管「一条 SessionMeta 是什么样」。
 */

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
  const kind = sessionKindOf(meta)
  const roomId = meta.collab?.roomSessionId ?? null
  return {
    id: meta.id,
    title: meta.name,
    kind,
    /*
     * 房间的子会话(`[任务]` / `[执行]`,以及任何带 `collab.roomSessionId` 的会话)
     * **没有自己的项目**:它们的 workingDirectory 是房间的私有目录
     * (`~/.onething/rooms/<uuid>`),不是用户的工程。09-04 用户报「项目下拉框
     * 随名字无限增长」—— 真店 41 条「项目」里 20 条是这种 36–100 字的 uuid /
     * agent-dm-room-… 目录名,全来自子会话;它们的归属由父房间说了算
     * (`list-model.applyScope`),摘掉之后只剩 21 条真项目、最长 20 字。
     */
    projectId:
      isRoomChildKind(kind) || roomId ? null : normalizeWorkingDirectory(meta.workingDirectory),
    preview: meta.previewText ?? '',
    digest: sessionDigestOf(meta),
    messageCount: sessionMessageCountOf(meta),
    updatedAt: meta.updatedAt,
    model: sessionModelOf(meta),
    provider: sessionProviderOf(meta),
    agentId: sessionAgentIdOf(meta),
    workspaceId: meta.workspaceId || DEFAULT_SPACE_ID,
    /*
     * 置顶:缺席读作 **false**(不是 null)—— 「没置顶」是一个真状态。
     * `=== true` 而不是 `!!`:这一格线上是可选布尔,别的假值不该被读成
     * 「置顶了但值有点怪」。
     */
    isPinned: meta.isPinned === true,
    /*
     * 父房间:`work` / `agent` 两档才有(后端 `CollabWorkRef`)。别的形态即便
     * 带着这一格也照样搬 —— 判「谁能当子行」是 `row-kinds` 那张表的事,
     * 投影只如实转述后端写了什么(少一处判据就少一处会与那张表分叉的地方)。
     */
    roomId,
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
    if (isRoomKind(session.kind)) continue
    const seen = newest.get(session.projectId) ?? 0
    if (session.updatedAt > seen) newest.set(session.projectId, session.updatedAt)
  }
  return [...newest.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([dir]) => ({ id: dir, name: projectNameOf(dir), path: dir }))
}

/*
 * ── 09-04 P1:`groupMatchesQuery` / `filterGroups` 已删 ────────────────────
 * 过滤搬去了 `list-model.applyQuery`(它认得房间的子行,这两只不认得),
 * 而删掉的判据是「grep 全仓零消费者」—— 卡片时代的 `Overview` 是它俩唯一的
 * 调用点,那只组件在本批被三块面换掉了。
 *
 * P2 结清了 P1 留的那笔账:`buildGroups` / `SessionGroup` / 两个合成组 id /
 * `sessions-source.groups` / 夹具 `GROUPS` / `expose.group*` 四条字典**全部删掉**。
 * 那批测试断言钉的是「律④:值没变就不重投影」那条契约,不是分组本身 ——
 * 所以它们改吃 `sessions` / `projects` 的引用恒等,契约一个字没变、被试更贴近真事实。
 */

/* ── 取数(纯查表,不发请求) ─────────────────────────────────────────── */

export function findSession(
  sessions: SessionSummary[],
  id: string | null,
): SessionSummary | undefined {
  if (!id) return undefined
  return sessions.find((s) => s.id === id)
}

/*
 * `findGroup` / `sessionsOfGroup` 09-04 P1 随 `ListView`(它俩唯一的调用点)
 * 一起删 —— 没有第二屏,也就没有「按组取数」这件事。
 */

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
