import type { PresentedResource } from '@shared/events/index.js'
import { getLogger } from '../wiring/logging/index.js'

/**
 * **呈现的入口**(09-18,正本 `apps/desktop-react/docs/composer-open-dir-mentions-2026-09.md` §2.5.0)。
 *
 * 发送命令上的 `presented` 说的是一件事实:「用户这一轮把这些资源摆在了助手面前」(引用了它,
 * 或它此刻在工作台里开着)。这只文件是这件事实**在后端唯一的落脚处**:
 *
 *  1. `takePresented` —— 从命令上**摘下来**并校验信封(形状 / 条数 / 去重)。摘掉是有意的:
 *     事实只在入口被读,不进总线、不落账 —— 没有读者的字段落进账本就是第二真相。
 *  2. `deliverPresentation` —— 交给此刻登记的每一位处理者,**等它们做完**再让命令进总线
 *     (将来的鉴权处理者要在这一轮第一次工具调用之前把授权落好)。
 *
 * ── 为什么今天一个处理者都没有 ──────────────────────────────────────────────
 * 用户 09-18 裁定「先不做鉴权,但留好入口」。所以这里只立**入口**:处理者表是空的,
 * `presented` 经过校验就被丢弃,行为与没有这一格时逐字相同。将来接鉴权 = 登记一位处理者
 * (正本 §2.5.2 的 `PresentationGrantIssuer`),本文件、命令契约、壳与 RPC 域的调用点一行不改。
 *
 * ── 这只文件不认识任何资源 ────────────────────────────────────────────────────
 * 没有 scheme、没有效果类、没有「目录」这个词。它只知道「一条呈现长什么样」。
 *
 * ── 状态 ────────────────────────────────────────────────────────────────────
 * 处理者表是一只 `const` 集合,登记交回一只退役函数 —— 装配处 `backend.own()` 它,
 * `dispose()` 时退役(与 `registerPromptFragment` 同一体例)。模块本身零副作用。
 */

const log = getLogger('session.presentation')

/** 一次呈现最多几条。超出的截掉 —— 那不是一个人一轮能摆出来的量,多半是发送方出了错。 */
export const PRESENTED_MAX = 32

/** 处理者收到的现场。**身份由宿主铸**,不从命令上读(RPC 通则)。 */
export interface PresentationContext {
  sessionId: string
  /** 这条用户消息预铸的 id(发送方给了才有)。 */
  messageId?: string
  /**
   * 发起这次发送的宿主是不是本机可信(`isHostLocallyTrusted()` 那一句)。**「信不信」只看这一格** ——
   * 不给传输种类:域里按 `context.transport` 分叉是 `transport:gate` 禁的那一类(路线 B)。
   */
  locallyTrusted: boolean
}

export interface PresentationHandler {
  /** 给处理者起的名字,只进日志。 */
  readonly id: string
  onPresented(presented: readonly PresentedResource[], ctx: PresentationContext): void | Promise<void>
}

const handlers = new Set<PresentationHandler>()

/** 登记一位处理者。交回的函数退役它(幂等)。 */
export function registerPresentationHandler(handler: PresentationHandler): () => void {
  handlers.add(handler)
  return () => {
    handlers.delete(handler)
  }
}

/** 此刻登记了几位(给测试与诊断)。 */
export function presentationHandlerCount(): number {
  return handlers.size
}

/**
 * 信封校验:只留形状对的(`uri` 非空字符串、`via` 是两个词之一),按 `uri + via` 去重,
 * 截到 `PRESENTED_MAX` 条。认不出的条目静默丢掉 —— 它们是事实的噪声,不是错误。
 */
export function normalizePresented(raw: unknown): PresentedResource[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const output: PresentedResource[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const { uri, via } = item as Record<string, unknown>
    if (typeof uri !== 'string' || uri.trim() === '') continue
    if (via !== 'open' && via !== 'reference') continue
    const key = `${via}:${uri}` // via 里没有冒号,所以这一拼不会串
    if (seen.has(key)) continue
    seen.add(key)
    output.push({ uri, via })
    if (output.length >= PRESENTED_MAX) break
  }
  return output
}

/**
 * 从一条命令上摘下 `presented`。交回**不带这一格**的命令与校验过的事实;
 * 命令上本来就没有这一格时原样交回同一个对象(不白造一份拷贝)。
 */
export function takePresented<T>(command: T): { command: T; presented: PresentedResource[] } {
  if (!command || typeof command !== 'object' || !('presented' in command)) {
    return { command, presented: [] }
  }
  const { presented, ...rest } = command as Record<string, unknown>
  return { command: rest as T, presented: normalizePresented(presented) }
}

/**
 * 交给每一位处理者。一位失败只记一行日志,**不挡发送** —— 呈现是这一轮的附带事实,
 * 它出错不该让用户的消息发不出去。
 */
export async function deliverPresentation(
  presented: readonly PresentedResource[],
  ctx: PresentationContext,
): Promise<void> {
  if (presented.length === 0 || handlers.size === 0) return
  for (const handler of [...handlers]) {
    try {
      await handler.onPresented(presented, ctx)
    } catch (error) {
      log.warn('presentation handler failed', { handler: handler.id, sessionId: ctx.sessionId }, error)
    }
  }
}
