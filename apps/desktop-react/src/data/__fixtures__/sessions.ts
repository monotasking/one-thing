import type { SessionMeta } from '@shared/ipc/chat'
import { buildGroups, buildProjects, toSessionSummary } from '../../expose/projection'
import { configureSessionsPort } from '../sessions-port'
import {
  chaptersQuery,
  markersQuery,
  messagesQuery,
  sessionsQuery,
  useSessionsSource,
} from '../sessions-source'
import type {
  SessionChapter,
  SessionMarker,
  SessionPreviewMessage,
  SessionSummary,
} from '../../expose/types'

/**
 * 测试用的**线上形状**样本 —— 只被 *.test.* 引用,不进产品树。
 *
 * 它刻意从 `SessionMeta`(后端真形状)起步而不是直接手写 SessionSummary:
 * 这样每一条测试都顺带验着 projection 那层映射,而不是验一份自己造的中间态。
 */

/** 固定的「此刻」。相对时间与时间分桶都得有一个不动的参照,否则测试半夜会红。 */
export const NOW = new Date('2026-08-29T14:30:00').getTime()

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const ONETHING_DIR = '/Users/dev/code/start-electron'
export const TRANSREADER_DIR = '/Users/dev/code/transreader'

function meta(partial: Partial<SessionMeta> & Pick<SessionMeta, 'id' | 'name' | 'updatedAt'>): SessionMeta {
  return { createdAt: partial.updatedAt, ...partial }
}

/**
 * 九条会话:项目 A 四条(最近)、项目 B 两条、协作两条(房间 + 私聊)、独立一条。
 * 协作那两条**故意带着工作目录** —— 用来钉「协作形态优先于项目归属」这一条。
 */
export const SESSION_META: SessionMeta[] = [
  meta({
    id: 'os-provider',
    name: '重构 provider 抽象',
    updatedAt: NOW - 8 * MINUTE,
    workingDirectory: ONETHING_DIR,
    previewText: '把 provider 的能力判定收敛到一处',
    // 模型徽 / agent 徽的样本:只有这一条两格都有,好钉「有产地才画」。
    lastModel: 'claude-opus-5',
    agentId: 'reviewer',
    // H 批的两格。摘要故意与 previewText 用词不同 —— 它们是「从哪儿开的」与
    // 「最近说到哪儿」两件事,测试要能只凭摘要里的词把这一条搜出来。
    lastMessagePreview: '那就把三处读取点合成同一个判定函数',
    messageCount: 42,
  }),
  meta({
    id: 'os-compact',
    name: '上下文压缩早触发排查',
    updatedAt: NOW - 3 * HOUR,
    workingDirectory: ONETHING_DIR,
    previewText: '为什么开了 goal 之后压缩会提前触发',
    lastModel: 'deepseek-chat',
    // 默认 agent 在投影里读作「没有绑定」—— 这一条钉的就是它**不**出徽。
    agentId: 'default',
    // 单数档的样本(「1 条消息」)。摘要仍然缺席:两格各自独立,不是一对。
    messageCount: 1,
  }),
  meta({
    id: 'os-expose',
    name: '会话总览 Exposé 设计',
    updatedAt: NOW - DAY - HOUR,
    workingDirectory: `${ONETHING_DIR}/`, // 末尾斜杠:归一之后必须与上面同组
    previewText: '会话总览要做成 Exposé 那样',
  }),
  meta({
    id: 'os-toolkit',
    name: 'toolkit 重建',
    updatedAt: NOW - 3 * DAY,
    workingDirectory: ONETHING_DIR,
    previewText: '工具系统要推翻重来',
  }),
  meta({
    id: 'tr-menubar',
    name: '菜单栏翻译窗',
    updatedAt: NOW - 2 * DAY,
    workingDirectory: TRANSREADER_DIR,
    previewText: '菜单栏那个窗口太小了',
  }),
  meta({
    id: 'tr-flask',
    name: 'Flask 端口冲突',
    updatedAt: NOW - 20 * DAY,
    workingDirectory: TRANSREADER_DIR,
    previewText: '15487 被别的进程占了',
  }),
  meta({
    id: 'rm-release',
    name: '发版房',
    kind: 'room',
    room: { memberAgentIds: ['a', 'b'] },
    updatedAt: NOW - 40 * MINUTE,
    workingDirectory: ONETHING_DIR,
    previewText: '这一批什么时候发',
  }),
  meta({
    id: 'dm-ying',
    name: '和 Ying 的私聊',
    kind: 'room',
    room: { memberAgentIds: ['ying'], dm: true },
    updatedAt: NOW - 5 * HOUR,
    previewText: '帮我看一眼这段',
  }),
  meta({
    id: 'lo-notes',
    name: '随手记',
    updatedAt: NOW - 9 * DAY,
    previewText: '记一下今天的三件事',
  }),
]

/**
 * 一条**执行会话**(协作房间派生的 agent-exec-*)。它刻意**不进** `SESSION_META`:
 * 那张表是「屏幕上的九条」,而这一条的用途正好相反 —— 它是投影过滤掉、却仍然在
 * 发事件的那一类,只被 sessions-source 的「认识但不陈列」用例点名。
 * 放进 SESSION_META 会把所有靠 SESSIONS / GROUPS 吃这张表的组件测试一起搅动。
 */
export const AGENT_SESSION_META: SessionMeta = meta({
  id: 'agent-exec-1',
  name: '发版房 · reviewer',
  kind: 'agent',
  updatedAt: NOW - 30 * MINUTE,
  workingDirectory: ONETHING_DIR,
  previewText: '按房里的分工先跑一遍',
})

export const SESSIONS: SessionSummary[] = SESSION_META.map(toSessionSummary)
export const PROJECTS = buildProjects(SESSIONS)
export const GROUPS = buildGroups(PROJECTS, SESSIONS)

/** 按会话的章节缓存样本(数据源 chapters 表的形状)。 */
export const CHAPTERS: Record<string, SessionChapter[]> = {
  'os-provider': [
    {
      id: 'seg-1',
      title: '摸清三处读取点',
      detail: '请求装配读 capabilities.output,徽标读 modalities。',
      kind: 'task',
      startMessageId: 'm1',
    },
    {
      id: 'seg-2',
      title: '抽成一个判定函数',
      detail: '三处都改成调同一个纯函数。',
      kind: 'question',
      startMessageId: 'm3',
    },
  ],
}

/**
 * 把上面这批样本灌进真数据源(不经端口、不发请求)。
 *
 * 组件测试要的是「数据在场时屏幕长什么样」,而不是「取数怎么发生」——
 * 后者由 sessions-source.test.ts 单独钉。所以这里直接 setState,
 * 组件与 store 走的仍然是产品那一条路。
 */
export function seedSessionsSource(
  overrides: Partial<{
    sessions: SessionSummary[]
    chapters: Record<string, SessionChapter[]>
    messages: Record<string, SessionPreviewMessage[]>
    markers: Record<string, SessionMarker[]>
    /**
     * 列表那一格此刻是「从来没问过」还是「手上有答案」(7e:从前那个压扁的
     * `status` 退役了,这里跟着换成 query 的 `phase`)。
     *  · `'ready'`(缺省)—— `patch` 一份样本进去,phase 走到 ready;
     *  · `'initial'` —— 那一格回出厂,屏幕上该画「正在读会话」。
     * **error 不在这里摆**:它只有走一次真的失败才拿得到,见 `seedSessionsFailure`。
     */
    phase: 'initial' | 'ready'
  }> = {},
): void {
  const sessions = overrides.sessions ?? SESSIONS
  const projects = buildProjects(sessions)
  /*
   * 列表那一格也要摆(7e):产品那条路上 store 的三格是它的投影,
   * 而消费者里已经有人直接读那一格的 `phase` / `error`(总览的三种空态)。
   * 用 `patch()` 而不是配一个端口再 `ensure` —— 组件测试要的是「数据在场时屏幕
   * 长什么样」,不是「取数怎么发生」(与下面三张按需缓存同一条理由)。
   */
  sessionsQuery.reset()
  if ((overrides.phase ?? 'ready') === 'ready') sessionsQuery.patch(sessions)
  useSessionsSource.setState({
    sessions,
    projects,
    groups: buildGroups(projects, sessions),
  })
  // 三张按需缓存从 store 搬进了三族 query(7c 批),所以摆样本也得摆到那边去。
  // **先清空再灌**:样本是「这一条用例的全部事实」,上一条用例留下的格不该
  // 混进来(从前那份整份 setState 天然带着这层意思)。
  chaptersQuery.reset()
  messagesQuery.reset()
  markersQuery.reset()
  seedSessionCaches(overrides)
}

/**
 * 只摆三张按需缓存,**不动列表**。
 *
 * 用 `patch()` 而不是先 `configureSessionsPort` 再 `ensure`:组件测试要的是
 * 「数据在场时屏幕长什么样」,不是「取数怎么发生」。`patch` 把那一格推到
 * `phase: 'ready'` 且 `dataRev > 0`,于是组件挂载时那一发 `ensureX` 是恒等变换
 * (原语的「问过一次且不脏就什么都不做」),一条请求都不会发出去。
 */
export function seedSessionCaches(
  caches: Partial<{
    chapters: Record<string, SessionChapter[]>
    messages: Record<string, SessionPreviewMessage[]>
    markers: Record<string, SessionMarker[]>
  }> = {},
): void {
  for (const [id, value] of Object.entries(caches.chapters ?? {})) chaptersQuery.get(id).patch(value)
  for (const [id, value] of Object.entries(caches.messages ?? {})) messagesQuery.get(id).patch(value)
  for (const [id, value] of Object.entries(caches.markers ?? {})) markersQuery.get(id).patch(value)
}

/**
 * 摆一个**真的失败过**的列表格(7e)。
 *
 * 与三张缓存那边的 `patch` 不同,这一格没法「摆一个错进去」—— kernel 里没有
 * 「就地设一句错」的口,而**也不该有**:错误是取数失败的结果,给原语开一个
 * 只有测试用的写口,等于让屏幕上那句话多一个不经过真实路径的产地。
 *
 * 所以这里走的是真路:换一个「后端说不行」的端口,`refetch()` 一次。
 * 因此它是 async 的,调用点得 await —— 那正是这条路真实的样子。
 *
 * `sessions` 给非空表就得到「有列表 + 有错」那一档(7e 规范修正要验的并存),
 * 缺省是「一条都没有 + 有错」那一档(整块「没连上 core」空态)。
 */
export async function seedSessionsFailure(
  error: string,
  sessions: SessionSummary[] = [],
): Promise<void> {
  seedSessionsSource({ sessions, phase: sessions.length > 0 ? 'ready' : 'initial' })
  configureSessionsPort({
    ready: async () => undefined,
    listMeta: async () => ({ success: false, error }),
    getSegments: async () => ({ success: true, segments: [] }),
    getMessagesPage: async () => ({ success: true, messages: [] }),
    getUserMarkers: async () => ({ success: true, markers: [] }),
    create: async () => ({ success: false, error: 'not stubbed' }),
    updateWorkingDirectory: async () => ({ success: true }),
    onSessionEvent: () => () => undefined,
    onSessionLifecycle: () => () => undefined,
  })
  await sessionsQuery.refetch()
}
