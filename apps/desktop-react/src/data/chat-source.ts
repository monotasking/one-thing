import { create } from 'zustand'
import {
  createSessionProjectionState,
  reduceSessionProjection,
} from '@onething/core/session/projection/reducer'
import { materializeChatMessages } from '@onething/core/session/projection/chat-messages'
import { SESSION_EVENT_TYPES } from '@shared/events/session-events'
import type { SessionEventEnvelope } from '@shared/events/envelope'
import type { SessionStreamPayload } from '@renderer/platform/types'
import {
  appendTail,
  feedTail,
  reconcileOverlay,
  userMessageIds,
  type OverlayEntry,
  type ProjectedMessage,
  type Tail,
} from './chat-fold'
import { chatPort } from './chat-port'
import { notify } from '../services/notify'
import { t } from '../i18n'

/**
 * 聊天区的**真数据源**(D3,路线 A)。全应用一个,聊天面只从这里取。
 *
 * ── 一句话 ────────────────────────────────────────────────────────────
 * **屏幕上那棵树 = core 折叠器的输出 + 活尾巴 + overlay**。React 侧零拼装:
 * 这个文件里没有任何一处"从事件推导消息结构"的代码 —— 结构全部来自
 * `reduceSessionProjection`(与主进程、与 Vue 壳跑的是**同一台**归约器)。
 *
 * ── 取数与增量(与 Vue 壳 `stores/ui-refold.ts` 逐条同判例)─────────────
 *  1. **起底**:进会话拉一次 `listRaw`(全集原词汇)整份折;
 *  2. **增量**:账本活事件(`session:ledger-event`)一条一条喂 —— `seq` 接得上
 *     就当场折进去,零拷贝零节流(账本行本身就是打包过的,不需要第二套合批);
 *  3. **缺号 / 中途入场**:**不补拼**(无快照裁定),整会话经 `listRaw` 重折,
 *     窗口内合并成一次(`REFOLD_THROTTLE_MS`)。SSE 自带 Last-Event-ID 自动重连,
 *     断线补发的那几条会先到、缺号那条会触发重折 —— 两条路殊途同归。
 *
 * ── 打包行的 decode 在哪 ───────────────────────────────────────────────
 * **在归约器里**(`reducer.ts` 的 `case 'assistant/chunks'` 经
 * `core/session/events/chunk-codec.ts` 展开)。消费侧因此不需要自己 decode ——
 * 把账本行原样喂进去就是了。这也是"打包是压缩,不是语义"那条定律的落点:
 * 展开这件事只在一处发生。
 *
 * ── 节拍 ──────────────────────────────────────────────────────────────
 * 组合与推屏**按帧合并**(rAF):一帧之内来多少条 delta / 账本行,只组合一次树。
 */

/** 缺号之后整份重折的最小间隔 —— 窗口内的多次缺号塌成一次。 */
export const REFOLD_THROTTLE_MS = 3000

export type ChatSourceStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface ChatSourceState {
  /** 当前正在看的会话;空串 = 还没有。 */
  sessionId: string
  status: ChatSourceStatus
  /** 失败时那句人话(照抄后端说的);成功后清空。 */
  error?: string
  /** 屏幕上那棵树:折叠产物 + 活尾巴 + overlay,一份现成的。 */
  messages: ProjectedMessage[]
  /** 正在生成的那条助手消息 id;undefined = 此刻没有在跑的 run。 */
  activeMessageId?: string
  /** overlay 车道:待送出 / 送不出去的消息,加本地提示。 */
  overlay: OverlayEntry[]

  /** 打开一条会话(幂等):起底 + 订上推送。 */
  open: (sessionId: string) => Promise<void>
  /** 发一条纯文本消息。返回 false = 空话,压根没离开输入框。 */
  send: (text: string, attachments?: number) => boolean
  /** 重试一条失败的 pending。 */
  retry: (entryId: string) => void
  /** 丢弃一条 overlay(失败后不想再试 / 关掉提示)。 */
  dismiss: (entryId: string) => void
  /** 挂一条本地提示(说的正是"这件事没有进账本")。 */
  notice: (kind: 'ask-rejected') => void
  /** 测试用:回到未启动的干净态(并退订)。 */
  reset: () => void
}

/**
 * 一条会话的活折。模块级而不是 store 字段:它是**这一个进程的事实**,
 * 不是可渲染状态(往 store 里塞会让每一条 delta 都触发一次订阅者重算)。
 */
interface LiveFold {
  state: ReturnType<typeof createSessionProjectionState>
  /** 已折进去的最后一条 seq。0 = 还没起底。 */
  lastSeq: number
  /** 起底 / 重折还没完成时,新到的行一律丢掉(重折读的整份账本里本来就有它们)。 */
  pending: boolean
  lastRefoldAt: number
  refoldScheduled: boolean
}

let fold: LiveFold | undefined
let tail: Tail | undefined
let unsubEvent: (() => void) | undefined
let unsubStream: (() => void) | undefined
let openSeq = 0
let pushScheduled = false
let entrySeq = 0

/** 账本 blob 的同步解析器需要一份缓存 —— 超 64KB 的正文在账本里只有 `BlobRef`。 */
const blobs = new Map<string, string>()
const blobsMissing = new Set<string>()
const blobsInFlight = new Set<string>()

const nextEntryId = () => `out-${(entrySeq += 1)}`

function newFold(): LiveFold {
  return {
    state: createSessionProjectionState(),
    lastSeq: 0,
    pending: true,
    lastRefoldAt: 0,
    refoldScheduled: false,
  }
}

const raf: (fn: () => void) => void =
  typeof globalThis.requestAnimationFrame === 'function'
    ? (fn) => void globalThis.requestAnimationFrame(() => fn())
    : (fn) => void setTimeout(fn, 0)

export const useChatSource = create<ChatSourceState>()((set, get) => {
  /**
   * 账本 blob 的**同步**解析器:命中缓存就当场给,没有就安排一次拉取并返回
   * `undefined` —— 折叠器照实留引用(`onMissing:'keep'`),屏幕上那一格是占位,
   * 而占位正是此刻的事实。拉回来之后推一次屏,那一格就补上了。
   */
  function resolveBlob(ref: { hash: string; bytes: number; mime?: string }): string | undefined {
    const sessionId = get().sessionId
    if (!sessionId) return undefined
    const key = `${sessionId}:${ref.hash}`
    const hit = blobs.get(key)
    if (hit !== undefined) return hit
    if (blobsMissing.has(key) || blobsInFlight.has(key)) return undefined
    blobsInFlight.add(key)
    void (async () => {
      try {
        const port = await chatPort()
        const { base64 } = await port.readBlob(sessionId, ref.hash)
        // 读不到就记下来,别每次物化都再问一遍(账本引用的正文可能真的没了)。
        if (!base64) blobsMissing.add(key)
        else blobs.set(key, base64)
      } catch {
        blobsMissing.add(key)
      } finally {
        blobsInFlight.delete(key)
        schedulePush()
      }
    })()
    return undefined
  }

  /** 折叠产物 → 屏幕树。顺序要紧:先接尾巴,再叠 overlay。 */
  function compose(): void {
    if (!fold || fold.pending) return
    const projected = materializeChatMessages(fold.state, { resolveBlob })
    const base = projected.messages as ProjectedMessage[]
    const overlay = reconcileOverlay(get().overlay, base)
    set({
      status: 'ready',
      error: undefined,
      messages: appendTail(base, tail),
      activeMessageId: projected.activeRun?.messageId,
      overlay,
    })
  }

  /** 按帧合并的推屏 —— 打字上屏的那一拍。 */
  function schedulePush(): void {
    if (pushScheduled) return
    pushScheduled = true
    raf(() => {
      pushScheduled = false
      try {
        compose()
      } catch {
        // 纪律:组合失败永不抛进渲染路径,保持上一份。
      }
    })
  }

  /** 起底 / 重折:整份账本折一遍。`token` 是换会话的防串号闸。 */
  async function refold(sessionId: string, token: number): Promise<void> {
    const mine = fold
    if (!mine) return
    mine.refoldScheduled = false
    mine.lastRefoldAt = Date.now()
    try {
      const port = await chatPort()
      const { events } = await port.listRaw(sessionId)
      // 换会话之后回来的那一份属于上一条会话 —— 整份丢掉,不写进新会话的折。
      if (token !== openSeq || fold !== mine) return
      let state = createSessionProjectionState()
      let lastSeq = 0
      for (const event of events ?? []) {
        state = reduceSessionProjection(state, event as never)
        const seq = (event as { seq?: number }).seq
        if (typeof seq === 'number' && seq > lastSeq) lastSeq = seq
      }
      mine.state = state
      mine.lastSeq = lastSeq
      mine.pending = false
      // 起底完成 = 屏幕那棵树此刻才有底,马上推一次(不推的话打开会话是空白)。
      compose()
    } catch (error) {
      // 重折失败:保持 pending,下一条缺号会再排一次(节流仍然生效)。
      if (token !== openSeq) return
      set({ status: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  }

  function scheduleRefold(sessionId: string, mine: LiveFold): void {
    mine.pending = true
    if (mine.refoldScheduled) return
    mine.refoldScheduled = true
    const token = openSeq
    const wait = Math.max(0, mine.lastRefoldAt + REFOLD_THROTTLE_MS - Date.now())
    setTimeout(() => void refold(sessionId, token), wait)
  }

  /**
   * 账本活事件来了一条。三种情况(与 Vue 壳逐条相同):
   *  - **接得上**(`seq === lastSeq + 1`):当场折进去;
   *  - **旧行**(`seq <= lastSeq`):重折之后追上来的回声,丢掉(幂等);
   *  - **缺号**:不补拼,整会话重折。
   */
  function feedLedger(record: unknown): void {
    const mine = fold
    if (!mine) return
    const seq = (record as { seq?: unknown })?.seq
    if (typeof seq !== 'number' || !Number.isFinite(seq)) return
    if (mine.pending) return
    if (seq <= mine.lastSeq) return
    if (seq !== mine.lastSeq + 1) {
      scheduleRefold(get().sessionId, mine)
      return
    }
    mine.state = reduceSessionProjection(mine.state, record as never)
    mine.lastSeq = seq
    // 打包行一到,活尾巴整段丢掉 —— 它装的那几条 delta 已经在折里,两份逐字节
    // 相同(`decode∘encode ≡ id`)。丢了重攒的代价是一帧内可能少几个字,而不丢
    // 的代价是**重影**(同一段文字出现两遍)。宁可少一帧,不要重影。
    if ((record as { type?: string })?.type === 'assistant/chunks') tail = undefined
    schedulePush()
  }

  function onEvent(envelope: SessionEventEnvelope): void {
    if (envelope.sessionId !== get().sessionId) return
    const event = envelope.event as { type?: string; record?: unknown }
    if (event?.type === SESSION_EVENT_TYPES.SESSION_LEDGER_EVENT) {
      feedLedger(event.record)
      return
    }
    // 这一轮完了,尾巴不再有主 —— 丢掉并推最后一次(账本那份已经全了)。
    if (
      event?.type === SESSION_EVENT_TYPES.STREAM_COMPLETE ||
      event?.type === SESSION_EVENT_TYPES.STREAM_ERROR ||
      event?.type === SESSION_EVENT_TYPES.STREAM_ABORTED
    ) {
      tail = undefined
      schedulePush()
    }
  }

  /**
   * 流分片进活尾巴。**只认两种裸 delta** —— 它们是"每条立刻发"的那条出口;
   * UI 事件流那几条(`assistant/*`)与账本行同形同名,由折叠负责,尾巴不碰,
   * 碰了就是同一段文字被两条路各画一遍。
   */
  function onStream(payload: SessionStreamPayload): void {
    if (payload.sessionId !== get().sessionId) return
    const chunk = payload.chunk as {
      type?: string
      text?: string
      reasoning?: string
      placement?: 'top' | 'inline'
      messageId?: string
    }
    const messageId = chunk?.messageId
    if (!messageId) return
    const hasContent = get().messages.some(
      (message) => message.id === messageId && Boolean(message.content),
    )
    if (chunk.type === 'text-delta' && chunk.text) {
      tail = feedTail(tail, messageId, 'text', chunk.text)
    } else if (chunk.type === 'reasoning-delta' && chunk.reasoning) {
      tail = feedTail(tail, messageId, 'reasoning', chunk.reasoning, chunk.placement, hasContent)
    } else {
      return
    }
    schedulePush()
  }

  /** 真发送 —— 成败都落在那一格 overlay 上,认领由 `reconcileOverlay` 负责。 */
  async function dispatch(entryId: string, sessionId: string, text: string): Promise<void> {
    try {
      const port = await chatPort()
      const result = await port.sendMessage(sessionId, text)
      if (result?.success) return
      failEntry(entryId, result?.error || 'session-command.emit 未成功')
    } catch (error) {
      failEntry(entryId, error instanceof Error ? error.message : String(error))
    }
  }

  function failEntry(entryId: string, error: string): void {
    set((prev) => ({
      overlay: prev.overlay.map((entry) =>
        entry.kind === 'pending' && entry.id === entryId
          ? { ...entry, status: 'failed' as const, error }
          : entry,
      ),
    }))
    /*
     * 兜底的一声。**气泡里那条就地重试条一格不动** —— 修这件事的手在那儿,
     * 通知不抢它的活。它管的是另一种情形:发失败的那一刻用户已经滚到别处、
     * 或者干脆切走了会话,那条重试条此刻不在他眼前。
     * error 档不自动消失,所以回来时它还在。
     */
    notify({
      level: 'error',
      source: 'chat.send',
      title: t('notify.sendFailed'),
      body: error,
      detail: error,
    })
  }

  return {
    sessionId: '',
    status: 'idle',
    messages: [],
    overlay: [],

    open: async (sessionId) => {
      if (!sessionId) {
        // 没有当前会话 = 没什么可折的。退订并归零,别把上一条会话的树留在屏幕上。
        unsubEvent?.()
        unsubStream?.()
        unsubEvent = undefined
        unsubStream = undefined
        fold = undefined
        tail = undefined
        openSeq += 1
        set({ sessionId: '', status: 'idle', error: undefined, messages: [], activeMessageId: undefined })
        return
      }
      if (get().sessionId === sessionId && fold) return
      const token = (openSeq += 1)
      fold = newFold()
      tail = undefined
      // 换会话 = overlay 清空:那几条 pending 属于上一条会话的屏幕。
      set({ sessionId, status: 'loading', error: undefined, messages: [], activeMessageId: undefined, overlay: [] })

      const port = await chatPort()
      await port.ready()
      if (token !== openSeq) return
      // 先订上再拉:拉的那一刻起的事件不能漏(与 D0 / D1 同一条理由)。
      unsubEvent?.()
      unsubStream?.()
      unsubEvent = port.onSessionEvent(onEvent)
      unsubStream = port.onSessionStream(onStream)
      await refold(sessionId, token)
    },

    send: (text, attachments = 0) => {
      const body = text.trim()
      if (!body) return false
      const sessionId = get().sessionId
      if (!sessionId) return false
      const entry = {
        id: nextEntryId(),
        kind: 'pending' as const,
        text: body,
        attachments,
        status: 'sending' as const,
        seenUserIds: userMessageIds(get().messages),
      }
      set((prev) => ({ overlay: [...prev.overlay, entry] }))
      void dispatch(entry.id, sessionId, body)
      return true
    },

    retry: (entryId) => {
      const entry = get().overlay.find((item) => item.id === entryId)
      if (!entry || entry.kind !== 'pending') return
      const sessionId = get().sessionId
      if (!sessionId) return
      set((prev) => ({
        overlay: prev.overlay.map((item) =>
          item.id === entryId
            ? // 重试要重新拍一次快照:上一次之后账本可能已经长出别的用户消息了。
              { ...item, status: 'sending' as const, error: undefined, seenUserIds: userMessageIds(get().messages) }
            : item,
        ),
      }))
      void dispatch(entryId, sessionId, entry.text)
    },

    dismiss: (entryId) => {
      set((prev) => ({ overlay: prev.overlay.filter((entry) => entry.id !== entryId) }))
    },

    notice: (kind) => {
      set((prev) => ({
        overlay: [...prev.overlay, { id: nextEntryId(), kind: 'notice' as const, notice: kind }],
      }))
    },

    reset: () => {
      unsubEvent?.()
      unsubStream?.()
      unsubEvent = undefined
      unsubStream = undefined
      fold = undefined
      tail = undefined
      openSeq += 1
      pushScheduled = false
      entrySeq = 0
      blobs.clear()
      blobsMissing.clear()
      blobsInFlight.clear()
      set({
        sessionId: '',
        status: 'idle',
        error: undefined,
        messages: [],
        activeMessageId: undefined,
        overlay: [],
      })
    },
  }
})

/** 非组件上下文的写法(composer store 的接缝就是这一口)。 */
export function sendChatMessage(text: string, attachments = 0): boolean {
  return useChatSource.getState().send(text, attachments)
}

export function pushChatNotice(kind: 'ask-rejected'): void {
  useChatSource.getState().notice(kind)
}
