/**
 * **屏幕上的消息树 = 折叠产物 + 活尾巴 + overlay**(U2-a,§17.8.7)。
 *
 * ## 三条来源,各管一段
 *
 * | 来源 | 管什么 | 词汇 |
 * |---|---|---|
 * | **fold**(账本折叠) | 全部结构与已结算事实:身份、顺序、part 结构、tools/steps、usage、turnContext… | `SessionLogEventRecord` |
 * | **活尾巴** | **当前那一段还没被打包行刷出来的文本** | `session:stream` 的 delta |
 * | **overlay** | 按定义进不了账本的两类:本地错误卡、占位型瞬态 | `stores/session-overlays.ts` |
 *
 * ## 活尾巴为什么不是"第十一项手写派生"
 *
 * 判据是**它不做任何结构决策**:开段/闭段/这段属于哪条消息,全部听 fold 与账本
 * 词汇 —— 尾巴只是"这条消息最后那段文本的、还没进打包行的那一截",一个纯文本
 * 追加缓冲。打包行(`assistant/chunks`)一到,尾巴**整段丢掉**,由账本那份接管:
 * 两者逐字节相同,依据是 F4-c c2 的编解码器合同 `decode∘encode ≡ id`
 * (`core/session/events/chunk-codec.ts`,全库 212 万 delta 0 差),所以换装在
 * 屏幕上不可见。
 *
 * 为什么必须有它:打包器有两个出口 —— UI 流(每条 delta 立刻)与打包行
 * (**段收尾 / 64 条 / 2000ms 三者先到**,`SESSION_CHUNK_BATCH_INTERVAL_MS`)。
 * 只读打包行的话,打字上屏会从 ~16ms 掉到最坏 2s 一蹦。尾巴补的正是这一段差,
 * 而不是补"折叠器算不出来的东西"。
 *
 * ## 开关(迁移期临时物)
 *
 * `localStorage['onething.uiFoldTree'] = 'off'` 回旧路(刷新生效),
 * 或控制台 `window.__onethingUiFoldTree.disable()`。双端一致,不进设置页
 * (设置极简判例),不走 preload。U2-b 删旧路时这个开关一起死。
 */

import { getLogger } from '@/services/log'
import {
  getUiRefoldActiveRun,
  getUiRefoldLiveMessages,
  hasUiRefoldLiveFold,
} from '@/stores/ui-refold'
import { getSessionOverlay } from '@/stores/session-overlays'
import type { ChatMessage, ContentPart } from '@/types'

const log = getLogger('renderer.fold-tree')

const STORAGE_KEY = 'onething.uiFoldTree'

/**
 * 现场/测试覆盖值挂在 **globalThis** 上而不是模块变量里。
 *
 * 理由是测试:`vi.resetModules()` 会给每个用例换一份新模块实例,模块变量里的
 * 开关当场归零 —— 那样"旧路用例"就得记住"必须在 resetModules 之后按开关",
 * 一个必然会被忘掉的仪式。挂在 global 上,`beforeEach` 里按一次就够。
 */
const OVERRIDE_KEY = '__onethingFoldTreeOverride'

function readOverride(): boolean | undefined {
  return (globalThis as Record<string, unknown>)[OVERRIDE_KEY] as boolean | undefined
}

/** 默认**开**(清障已齐)。localStorage 的 `'off'` 或现场把手可以关掉。 */
export function isFoldTreeEnabled(): boolean {
  const overrideEnabled = readOverride()
  if (overrideEnabled !== undefined) return overrideEnabled
  try {
    if (globalThis.localStorage?.getItem(STORAGE_KEY) === 'off') return false
  } catch {
    // 隐私模式 / storage 被禁:当没设置过。
  }
  return true
}

/** 仅测试与现场把手。 */
export function setFoldTreeEnabled(enabled: boolean | undefined): void {
  if (enabled === undefined) delete (globalThis as Record<string, unknown>)[OVERRIDE_KEY]
  else (globalThis as Record<string, unknown>)[OVERRIDE_KEY] = enabled
}

/** 装现场把手:`window.__onethingUiFoldTree.disable()` / `.enable()` / `.status()`。 */
export function installFoldTreeHandle(): void {
  try {
    ;(globalThis as { __onethingUiFoldTree?: unknown }).__onethingUiFoldTree = {
      status: () => ({ enabled: isFoldTreeEnabled(), sessions: tails.size }),
      disable: () => {
        try {
          globalThis.localStorage?.setItem(STORAGE_KEY, 'off')
        } catch { /* ignore */ }
        setFoldTreeEnabled(false)
        return 'fold tree off — 刷新页面回旧路'
      },
      enable: () => {
        try {
          globalThis.localStorage?.removeItem(STORAGE_KEY)
        } catch { /* ignore */ }
        setFoldTreeEnabled(undefined)
        return 'fold tree on'
      },
    }
  } catch {
    // 把手装不上不影响树本身。
  }
}

// ============ 活尾巴 ============

interface Tail {
  messageId: string
  /** 纯文本追加缓冲 —— **只有文本,没有结构**。 */
  text: string
  reasoning: string
}

const tails = new Map<string, Tail>()

/**
 * 一条 delta 进尾巴。**只追加文本**:段是谁开的、属于哪条消息,由 fold 说了算 ——
 * 这里只认 `messageId`(流自己盖的号),换了消息就换一条尾巴。
 */
export function feedFoldTail(
  sessionId: string,
  messageId: string,
  kind: 'text' | 'reasoning',
  text: string,
): void {
  if (!messageId || !text) return
  const existing = tails.get(sessionId)
  const tail = existing?.messageId === messageId
    ? existing
    : { messageId, text: '', reasoning: '' }
  if (kind === 'text') tail.text += text
  else tail.reasoning += text
  tails.set(sessionId, tail)
}

/**
 * 打包行到了 / 这一轮收尾了 —— 尾巴整段丢掉,由账本那份接管。
 *
 * 丢的时机是**每一条账本行**:打包行一到,它装的那几条 delta 已经在 fold 里了;
 * 尾巴里可能还剩着更后面的几条,所以丢掉之后由后续 delta 重新攒。这条"丢了重攒"
 * 的代价是一帧内可能少几个字,而错误的另一半(不丢)是**重影**——同一段文字出现
 * 两遍。宁可少一帧,不要重影。
 */
export function clearFoldTail(sessionId: string): void {
  tails.delete(sessionId)
}

// ============ 组合 ============

/** 尾巴接在最后一段 `text` / `reasoning` part 上;没有那一段就自己不显示。 */
function appendTail(messages: ChatMessage[], tail: Tail | undefined): ChatMessage[] {
  if (!tail || (!tail.text && !tail.reasoning)) return messages
  const index = messages.findIndex(message => message.id === tail.messageId)
  if (index < 0) return messages
  const message = messages[index]
  const parts = [...(message.contentParts ?? [])] as ContentPart[]

  const appendTo = (kind: 'text' | 'reasoning', text: string): void => {
    if (!text) return
    for (let at = parts.length - 1; at >= 0; at--) {
      const part = parts[at] as { type?: string; content?: string }
      if (part?.type !== kind) continue
      parts[at] = { ...(part as object), content: `${part.content ?? ''}${text}` } as ContentPart
      return
    }
    // 账本还没开出这一段(第一条打包行之前):挂一格**显示用**的尾巴。它没有
    // turnIndex 之类的结构信息 —— 那些等账本说话。
    parts.push({ type: kind, content: text } as ContentPart)
  }

  appendTo('text', tail.text)
  appendTo('reasoning', tail.reasoning)

  const next = [...messages]
  next[index] = {
    ...message,
    content: `${message.content ?? ''}${tail.text}`,
    contentParts: parts,
  }
  return next
}

/**
 * **等待指示由 run 态派生**(U2-a 裁定):`run` 还活着、尾巴是空的、这条消息上
 * 也还没有任何正文 —— 那就是"在等第一个字"。
 *
 * 从前它是流里推来的一格瞬态 part(`content_part: waiting`),插进数组再在收尾
 * 扫掉;瞬态归 overlay 车道之后,新路上不再有人往树里插它,于是这一格改成**算**
 * 出来的:输入是账本的 run 态,不是第二条推送。
 */
function appendWaiting(
  sessionId: string,
  messages: ChatMessage[],
  tail: Tail | undefined,
): ChatMessage[] {
  const activeRun = getUiRefoldActiveRun(sessionId)
  if (!activeRun) return messages
  if (tail?.text || tail?.reasoning) return messages
  const index = messages.findIndex(message => message.id === activeRun.messageId)
  if (index < 0) return messages
  const message = messages[index]
  const parts = (message.contentParts ?? []) as ContentPart[]
  // 已经有正文/推理/工具的那一格就不再显示"在等第一个字"。
  if (parts.length > 0 || (message.content ?? '').length > 0) return messages
  const next = [...messages]
  next[index] = {
    ...message,
    contentParts: [...parts, { type: 'waiting' } as ContentPart],
  }
  return next
}

/** overlay:瞬态挂到对应消息的尾部,本地卡挂在整棵树末尾。 */
function applyOverlay(sessionId: string, messages: ChatMessage[]): ChatMessage[] {
  const overlay = getSessionOverlay(sessionId)
  if (!overlay.transientParts.length && !overlay.localMessages.length) return messages

  let next = messages
  if (overlay.transientParts.length) {
    next = next.map(message => {
      const mine = overlay.transientParts.filter(entry => entry.messageId === message.id)
      if (!mine.length) return message
      return {
        ...message,
        contentParts: [...(message.contentParts ?? []), ...mine.map(entry => entry.part)],
      }
    })
  }
  if (overlay.localMessages.length) {
    next = [...next, ...overlay.localMessages.map(entry => entry.message)]
  }
  return next
}

/**
 * 屏幕上该显示的那棵树。
 *
 * 没有活折(会话还没起底)时返回 `undefined` —— 调用方**不要**因此把屏幕清空,
 * 保持上一份即可(起底是异步的,见 `ensureUiRefoldLiveFold`)。
 */
export function composeFoldTree(sessionId: string): ChatMessage[] | undefined {
  if (!hasUiRefoldLiveFold(sessionId)) return undefined
  const base = getUiRefoldLiveMessages(sessionId)
  if (!base) return undefined
  const tail = tails.get(sessionId)
  return applyOverlay(sessionId, appendWaiting(sessionId, appendTail(base, tail), tail))
}

// ============ 推送 ============

type Applier = (sessionId: string, messages: ChatMessage[]) => void

let applier: Applier | undefined
const scheduled = new Set<string>()

/** chatStore 在初始化时把"写树"的口交进来(渲染层唯一的写点)。 */
export function installFoldTreeApplier(next: Applier | undefined): void {
  applier = next
}

const raf: (fn: () => void) => void =
  typeof globalThis.requestAnimationFrame === 'function'
    ? fn => { globalThis.requestAnimationFrame(() => fn()) }
    : fn => { setTimeout(fn, 0) }

/**
 * 安排一次推送。**按帧合并**:一帧之内来多少条 delta / 账本行,只组合一次树。
 *
 * 这就是"打字上屏节拍"的那一拍 —— 与旧路的 16ms 合批同量级(推送侧本来就已经
 * 16ms 合过一次批了,这里再按帧合一次)。
 */
export function scheduleFoldTreePush(sessionId: string): void {
  if (!isFoldTreeEnabled() || !applier || scheduled.has(sessionId)) return
  scheduled.add(sessionId)
  raf(() => {
    scheduled.delete(sessionId)
    try {
      const messages = composeFoldTree(sessionId)
      if (messages) applier?.(sessionId, messages)
    } catch (error) {
      log.debug('fold tree push failed', { sessionId }, error)
    }
  })
}

/**
 * **马上**组合并推一次(不等下一帧)。
 *
 * 门在收尾那一刻要比"屏幕 ≡ 耐久账本",而屏幕是按帧推的 —— 不强推一次的话,
 * 比到的是"上一帧的屏幕"对"此刻的文件",差的那几格(最后一条 `request/response`
 * 的 usage、`run/end` 之后的 `isStreaming`)会被记成失配,而它其实只是**一帧的
 * 时差**。
 */
export function flushFoldTreePush(sessionId: string): void {
  if (!isFoldTreeEnabled() || !applier) return
  try {
    const messages = composeFoldTree(sessionId)
    if (messages) applier(sessionId, messages)
  } catch (error) {
    log.debug('fold tree flush failed', { sessionId }, error)
  }
}

/** 仅测试:忘掉尾巴与排队。 */
export function resetFoldTree(): void {
  tails.clear()
  scheduled.clear()
  setFoldTreeEnabled(undefined)
}
