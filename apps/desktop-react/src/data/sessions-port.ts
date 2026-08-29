import type {
  GetSessionMessagesPageResponse,
  GetSessionUserMarkersResponse,
  GetSessionsListResponse,
} from '@shared/ipc/chat'
import type { GetSessionSegmentsResponse } from '@shared/ipc/toc'
import type { SessionEventEnvelope } from '@shared/events/envelope'
import type { SessionLifecycleEvent } from '@renderer/platform/session-lifecycle'

/**
 * 数据源与 `@renderer/platform` 之间的那一层**端口**。
 *
 * 它存在的唯一理由是可测:sessions-source 的全部判据(节流、增量 vs 重拉、缓存
 * 失效)都是纯逻辑,不该为了测它去起一台 core。真实现是下面那一个,
 * 测试用 `configureSessionsPort` 换成假的。
 *
 * 形状是**平台调用面的子集**,不是新契约:六个方法逐条对应
 * `sessionsApi.listMeta / getSegments / getMessagesPage / getUserMarkers`、
 * `platformApi.onSessionEvent` 与 `platform/session-lifecycle` 的
 * `onSessionLifecycle`,一个字段都没有多。
 */
export interface SessionsPort {
  /** 传输面就绪(D0 的 whenConnected);浏览器直开时它也会 resolve。 */
  ready(): Promise<unknown>
  listMeta(): Promise<GetSessionsListResponse>
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
 * 真实现是**惰性**建的:`@renderer/platform` 在模块顶层就会去摸 `window`,
 * 而端口被换掉的测试根本不该把它拖进来(单元测试不碰网,默认假端口装在
 * `src/test/setup.ts` 里)。
 *
 * vite build 会为此打一条 “dynamically imported … but also statically imported”
 * 的提示:`main.tsx` 静态引着 `platform/connection`,所以这条动态 import 换不来
 * 一个独立 chunk。**这是预期的** —— 它买的是测试隔离,不是分包。
 */
async function realPort(): Promise<SessionsPort> {
  const [{ platformApi }, { sessionsApi }, { onSessionLifecycle }, { whenConnected }] =
    await Promise.all([
      import('@renderer/platform'),
      import('@renderer/platform/sessions-client'),
      import('@renderer/platform/session-lifecycle'),
      import('../platform/connection'),
    ])
  return {
    ready: () => whenConnected(),
    listMeta: () => sessionsApi.listMeta({}),
    getSegments: (sessionId) => sessionsApi.getSegments({ sessionId }),
    // anchor:'tail' = 首页取**最新**那一页。QuickLook 要看的是「这条会话最近在聊
    // 什么」,不是它开头说了什么 —— 与会话列表按 updatedAt 倒序是同一个口径。
    getMessagesPage: (sessionId, limit) =>
      sessionsApi.getMessagesPage({ sessionId, limit, anchor: 'tail' }),
    getUserMarkers: (sessionId) => sessionsApi.getUserMarkers({ sessionId }),
    onSessionEvent: (callback) => platformApi.onSessionEvent(callback),
    onSessionLifecycle: (callback) => onSessionLifecycle(callback),
  }
}

let pending: Promise<SessionsPort> | undefined

export function sessionsPort(): Promise<SessionsPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}
