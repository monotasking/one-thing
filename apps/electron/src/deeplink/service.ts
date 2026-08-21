/**
 * 深链的**确认门**(H4,Electron 宿主)。
 *
 * 一条 URL 到这里之后走的路,一条都不能少:
 *
 *   解析 → 形状非法 = 静默丢弃 + 一行日志
 *        → 合法 / 可见拒绝 = 聚焦主窗 → 推一张确认卡 → 等用户
 *   用户取消 = 什么也不发生(条目删掉,插件永远不知道有过这一次)
 *   用户确认 = ask 交回渲染层照普通消息发;插件动作交给装配层的派发口
 *
 * 三条纪律:
 *
 *  1. **确认门没有旁路**。派发口只从 `respondDeepLink` 走,而它只认 pending 表
 *     里的 requestId —— 没有"内部直接调用"的第二条路。这是"每次必弹"这条拍板
 *     在代码里的执行点,不是一句约定。
 *  2. **弹窗权不外包**。形状非法一律哑掉(见 buildDeepLinkCard 的 null),否则
 *     任何一个网页都能拿 `onething://%%%` 让用户被弹一次。
 *  3. **pending 有上限、有时效**。一张没人答的卡不该永远占着内存,更不该在半
 *     小时后被误答 —— 用户早忘了那条链接是干什么的。
 */
import { randomUUID } from 'node:crypto'
import type {
  DeepLinkConfirmRequest,
  DeepLinkRespondRequest,
  DeepLinkRespondResponse,
} from '@shared/ipc/deeplink.js'
import { IPC_CHANNELS } from '@shared/ipc.js'
import { parseDeepLink, type DeepLinkIntent } from '@onething/core/plugins/deep-link'
import {
  buildDeepLinkCard,
  invokePluginDeepLinkAction,
} from '@onething/backend/wiring/deeplink/index.js'

/** 同时最多压几张未答的卡。超出丢最旧。 */
export const DEEPLINK_PENDING_MAX = 5

/** 一张卡的时效。过期之后答它 = 拒绝(用户早忘了那条链接是什么)。 */
export const DEEPLINK_PENDING_TTL_MS = 5 * 60_000

interface WindowLike {
  isDestroyed(): boolean
  webContents: { send(channel: string, payload: unknown): void }
}

export interface DeepLinkServiceDeps {
  getMainWindow(): WindowLike | null | undefined
  /** 把主窗拉到前面来。确认卡必须在用户眼前,不能在别的桌面上。 */
  activateMainWindow(window: WindowLike | null | undefined): boolean
  logger?: Pick<Console, 'log' | 'warn'>
  now?(): number
}

interface PendingDeepLink {
  requestId: string
  intent: DeepLinkIntent | null
  createdAt: number
}

let deps: DeepLinkServiceDeps | null = null
const pending = new Map<string, PendingDeepLink>()

export function configureDeepLinkService(next: DeepLinkServiceDeps): void {
  deps = next
}

/** 测试专用。 */
export function resetDeepLinkServiceForTests(): void {
  deps = null
  pending.clear()
}

/** 诊断用:现在有几张卡还没人答。 */
export function pendingDeepLinkRequestCount(): number {
  return pending.size
}

function logger(): Pick<Console, 'log' | 'warn'> {
  return deps?.logger ?? console
}

function now(): number {
  return deps?.now?.() ?? Date.now()
}

/**
 * 一条深链到了。
 *
 * 返回值是给测试与诊断看的:`'delivered'` = 卡推出去了,`'dropped'` = 静默丢弃,
 * `'no-window'` = 没窗口可推(窗口还没建好的极早期;队列本该挡住这种情况)。
 */
export function handleIncomingDeepLink(url: string): 'delivered' | 'dropped' | 'no-window' {
  const parsed = parseDeepLink(url)
  const card = buildDeepLinkCard(parsed)
  if (!card) {
    // 唯一的一行日志。**不弹窗** —— 见文件头第 2 条。
    const reason = parsed.ok ? 'unknown' : parsed.reason
    logger().warn(`[DeepLink] Dropped (${reason}): ${String(url).slice(0, 120)}`)
    return 'dropped'
  }

  const window = deps?.getMainWindow?.() ?? null
  if (!window || window.isDestroyed()) {
    logger().warn('[DeepLink] No main window to show the confirmation on; dropped')
    return 'no-window'
  }
  // 先聚焦再推卡:卡在一扇看不见的窗上等于没弹。
  try {
    deps?.activateMainWindow(window)
  } catch (error) {
    logger().warn(`[DeepLink] Failed to focus the main window: ${String(error)}`)
  }

  const requestId = randomUUID()
  // 拒绝卡没有"确认"可按,所以它不进 pending —— 一条永远不会被派发的条目留着
  // 只是给自己攒一份可以被误答的状态。
  if (card.kind !== 'rejected') {
    prunePending()
    pending.set(requestId, {
      requestId,
      intent: parsed.ok ? parsed.intent : null,
      createdAt: now(),
    })
  }

  const request: DeepLinkConfirmRequest = { requestId, card }
  window.webContents.send(IPC_CHANNELS.DEEPLINK_REQUEST, request)
  logger().log(`[DeepLink] Confirmation requested (${card.kind}) — ${requestId}`)
  return 'delivered'
}

function prunePending(): void {
  const cutoff = now() - DEEPLINK_PENDING_TTL_MS
  for (const [id, entry] of pending) {
    if (entry.createdAt < cutoff) pending.delete(id)
  }
  // 插入之前先给新来的腾位:超出上限丢最旧(Map 保插入序)。
  while (pending.size >= DEEPLINK_PENDING_MAX) {
    const oldest = pending.keys().next().value
    if (oldest === undefined) break
    pending.delete(oldest)
  }
}

/**
 * 用户按了钮。
 *
 * **这是派发的唯一入口。** 没有它,任何 intent 都不会被执行 —— 确认门的强度
 * 就等于这句话的强度。
 */
export async function respondToDeepLink(
  request: DeepLinkRespondRequest,
): Promise<DeepLinkRespondResponse> {
  const requestId = String(request?.requestId ?? '')
  const entry = pending.get(requestId)
  if (!entry) {
    // 过期 / 重复回答 / 伪造的 id 走同一条路:不派发,说得清地失败。
    return { success: false, error: 'unknown or expired deep link request' }
  }
  pending.delete(requestId)

  if (!request.approved) {
    logger().log(`[DeepLink] Cancelled by the user — ${requestId}`)
    return { success: true, dispatched: false }
  }
  if (!entry.intent) {
    return { success: false, error: 'nothing to dispatch' }
  }

  if (entry.intent.kind === 'ask') {
    // 渲染层来跑:它既要建会话又要**打开**它。见 DeepLinkRespondResponse 的注释。
    logger().log(`[DeepLink] Approved (ask) — ${requestId}`)
    return {
      success: true,
      dispatched: true,
      ask: entry.intent.agentId
        ? { text: entry.intent.text, agentId: entry.intent.agentId }
        : { text: entry.intent.text },
    }
  }

  const { pluginId, action, text, params } = entry.intent
  const outcome = await invokePluginDeepLinkAction(pluginId, action, { text, params })
  if (!outcome.ok) {
    logger().warn(`[DeepLink] Plugin action failed (${outcome.reason}) — ${pluginId}/${action}: ${outcome.detail}`)
    return { success: false, dispatched: true, error: outcome.detail }
  }
  logger().log(`[DeepLink] Approved (plugin) — ${pluginId}/${action}`)
  return outcome.notice
    ? { success: true, dispatched: true, notice: outcome.notice }
    : { success: true, dispatched: true }
}
