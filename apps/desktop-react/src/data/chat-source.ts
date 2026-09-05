import { useEffect, useSyncExternalStore } from 'react'
import { useStore } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'
import {
  createSessionProjectionState,
  reduceSessionProjection,
} from '@onething/core/session/projection/reducer'
import { materializeChatMessagesCached } from './chat-materialize'
import { StreamWater } from './stream-water'
import { SESSION_EVENT_TYPES } from '@shared/events/session-events'
import type { SessionEventEnvelope } from '@shared/events/envelope'
import type { SessionStreamPayload } from '@shared/events/envelope'
import { coreRenderMessageHasToolWork } from '@onething/core/session/render-anchors'
import {
  appendTail,
  applyToolProgress,
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
 * 聊天区的**真数据源**(D3,路线 A;W5-a 起**一条会话一台**)。
 *
 * ── 一句话 ────────────────────────────────────────────────────────────
 * **屏幕上那棵树 = core 折叠器的输出 + 活尾巴 + overlay**。React 侧零拼装:
 * 这个文件里没有任何一处"从事件推导消息结构"的代码 —— 结构全部来自
 * `reduceSessionProjection`(与主进程跑的是**同一台**归约器)。
 *
 * ── W5-a:从「全应用一台」改成「一条会话一台 + 一张注册表」 ───────────────
 * 从前这只文件是一台模块级单例:15 个模块级可变量(活折 / 活尾巴 / 水位 / 那对
 * 推送订阅 / 防串号闸)全部是「这个模块实例」的事实,于是**同时只能看一条会话**
 * —— 换会话就是把那台机器整个掉头,两处 `envelope.sessionId !== get().sessionId`
 * 的过滤就是这件事在代码里的形状。会话多开(W5)要的正是它们各活各的,所以:
 *
 *  · `createChatSource(sessionId)` —— **一条会话的数据机器**。上面那 15 格全部
 *    收进实例;它只认自己那条会话,不需要任何过滤;
 *  · `chatSources` —— **生命周期**。按会话 id 引用计数(`acquire` / `release`),
 *    归零后延迟一拍(微任务)再 dispose,所以「同一次提交里先卸后挂」(React
 *    StrictMode / 换 key)不会把机器拆了重建 —— 判据是**次序**不是时间窗
 *    (与 `focus/registry.ts` 的 `pendingUnregister` 同一条判例);
 *  · **推送订阅全进程只有一对**,住在注册表上,按 `envelope.sessionId` 分发到
 *    实例。从前每次 `open()` 退订重订一次(而且订的是「当前这条」),多开时
 *    那条路会让后开的那条把先开的那条挤掉。
 *
 * ── 「当前会话」那一格(`useChatSource` / 三个自由函数的缺省)──────────────
 * 壳里还有几处**全局面**在说「当前会话」(输入面板的忙态、`expose` 建会话之后
 * 那一手 `open`)。它们今天读注册表的 `current` 槽,而这一格由**唯一在场的那片
 * 会话叶**宣布(`ChatStream` 的 effect)。W5-b 会把它换成「焦点叶的活动 session
 * tab」那条投影(裁定 3),消费者一行不用改 —— 这正是这一格存在的理由。
 *
 * ── 取数与增量(判例逐条不变)────────────────────────────────────────────
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
 * 合并是**按实例**的 —— 两条会话同时在流,各推各的屏。
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
  /** 这台机器看的那条会话;空串 = 还没有(空会话那一台恒 idle)。 */
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
  /**
   * **「自己刚发出去一条」的那一拍**(C1 §5.1「发送」那一格的产地)。
   *
   * 一个只增不减的号,不是一条消息、不是一个布尔。跟随状态机要的是**事件**
   * (「这一下是发送」),而 store 里能放的只有状态 —— 单调号是这两者之间那座
   * 唯一不撒谎的桥:订阅方比对号变没变就知道「刚刚发生了一次」,不必去猜
   * (拿 `messages.length` 的差当发送是猜:重折、账本追上来、overlay 认领,
   * 三条路都会让长度变,而它们一条都不是「我按了发送」)。
   *
   * **按实例单调**(W5-a):它数的是「这台机器交出去过多少条」。做成全进程一个
   * 号会让 A 会话发一条把 B 会话的跟随状态机也推一下 —— 那正是这个号最不该
   * 撒的谎(反证:`chat-follow` 那几条既有用例当场红)。
   */
  sentTick: number
  /**
   * **正在生成的那条消息上一次收到 delta 的时刻**(§6.6 活性读数的产地)。
   *
   * 与 `messages` 同一次 `set` 写出去 —— 也就是说它跟着按帧合并的推屏走,
   * 每条 delta 各推一次 store 那种事不会发生(那正是这个文件把活折留在实例上、
   * 不塞进 store 的理由)。没有在跑的 run、或者这一轮一个 delta 都还没到时是
   * `undefined`:调用方该退到 `run/start` 的时刻,而不是拿 0 当「刚刚」。
   */
  lastDeltaAt?: number

  /**
   * **换「当前会话」**(兼容口,不是这台机器的方法)。
   *
   * W5-a 之前它是「这台单例掉头去看另一条会话」;现在一条会话一台机器,掉头这件事
   * 不存在了 —— 留下的这一口说的是**注册表的 `current` 槽换人**(顺带把那条会话的
   * 机器起起来)。它对同一条会话仍然幂等。今天唯一的真实调用点是
   * `expose/store.newSession`(建完会话紧接着要发第一句话,等不了 React 那一帧),
   * W5-b 把 `current` 换成焦点叶投影时这一口跟着退役。
   */
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
  /**
   * 测试用:**整张注册表**回到未启动的干净态(退订、拆掉每一台机器)。
   *
   * 它挂在状态上而不是注册表上,是因为调用点(测试与 HMR 退役)从前就是这一口;
   * 语义换成了「全表归零」而不是「这一台归零」—— 拆一台机器的那口叫 `dispose`,
   * 归注册表管,不外露给消费者。
   */
  reset: () => void
}

/**
 * 一条会话的活折。实例字段而不是 store 字段:它是**这台机器的事实**,
 * 不是可渲染状态(往 store 里塞会让每一条 delta 都触发一次订阅者重算)。
 */
interface LiveFold {
  state: ReturnType<typeof createSessionProjectionState>
  /** 已折进去的最后一条 seq。0 = 还没起底。 */
  lastSeq: number
  /*
   * ui-consume-allow: async-busy-boolean — 规则误报:它是这只 LiveFold 的
   * 折叠机内部闸门,既不是可渲染状态也不是写路忙态 —— 没有任何控件读它,
   * 逐格 pending 在这里无处可挂,迁过去只会把一个进程事实伪装成一次用户的写。
   */
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

/** 攒的上限 —— 一次重折的在飞窗口里攒过这个数属病态,清掉靠下一次重折兜底。 */
const PENDING_LEDGER_CAP = 1024

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

/**
 * **一条会话的数据机器**。
 *
 * 它是个**值**:谁要看这条会话谁向注册表要一份,没有「模块里的那一个」。
 * 它只认自己那条会话 —— 分发在注册表那一层做完了,所以这里一处 `sessionId`
 * 的比对都没有(从前那两处过滤是单例的税)。
 */
export interface ChatSource {
  /** 这台机器绑的那条会话(构造之后不变)。 */
  readonly sessionId: string
  /** 可渲染状态那一面(zustand vanilla store —— React 那半边在 hook 里接)。 */
  readonly store: StoreApi<ChatSourceState>
  getState: () => ChatSourceState
  setState: (partial: Partial<ChatSourceState>) => void
  /** 起底 + 接上增量。**幂等** —— 已经起过底就当场返回。 */
  open: () => Promise<void>
  /** 注册表按 `sessionId` 分发进来的账本 / 会话事件。 */
  handleEvent: (envelope: SessionEventEnvelope) => void
  /** 注册表按 `sessionId` 分发进来的流分片。 */
  handleStream: (payload: SessionStreamPayload) => void
  /** 拆机器:停掉在飞的重折、那只等收尾的表、按帧合并的推屏。幂等。 */
  dispose: () => void
}

export function createChatSource(sessionId: string): ChatSource {
  /* ── 这台机器的活状态(W5-a 之前它们是 15 个模块级可变量)──────────────── */

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
   * **上一次收到 delta 的时刻**(按消息记)。实例字段而不是 store 字段,理由与
   * `LiveFold` 逐字相同:每条 delta 各写一次 store = 每条 delta 触发一次全体订阅者
   * 重算。它由 `compose()`(按帧合并的那一拍)搬进 store,于是一帧最多一次。
   *
   * 记 `messageId` 而不是只记时刻:换一条消息就是换一轮,上一轮的静默时长
   * 对这一轮没有任何意义。
   */
  let lastDelta: { messageId: string; at: number } | undefined
  /**
   * **活水位**(R2,`data/stream-water.ts`)。与 `fold` 同生共死:一条打开着的会话
   * 一份 —— 它是个值,不是模块里的那一个(审查条 4)。
   */
  let water: StreamWater | undefined
  /**
   * blob 缓存的**世代号**(见 `chat-materialize` 的 memo 键)。
   *
   * 物化按 `(节点, node.rev)` 缓存,而壳这条读路的物化选项 `resolveBlob` 读的是
   * 这台机器自己那张 blob 表 —— 一条 blob 换回来之后成品会变,账本却一个字没动。
   * 所以另立这一格单调号,blob 落一条就 +1(唯一产地在 `resolveBlob` 的 finally 里)。
   */
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
  /** 「按了停止,还在等收尾」的那只表。实例字段 —— 它不是可渲染状态。 */
  let abortWatch: ReturnType<typeof setTimeout> | undefined
  /** 起底 / 重折的防串号闸(也是 `dispose` 作废在飞回调的那一手)。 */
  let openSeq = 0
  let pushScheduled = false
  let entrySeq = 0
  let disposed = false
  /**
   * **正在起底的那一次**(`open()` 的返回值)。
   *
   * `open()` 对同一台机器是幂等的,但幂等**不等于**「第二个调用者立刻拿到一个
   * resolved 的 promise」:第二个人 `await` 的语义仍然是「等这一次起底办完」。
   * 少了这一格,`expose.newSession` 那条路(建完会话紧接着发第一句话,理由写在
   * 它的调用处)会在订阅与起底都还没落地时就往下走。
   */
  let opening: Promise<void> | undefined

  /** 账本 blob 的同步解析器需要一份缓存 —— 超 64KB 的正文在账本里只有 `BlobRef`。 */
  const blobs = new Map<string, string>()
  const blobsMissing = new Set<string>()
  const blobsInFlight = new Set<string>()

  const nextEntryId = () => `out-${(entrySeq += 1)}`

  /*
   * store 的工厂里定义、工厂外面用:这三件事都要读上面那一堆实例活状态,而那堆状态的
   * 作用域就在这只函数里。声明在 `createStore` **之前**(工厂是同步跑完的,所以出了
   * 那一句它就一定填好了)—— 比把整套活状态提到外层再一路往里传省一整层。
   */
  let internals: {
    load: () => Promise<void>
    onEvent: (envelope: SessionEventEnvelope) => void
    onStream: (payload: SessionStreamPayload) => void
    tearDown: () => void
  } | undefined

  const store = createStore<ChatSourceState>()((set, get) => {
    /**
     * 账本 blob 的**同步**解析器:命中缓存就当场给,没有就安排一次拉取并返回
     * `undefined` —— 折叠器照实留引用(`onMissing:'keep'`),屏幕上那一格是占位,
     * 而占位正是此刻的事实。拉回来之后推一次屏,那一格就补上了。
     */
    function resolveBlob(ref: { hash: string; bytes: number; mime?: string }): string | undefined {
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
          // **blob 世代前进 —— 这是本机器唯一一处**。物化按节点缓存(chat-materialize),
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
        const activeMessageId = projected.activeRun?.messageId
        set({
          status: 'ready',
          error: undefined,
          // R2 新路:合并已经在物化里做完了(每 part 一条 max),这一层不再拼装。
          messages: STREAM_R2 ? base : appendTail(base, tail, tailCoverage()),
          activeMessageId,
          /*
           * 活性读数只对**此刻在跑的那一条**成立。上一轮的静默时刻留在实例那一格
           * 里没关系(下一条 delta 会覆盖它),但绝不许交给屏幕 —— 那会让新一轮
           * 一开张就顶着上一轮的静默秒数。
           */
          lastDeltaAt:
            activeMessageId !== undefined && lastDelta?.messageId === activeMessageId
              ? lastDelta.at
              : undefined,
          overlay,
        })
      })
    }

    /** 按帧合并的推屏 —— 打字上屏的那一拍(**按实例合并**,两条会话各推各的)。 */
    function schedulePush(): void {
      if (pushScheduled) return
      pushScheduled = true
      raf(() => {
        pushScheduled = false
        if (disposed) return
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
        // 会话读**这台机器自己的 id**:它是构造时钉死的事实,不会因为 store 里
        // 那一格此刻是什么而变(单例时代那句 `get().sessionId` 是同一个意思)。
        session: sessionId,
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
              session: sessionId,
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
      if (diverged > 0) scheduleRefold(mine)
    }

    /** 起底 / 重折:整份账本折一遍。`token` 是拆机器 / 再起底的防串号闸。 */
    async function refold(token: number): Promise<void> {
      const mine = fold
      if (!mine) return
      mine.refoldScheduled = false
      mine.lastRefoldAt = Date.now()
      try {
        const port = await chatPort()
        const { events } = await port.listRaw(sessionId)
        // 机器已经拆了 / 又起了一次底:回来的这一份属于上一轮,整份丢掉。
        if (token !== openSeq || fold !== mine || disposed) return
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
        if (token !== openSeq || disposed) return
        set({ status: 'error', error: error instanceof Error ? error.message : String(error) })
      }
    }

    function scheduleRefold(mine: LiveFold): void {
      mine.pending = true
      if (mine.refoldScheduled) return
      mine.refoldScheduled = true
      const token = openSeq
      const wait = Math.max(0, mine.lastRefoldAt + REFOLD_THROTTLE_MS - Date.now())
      setTimeout(() => void refold(token), wait)
    }

    /**
     * 账本活事件来了一条。三种情况(与从前逐条相同):
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
        scheduleRefold(mine)
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

    /**
     * 会话事件到了一条。**没有 `sessionId` 的比对** —— 分发是注册表的活,
     * 到这里的每一条按定义就是这条会话的(单例时代那道过滤是税,不是判据)。
     */
    function onEvent(envelope: SessionEventEnvelope): void {
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
     *
     * 与 `onEvent` 同款:**分发归注册表**,这里不比对 `sessionId`。
     */
    function onStream(payload: SessionStreamPayload): void {
      const chunk = payload.chunk as {
        type?: string
        text?: string
        reasoning?: string
        placement?: 'top' | 'inline'
        messageId?: string
        turnIndex?: number
        toolCallId?: string
        argsTextDelta?: string
        ratio?: number
        outputTail?: string
        message?: string
        stamp?: import('@shared/events/index.js').StreamDeltaStamp
      }
      const messageId = chunk?.messageId
      if (!messageId) return
      /*
       * **活性读数的唯一产地**(§6.6):三种裸 delta 就是「还在往外吐字」的全部证据。
       * 记在这里而不是在下面两条岔路(R2 / 旧路)里各记一次 —— 岔路会长,产地不该
       * 跟着长;判据也只有一句「这一条是不是那三种之一」,与它后面被谁怎么处理无关
       * (没盖章被 R2 丢掉的那种也算 —— 引擎确实在吐字,读数问的正是这件事)。
       * `Date.now()` 而不是 `performance.now()`:读数要和账本上的 `run/start`
       * (墙钟毫秒)相减,两个时基不能混。
       */
      if (
        chunk.type === 'text-delta' ||
        chunk.type === 'reasoning-delta' ||
        chunk.type === 'tool-input-delta'
      ) {
        lastDelta = { messageId, at: Date.now() }
      }
      /*
       * ── C2-b 工具进度:**两条车道之前分流** ────────────────────────────
       *
       * 分在这里而不是各分一次,理由是它与下面那道 `STREAM_R2` 分叉说的不是同一
       * 件事:R2 分的是「正文这一截归水位表还是归活尾巴」,而进度**不是正文** ——
       * 它不带身份章、不进水位、不参与前缀定律,两条路要的是同一份读数。
       *
       * `messageId` 那道闸在它之前(合批器的直送分支替旁路 chunk 盖了那一格,
       * 见 `stream-coalescer.ts` 的 bufferable 表旁注)—— 没盖上的一条本来就没法
       * 落到任何一条消息上。
       */
      if (chunk.type === 'tool-progress') {
        if (!chunk.toolCallId) return
        const progress = {
          ...(chunk.message !== undefined ? { message: chunk.message } : {}),
          ...(chunk.ratio !== undefined ? { ratio: chunk.ratio } : {}),
          ...(chunk.outputTail !== undefined ? { outputTail: chunk.outputTail } : {}),
        }
        if (STREAM_R2) water?.feedToolProgress(messageId, chunk.toolCallId, progress)
        else tail = applyToolProgress(tail, messageId, chunk.toolCallId, progress)
        schedulePush()
        return
      }
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

    /**
     * 起底 + 接上增量。**幂等** —— `fold` 立着就是已经起过底(或正在起)。
     *
     * 推送订阅**不在这里**:全进程只有那一对,住在注册表上(见文件头)。
     * 「先订上再拉」那条纪律一格没动 —— 它现在是 `ensureSubscribed()` 排在
     * `listRaw` 之前这一句(拉的那一刻起的事件不能漏,与 D0 / D1 同一条理由)。
     */
    /**
     * 起底(幂等)。**在飞的那一次由所有调用者共享同一个 promise** —— 见 `opening`。
     */
    function load(): Promise<void> {
      if (opening) return opening
      const started = runLoad()
      opening = started
      void started.finally(() => {
        if (opening === started) opening = undefined
      })
      return started
    }

    async function runLoad(): Promise<void> {
      if (disposed) return
      if (!sessionId) {
        // 没有会话 = 没什么可折的。这台机器恒 idle,屏幕上是那句空态。
        if (get().status === 'idle' && get().messages.length === 0) return
        set({
          status: 'idle',
          error: undefined,
          messages: [],
          activeMessageId: undefined,
          lastDeltaAt: undefined,
        })
        return
      }
      if (fold) return
      // 换会话 = 上一条会话那只「等收尾」的表过期了 —— 现在换会话是换机器,
      // 这一句只在同一台机器上重新起底时用得着(拆机器那口在 dispose 里)。
      if (abortWatch) clearTimeout(abortWatch)
      abortWatch = undefined
      const token = (openSeq += 1)
      fold = newFold()
      water = new StreamWater()
      lastDelta = undefined
      tail = undefined
      tailLens = undefined
      tailReceived = undefined
      pendingLedger = []
      set({ sessionId, status: 'loading', error: undefined, messages: [], activeMessageId: undefined, overlay: [] })

      // 先订上再拉:拉的那一刻起的事件不能漏(与 D0 / D1 同一条理由)。
      await chatSources.ensureSubscribed()
      if (token !== openSeq || disposed) return
      await refold(token)
    }

    /** 真发送 —— 成败都落在那一格 overlay 上,认领由 `reconcileOverlay` 负责。 */
    async function dispatch(entryId: string, target: string, text: string): Promise<void> {
      try {
        const port = await chatPort()
        const result = await port.sendMessage(target, text)
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

    /** 拆机器。幂等 —— 停表、作废在飞的重折、把攒下的活事件丢掉。 */
    function tearDown(): void {
      if (disposed) return
      disposed = true
      if (abortWatch) clearTimeout(abortWatch)
      abortWatch = undefined
      // 号一动,在飞的 `refold` / `scheduleRefold` 回来时全部作废。
      openSeq += 1
      // 在飞的那一次起底作废(它自己会在 token 那道闸上掉头);别把它的 promise
      // 留给下一个 `open()` —— 那会让「等这一次起底办完」等到一次已经被作废的。
      opening = undefined
      fold = undefined
      water = undefined
      tail = undefined
      tailLens = undefined
      tailReceived = undefined
      lastDelta = undefined
      pendingLedger = []
      pushScheduled = false
      blobs.clear()
      blobsMissing.clear()
      blobsInFlight.clear()
    }

    // 内部那几口交给外面那层(实例对象)—— store 之外的世界只认这三件。
    internals = { load, onEvent, onStream, tearDown }

    return {
      sessionId,
      status: 'idle',
      messages: [],
      overlay: [],
      sentTick: 0,

      // 「换当前会话」是注册表的活,不是这台机器的(见类型上的注)。
      open: (next: string) => chatSources.openCurrent(next),

      send: (text, attachments = 0) => {
        const body = text.trim()
        if (!body) return false
        const target = get().sessionId
        if (!target) return false
        const entry = {
          id: nextEntryId(),
          kind: 'pending' as const,
          text: body,
          attachments,
          status: 'sending' as const,
          seenUserIds: userMessageIds(get().messages),
        }
        /*
         * 号与那条 overlay **同一次 `set`**:跟随状态机看到「多了一条」与「这是我发的」
         * 是同一帧的事实,中间不会插进一次别的推屏(赛跑的窗口从来就是这么开的)。
         * 只有真交出去的那一下才 +1 —— 空话与「还没有当前会话」上面已经 return 掉了。
         */
        set((prev) => ({ overlay: [...prev.overlay, entry], sentTick: prev.sentTick + 1 }))
        void dispatch(entry.id, target, body)
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
        const target = get().sessionId
        if (!target) return
        if (!selectEngineBusy(get())) return
        const focus = get().activeMessageId

        void (async () => {
          let failure: string | undefined
          try {
            const port = await chatPort()
            const result = await port.abort(target)
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
            // 机器拆了、或者这一轮已经收了(哪怕换成了下一轮)= 这只表过期了。
            if (disposed || now.sessionId !== target || now.activeMessageId !== focus) return
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
        const target = get().sessionId
        if (!target) return
        set((prev) => ({
          overlay: prev.overlay.map((item) =>
            item.id === entryId
              ? // 重试要重新拍一次快照:上一次之后账本可能已经长出别的用户消息了。
                { ...item, status: 'sending' as const, error: undefined, seenUserIds: userMessageIds(get().messages) }
              : item,
          ),
        }))
        void dispatch(entryId, target, entry.text)
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
        const target = get().sessionId
        if (!target || !messageId) return
        void (async () => {
          let failure: string | undefined
          try {
            const port = await chatPort()
            const result = await port.retryMessage(target, messageId)
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

      reset: () => chatSources.resetAll(),
    }
  })

  const inner = internals!

  return {
    sessionId,
    store,
    getState: () => store.getState(),
    setState: (partial) => store.setState(partial),
    open: () => inner.load(),
    handleEvent: (envelope) => inner.onEvent(envelope),
    handleStream: (payload) => inner.onStream(payload),
    dispose: () => inner.tearDown(),
  }
}

/* ── 注册表:谁活着、活多久、事件分发给谁 ─────────────────────────────── */

interface RegistryEntry {
  source: ChatSource
  /** 还有几个人在看这条会话(hook 一份、`current` 槽一份)。 */
  refs: number
}

const entries = new Map<string, RegistryEntry>()
/** 归零之后排着的那一拍拆卸(键 = sessionId)—— 见 `release` 的注。 */
const sweeping = new Set<string>()
/** **全进程只有这一对**推送订阅(见文件头)。 */
let unsubEvent: (() => void) | undefined
let unsubStream: (() => void) | undefined
let subscribing: Promise<void> | undefined
/** 「当前会话」那一格 + 它自己持的那一份引用。 */
let currentId = ''
let currentRef: ChatSource | undefined
const currentListeners = new Set<() => void>()

function notifyCurrent(): void {
  for (const listener of [...currentListeners]) listener()
}

function ensure(id: string): ChatSource {
  const hit = entries.get(id)
  if (hit) return hit.source
  const source = createChatSource(id)
  entries.set(id, { source, refs: 0 })
  return source
}

/**
 * **持有一份**:机器活着,但**不起底**。
 *
 * 「有人在读这台机器」与「这条会话该载入」是两件事:读一格 `sentTick` 不该把一条
 * 会话拉起来(测试里摆好的状态会被那一下的 `listRaw` 冲掉,真机上则是「谁都能顺手
 * 起一条会话」)。起底那一下由**摆这片叶的人**说了算,见 `acquire`。
 */
function retain(id: string): ChatSource {
  const source = ensure(id)
  entries.get(id)!.refs += 1
  return source
}

/**
 * **持有一份并起底** —— 「这一片叶要看这条会话」。
 * 起底幂等:第二片叶开同一条会话不会让它再拉一次 `listRaw`。
 */
function acquire(id: string): ChatSource {
  const source = retain(id)
  void source.open()
  return source
}

/**
 * 少一个看客。归零**不当场拆** —— 排下一拍(微任务)再看:同一次提交里「先卸后挂」
 * (React StrictMode 的双调用、换 `key`、换会话时先跑完所有 cleanup 再跑所有 setup)
 * 在那一拍之前就已经把引用加回来了,于是机器原样留着。
 *
 * 判据是**次序**不是时间窗:一次重挂的卸载与再挂载排在同一个宏任务里,微任务一定
 * 排在它们之后 —— 这与 `focus/registry.ts` 的 `pendingUnregister` 是同一条判例。
 */
function release(id: string): void {
  const entry = entries.get(id)
  if (!entry) return
  entry.refs = Math.max(0, entry.refs - 1)
  if (entry.refs > 0) return
  if (sweeping.has(id)) return
  sweeping.add(id)
  queueMicrotask(() => {
    sweeping.delete(id)
    const still = entries.get(id)
    if (!still || still.refs > 0) return
    entries.delete(id)
    still.source.dispose()
  })
}

function ensureSubscribed(): Promise<void> {
  subscribing ??= (async () => {
    const port = await chatPort()
    await port.ready()
    if (unsubEvent) return
    unsubEvent = port.onSessionEvent(dispatchSessionEvent)
    unsubStream = port.onSessionStream(dispatchSessionStream)
  })()
  return subscribing
}

/**
 * **分发 —— 从前那两处 `!== get().sessionId` 的过滤,现在是这一句查表**。
 *
 * 收件人不在表上(那条会话没人在看)= 丢掉,和从前一模一样;区别是从前只有
 * 「当前那一条」能收,现在每一条打开着的会话各收各的。
 */
function dispatchSessionEvent(envelope: SessionEventEnvelope): void {
  entries.get(envelope.sessionId)?.source.handleEvent(envelope)
}

function dispatchSessionStream(payload: SessionStreamPayload): void {
  entries.get(payload.sessionId)?.source.handleStream(payload)
}

function unsubscribeAll(): void {
  unsubEvent?.()
  unsubStream?.()
  unsubEvent = undefined
  unsubStream = undefined
  subscribing = undefined
}

/**
 * **谁在看哪条会话、看多久** —— 一条会话的数据机器的生命周期全在这张表上。
 *
 * 它是**进程级**的一格,和 `chatPort` 那只惰性单例同源:机器的寿命由看客决定,
 * 而看客散落在 React 树里,总得有一处替它们记账。表本身没有可渲染状态 ——
 * 唯一会变的那格(`current`)有自己的订阅口。
 */
export const chatSources = {
  /** 「这一片叶要看这条会话」:拿一份并起底,用完 `release`。 */
  acquire,
  /** 「我只是要读它」:拿一份但不起底(见 `retain` 的注),用完 `release`。 */
  retain,
  release,
  /** 只看不持有:表上没有就是 undefined(不造)。 */
  get: (id: string): ChatSource | undefined => entries.get(id)?.source,
  /** 造一台但不持有 —— 渲染期要有东西可读,持有那一份由 effect 补上。 */
  ensure,
  ensureSubscribed,
  /** 「当前会话」是哪条。 */
  currentSessionId: (): string => currentId,
  /**
   * 「当前会话」那台机器。**惰性**:第一次问的时候才造(空会话那一台也是一台,
   * 它恒 idle)。返回值在 `current` 没换人之前是同一个对象 —— `useSyncExternalStore`
   * 的快照契约要的正是这一条。
   */
  currentSource: (): ChatSource => {
    if (!currentRef) currentRef = acquire(currentId)
    return currentRef
  },
  subscribeCurrent: (listener: () => void): (() => void) => {
    currentListeners.add(listener)
    return () => void currentListeners.delete(listener)
  },
  /**
   * 换「当前会话」。今天由唯一在场的那片会话叶宣布(`ChatStream` 的 effect),
   * W5-b 换成焦点叶投影。**先取后放**:同一条会话时是恒等,换人时新的先立住,
   * 旧的才松手(不然中间那一拍会把机器拆了又造)。
   */
  setCurrent: (id: string): ChatSource => {
    if (currentRef && currentId === id) return currentRef
    const next = acquire(id)
    const prev = currentRef
    currentId = id
    currentRef = next
    notifyCurrent()
    if (prev) release(prev.sessionId)
    return next
  },
  /** 兼容口:换当前会话并等它起底(`ChatSourceState.open` 的落点)。 */
  openCurrent: (id: string): Promise<void> => chatSources.setCurrent(id).open(),
  /** 测试用:整张表回到未启动的干净态(退订 + 拆掉每一台机器)。 */
  resetAll: (): void => {
    unsubscribeAll()
    for (const entry of [...entries.values()]) entry.source.dispose()
    entries.clear()
    sweeping.clear()
    currentRef = undefined
    currentId = ''
    notifyCurrent()
  },
  /** 只读快照:表上此刻有哪几条会话(测试与排障用)。 */
  ownedIds: (): string[] => [...entries.keys()],
}

/* ── React 那半边 ─────────────────────────────────────────────────────── */

/**
 * **读一条会话的数据源**。
 *
 * 两件事一句话做完:渲染期 `ensure` 保证有东西可读(第一帧就拿得到那条会话自己的
 * 空态,而不是上一条会话的树);挂载期 `retain` 持有一份引用,卸载时归还 ——
 * 所以「读」与「活多久」不会分家(读了不持有 = 机器可能在你眼皮底下被拆掉)。
 *
 * **读不起底**:起底是「摆这片叶的人」说的(`chatSources.acquire`),不是读的人 ——
 * 否则任何一处顺手读一格都会把一条会话拉起来。
 *
 * **留账**:渲染期造出来、effect 却没跑到(组件在提交与副作用之间就被丢弃)的那一格
 * 会留在表上。它是**惰的** —— 没起底、没订阅、没表、没 rAF 环,只占一个 Map 键;
 * 拿微任务去扫它反而危险(React 的 passive effect 排在宏任务里,扫掉的正是这一帧
 * 渲染刚拿到手的那台)。`resetAll()` 会清掉它们。
 */
export function useChatSourceOf<T>(sessionId: string, selector: (state: ChatSourceState) => T): T {
  const source = chatSources.ensure(sessionId)
  useEffect(() => {
    chatSources.retain(sessionId)
    return () => chatSources.release(sessionId)
  }, [sessionId])
  return useStore(source.store, selector)
}

/**
 * **读「当前会话」的数据源**(兼容面)。
 *
 * 全局面(输入面板的忙态)与非组件写法的缺省都读这一格。它不是第二台机器 ——
 * 它就是 `current` 槽指着的那一台。W5-b 把 `current` 换成焦点叶投影之后,
 * 这只 hook 与三个自由函数的缺省一起退役,消费者改成显式传会话 id。
 */
function useCurrentChatSource<T>(selector: (state: ChatSourceState) => T): T {
  const source = useSyncExternalStore(
    chatSources.subscribeCurrent,
    chatSources.currentSource,
    chatSources.currentSource,
  )
  return useStore(source.store, selector)
}

export const useChatSource = Object.assign(useCurrentChatSource, {
  getState: (): ChatSourceState => chatSources.currentSource().getState(),
  setState: (partial: Partial<ChatSourceState>): void =>
    chatSources.currentSource().setState(partial),
})

/**
 * **HMR 退役**(09-01,性能调查坐实:同一帧里出现两个不同 `?t=` 版本的 chat-source
 * 各自的 rAF 回调 —— 热更之后旧模块的订阅与推屏环没死,两台折叠器同时活着各自推屏)。
 *
 * 这个文件的**模块级副作用**全部收在注册表上了:那对推送订阅、每台机器的按帧
 * 合并 rAF 环、`abortWatch` 那只表、整张实例表。它们的寿命是「这个模块实例」,
 * 而热更换的正是模块实例 —— 不退役,旧实例的订阅照收事件、照推屏,而它的折叠状态
 * 永远停在换模块那一刻,与新实例交替上屏。
 *
 * 退役直接用注册表已有的那一口 `resetAll()` —— 别写第二套拆卸逻辑(两套拆卸迟早
 * 漏一格)。它自身幂等,重复调用无害。
 *
 * 生产构建里 `import.meta.hot` 是 undefined,整段被 tree-shake 掉。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    chatSources.resetAll()
  })
}

/**
 * 非组件上下文的写法(composer store 的接缝就是这一口)。
 *
 * `sessionId` 缺省 = 「当前会话」。W5-b 之后 composer 会显式传焦点叶那一条 ——
 * 参数排在最后而不是最前,正是为了那一天能一处一处地换过去而不惊动别的调用点。
 */
export function sendChatMessage(text: string, attachments = 0, sessionId?: string): boolean {
  return sourceFor(sessionId)?.getState().send(text, attachments) ?? false
}

export function pushChatNotice(kind: 'ask-rejected', sessionId?: string): void {
  sourceFor(sessionId)?.getState().notice(kind)
}

/** 同上,给输入面板那条接缝(composer/sink.ts)用的非组件写法。 */
export function abortChatRun(sessionId?: string): void {
  sourceFor(sessionId)?.getState().abort()
}

/** 缺省 = 当前会话那一台;显式给了 id 就只认表上那一台(没有就什么都不做)。 */
function sourceFor(sessionId: string | undefined): ChatSource | undefined {
  return sessionId === undefined ? chatSources.currentSource() : chatSources.get(sessionId)
}
