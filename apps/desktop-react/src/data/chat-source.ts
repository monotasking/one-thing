import { create } from 'zustand'
import {
  createSessionProjectionState,
  reduceSessionProjection,
} from '@onething/core/session/projection/reducer'
import { materializeChatMessagesCached } from './chat-materialize'
import { StreamWater } from './stream-water'
import { SESSION_EVENT_TYPES } from '@shared/events/session-events'
import type { SessionEventEnvelope } from '@shared/events/envelope'
import type { SessionStreamPayload } from '@renderer/platform/types'
import { coreRenderMessageHasToolWork } from '@onething/core/session/render-anchors'
import {
  appendTail,
  feedTail,
  feedTailToolArgs,
  reconcileOverlay,
  handOverToLedger,
  startTailTool,
  tailTextLength,
  userMessageIds,
  type FoldLens,
  type OverlayEntry,
  type ProjectedMessage,
  type Tail,
} from './chat-fold'
import { chatPort } from './chat-port'
import { notify } from '../services/notify'
import { perfCount, perfSpan } from '../services/perf'
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

/**
 * **R2 开关**:水位合并(新路)还是拼装机器(旧路)。
 *
 * 默认开。旧路保留到 R3 真机浸泡结束 —— 开关一翻即回,回滚不需要改代码。
 * 读一次存起来:它是「这一台跑哪条路」的档位,不是每帧要问的问题。
 */
export const STREAM_R2 = readStreamR2()

function readStreamR2(): boolean {
  try {
    return globalThis.localStorage?.getItem('onething.streamR2') !== 'off'
  } catch {
    return true
  }
}

/** 缺号之后整份重折的最小间隔 —— 窗口内的多次缺号塌成一次。 */
export const REFOLD_THROTTLE_MS = 3000

/**
 * 按了停止之后,等这一轮收尾的宽限。超时只说一句话(warn),**不重发、不清尾巴**
 * —— 收尾归账本(`run/end` 会到),壳这边做乐观清理就是画一个和事实不符的屏幕。
 */
export const ABORT_SETTLE_MS = 3000

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
  /** 中止正在跑的那一轮。没有在跑的轮次时是**恒等**(不发命令、不报错)。 */
  abort: () => void
  /** 重试一条失败的 pending。 */
  retry: (entryId: string) => void
  /**
   * 重跑一条**已经落账的助手消息**(消息动作行的「重试」)。
   *
   * 与上面那个 `retry` 是两件事,名字因此不同:`retry` 修的是「这句话没交出去」
   * (overlay 车道,还没进账本),这一条说的是「这条回答我不满意,再跑一次」
   * —— 消息在账本上好好的,重跑由引擎负责。
   */
  regenerate: (messageId: string) => void
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
  /** 起底 / 重折还没完成时,新到的行进 `pendingLedger` 攒着,完成后排空回放。 */
  pending: boolean
  lastRefoldAt: number
  refoldScheduled: boolean
}

/**
 * **「引擎此刻在不在跑」的唯一产地。**
 *
 * 判据就是折叠产物上的 `activeRun`(`core/session/projection/reducer.ts`:
 * `run/start` 立牌、`run/end` 撤牌),经 `materializeChatMessages` 落成
 * `activeMessageId`。为什么是它而不是「活尾巴还在 / 最近一条 stream 没收尾」:
 *
 *  - 活尾巴是**渲染优化**的产物(每条 delta 立刻上屏),打包行一到它就被丢掉
 *    重攒 —— 它有没有,与「这一轮跑没跑完」中间隔着一层节拍;
 *  - `activeRun` 是账本上真真切切的一件事:开张与收摊各有一条事件,
 *    断线重连、整份重折之后它自己就对回来了,不需要第二套簿记。
 *
 * 写成选择器而不是 store 里的一格 `busy`,是因为它是**派生量**:多存一格
 * 就是多一个要维护的真相,而两个真相迟早对不上。
 */
export function selectEngineBusy(state: ChatSourceState): boolean {
  return state.activeMessageId !== undefined
}

let fold: LiveFold | undefined
let tail: Tail | undefined
/**
 * **尾巴已经交给账本多少**(三条车道各一格,判据见 chat-fold 的 `FoldLens`)。
 *
 * 与 `tail` 同生共死:`tail` 一退场就清空,一换消息就重新起算。它是尾巴与账本之间
 * 那条交接线的**唯一记账**;少了它就得每次现量两遍(多一处会分叉的产地),
 * 拿旧基准去裁新尾巴则是「一裁就整段」。
 *
 * ── 09-01:从「上一次量到多少」改成「已经交出去多少」 ──────────────────
 * 从前这里存的是**上一次的测量值**,额度 = 这次量 − 上次量。那条算法有两个洞:
 *  · 量法一变(锚点维让扁平车道停额)基准跟着变,下一次会把**早就交过**的那一截
 *    再算一次额度 —— 真机上就是尾巴被多裁一截;
 *  · 顺序闸挡下的额度**永远丢了**(基准已经推到新的测量值上),而那一截其实
 *    只是"这一帧还交不出去"。
 * 记「已经交出去多少」两个洞一起没有:额度 = 账本此刻画得出多少 − 已交出多少,
 * 与测量口径怎么变、这一帧交没交成都无关。`contentCoverage` 因此也退役了 ——
 * 它与 `lens.content` 从定义上就是同一个数,存两份迟早分叉。
 */
let tailLens: { messageId: string; lens: FoldLens } | undefined
/**
 * blob 缓存的**世代号**(见 `chat-materialize` 的 memo 键)。
 *
 * 物化按 `(节点, node.rev)` 缓存,而壳这条读路的物化选项 `resolveBlob` 读的是模块级
 * 那张 blob 表 —— 一条 blob 换回来之后成品会变,账本却一个字没动。所以另立这一格
 * 单调号,blob 落一条就 +1(唯一产地在 `resolveBlob` 的 finally 里)。
 */
/**
 * **这条消息一共收到了多少正文字符**(裸 delta 那条路的活计数)。
 *
 * 交接线(账本画到第几个字)从前是**累加** `taken.content` 攒出来的,而累加会漂:
 * 一处多算、一处少算,后面全歪。09-01 自查抓到的正是这条 —— 十三列表的分隔行
 * 一会儿多一格、一会儿少几个字,表头 8 列对不上分隔行的格数,GFM 当场判它不是表,
 * 表退回裸文本 350ms+。
 *
 * 改成**现算**:`交接线 = 收到多少 − 尾巴手里还剩多少`。两个数都是活的、都不累加,
 * 算出来的线因此不会漂;顺序闸把正文压在尾巴里时,「还剩多少」自己变大,线跟着后退,
 * 账本那一格自然少画 —— 一条式子同时管住了重画与漏画。
 */
let tailReceived: { messageId: string; chars: number } | undefined

/**
 * **活水位**(R2,`data/stream-water.ts`)。与 `fold` 同生共死:一条打开着的会话
 * 一份,换会话就是换一份 —— 它是个值,不是模块里的那一个(审查条 4)。
 */
let water: StreamWater | undefined

let blobEpoch = 0
/**
 * 重折在飞时到达的活事件 —— **攒着,不是丢掉**。
 *
 * 从前这里是丢("重折读的整份账本里本来就有它们"),但那句话对**重折发出之后
 * 才写下的行**不成立:listRaw 的快照定格在服务端应答那一刻,在飞窗口里写下的
 * 事件既不在快照里、又被丢掉,重折一完成就是缺号 → 再排一次重折(3s 节流)——
 * 中间这一整段活事件全部不折,正是真机上"打包行没清尾巴、重折折出重影"的引信。
 * 攒下来,重折完成后按 seq 排空回放(旧行照旧被幂等丢弃),缺号就不再凭空出现。
 */
let pendingLedger: Array<Record<string, unknown>> = []
/** 攒的上限 —— 一次重折的在飞窗口里攒过这个数属病态,清掉靠下一次重折兜底。 */
const PENDING_LEDGER_CAP = 1024
/** 「按了停止,还在等收尾」的那只表。模块级 —— 它不是可渲染状态。 */
let abortWatch: ReturnType<typeof setTimeout> | undefined
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
        // **blob 世代前进 —— 这是本文件唯一一处**。物化按节点缓存(chat-materialize),
        // 而这条 blob 换回来之后成品会变、账本却没变(`node.rev` 不动)。少了这一格,
        // 附件正文会永远停在「还没读回来」的那一版。
        blobEpoch += 1
        schedulePush()
      }
    })()
    return undefined
  }

  /**
   * 折叠产物 → 屏幕树。顺序要紧:先接尾巴,再叠 overlay。
   *
   * 物化走**按节点缓存**那一口(`chat-materialize`):流式期间真正在变的只有一条
   * 消息,其余全部命中上一帧的成品 —— 于是这一帧的代价与抄本长度脱钩。
   * 打点埋在这里而不是 `schedulePush`:要量的是「组一次屏要多久」,不是排队。
   */
  function compose(): void {
    if (!fold || fold.pending) return
    perfSpan('chat.compose', () => {
      const projected = materializeChatMessagesCached(
        fold!.state,
        // R2:段号只在这条读路上要(见 core 的 `includePartIndex`)——影子对账零感知。
        STREAM_R2 ? { resolveBlob, includePartIndex: true } : { resolveBlob },
        blobEpoch,
        STREAM_R2 ? water : undefined,
      )
      const base = projected.messages
      const overlay = reconcileOverlay(get().overlay, base)
      set({
        status: 'ready',
        error: undefined,
        // R2 新路:合并已经在物化里做完了(每 part 一条 max),这一层不再拼装。
        messages: STREAM_R2 ? base : appendTail(base, tail, tailCoverage()),
        activeMessageId: projected.activeRun?.messageId,
        overlay,
      })
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

  /**
   * 一条消息在某份折叠状态上**此刻画得出来**的那几把尺(判据见 `FoldLens` 的注)。
   *
   * `reasoningInline` 必须数 `contentParts` 而不是 `reasoning` —— 后者只装顶部那一段。
   * 数错这一格就是 09-01 那条「思考块消失 2 秒」的报障。
   *
   * `contentPlaceable` 是 09-01 P0 补的**锚点维**:判据一句话 —— **这条消息有工具
   * 活儿、而 parts 还一格都没物化时,正文那条扁平车道摆不对新一轮的正文**。
   * 「有没有工具活儿」问的是 core 那一个函数(`coreRenderMessageHasToolWork`),
   * 与锚点合成器自己用的判据**逐字同一个**:两处各写一份就是两个会分叉的产地。
   */
  /** 折叠产物上的那一条消息(尺与锚都从它上面量,别量两遍)。 */
  /**
   * 这条消息此刻账本里有多少正文 —— **新开一条流水的起点**。
   *
   * 第一条 delta 之前账本可能已经有字(重连、换会话回来、上一轮的正文),那些字
   * 按定义是「收到过并且已经交出去了」。
   */
  function contentLengthOf(messageId: string): number {
    if (!fold) return 0
    return messageOf(fold.state, messageId)?.content?.length ?? 0
  }

  function messageOf(state: ReturnType<typeof createSessionProjectionState>, messageId: string) {
    return materializeChatMessagesCached(state, { resolveBlob }, blobEpoch).messages.find(
      (message) => message.id === messageId,
    )
  }

  function lensOf(state: ReturnType<typeof createSessionProjectionState>, messageId: string): FoldLens {
    const found = messageOf(state, messageId)
    const parts = (found?.contentParts ?? []) as ReadonlyArray<{ type?: string; content?: string }>
    let reasoningInline = 0
    for (const part of parts) {
      if (part.type === 'reasoning') reasoningInline += part.content?.length ?? 0
    }
    const hasToolWork = found ? coreRenderMessageHasToolWork(found) : false
    return {
      content: found?.content?.length ?? 0,
      reasoningTop: found?.reasoning?.length ?? 0,
      reasoningInline,
      contentPlaceable: !(hasToolWork && parts.length === 0),
      ledgerToolCallIds: new Set((found?.toolCalls ?? []).map((call) => call.id)),
    }
  }

  /**
   * **尾巴与账本的交接点 —— 全文件唯一一处**(活路与重折都走它)。
   *
   * `tailLens` 是「上一次交接完成时,账本对这条消息画得出来多少」。折进新东西之后
   * 再量一次,多出来的那一截就是尾巴该交出去的。`tailLens` 与 `tail` 同生共死
   * (两者要么都在、要么都不在):尾巴一换消息 / 一退场,基准必须跟着重新起算,
   * 否则下一轮会拿上一轮的账本量去裁新尾巴,一裁就是整段。
   */
  /**
   * **交接线 —— 账本的正文画到第几个字**。
   *
   * `收到多少 − 尾巴手里还剩多少`:两个活数现算,不累加。尾巴不在场时是 undefined
   * (账本手里就是全部,不设限)。
   */
  function tailCoverage(): number | undefined {
    if (!tail || tailReceived?.messageId !== tail.messageId) return undefined
    return Math.max(0, tailReceived.chars - tailTextLength(tail))
  }

  function handOverTail(state: ReturnType<typeof createSessionProjectionState>): void {
    if (!tail || tailLens?.messageId !== tail.messageId) return
    const covered = { ...tailLens.lens, content: tailCoverage() ?? tailLens.lens.content }
    const { tail: next, taken } = handOverToLedger(tail, covered, lensOf(state, tail.messageId))
    tail = next
    // **只推进真交出去的那一截**。交接从前往后停(顺序闸),没交成的那一截下一帧
    // 还会重新算额度 —— 记「交出去多少」而不是「量到多少」正是为了这一条。
    tailLens = next
      ? {
          messageId: next.messageId,
          lens: {
            content: covered.content + taken.content,
            reasoningTop: covered.reasoningTop + taken.reasoningTop,
            reasoningInline: covered.reasoningInline + taken.reasoningInline,
          },
        }
      : undefined
  }

  /**
   * 尾巴刚从无到有、或刚换了消息:把交接基准钉在账本此刻的量上。
   * 认 `messageId` 而不是「有没有值」—— 换了消息还用上一条的基准,第一次交接就会
   * 拿别人的账本量去裁这条尾巴。
   */
  function rebaseTailLens(state: ReturnType<typeof createSessionProjectionState>): void {
    if (!tail) {
      tailLens = undefined
      return
    }
    if (tailLens?.messageId === tail.messageId) return
    // 三条车道的起算点。正文那条**不由它说了算**(见 `tailCoverage`):正文的交接线
    // 是「收到多少 − 还剩多少」现算的,这里存的那一格只当 `handOverToLedger` 的
    // 兜底基线用。
    tailLens = { messageId: tail.messageId, lens: lensOf(state, tail.messageId) }
  }

  /**
   * 清格:拿账本此刻**画得出来**的每段长度去退役水位。
   *
   * 「画得出来」= `contentParts` 里那一格的长度(投影的 `requestSettled` 闸说了算),
   * 不是 `message.content`(它把没结算的轮次也折进去了)—— 与合并式同一把尺,
   * 两处用不同的尺就是下一轮事故。
   */
  /**
   * **缺段记一笔**(审查条 3 的可见面)。
   *
   * 「偏移接不上就丢」是对的(带洞的字符串比没有更坏),但**丢了这件事本身不该
   * 静默**:它要么说明上游漏了段,要么说明这一刻是中途入场 / 重连 —— 后者屏幕上
   * 该由账本补账那条路接住(见 `mergeWater` 的「账本比 parts 长的那截」),
   * 而这一笔就是那条路有没有真接住的对照。
   *
   * 节流与去重在 `perfCount` 里:缺段是**成串**发生的,一条丢了后面每一条都对不上。
   */
  function reportWaterGap(messageId: string, kind: string): void {
    perfCount('stream.water.gap', {
      session: get().sessionId,
      message: messageId,
      kind,
      total: water?.gapCount,
    })
  }

  function settleWater(state: ReturnType<typeof createSessionProjectionState>, mine: LiveFold): void {
    if (!water) return
    const projected = materializeChatMessagesCached(
      state,
      { resolveBlob, includePartIndex: true },
      blobEpoch,
    )
    let diverged = 0
    for (const message of projected.messages) {
      const drawable = new Map<number, number>()
      const ledgerText = new Map<number, string>()
      for (const part of (message.contentParts ?? []) as Array<{ partIndex?: number; content?: string }>) {
        if (part.partIndex === undefined) continue
        drawable.set(part.partIndex, part.content?.length ?? 0)
        ledgerText.set(part.partIndex, part.content ?? '')
      }
      // 顶部推理不在 parts 里,它的产地是 `message.reasoning` —— 那一格由消息级
      // 长度追平(段号未知,所以按「这条消息的 top 段」整体判,见水位表的 settle)。
      if (drawable.size > 0) {
        /*
         * 清格顺手验一次**前缀定律**(第 2 条不变式):账本这一段与水位这一段必须是
         * 同一个字符串的两个前缀。验在这里而不是每帧 —— 定律的地基是账本,而账本只在
         * 打包行到达那一刻长。对不上:那一格已被水位表自己退役(诚实地退回纯账本投影),
         * 这里补两件事 —— 记一笔可见的账,排一次定向重折让账本重新说一遍。
         */
        const result = water.settle(message.id, drawable, index => ledgerText.get(index))
        if (result.diverged > 0) {
          diverged += result.diverged
          perfCount('stream.water.divergence', {
            session: get().sessionId,
            message: message.id,
            parts: result.diverged,
            total: water.divergenceCount,
          })
        }
      }
      const ledgerCallIds = new Set((message.toolCalls ?? []).map(call => call.id))
      if (ledgerCallIds.size > 0) water.settleTools(message.id, ledgerCallIds)
    }
    // 定向重折走既有那一口(带节流),不另开一条自愈路。
    if (diverged > 0) scheduleRefold(get().sessionId, mine)
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
      // 交接基准不在这里现量:`tailLens` 一直跟着每次交接走,pending 期间旧折冻结,
      // 它就是「重折前账本画得出来多少」。现量一次反而多一处会与它分叉的产地。
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
      // 新折叠可能已经装下了尾巴前面那一截(打包行进了快照而尾巴没被裁过)——
      // 交给那条唯一的交接规则,不然就是重影(见 handOverToLedger 的注)。
      handOverTail(state)
      // 排空重折在飞时攒下的活事件:旧行被幂等丢弃,接得上的当场折进去,
      // 真缺号(SSE 真丢了行)照旧触发下一次重折。
      const drained = pendingLedger
      pendingLedger = []
      drained.sort((a, b) => ((a.seq as number) ?? 0) - ((b.seq as number) ?? 0))
      for (const record of drained) feedLedger(record)
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
    if (mine.pending) {
      // 重折在飞:攒着(见 pendingLedger 的注),重折完成后按 seq 排空回放。
      pendingLedger.push(record as Record<string, unknown>)
      if (pendingLedger.length > PENDING_LEDGER_CAP) pendingLedger.length = 0
      return
    }
    if (seq <= mine.lastSeq) return
    if (seq !== mine.lastSeq + 1) {
      scheduleRefold(get().sessionId, mine)
      return
    }
    mine.state = reduceSessionProjection(mine.state, record as never)
    mine.lastSeq = seq
    // R2 第六不变式:**打包行到达那一帧只清格,不画画**。账本对这一段画得出来的
    // 长度追平水位,那一格就退役 —— 清格不改 `max` 的结果,所以屏幕零像素变化。
    if (STREAM_R2) settleWater(mine.state, mine)
    // 折进新东西之后,尾巴把「账本这一刻新画得出来的那一截」交出去 —— 判据不看
    // 这是不是一条打包行(见 handOverToLedger 的病历:打包行只说明「进账本了」,
    // 不说明「画得出来」;行内推理要等 parts 物化才有第二个产地)。
    handOverTail(mine.state)
    schedulePush()
  }

  function onEvent(envelope: SessionEventEnvelope): void {
    if (envelope.sessionId !== get().sessionId) return
    const event = envelope.event as {
      type?: string
      record?: unknown
      messageId?: string
      toolCallId?: string
      toolName?: string
      toolCall?: { timestamp?: number }
    }
    if (event?.type === SESSION_EVENT_TYPES.SESSION_LEDGER_EVENT) {
      feedLedger(event.record)
      return
    }
    /*
     * 一次调用开始收参数 —— **活尾巴的第三条车道**(09-01 P1)。
     *
     * 为什么是这条事件而不是等账本:账本上这次调用要等参数收齐(`tool/call`)才
     * 出生,而参数是逐片流的。真机读数:`tool:input-start` t=1693ms、`tool/call`
     * t=1929ms、打包行 t=1988ms —— 屏幕上足足 **295ms 什么都没有**,而真实工具的
     * 参数(写文件、改代码)长得多,这个空窗按比例放大到数秒。
     *
     * 它与正文那两条车道是同一件事:账本此刻画不出来的那一截,由尾巴顶着。
     */
    if (event?.type === SESSION_EVENT_TYPES.TOOL_INPUT_START) {
      if (!event.messageId || !event.toolCallId || !event.toolName) return
      if (STREAM_R2) {
        water?.openTool(
          event.messageId,
          event.toolCallId,
          event.toolName,
          event.toolCall?.timestamp ?? Date.now(),
        )
        schedulePush()
        return
      }
      tail = startTailTool(
        tail,
        event.messageId,
        event.toolCallId,
        event.toolName,
        event.toolCall?.timestamp ?? Date.now(),
      )
      if (fold) rebaseTailLens(fold.state)
      schedulePush()
      return
    }
    // 这一轮完了,尾巴不再有主 —— 丢掉并推最后一次(账本那份已经全了)。
    if (
      event?.type === SESSION_EVENT_TYPES.STREAM_COMPLETE ||
      event?.type === SESSION_EVENT_TYPES.STREAM_ERROR ||
      event?.type === SESSION_EVENT_TYPES.STREAM_ABORTED
    ) {
      tail = undefined
      tailLens = undefined
      tailReceived = undefined
      // R2:这一轮收尾 = 账本是全的,水位只会说同样的话;顺带也是本期对「换代」的
      // 保守答复(重跑 / 编辑重发一律清,不去猜 gen)。
      const settledMessageId = (event as { messageId?: string }).messageId
      if (settledMessageId) water?.clearMessage(settledMessageId)
      else water?.clear()
      schedulePush()
    }
  }

  /**
   * 流分片进活尾巴。**只认三种裸 delta** —— 它们是"每条立刻发"的那条出口;
   * UI 事件流那几条(`assistant/*`)与账本行同形同名,由折叠负责,尾巴不碰,
   * 碰了就是同一段文字被两条路各画一遍。
   *
   * `turnIndex` 与 `placement` 同款:引擎开这一段时就定下的事实,尾巴只是照抄。
   * 少了它,第二轮的正文会被并进第一轮那一段,工具锚点从整段头上跨过去
   * (真机 191ms 错位 + 992ms 消失,见 `FoldLens.contentPlaceable`)。
   */
  function onStream(payload: SessionStreamPayload): void {
    if (payload.sessionId !== get().sessionId) return
    const chunk = payload.chunk as {
      type?: string
      text?: string
      reasoning?: string
      placement?: 'top' | 'inline'
      messageId?: string
      turnIndex?: number
      toolCallId?: string
      argsTextDelta?: string
      stamp?: import('@shared/events/index.js').StreamDeltaStamp
    }
    const messageId = chunk?.messageId
    if (!messageId) return
    const hasContent = get().messages.some(
      (message) => message.id === messageId && Boolean(message.content),
    )
    /*
     * R2:**盖过章的 delta 进水位表**,一条路走到底。
     *
     * 没有章 = 这条 delta 没走过引擎的铸章机(重放 / 生图旁路)。那种正文本来就
     * 只活在账本里,水位不认领它 —— 也不必:账本 ≤2s 就把它画出来。
     */
    if (STREAM_R2) {
      if (!water) return
      const stamp = chunk.stamp
      if (!stamp) return
      const text = chunk.type === 'text-delta'
        ? chunk.text
        : chunk.type === 'reasoning-delta'
          ? chunk.reasoning
          : chunk.type === 'tool-input-delta'
            ? chunk.argsTextDelta
            : undefined
      if (!text) return
      if (chunk.type === 'tool-input-delta') {
        // 参数那一路按 toolCallId 落格(章上没有这一格 —— 名字与身份由
        // `tool:input-start` 给,章只负责说偏移)。
        if (chunk.toolCallId) {
          const result = water.feedToolArgs(messageId, chunk.toolCallId, stamp.charOffset, text)
          if (result.outcome === 'gap') reportWaterGap(messageId, 'tool-input')
        }
      } else {
        const result = water.feed(stamp, text, chunk.placement)
        if (result.outcome === 'gap') reportWaterGap(messageId, stamp.kind)
      }
      schedulePush()
      return
    }

    if (chunk.type === 'text-delta' && chunk.text) {
      // 先记账再喂 —— 「收到多少」是这条消息的流水,与尾巴此刻手里有多少无关。
      tailReceived =
        tailReceived?.messageId === messageId
          ? { messageId, chars: tailReceived.chars + chunk.text.length }
          : { messageId, chars: contentLengthOf(messageId) + chunk.text.length }
      tail = feedTail(tail, messageId, 'text', chunk.text, undefined, undefined, chunk.turnIndex)
    } else if (chunk.type === 'reasoning-delta' && chunk.reasoning) {
      tail = feedTail(
        tail,
        messageId,
        'reasoning',
        chunk.reasoning,
        chunk.placement,
        hasContent,
        chunk.turnIndex,
      )
    } else if (chunk.type === 'tool-input-delta' && chunk.toolCallId && chunk.argsTextDelta) {
      tail = feedTailToolArgs(tail, messageId, chunk.toolCallId, chunk.argsTextDelta)
    } else {
      return
    }
    // 尾巴刚从无到有 / 刚换消息:交接基准钉在账本此刻的量上(见 rebaseTailLens)。
    if (fold) rebaseTailLens(fold.state)
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
      // 换会话 = 上一条会话那只「等收尾」的表过期了(它会自己判,但留着没意义)。
      if (abortWatch) clearTimeout(abortWatch)
      abortWatch = undefined
      if (!sessionId) {
        // 没有当前会话 = 没什么可折的。退订并归零,别把上一条会话的树留在屏幕上。
        unsubEvent?.()
        unsubStream?.()
        unsubEvent = undefined
        unsubStream = undefined
        fold = undefined
        water = undefined
        tail = undefined
        tailLens = undefined
        tailReceived = undefined
        pendingLedger = []
        openSeq += 1
        set({ sessionId: '', status: 'idle', error: undefined, messages: [], activeMessageId: undefined })
        return
      }
      if (get().sessionId === sessionId && fold) return
      const token = (openSeq += 1)
      fold = newFold()
      // 换会话 = 换一份水位(它是个值,不是模块里的那一个 —— 审查条 4)。
      water = new StreamWater()
      tail = undefined
      tailLens = undefined
      tailReceived = undefined
      pendingLedger = []
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

    /**
     * 停止这一轮。
     *
     * 三条纪律:
     *  1. **没在跑就什么都不做** —— 发一条打空的 abort 只会在账本上留一条噪音;
     *  2. 命令被 core 收下之后**壳不动屏幕**:收尾由账本负责(`run/end` 会到,
     *     onEvent 里那条 STREAM_* 分支顺手把活尾巴丢掉)。乐观清尾巴 = 画一个
     *     和事实不符的屏幕,而这条链路的全部信用就建立在「屏幕 = 折叠产物」上;
     *  3. 超过宽限还没收尾就说一句(warn),**只说不做** —— 重发一次 abort
     *     解决不了「引擎卡住了」,只会再堆一条命令。
     *
     * 命令本身发不出去(网断 / core 拒收)是 error 档:人按了停止而它没停,
     * 这件事必须让人知道,而且不该自动飘走。
     */
    abort: () => {
      const sessionId = get().sessionId
      if (!sessionId) return
      if (!selectEngineBusy(get())) return
      const target = get().activeMessageId

      void (async () => {
        let failure: string | undefined
        try {
          const port = await chatPort()
          const result = await port.abort(sessionId)
          if (!result?.success) failure = result?.error || 'session-command.emit 未成功'
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error)
        }
        if (failure) {
          notify({
            level: 'error',
            source: 'chat.abort',
            title: t('notify.abortFailed'),
            body: failure,
            detail: failure,
          })
          return
        }
        if (abortWatch) clearTimeout(abortWatch)
        abortWatch = setTimeout(() => {
          abortWatch = undefined
          const now = get()
          // 换了会话、或者这一轮已经收了(哪怕换成了下一轮)= 这只表过期了。
          if (now.sessionId !== sessionId || now.activeMessageId !== target) return
          notify({
            level: 'warn',
            source: 'chat.abort',
            title: t('notify.abortStuck'),
            body: t('notify.abortStuckHint'),
          })
        }, ABORT_SETTLE_MS)
      })()
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

    /**
     * 重跑一条助手消息。
     *
     * 三条纪律,与 `abort` 逐条同源:
     *  1. **壳不动屏幕** —— 命令交出去就完了。重跑会在账本上开一条新 run,
     *     屏幕跟着折叠产物走;这里乐观地把旧正文抹掉就是画一个与事实不符的屏幕;
     *  2. 信封**一个字段都不多给**(见 chat-port 的注);
     *  3. 发不出去(网断 / core 拒收)是 error 档:人按了重试而它没跑,
     *     这件事必须让人知道,而且不该自动飘走。
     */
    regenerate: (messageId) => {
      const sessionId = get().sessionId
      if (!sessionId || !messageId) return
      void (async () => {
        let failure: string | undefined
        try {
          const port = await chatPort()
          const result = await port.retryMessage(sessionId, messageId)
          if (!result?.success) failure = result?.error || 'session-command.emit 未成功'
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error)
        }
        if (!failure) return
        notify({
          level: 'error',
          source: 'chat.retry',
          title: t('notify.retryFailed'),
          body: failure,
          detail: failure,
        })
      })()
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
      water = undefined
      tail = undefined
      tailLens = undefined
      tailReceived = undefined
      pendingLedger = []
      if (abortWatch) clearTimeout(abortWatch)
      abortWatch = undefined
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

/**
 * **HMR 退役**(09-01,性能调查坐实:同一帧里出现两个不同 `?t=` 版本的 chat-source
 * 各自的 rAF 回调 —— 热更之后旧模块的订阅与推屏环没死,两台折叠器同时活着各自推屏)。
 *
 * 这个文件有一堆**模块级副作用**:`unsubEvent` / `unsubStream` 两条推送订阅、
 * 按帧合并的 rAF 环、`abortWatch` 那只表,外加 `fold` / `tail` / `tailLens` 一整套
 * 活折状态。它们的寿命是「这个模块实例」,而热更换的正是模块实例 —— 不退役,旧实例
 * 的订阅照收事件、照推屏,而它的折叠状态永远停在换模块那一刻,与新实例交替上屏。
 *
 * `reset()` 本来就是「回到未启动的干净态」那一口,退役直接用它 —— 别写第二套拆卸
 * 逻辑(两套拆卸迟早漏一格)。它自身幂等,重复调用无害。
 *
 * 生产构建里 `import.meta.hot` 是 undefined,整段被 tree-shake 掉。
 *
 * **留账**:这只治本文件自己。同族病(块注册表 `registerBlock` 热更重复注册)归
 * 另一批;纪律「模块级副作用必须配 HMR dispose」已立进本目录的 CLAUDE.md。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    useChatSource.getState().reset()
  })
}

/** 非组件上下文的写法(composer store 的接缝就是这一口)。 */
export function sendChatMessage(text: string, attachments = 0): boolean {
  return useChatSource.getState().send(text, attachments)
}

export function pushChatNotice(kind: 'ask-rejected'): void {
  useChatSource.getState().notice(kind)
}

/** 同上,给输入面板那条接缝(composer/sink.ts)用的非组件写法。 */
export function abortChatRun(): void {
  useChatSource.getState().abort()
}
