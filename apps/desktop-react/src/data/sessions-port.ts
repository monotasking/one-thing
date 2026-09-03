import type {
  CreateSessionResponse,
  GetSessionMessagesPageResponse,
  GetSessionUserMarkersResponse,
  GetSessionsListResponse,
} from '@shared/ipc/chat'
import type { SessionMutationResponse, SessionsCreateRequest } from '@shared/ipc/sessions'
import type { GetSessionSegmentsResponse } from '@shared/ipc/toc'
import type { SessionEventEnvelope } from '@shared/events/envelope'
import type { SessionLifecycleEvent } from '@onething/client/events/session-lifecycle'
import { IPC_CHANNELS } from '@shared/ipc/channels'
import { sessionsRouter } from '@shared/ipc/sessions'

/**
 * 数据源与 core 的客户端(`@onething/client`)之间的那一层**端口**。
 *
 * 它存在的唯一理由是可测:sessions-source 的全部判据(节流、增量 vs 重拉、缓存
 * 失效)都是纯逻辑,不该为了测它去起一台 core。真实现是下面那一个,
 * 测试用 `configureSessionsPort` 换成假的。
 *
 * 形状是**契约的子集**,不是新契约:八个方法逐条对应 `sessionsRouter` 的
 * `listMeta / getSegments / getMessagesPage / getUserMarkers / create /
 * updateWorkingDirectory`、推送面上的 `session:event`,与
 * `@onething/client` 的 `onSessionLifecycle`,一个字段都没有多。
 */
export interface SessionsPort {
  /** 传输面就绪(D0 的 whenConnected);浏览器直开时它也会 resolve。 */
  ready(): Promise<unknown>
  listMeta(): Promise<GetSessionsListResponse>
  /**
   * 建一条会话(D1 开工批)。
   *
   * **不带 name** 是刻意的:缺席时后端自己落 `'New Chat'`
   * (`runtime/src/sessions/ipc-operations.ts` 的 `options.name || … || 'New Chat'`),
   * 而会话标题是**存进账本的数据**不是界面文案 —— 由渲染层按当下语言现造一个,
   * 换一次语言之后老会话的名字就成了说谎的那一格。默认名归后端,只有一个产地。
   *
   * 同理**不带 workspaceId**:新壳没有 space 概念(Vue 壳的 `currentSpaceId()`
   * 在这里没有对应物),缺席 = default,不假装有一个当前空间。
   */
  create(request: SessionsCreateRequest): Promise<CreateSessionResponse>
  /**
   * 改工作目录 —— 「新会话落在哪个项目下」唯一的表达方式。
   *
   * `SessionsCreateRequest` **没有 workingDirectory 这一格**(去看契约),而项目分组
   * 的判据恰恰是它(`expose/projection.ts` 的 `normalizeWorkingDirectory`)。所以
   * 「在某个项目下新建」在线上就是两步:先建,再落目录 —— 与 Vue 壳
   * (`stores/sessions.ts` 的草稿落地路径)是同一条路,不是这一层发明的。
   */
  updateWorkingDirectory(
    sessionId: string,
    workingDirectory: string | null,
  ): Promise<SessionMutationResponse>
  getSegments(sessionId: string): Promise<GetSessionSegmentsResponse>
  getMessagesPage(sessionId: string, limit: number): Promise<GetSessionMessagesPageResponse>
  getUserMarkers(sessionId: string): Promise<GetSessionUserMarkersResponse>
  onSessionEvent(callback: (envelope: SessionEventEnvelope) => void): () => void
  /**
   * 会话被建 / 被删(共享层读侧补齐 E 批新开的口)。
   *
   * 它与 `onSessionEvent` 骑的是**同一条** `session:event` 推送面,差别只在
   * 那一层折叠:`foldSessionLifecycleEvent` 把账本的 `session/created` 与
   * `session:removed` 这两件事从流里认出来,并带上级联删除的完整名单
   * (删一条房间会连带删掉它的子会话,每条各来一次事件)。
   */
  onSessionLifecycle(callback: (event: SessionLifecycleEvent) => void): () => void
}

let port: SessionsPort | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureSessionsPort(next: SessionsPort | undefined): void {
  port = next
}

/**
 * 真实现是**惰性**建的:它要的是那个**连通之后才存在**的客户端,而端口被换掉的
 * 测试根本不该把连通面拖进来(单元测试不碰网,默认假端口装在
 * `src/test/setup.ts` 里)。
 *
 * vite build 会为此打一条 “dynamically imported … but also statically imported”
 * 的提示:`main.tsx` 静态引着 `platform/connection`,所以这条动态 import 换不来
 * 一个独立 chunk。**这是预期的** —— 它买的是测试隔离,不是分包。
 */
async function realPort(): Promise<SessionsPort> {
  const [{ onethingClient, whenConnected }, { onSessionLifecycle }] = await Promise.all([
    import('../platform/connection'),
    import('@onething/client/events/session-lifecycle'),
  ])
  const client = await onethingClient()
  const sessionsApi = client.api(sessionsRouter)
  return {
    ready: () => whenConnected(),
    listMeta: () => sessionsApi.listMeta({}),
    getSegments: (sessionId) => sessionsApi.getSegments({ sessionId }),
    // anchor:'tail' = 首页取**最新**那一页。QuickLook 要看的是「这条会话最近在聊
    // 什么」,不是它开头说了什么 —— 与会话列表按 updatedAt 倒序是同一个口径。
    getMessagesPage: (sessionId, limit) =>
      sessionsApi.getMessagesPage({ sessionId, limit, anchor: 'tail' }),
    getUserMarkers: (sessionId) => sessionsApi.getUserMarkers({ sessionId }),
    create: (request) => sessionsApi.create(request),
    updateWorkingDirectory: (sessionId, workingDirectory) =>
      sessionsApi.updateWorkingDirectory({ sessionId, workingDirectory }),
    onSessionEvent: (callback) => client.events.on(IPC_CHANNELS.SESSION_EVENT, callback),
    onSessionLifecycle: (callback) => onSessionLifecycle(client.events, callback),
  }
}

let pending: Promise<SessionsPort> | undefined

export function sessionsPort(): Promise<SessionsPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}
