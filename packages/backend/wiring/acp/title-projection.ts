/**
 * ACP 会话标题 → 本地会话名的投影(A2-b,方案 `docs/design/acp-integration-2026-09.md` §11.6)。
 *
 * agent 推 `session_info_update.title`(reducer 折进 `AcpSessionState.info.title`)。它是一种
 * **自动起的标题**,与引擎的标题模型同一档:人没显式改过名,就把会话名换成它;人改过
 * (`ChatSession.titleSource === 'user'`)就不动。缺席的 `titleSource` 当作 `'auto'`(零迁移,
 * 理由写在 `shared/ipc/chat.ts` 那一格上)。
 *
 * 写法走宿主递进来的 `rename` 端口:装配层接的是 `store.renameSession(id, title, 'auto')` +
 * 一条 `session:renamed` 会话事件(与引擎自动起题那一发同形,别的客户端跟着换名字)。
 * 同一个标题只处理一次(按会话记上一次见到的标题),agent 反复推同一句不会反复读会话。
 */
import type { AcpSessionState } from '@shared/contracts/acp'
import type { SessionTitleSource } from '@shared/ipc/chat.js'
import { getLogger } from '../logging/index.js'
import type { AcpSessionStateProjection } from './subsystem.js'

const log = getLogger('app.acp.title')

export interface AcpTitleProjectionPorts {
  /** 读本地会话的名字与标题来源;查无此会话 = undefined。 */
  getSession(sessionId: string): { name?: string; titleSource?: SessionTitleSource } | undefined
  /** 以「自动」来源改名并广播。 */
  rename(sessionId: string, title: string): void | Promise<void>
}

/** 人显式改过名的会话,自动起题的一方不覆盖。 */
export function isUserTitled(session: { titleSource?: SessionTitleSource }): boolean {
  return session.titleSource === 'user'
}

export class AcpTitleProjection implements AcpSessionStateProjection {
  readonly label = 'acpTitleProjection'
  private readonly lastTitle = new Map<string, string>()
  private disposed = false

  constructor(private readonly ports: AcpTitleProjectionPorts) {}

  observe(state: AcpSessionState): void {
    if (this.disposed) return
    const sessionId = state.localSessionId
    const title = state.info?.title?.replace(/\s+/g, ' ').trim()
    if (!title) {
      this.lastTitle.delete(sessionId)
      return
    }
    if (this.lastTitle.get(sessionId) === title) return
    this.lastTitle.set(sessionId, title)
    const session = this.ports.getSession(sessionId)
    if (!session || isUserTitled(session) || session.name === title) return
    Promise.resolve(this.ports.rename(sessionId, title))
      .catch(error => log.warn('acp title projection failed', { sessionId }, error))
  }

  dispose(): void {
    this.disposed = true
  }
}
