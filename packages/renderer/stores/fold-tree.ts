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
import { synthesizeToolAnchors } from '@/stores/helpers/content-parts'
import { linkStepsToToolCalls } from '@/stores/helpers/tool-calls'
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

/**
 * 尾巴里的一截:**同一种、连续到达**的文本。
 *
 * 分截的判据不是尾巴自己想出来的 —— 它与打包器开段的判据是同一条(`core` 的
 * `CoreAssistantPartBoundary`:同类连续的 delta 归同一段,换了种就是新的一段)。
 * 尾巴只是把"这一截还没打包"的那些字按到达顺序排好,依旧一个结构决策都不做。
 */
interface TailSegment {
  kind: 'text' | 'reasoning'
  text: string
}

interface Tail {
  messageId: string
  /** 按到达顺序的段(**只有文本**,段界来自流本身)。 */
  segments: TailSegment[]
  /** 顶部推理(渲染成 Thought 块;它落在 `message.reasoning`,**不是** part)。 */
  reasoningTop: string
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
  /**
   * 推理的**落点**,由流自己说(`session:stream` 的 reasoning-delta 带着它)。
   *
   * 这不是尾巴自己的结构决策:`top` / `inline` 是引擎在开这一段时就定下的事实
   * (`core/engine/agent-loop-executor.ts` 的 `getAgentLoopReasoningPlacement`,
   * 折叠侧的复刻在 `reducer.ts` 的 `topReasoningPartIndexes`),缺席时按手写侧
   * 逐字相同的那条兜底(`chat.ts:1565`:这条消息还没有正文 = top)。
   *
   * **少了它就是真机上那两条回归**:top 推理被当成行内推理挂进 contentParts,
   * 于是同一段思考既进 Thought 块又以正文渲染(症状 3),而且多出一个思考块
   * (症状 1)。
   */
  placement?: 'top' | 'inline',
  messageHasContent?: boolean,
): void {
  if (!messageId || !text) return
  const existing = tails.get(sessionId)
  const tail: Tail = existing?.messageId === messageId
    ? existing
    : { messageId, segments: [], reasoningTop: '' }
  if (kind === 'reasoning') {
    const resolved = placement ?? (messageHasContent ? 'inline' : 'top')
    if (resolved === 'top') {
      tail.reasoningTop += text
      tails.set(sessionId, tail)
      return
    }
  }
  const last = tail.segments[tail.segments.length - 1]
  if (last?.kind === kind) last.text += text
  else tail.segments.push({ kind, text })
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

/**
 * 尾巴接到**最后那一段**上。
 *
 * 两条纪律(真机回归换来的):
 *
 * 1. **只看最后一段,不回头找**。从前是"从尾往前找第一段同类的",于是一段新的
 *    行内推理会被追加进**上一个**推理块里(它前面隔着正文),屏幕上就成了
 *    "两个思考块 + 文字跑错块"(症状 1)。段的开合是账本的事,尾巴只延长
 *    **当前那一段**;当前那一段不是同类,就自己在末尾起一格显示用的。
 * 2. **顶部推理不进 contentParts**。它的落点是 `message.reasoning`(Thought 块),
 *    与手写侧逐字相同(`chat.ts:1566`)。从前一律当行内挂进 parts,于是同一段
 *    思考既进 Thought 块又以正文渲染(症状 3)。
 */
function appendTail(messages: ChatMessage[], tail: Tail | undefined): ChatMessage[] {
  if (!tail) return messages
  if (tail.segments.length === 0 && !tail.reasoningTop) return messages
  const index = messages.findIndex(message => message.id === tail.messageId)
  if (index < 0) return messages
  const message = messages[index]
  const parts = [...(message.contentParts ?? [])] as ContentPart[]

  // **只看最后一段**:第一截若与末段同类就延长它,否则自己起一格;后面每一截
  // 都是新的一段(段界来自流)。从前是"从尾往前找同类",于是一段新的行内推理
  // 会被追加进**上一个**推理块 —— 真机上那两个思考块就是这么来的。
  // 只有**第一截**可以延长账本那一段(它就是那一段还没打包的尾巴);其后每一截
  // 都是流上新的一段,各自起一格 —— 用一个局部标记表达,不留任何模块级状态。
  let extendedLedgerPart = false
  for (const segment of tail.segments) {
    if (!segment.text) continue
    const last = parts[parts.length - 1] as { type?: string; content?: string } | undefined
    if (!extendedLedgerPart && last?.type === segment.kind) {
      parts[parts.length - 1] = {
        ...(last as object),
        content: `${last.content ?? ''}${segment.text}`,
      } as ContentPart
    } else {
      // 账本还没开出这一段(第一条打包行之前):在**末尾**挂一格显示用的尾巴。
      // 它没有 turnIndex 之类的结构信息 —— 那些等账本说话。
      parts.push({ type: segment.kind, content: segment.text } as ContentPart)
    }
    extendedLedgerPart = true
  }

  const tailText = tail.segments
    .filter(segment => segment.kind === 'text')
    .map(segment => segment.text)
    .join('')

  const next = [...messages]
  next[index] = {
    ...message,
    content: `${message.content ?? ''}${tailText}`,
    ...(tail.reasoningTop
      ? { reasoning: `${message.reasoning ?? ''}${tail.reasoningTop}` }
      : {}),
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
  if (tail?.segments.length || tail?.reasoningTop) return messages
  const index = messages.findIndex(message => message.id === activeRun.messageId)
  if (index < 0) return messages
  const message = messages[index]
  const parts = (message.contentParts ?? []) as ContentPart[]
  // 已经有正文/推理/工具的那一格就不再显示"在等第一个字"。**顶部推理也算**
  // (它不在 parts 里,在 `message.reasoning` 上)—— 漏了它就会在思考已经开始
  // 的消息上再挂一个转圈。
  if (
    parts.length > 0
    || (message.content ?? '').length > 0
    || (message.reasoning ?? '').length > 0
  ) return messages
  const next = [...messages]
  next[index] = {
    ...message,
    contentParts: [...parts, { type: 'waiting' } as ContentPart],
  }
  return next
}

/**
 * **把折叠产物整理成"屏幕认得的那棵树"**。
 *
 * 折叠产物是**事实**,不是渲染形态。手写侧从盘上读回消息时走的是
 * `chat.ts` 的 `rebuildContentParts`,那里做了两件渲染层依赖的事;新路上没人做,
 * 于是真机上工具卡整片消失(症状 4):
 *
 * 1. **渲染锚点自合成**(`synthesizeCoreToolAnchors`,core 单实现):投影的
 *    `contentParts` 只有 text / reasoning —— 锚点是 canonical G4 明文丢掉的东西,
 *    所以**判据永远看不见这一格**(这也正是四只单测全绿而真机红的原因)。工具行、
 *    work-group 分界全靠它;没有锚点,消息上有 toolCalls 也一个工具卡都不画。
 * 2. **steps ↔ toolCalls 连线**:投影出来的两边是各自独立的对象,连线之后
 *    后续更新才在两个消费者上同时可见(与手写侧同一个函数)。
 *
 * 另加一格**单位换算**:`thinkingTime` 在投影里是**毫秒**
 * (`deriveThinkingTime` = 推理段首尾时刻差),而产品契约上这一格是**秒**
 * (`@shared/ipc/chat.ts:506`,手写侧写进去的也是秒)。真机上 15.7s 的思考显示成
 * "261:40" 就是这一格(症状 2)。canonical 把 `thinkingTime` 当派生量丢掉(G5),
 * 判据同样看不见 —— **更深处那个单位分歧另挂裁定**,这里先在边界上换算,
 * 让屏幕显示的是秒。
 */
function toRenderableMessage(message: ChatMessage): ChatMessage {
  if (message.role !== 'assistant') return message
  const linked = { ...message } as ChatMessage
  linkStepsToToolCalls(linked)
  const anchored = synthesizeToolAnchors(linked.contentParts ?? [], linked)
  if (anchored) linked.contentParts = anchored
  // **无条件换算**:走到这里的值只有一个来源 —— 折叠产物(毫秒)。手写侧那条路
  // 不经过这个函数,所以不存在"已经是秒了"的输入。从前加过一道 `>1000` 的保险,
  // 那反而让不足一秒的思考(真机上有 925ms 这一条)显示成 925 秒。
  if (typeof linked.thinkingTime === 'number' && Number.isFinite(linked.thinkingTime)) {
    linked.thinkingTime = linked.thinkingTime / 1000
  }
  return linked
}

/** 仅测试:把"折叠产物 → 可渲染形态"那一步单独拿出来钉。 */
export const toRenderableMessageForTest = toRenderableMessage

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
  // 顺序要紧:先把折叠产物整理成可渲染形态(锚点 / 连线 / 单位),再接尾巴、
  // 补等待、叠 overlay —— 尾巴与 overlay 加的是**显示用**的格子,不该再被
  // 锚点合成挪位置。
  const renderable = base.map(toRenderableMessage)
  return applyOverlay(sessionId, appendWaiting(sessionId, appendTail(renderable, tail), tail))
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
