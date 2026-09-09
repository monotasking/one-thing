/**
 * K1 —— 会话这一 scheme 的实现(`docs/design/atom-2026-09.md` §3 那张表的
 * `session:` 三行)。
 *
 * 自述在产品层(`@onething/runtime/sessions/resource-spec`),实现在这里 —— 因为
 * 只有装配层够得着脊柱:读走 `sessionReads`(返回 readonly 的唯一读面),做走
 * `sessionCommands.patchSession`(会话级字段的唯一写面,P0 立的规矩)。
 *
 * ── 它没有第二条路 ─────────────────────────────────────────────────────────
 * 「重命名一条会话」在今天还有 `store.renameSession` 这个门牌(仓库层直调)。这里
 * **不**用它:`patchSession` 是命令面那扇门,它按 `meta` 档写盘、盖 index、发
 * `session/patched` 事件;绕过它就是在会话写面旁边开第二个洞,而 `session:gate`
 * 是硬闸正是为了不让那种洞长出来。这一条同时是 §2 不变量 2 在**实现**这一侧的
 * 兑现:资源的做法不是新写一遍逻辑,是给既有的那一条命令面挂一个地址。
 *
 * ── 露面规则 ────────────────────────────────────────────────────────────────
 * 资源工具进不进工具目录、在哪种场子露面归 K3,本单不注册。
 */

import type {
  ResourceProvider,
  ResourceReadContext,
  ResourceEventHub,
} from '@onething/core/resource'
import { planFromSpec } from '@onething/core/resource'
import type { ResourceRef } from '@onething/core/resource'
import type { Intent, PlanContext, Result, RunContext } from '@onething/core/toolkit'
import { textResult } from '@onething/core/toolkit'
import { sessionResourceSpec } from '@onething/runtime/sessions/resource-spec'
import { sessionCommands } from '../../session/commands.js'
import { sessionReads } from '../../session/reads.js'

/** 这条会话不在。读与做都用它 —— 「不存在」是一句事实,不是一次降级。 */
export class SessionNotFoundError extends Error {
  readonly sessionId: string

  constructor(sessionId: string) {
    super(`No such session: ${sessionId}`)
    this.name = 'SessionNotFoundError'
    this.sessionId = sessionId
  }
}

/** 地址缺席时的那句话。会话的每一条读法与做法都作用在**一条**会话上。 */
export class SessionRefRequiredError extends Error {
  constructor(member: string) {
    super(`${member} needs a session address, e.g. "session:<id>"`)
    this.name = 'SessionRefRequiredError'
  }
}

/** `plan` 交给 `apply` 的载荷:已经解析好的目标与参数。 */
export type SessionOpPayload =
  | { readonly op: 'rename'; readonly sessionId: string; readonly title: string }
  | { readonly op: 'setWorkingDirectory'; readonly sessionId: string; readonly path: string }

const DEFAULT_MESSAGE_PAGE = 20
const PREVIEW_LIMIT = 120

function requireSessionId(ref: ResourceRef | null, member: string): string {
  if (!ref || !ref.path) throw new SessionRefRequiredError(member)
  return ref.path
}

function stringParam(params: unknown, key: string, member: string): string {
  const value = params && typeof params === 'object' ? (params as Record<string, unknown>)[key] : undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${member} needs a non-empty ${key}`)
  }
  return value
}

/** 一条消息的一行预览。与列表投影那一格同一个口径:折成一行、砍到 120 字。 */
function previewOf(content: string): string {
  const collapsed = content.replace(/\s+/g, ' ').trim()
  return collapsed.length > PREVIEW_LIMIT ? `${collapsed.slice(0, PREVIEW_LIMIT)}…` : collapsed
}

export class SessionResourceProvider implements ResourceProvider<SessionOpPayload> {
  readonly spec = sessionResourceSpec

  private hub: ResourceEventHub | undefined

  attach(hub: ResourceEventHub): void {
    this.hub = hub
  }

  async read(name: string, ref: ResourceRef | null, query: unknown, _ctx: ResourceReadContext): Promise<unknown> {
    const sessionId = requireSessionId(ref, name)
    switch (name) {
      case 'get':
        return this.summary(sessionId)
      case 'messages':
        return this.messages(sessionId, query)
      default:
        // 走不到:`ResourceTool` 只在自述里有这条读法时才调进来。留一句诚实的错,
        // 而不是返回 `undefined` 让调用方去猜「这条会话是空的还是这条读法不存在」。
        throw new TypeError(`Session resource has no read named ${JSON.stringify(name)}`)
    }
  }

  async plan(
    op: string,
    ref: ResourceRef | null,
    params: unknown,
    _ctx: PlanContext,
  ): Promise<Intent<SessionOpPayload>> {
    const sessionId = requireSessionId(ref, op)
    // 存在性在 plan 期就判:一次注定改不动的做法不该走到 apply 才发现目标不在
    // (而且 `patchSession` 对不存在的会话只是返回 false —— 那读起来像「没变化」)。
    if (!sessionReads.hasSessionInStore(sessionId)) throw new SessionNotFoundError(sessionId)

    switch (op) {
      case 'rename': {
        const title = stringParam(params, 'title', op)
        return planFromSpec<SessionOpPayload>(this.spec, op, ref, { op, sessionId, title }, {
          title: `Rename session to ${title}`,
        })
      }
      case 'setWorkingDirectory': {
        const path = stringParam(params, 'path', op)
        return planFromSpec<SessionOpPayload>(this.spec, op, ref, { op, sessionId, path }, {
          title: `Point session at ${path}`,
        })
      }
      default:
        throw new TypeError(`Session resource has no op named ${JSON.stringify(op)}`)
    }
  }

  async apply(op: string, intent: Intent<SessionOpPayload>, _ctx: RunContext): Promise<Result> {
    const payload = intent.payload
    switch (payload.op) {
      case 'rename': {
        const applied = sessionCommands.patchSession(payload.sessionId, {
          patch: { name: payload.title },
          // 列表索引是只读投影,盖章漏了列表就与会话体不一致(`PatchSessionPayload`
          // 那一格的注释说的就是这件事)。
          mutateIndexMeta: meta => {
            meta.name = payload.title
          },
        })
        if (!applied) throw new SessionNotFoundError(payload.sessionId)
        this.emit(payload.sessionId, 'renamed', { title: payload.title })
        return textResult(`Renamed session to ${payload.title}`)
      }
      case 'setWorkingDirectory': {
        const applied = sessionCommands.patchSession(payload.sessionId, {
          patch: { workingDirectory: payload.path },
          mutateIndexMeta: meta => {
            meta.workingDirectory = payload.path
          },
        })
        if (!applied) throw new SessionNotFoundError(payload.sessionId)
        this.emit(payload.sessionId, 'workingDirectoryChanged', { path: payload.path })
        return textResult(`Session now works in ${payload.path}`)
      }
      default:
        // 类型上到不了(payload 是判别联合),运行时留一句 —— `apply` 是公开方法。
        throw new TypeError(`Session resource has no op named ${JSON.stringify(op)}`)
    }
  }

  private emit(sessionId: string, event: string, payload: unknown): void {
    this.hub?.emit({ scheme: this.spec.scheme, path: sessionId }, event, payload)
  }

  private summary(sessionId: string): unknown {
    const session = sessionReads.getSession(sessionId)
    if (!session) throw new SessionNotFoundError(sessionId)
    return {
      id: session.id,
      title: session.name,
      ...(session.workingDirectory ? { workingDirectory: session.workingDirectory } : {}),
      createdAt: session.createdAt,
      messageCount: sessionReads.countMessages(sessionId),
    }
  }

  private messages(sessionId: string, query: unknown): unknown {
    if (!sessionReads.hasSessionInStore(sessionId)) throw new SessionNotFoundError(sessionId)
    const options = (query ?? {}) as { limit?: unknown; before?: unknown }
    const limit = typeof options.limit === 'number' && options.limit > 0 ? Math.floor(options.limit) : DEFAULT_MESSAGE_PAGE
    const all = sessionReads.listMessages(sessionId).messages

    // `before` 是「这一页结束在那条消息之前」。找不到那条 id 时**不静默退回末页**:
    // 那会让翻页的人以为自己回到了开头。
    let end = all.length
    if (typeof options.before === 'string') {
      const at = all.findIndex(message => message.id === options.before)
      if (at < 0) throw new TypeError(`No such message in this session: ${options.before}`)
      end = at
    }

    return all.slice(Math.max(0, end - limit), end).map(message => ({
      id: message.id,
      role: message.role,
      preview: previewOf(message.content ?? ''),
      createdAt: message.timestamp,
    }))
  }
}
