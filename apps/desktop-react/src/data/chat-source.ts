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
import type { PermissionResponse } from '@shared/ipc/permissions'
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
import {
  askFromPendingInfo,
  askFromRequestEvent,
  NO_PERMISSION_ASKS,
  type PermissionAsk,
} from './permission-ask'
import { chatPort } from './chat-port'
import {
  applyToolResultBody,
  pageResultKey,
  rehangPageResults,
  type PageResultReference,
} from './page-results'
import { onSessionsDeleted } from './sessions-source'
import { readSessionScrollAnchor } from './session-view-state'
import { markFirstScreenLanded, markFirstScreenPending } from './first-screen'
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
 *    归零后延迟一拍(微任务)再收 —— 所以「同一次提交里先卸后挂」(React
 *    StrictMode / 换 key)不会把机器拆了重建,判据是**次序**不是时间窗
 *    (与 `focus/registry.ts` 的 `pendingUnregister` 同一条判例)。
 *    **那一拍收走的去处是停靠池,不是 `dispose`**(C1 · §5.1,见下面「停靠池」
 *    那一节):最近看过的几条留在内存里照收事件,切回来零加载;
 *    真正的拆卸只发生在被挤出池、会话没了、或整表重置的时候;
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
 *
 * ── 重试的两道闸(2026-09-08 事故立)────────────────────────────────────
 * 这只文件里所有的忙态都是派生的,只有 `retryPending` 那一格是自己记的账 ——
 * 它说的正是「账本上还什么都没有」,而那段真空按定义推导不出来(为什么它不能是
 * 派生量,写在 `ChatSourceState.retryPending` 上)。两道闸与三条清闩路的全文在
 * `regenerate` 的注里;`stream:error` 为什么只在闩在时被当成回音、闩不在时为什么
 * 一个字都不改,写在 `onEvent` 的终止分支上。
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
 * **一页拉几条**(工单 5 ③)。
 *
 * 与 `content/chat-window.ts` 的 `CHAT_TAIL_WINDOW` 是**同一个数、两个产地**,
 * 而这正是有意的:那一格说的是「这一帧摆几条 DOM」(渲染预算),这一格说的是
 * 「一次往返带几条回来」(取数预算)。今天两者都是 24,凑成一个常量只会让下一个
 * 人调错那一头 —— 判据与后端 `TAIL_PAGE_LIMIT_DEFAULT` 那一段逐字同源。
 */
export const CHAT_PAGE_LIMIT = 24

/**
 * 一次取页**最多翻几页**(工单 5 ⑤⑦)。
 *
 * 两个调用点共用它,因为它们要的是同一件事「往前够到某一条为止」:冷载够
 * **锚点**(上次看到哪儿),缺号重取够**手里最老的那一条**(重取之后屏幕上此前
 * 有的东西还得在)。
 *
 * 有封顶而不是翻到底:锚点可能指着几百条之前的消息,为了它把整条会话拉回来正是
 * 本单在治的病。够不到就到此为止 —— 冷载那一次表现为落底(人回到的是最新那一屏),
 * 重取那一次表现为屏幕上少了最前面几条(而它们由上翻取页随时补得回来)。
 * 两种都是诚实的降级,不是失败。
 */
export const CHAT_PAGE_HUNT_LIMIT = 8

/**
 * 按了停止之后,等这一轮收尾的宽限。超时只说一句话(warn),**不重发、不清尾巴**
 * —— 收尾归账本(`run/end` 会到),壳这边做乐观清理就是画一个和事实不符的屏幕。
 */
export const ABORT_SETTLE_MS = 3000

/**
 * 按了重试、core 收下之后,等账本长出新一轮的宽限。与 `ABORT_SETTLE_MS` 并排,
 * 判据也逐条同源:超时**只说一句话**(warn),不重发、不改屏幕 —— 新一轮开没开
 * 是账本说了算(`run/start`),壳这边乐观地画一个「在跑」就是画一个和事实不符的屏幕。
 *
 * 它同时是那道在飞闩的**保险丝**:三条清闩路里只有这一条不依赖 core 再说一句话,
 * 所以 core 收下命令之后一声不吭(2026-09-08 那条 129 秒的 deepseek 请求就是这一形)
 * 时,重试钮不会永远灰着。
 */
export const RETRY_SETTLE_MS = 3000

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
   * **审批车道**:此刻挂在这条会话上的权限卡,按 `toolCallId` 对齐
   * (为什么它不长在折叠产物的 toolCall 上,写在 `data/permission-ask.ts` 头上)。
   *
   * 两个进料口,一条纪律(**写就地更新,重拉对账**):活事件
   * (`permission:request` / `queued` / `settled` / `timeout`)就地改这一格;
   * 每一次起底与每一次缺号重折之后,`permission.getPending` 整份对一次账 ——
   * 冷载与断线补发都会让壳错过那条活事件,而漏掉一张卡的样子是「工具永远停在
   * 执行中、引擎在那头一直等」。
   */
  permissions: Readonly<Record<string, PermissionAsk>>
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
   * **正在生成的那条消息上一次收到 delta 的时刻**(§6.6)。
   *
   * 与 `messages` 同一次 `set` 写出去 —— 也就是说它跟着按帧合并的推屏走,
   * 每条 delta 各推一次 store 那种事不会发生(那正是这个文件把活折留在实例上、
   * 不塞进 store 的理由)。没有在跑的 run、或者这一轮一个 delta 都还没到时是
   * `undefined`:调用方该退到 `run/start` 的时刻,而不是拿 0 当「刚刚」。
   *
   * **它说的是「模型又吐了一段」,不是「这一轮还活着」**(2026-09-09 分家):
   * 唯一的消费者是跟随状态机那一拍「回复到了」(`ChatStream` 的 `useFollowBottom`)
   * —— 工具跑着不该点亮跟随丸的那张脸。「还活着吗」由下面的 `lastActivityAt` 答。
   */
  lastDeltaAt?: number
  /**
   * **这一轮最近一次有东西到达的时刻**(2026-09-09 立,活性读数的产地)。
   *
   * ── 为什么它与 `lastDeltaAt` 是两格 ──────────────────────────────────────
   * 事故:真店会话 fe5261d9 的一轮里模型不到 1 秒就发了工具调用,bash 跑了 7 秒、
   * 卡片一直在刷输出,读数行却说「已 7.0s 没有新内容」—— 因为那一格只认三种文字
   * delta,工具执行期间到达的东西一件都不算。用户裁定:**工具进度计入活性**。
   * 但「回复到了」那一拍不能跟着改语义(工具跑着不是模型又说了话),所以不是把
   * `lastDeltaAt` 放宽,而是另立这一格:两件事实,各有各的唯一消费者。
   *
   * 算数的四类来源(全部经 `markActivity` 这一只帮手写):三种裸 delta ∪
   * `tool-progress` 快照 ∪ 活 run 的工具账本事件 ∪ `tool:input-start`。
   *
   * 其余与 `lastDeltaAt` 逐字相同:跟着按帧合并的推屏走;不是此刻活消息的就交
   * `undefined`(调用方退到 `run/start` 的时刻,而不是拿 0 当「刚刚」)。
   */
  lastActivityAt?: number
  /**
   * **「我发出去一条重试,还没见回音」**(2026-09-08 立)。
   *
   * ── 为什么它是一格事实,不是派生量 ──────────────────────────────────────
   * 这台机器身上别的忙态(`selectEngineBusy`)全是派生的,判据在账本上 —— 而这一格
   * 恰恰说的是「账本上**还什么都没有**」:命令已经离开壳、core 也收下了(`success`),
   * 但账本上既没有新的 `run/start`、也没有任何一条 `stream:error`。这段真空**没有任何
   * 账本事实可以推导它**,所以它只能是一格自己记的账。
   *
   * 事故背书:会话 ef079fd7 一条请求发出去 129 秒一个字节没回,用户连点了十几次重试,
   * 每一下都变成一条 core 当场答 `success` 的命令 —— 而引擎要么在忙、要么目标消息已被
   * 上一次重试删掉,只回一条 `stream:error`,壳这边零反馈。
   *
   * 三条清闩路写在 `regenerate` 的注里,`RETRY_SETTLE_MS` 是其中的保险丝。
   */
  retryPending?: { messageId: string; at: number }
  /**
   * **已装载那一页之上还有没有更早的消息**(工单 5 ⑥)。
   *
   * 产地是页那条读法的 `hasMoreBefore`,不是「消息够不够多」—— 后者答不出这个
   * 问题(一条 400 条的会话,本地手里那 24 条与「上面还有」是两件事)。
   * 走整份账本那条老路时恒 `false`:那一次手里就是全部。
   */
  hasMoreBefore: boolean
  /**
   * **正在取上一页**。列表顶端那一行读数照它换措辞(**禁 spinner** —— 列表/卡的
   * 加载态用文字,规范禁令第一条)。
   */
  loadingOlder: boolean
  /**
   * **又往前接了一页**(单调号)。与 `sentTick` 同族:订阅方要的是「刚刚发生了
   * 一次 prepend」这件**事**,而 store 里只放得下状态。`ChatStream` 拿它当那一格
   * 扩窗补偿的触发沿 —— 拿 `messages.length` 的差去猜是猜(账本追上来、overlay
   * 认领、重折三条路都会让长度变)。
   */
  olderTick: number
  /**
   * **大结果此刻取到哪一步**,键与页里那张侧表同源(`pageResultKey`)。
   *
   * 只有两档在表上:`'loading'`(在飞)与 `'failed'`(读不到)。**取成功的那一格
   * 不在这里** —— 它落在消息本身上(就地换掉那一格),而「已拉」这件事在屏幕上
   * 的形状就是那段正文出现了。存两份迟早分叉(与 `selectEngineBusy` 那条同判)。
   */
  toolResults: Readonly<Record<string, 'loading' | 'failed'>>

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
   *
   * 返回 `true` = 这一下真的交出去了(命令离开了壳)。`false` 的两种意思都是
   * 「被闸挡住了,一个字节都没发」:引擎在跑,或者上一条重试还没见回音。
   */
  regenerate: (messageId: string) => boolean
  /**
   * 答一张权限卡。`decision` 的五档与 `Permission.Response` 逐字同形。
   *
   * 三条纪律,每条都有出处:
   *  1. **发出去之前先把卡置成「已答」**(交互稳定律③:异步动作必有进行中反馈)。
   *     卡上那一排键当场变成一句「已允许 / 已拒绝」,连点第二下点不着;
   *  2. **收尾归事件,不归这一发的应答** —— `permission:settled` 才是「核心认下了」
   *     的唯一凭据,而它同样会在**别人**答掉(网关回 1/2/3、超时自结算)时到达。
   *     拿 emit 的返回值清卡等于把「命令送到了」当成「审批结算了」;
   *  3. 命令**发不出去**(网断 / core 拒收)才回滚这一格并说一句 —— 人点了允许而
   *     它没允许,这件事必须让人知道(与 `abort` 那一段逐字同判)。
   */
  respondPermission: (toolCallId: string, decision: PermissionResponse) => void
  /**
   * **再往前接一页**(工单 5 ⑥)。幂等 —— 已经在取、或者上面没有了,就是恒等。
   *
   * 返回 `true` = 这一下真的发出去了(调用方据此知道要不要留一格补偿)。
   */
  loadOlder: () => boolean
  /**
   * **取一格大结果的正文**(工单 5 ②)。页里超过内联预算的结果只带
   * `{bytes, hash, preview}`,工具卡被展开的那一刻调它。
   *
   * 幂等:同一格在飞时不重发,取回来过就当场返回。取回来之后**就地换掉**挂着
   * 那枚引用的那几条消息(律①③:禁清屏),别的一格不动。
   */
  fetchToolResult: (ref: PageResultReference) => void
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

/**
 * **自己会造节点**的那几类账本事件(工单 5 ③)。
 *
 * 判据抄的是 core 归约器里那几支 `register(state, node)` 的 case —— 它们不问
 * 「这条 run/消息在不在」,所以在一份空状态上照样落得下。别的事件都指着一条
 * 已经在的节点,判据见 `ledgerLandsOnFold`。
 */
const NODE_CREATING_LEDGER_TYPES = new Set([
  'run/start',
  'user/message',
  'system/message',
  'message/imported',
  'user/message-edited',
  'session/created',
])

/** 空表共用一只 —— 每次新造一个会让下游的浅比全部落空(与 `NO_PERMISSION_ASKS` 同款)。 */
const NO_TOOL_RESULT_FETCHES: Readonly<Record<string, 'loading' | 'failed'>> = Object.freeze({})

/**
 * 对账回来的那一份与屏幕上这一份**说的是不是同一件事**。
 *
 * 存在的理由只有一条:律④(身份稳定)。`getPending` 每次都造一批新对象,直接
 * `set` 会让每一次重折都把整条车道换一遍身份 —— 而九成的重折里审批一格没变。
 * 逐格比六个可比的标量(`pattern` 是数组时按逐字序列比,它由后端原样给出、
 * 同一次 ask 的两次投影必然同序)。
 */
function samePermissionLane(
  a: Readonly<Record<string, PermissionAsk>>,
  b: Readonly<Record<string, PermissionAsk>>,
): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const key of keys) {
    const x = a[key]
    const y = b[key]
    if (!y) return false
    if (
      x.permissionId !== y.permissionId ||
      x.title !== y.title ||
      x.type !== y.type ||
      x.permissionQueued !== y.permissionQueued ||
      x.canRespond !== y.canRespond ||
      x.answered !== y.answered ||
      x.alwaysScope?.scheme !== y.alwaysScope?.scheme ||
      String(x.pattern) !== String(y.pattern)
    ) {
      return false
    }
  }
  return true
}

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
   * **上一次「有东西到达」的时刻**(按消息记,2026-09-09)。与 `lastDelta` 同样
   * 是实例字段、同样由 `compose()` 一帧最多搬一次 —— 理由逐字相同(工具进度在
   * 长输出上比正文 delta 还密,每条各推一次 store 就是每条一次全体订阅者重算)。
   *
   * 写点只有 `markActivity` 一处;`lastDelta` 那一格照旧只由三种裸 delta 写。
   */
  let lastActivity: { messageId: string; at: number } | undefined
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
  /**
   * 「按了重试,还在等账本开新一轮」的那只表。与 `abortWatch` 同款:实例字段,
   * 因为**表本身**不是可渲染状态 —— 屏幕要的是 `retryPending` 那一格,不是这只表。
   */
  let retryWatch: ReturnType<typeof setTimeout> | undefined
  /**
   * **页那一路交下来的底稿**(工单 5 ③):core 侧折好的那一页消息。
   *
   * `undefined` = 这一台走的是整份账本那条老路(见 `loadPage` 里那道
   * `activeMessageId` 闸),屏幕上那棵树全部来自活折。
   *
   * 它与活折的关系是**前缀与后缀**:底稿是水位那一刻为止的事实,活折是水位之后
   * 长出来的那几条。合并规则一句话(`mergePageAndFold`):同 id 的以活折为准
   * (它更新),活折里没有的按底稿的次序留着,底稿里没有的追加在后面。
   */
  let pageBase: ProjectedMessage[] | undefined
  /** 上一页从哪要 + 上面还有没有(页那条读法交下来的两格,原样存)。 */
  let pageCursor: { hasMoreBefore: boolean; nextBefore?: string } = { hasMoreBefore: false }
  /** 正在取上一页(实例字段:屏幕要的是 store 那一格,不是这只闸)。 */
  let loadingOlder = false
  /**
   * **已经取回来的大结果正文**,键与页里那张侧表逐字同源(`pageResultKey`)。
   *
   * 存在这一层而不是消息上:上翻取回来的那些页要重新挂一遍侧表,而「这一格
   * 早就取过了」不该跟着页一起丢 —— 与 `blobs` 那张表同一条理由、同一个位置。
   */
  const resultBodies = new Map<string, unknown>()
  const resultFetching = new Set<string>()
  /** 起底 / 重折的防串号闸(也是 `dispose` 作废在飞回调的那一手)。 */
  let openSeq = 0
  /**
   * **审批车道改过几次** —— 对账那一发的防串号闸(判据写在 `patchPermissions` 与
   * `reconcilePermissions` 上)。实例字段而不是 store 字段:没有任何控件读它,
   * 它是这台机器的簿记,不是可渲染状态。
   */
  let permissionRev = 0
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
    /**
     * 停掉那只「等新一轮」的表。三条清闩路各自调它一次 —— 表与 `retryPending`
     * 那一格同生共死,少停一次就是一发过期的 warn 飞出去。
     */
    function clearRetryWatch(): void {
      if (retryWatch) clearTimeout(retryWatch)
      retryWatch = undefined
    }

    /**
     * **底稿 ∪ 活折**(工单 5 ③ 的接缝在数据这一侧的形状)。
     *
     * 冷载之后活折是空的,所以这一口当场返回底稿本体 —— **连数组对象都是原来
     * 那个**,下游那些按引用短路的 memo 一格没 miss(律④)。SSE 长出新消息之后
     * 才真的合一次:同 id 以活折为准(水位之后它更新),其余按底稿次序留着,
     * 活折里的新面孔追加在后。
     *
     * 结果按 `(底稿, 活折)` 记一格 memo:`compose()` 挂在逐帧的推屏上,合并本身
     * 不该每帧重造一个新数组(那等于把上面那句「引用短路」再毁一次)。
     */
    let mergeMemo: { base: readonly ProjectedMessage[] | undefined; folded: readonly ProjectedMessage[]; out: ProjectedMessage[] } | undefined
    function mergePageAndFold(
      base: ProjectedMessage[] | undefined,
      folded: ProjectedMessage[],
    ): ProjectedMessage[] {
      if (!base) return folded
      if (folded.length === 0) return base
      if (mergeMemo && mergeMemo.base === base && mergeMemo.folded === folded) return mergeMemo.out
      const byId = new Map(folded.map(message => [message.id, message]))
      const out: ProjectedMessage[] = []
      for (const message of base) {
        const live = byId.get(message.id)
        if (live) {
          out.push(live)
          byId.delete(message.id)
        } else out.push(message)
      }
      for (const message of folded) if (byId.has(message.id)) out.push(message)
      mergeMemo = { base, folded, out }
      return out
    }

    /**
     * 那张取件表上一格的进出。**空表共用一只**(下游浅比要它),没变就不推 ——
     * 每次都造一个新对象等于每次都推一次全体订阅者。
     */
    function patchToolResultFetch(key: string, state: 'loading' | 'failed' | undefined): void {
      const prev = get().toolResults
      if (prev[key] === state) return
      const next = { ...prev }
      if (state === undefined) delete next[key]
      else next[key] = state
      set({ toolResults: Object.keys(next).length === 0 ? NO_TOOL_RESULT_FETCHES : next })
    }

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
        const base = mergePageAndFold(pageBase, projected.messages)
        const overlay = reconcileOverlay(get().overlay, base)
        const activeMessageId = projected.activeRun?.messageId
        /*
         * **清闩路 ①:账本开了新一轮**。「重试真的落地了」这件事在账本上就是活牌
         * 从无到有(`run/start`),而活牌的产地只有这一处(见 `selectEngineBusy` 的注)
         * —— 判「它变没变」就该守在同一处,守在 `feedLedger` 里是开第二个会分叉的产地。
         */
        const opensNewRun =
          get().activeMessageId === undefined &&
          activeMessageId !== undefined &&
          get().retryPending !== undefined
        if (opensNewRun) clearRetryWatch()
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
          // 同一条闸,同一条理由 —— 两格事实分家的只是「什么算一次」,不是「归谁」。
          lastActivityAt:
            activeMessageId !== undefined && lastActivity?.messageId === activeMessageId
              ? lastActivity.at
              : undefined,
          overlay,
          // 条件展开而不是恒写 undefined:恒写就是每一帧都把闩清一遍。
          ...(opensNewRun ? { retryPending: undefined } : {}),
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

    /**
     * 起底 / 缺号重取的**唯一入口**(工单 5 ③⑤)。
     *
     * 两条路,判据一句话:**页那条路走得通就走页**。
     *
     *  · 走得通 = core 给得出那一页,而且水位那一刻**没有一条开着的 run**
     *    —— 后者是硬判据不是偏好:页交下来的是折好的消息,壳按水位接 SSE 是
     *    「在一份空状态上接着折」,而一条**在水位之前就开张**的 run,它后面的
     *    delta 在空状态上一条都落不下(归约器 `state.runs.get` 落空就 break)。
     *    那一次只能整份折,所以那一次退回老路;
     *  · 缺号重取按**已装载的范围**重取(而不是整份 `listRaw`):页边界靠
     *    「必须盖住此刻手里最老的那一条」对齐 —— 游标是账本位置,新消息到达之后
     *    尾页会往后滑,拿条数对齐会漏一截,拿**那一条消息**对齐不会。
     */
    async function resync(token: number): Promise<void> {
      const mine = fold
      if (!mine) return
      mine.refoldScheduled = false
      mine.lastRefoldAt = Date.now()
      // 冷载盖锚点(⑦),缺号重取盖手里最老的那一条(⑤)。两次问的是同一个问题:
      // 「重取回来之后,屏幕上此前有的东西还得在」。
      if (await runPageLoad(token, pageBase?.[0]?.id ?? anchorMessageId())) return
      if (token !== openSeq || fold !== mine || disposed) return
      await refoldFromLedger(token)
    }

    /** 这一台此刻记着的锚点(冷载够页用)。`'bottom'` 与没有锚点是同一件事。 */
    function anchorMessageId(): string | undefined {
      const anchor = readSessionScrollAnchor(sessionId)
      return anchor && anchor !== 'bottom' ? anchor.messageId : undefined
    }

    /**
     * **拉页**:尾页,必要时再往前翻几页把 `cover` 那一条也盖进来。
     *
     * @returns `false` = 这一次页这条路不作数(有开着的 run / 读不到),调用方退回
     *          整份账本那条老路。**一个字节都没写进这台机器**,所以退回去是干净的。
     */
    async function runPageLoad(token: number, cover: string | undefined): Promise<boolean> {
      const mine = fold
      if (!mine) return false
      let collected: ProjectedMessage[] = []
      let cursor: { hasMoreBefore: boolean; nextBefore?: string } = { hasMoreBefore: false }
      let watermark = 0
      try {
        const port = await chatPort()
        for (let hunted = 0; hunted < CHAT_PAGE_HUNT_LIMIT; hunted += 1) {
          const before = hunted === 0 ? undefined : cursor.nextBefore
          if (hunted > 0 && !before) break
          const page = await port.readPage(sessionId, {
            limit: CHAT_PAGE_LIMIT,
            ...(before ? { before } : {}),
          })
          if (token !== openSeq || fold !== mine || disposed) return true
          // 见 `resync` 的注:开着的 run 那一次页这条路不成立,而且**第一页就知道**。
          if (page.activeMessageId) return false
          const older = rehangPageResults(page.messages, page.results, resultBodies)
          collected = hunted === 0 ? older : [...older, ...collected]
          if (hunted === 0) watermark = page.watermark
          cursor = {
            hasMoreBefore: page.hasMoreBefore,
            ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}),
          }
          if (!cover || collected.some(message => message.id === cover)) break
          if (!page.hasMoreBefore) break
        }
      } catch {
        // 读不到就退回老路 —— 那一条路还是今天那一条,不是一次降级(它是全集)。
        return false
      }
      if (token !== openSeq || fold !== mine || disposed) return true

      pageBase = collected
      pageCursor = cursor
      mergeMemo = undefined
      mine.state = createSessionProjectionState()
      mine.lastSeq = watermark
      mine.pending = false
      // 与整份那条路逐字同一句:新折叠可能已经装下了尾巴前面那一截。
      handOverTail(mine.state)
      const drained = pendingLedger
      pendingLedger = []
      drained.sort((a, b) => ((a.seq as number) ?? 0) - ((b.seq as number) ?? 0))
      for (const record of drained) feedLedger(record)
      set({ hasMoreBefore: cursor.hasMoreBefore })
      compose()
      void reconcilePermissions(token)
      return true
    }

    /** 起底 / 重折:整份账本折一遍。`token` 是拆机器 / 再起底的防串号闸。 */
    async function refoldFromLedger(token: number): Promise<void> {
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
        // 整份那条路手里就是全部 —— 底稿退场(留着就是同一棵树两个产地),
        // 「上面还有更早的」跟着变成 false。
        pageBase = undefined
        pageCursor = { hasMoreBefore: false }
        mergeMemo = undefined
        set({ hasMoreBefore: false })
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
        /*
         * 审批车道跟着对一次账。**不 await**:它是另一条链上的事实(引擎内存里
         * 挂着的 prompt),让它去拖住起底那一发的 promise,就是让「消息上屏」
         * 等一件与消息无关的往返。理由与 mutation 的 `settle` 不被 await 同源。
         */
        void reconcilePermissions(token)
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
      setTimeout(() => void resync(token), wait)
    }

    /**
     * **活性的唯一写点**(2026-09-09)。四个调用点各写了一句「为什么这一条算活动」;
     * 这里只答两件事:记 `messageId`(换一条消息就是换一轮,上一轮的静默时长对这一轮
     * 没有意义)、用 `Date.now()`(读数要和账本上的 `run/start` 相减,时基不能混)。
     *
     * 收成一只帮手而不是四处各写一句 `lastActivity = …`:判据「什么算一次活动」写在
     * 调用点上(它们本来就各不相同),而「怎么记一次活动」只该有一处 —— 第五类来源
     * 长出来时加的是第五个调用点,不是第二种记法。
     */
    function markActivity(messageId: string): void {
      lastActivity = { messageId, at: Date.now() }
    }

    /**
     * **这一条落得到手里这份折叠上吗**(工单 5 ③ 接缝的另一半)。
     *
     * 走页那条路时活折是**空状态 + 水位**:它只装得下水位之后**自己造节点**的
     * 那些事件(`run/start` 开一条 run、`user/message` 落一条消息)。一条指着
     * 水位之前那条 run / 那条消息的事件(某条老 run 的 `run/end`、给一条老消息
     * 打的 `message/patched`)在空状态上是**静默 no-op** —— 归约器 `.get()` 落空
     * 就 break,不报错、不留痕,屏幕从此与账本分家。
     *
     * 所以这里在折之前先问一句。判据只认两格**明说出来的地址**(`runId` /
     * `messageId`),认不出地址的一律放行 —— 认不出就说明它不指着任何一条,
     * 折进去是安全的。
     *
     * 整份账本那条路上这只函数恒 `true`:那份状态里什么都有。
     */
    function ledgerLandsOnFold(mine: LiveFold, record: Record<string, unknown>): boolean {
      if (!pageBase) return true
      const type = record.type
      if (typeof type !== 'string') return true
      // 会话级重写(清空 / 压缩):它们改的是**整棵树**,不是某一格 —— 重取。
      if (type === 'session/cleared' || type === 'session/compacted') return false
      if (NODE_CREATING_LEDGER_TYPES.has(type)) return true
      const data = record.data as Record<string, unknown> | undefined
      const runId = data?.runId
      if (typeof runId === 'string') return mine.state.runs.has(runId)
      const messageId = data?.messageId
        ?? (data?.message as Record<string, unknown> | undefined)?.id
      if (typeof messageId === 'string') return mine.state.byMessageId.has(messageId)
      return true
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
      if (!ledgerLandsOnFold(mine, record as Record<string, unknown>)) {
        // 这一条说的是**水位之前**的那一段(见 `ledgerLandsOnFold`)—— 折不下去,
        // 重取一次页(节流)。丢掉它、或者硬折一遍,两种都是让屏幕与账本分家。
        scheduleRefold(mine)
        return
      }
      mine.state = reduceSessionProjection(mine.state, record as never)
      mine.lastSeq = seq
      /*
       * 调用点 ③:**账本上这一轮的工具活儿也算活动**。工具执行期间流分片可能一条
       * 都没有(不刷输出的工具就是这样),而账本照旧在动:`tool/call` `tool/annotate`
       * `tool/audit` `tool/result` 一条条落 —— 事故里读数说「7 秒没新内容」,账本
       * 那几秒里其实一直有行。`assistant/first-token` / `assistant/part-end` 一起算:
       * 它们是「引擎这一轮确实在推进」的账本证据(重放 / 旁路正文没有裸 delta,
       * 全靠它们)。
       *
       * **判据是 runId,不是 messageId**:`tool/annotate` 只带 callId + runId
       * (见 core 归约器 `tool/annotate` 那一支),按 messageId 认会把它整类漏掉。
       * 认活 run 就够了 —— 活牌的产地只有折叠产物那一处,别的 run 的回声(重折追上来
       * 的旧行、别人那一轮)在这道闸上当场掉队。
       */
      const activeRun = mine.state.activeRun
      if (activeRun) {
        const type = (record as { type?: unknown }).type
        const runId = (record as { data?: { runId?: unknown } }).data?.runId
        if (
          typeof type === 'string' &&
          runId === activeRun.runId &&
          (type.startsWith('tool/') ||
            type === 'assistant/first-token' ||
            type === 'assistant/part-end')
        ) {
          markActivity(activeRun.messageId)
        }
      }
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
     * 审批车道的**唯一写点**:交出下一份表,身份没变就原样交回(律④)。
     *
     * 顺手推 `permissionRev` —— 那一格是对账那一发的**防串号闸**(见
     * `reconcilePermissions`),与 `openSeq` 之于重折是同一条判例:一次往返回来时
     * 手里那份快照是不是还说得上话,由号说,不由时间说。
     */
    function patchPermissions(
      next: (prev: Readonly<Record<string, PermissionAsk>>) => Readonly<Record<string, PermissionAsk>>,
    ): void {
      const prev = get().permissions
      const after = next(prev)
      if (after === prev) return
      permissionRev += 1
      set({ permissions: after })
    }

    /** 一批 toolCallId 出局(结算 / 超时 / 会话清理)。一个都不在表上就是恒等。 */
    function dropAsks(pick: (ask: PermissionAsk) => boolean): void {
      patchPermissions((prev) => {
        const doomed = Object.values(prev).filter(pick)
        if (doomed.length === 0) return prev
        const after = { ...prev }
        for (const ask of doomed) delete after[ask.toolCallId]
        return after
      })
    }

    /**
     * **审批事件的折**(应用级许可 · 壳半边)。认得下这一条就答 `true`,
     * 由调用方当场 return —— 与上面账本行那一支同一种写法。
     *
     * 四条事件各管一件事,一条都不许合并:
     *  · `request` —— 一张**能答**的卡;它同时会顶掉同一次调用上的排队态
     *    (轮到它了);
     *  · `queued`  —— 排在别人后面。画等待态、不给键;**已经有一张能答的卡时
     *    不许倒退**(内核会把后来的 ask 归并到在前的那一张上,那时先到的那条
     *    `request` 才是事实);
     *  · `settled` —— 头一张卡与所有被归并的跟随者一起出局。**它是收尾的唯一
     *    凭据**:远端答掉、超时自结算这两条路上壳一下都没点过,而卡照样得消失;
     *  · `timeout` —— 那次 ask 到点了,按 `permissionId` 出局。
     *
     * 推屏走 `schedulePush()` 而不是当场 `compose()`:这条车道与消息树在同一次
     * `set` 之外,但屏幕上它们同框 —— 跟着那一拍走,一帧只重算一次。
     */
    function foldPermissionEvent(event: { type?: string }): boolean {
      if (event?.type === SESSION_EVENT_TYPES.PERMISSION_REQUEST) {
        const ask = askFromRequestEvent(event as never)
        if (!ask.toolCallId) return true
        patchPermissions((prev) => ({ ...prev, [ask.toolCallId]: ask }))
        return true
      }
      if (event?.type === SESSION_EVENT_TYPES.PERMISSION_QUEUED) {
        const queued = event as { toolCallId?: string; requestId?: string; messageId?: string }
        const id = queued.toolCallId
        if (!id) return true
        patchPermissions((prev) => {
          // 已经有一张能答的卡了 —— 这条 queued 说的是**别人**排在它后面。
          if (prev[id]?.canRespond) return prev
          const before = prev[id]
          return {
            ...prev,
            [id]: {
              toolCallId: id,
              permissionId: queued.requestId ?? before?.permissionId ?? '',
              title: before?.title ?? '',
              type: before?.type ?? '',
              ...(before?.pattern !== undefined ? { pattern: before.pattern } : {}),
              ...(before?.alwaysScope ? { alwaysScope: before.alwaysScope } : {}),
              permissionQueued: true,
              canRespond: false,
            },
          }
        })
        return true
      }
      if (event?.type === SESSION_EVENT_TYPES.PERMISSION_SETTLED) {
        const ids = new Set((event as { toolCallIds?: string[] }).toolCallIds ?? [])
        dropAsks((ask) => ids.has(ask.toolCallId))
        return true
      }
      if (event?.type === SESSION_EVENT_TYPES.PERMISSION_TIMEOUT) {
        const requestId = (event as { requestId?: string }).requestId
        if (requestId) dropAsks((ask) => ask.permissionId === requestId)
        return true
      }
      return false
    }

    /**
     * **对账**:`permission.getPending` 整份换掉这条车道。
     *
     * 排在每一次 `refold` 的末尾 —— 冷载与缺号重折走的是同一条路,而这两次
     * 恰恰是壳可能错过那条活事件的全部时机(第一次进会话时事件早就飞过了;
     * 断线期间的事件 SSE 不重放,`?after=` 只补账本行)。
     *
     * **整份换而不是逐条合并**:后端交出来的就是「此刻挂着的全部」,合并只会让
     * 一张早已结算掉的卡因为壳这边没收到 `settled` 而永远留在屏幕上。
     * 「已答等确认」那一格因此也会被这一发抹掉 —— 那正是对的:表上还有它,
     * 说明核心还没结算,卡该回到能答的样子(与「重拉后台对账」逐字同义)。
     *
     * 拉不到就**一格不动**(不清空):把「问不到」画成「没有审批在等」是造事实。
     */
    async function reconcilePermissions(token: number): Promise<void> {
      const rev = permissionRev
      try {
        const port = await chatPort()
        const response = await port.listPendingPermissions(sessionId)
        if (token !== openSeq || disposed) return
        if (!response?.success) return
        /*
         * **在飞期间车道被就地改过 —— 这份快照过期了,一格不动。**
         *
         * 快照定格在服务端应答那一刻;窗口里到达的 `permission:request` 不在它
         * 里面,而「整份换」会把那张刚到的、用户正看着的卡抹掉,此后**再没有任何
         * 事件会把它送回来**(`settled` 只会删)—— 屏幕上是一个永远停在执行中的
         * 工具,引擎在那头一直等。反过来,留着就地那一份最坏是多留一张早已结算的
         * 卡(点下去核心结构化忽略),下一次重折就把它收走。两种错法不对等,
         * 所以这一句偏向就地那一份。
         */
        if (permissionRev !== rev) return
        const next: Record<string, PermissionAsk> = {}
        for (const info of response.pending ?? []) {
          const ask = askFromPendingInfo(info)
          if (ask) next[ask.toolCallId] = ask
        }
        const prev = get().permissions
        if (samePermissionLane(prev, next)) return
        permissionRev += 1
        set({ permissions: next })
      } catch {
        // 问不到就保持上一份(律②:重拉期间旧内容保留在屏)。
      }
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
        /** `StreamErrorData`(`@shared/events/session-events`)—— 清闩路 ② 读它那句人话。 */
        data?: { error?: string }
      }
      if (event?.type === SESSION_EVENT_TYPES.SESSION_LEDGER_EVENT) {
        feedLedger(event.record)
        return
      }
      if (foldPermissionEvent(envelope.event as { type?: string })) return
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
        /*
         * 调用点 ④:**一次调用刚开张也算活动**。它带 messageId,所以不必问活牌。
         * 记在两条车道分叉之前,理由与上面 tool-progress 那一处相同:分的是「这一截
         * 归水位还是归活尾巴」,两条路要的是同一份读数。它比账本上的 `tool/call` 早
         * 几百毫秒(真机 1693ms vs 1929ms),漏掉它读数就会在那段空窗里往上爬。
         */
        markActivity(event.messageId)
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
        /*
         * **清闩路 ②:这条 `stream:error` 就是那次重试的回音**。
         *
         * 闩在的时候才这么读它,理由是一句话:**闩不在时这条事件早就有人替它说话了**。
         * 一轮真跑失败的 run 在账本上留着 `run/end`(outcome error),屏幕上那条消息
         * 自己会显示出错 —— 这时候再飞一条 toast 就是同一件事播报两遍。而闩在的时候
         * 账本上什么都没有:引擎要么在忙、要么目标消息已被上一次重试删掉(真机上那句
         * 是 "Message not found"),core 只回这一条 —— 不接住它,屏幕上就是**零反馈**,
         * 正是 2026-09-08 那次事故里用户连点十几下的直接原因。
         *
         * 所以闩不在时这条分支上面那几句(丢尾巴、清水位)一个字不改。
         */
        if (event?.type === SESSION_EVENT_TYPES.STREAM_ERROR && get().retryPending) {
          const reason = event.data?.error
          clearRetryWatch()
          set({ retryPending: undefined })
          notify({
            level: 'error',
            source: 'chat.retry',
            // 不是「没发出去」:这一下发出去了,是 core 拒的 —— 标题要说对是谁的事。
            title: t('notify.retryRejected'),
            // 引擎没给出那句人话时不编一句 —— 标题已经说清了发生什么事。
            ...(reason ? { body: reason, detail: reason } : {}),
          })
        }
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
       * **「模型又吐了一段」的唯一产地**(§6.6):三种裸 delta 就是「还在往外吐字」
       * 的全部证据。记在这里而不是在下面两条岔路(R2 / 旧路)里各记一次 —— 岔路会
       * 长,产地不该跟着长;判据也只有一句「这一条是不是那三种之一」,与它后面被谁
       * 怎么处理无关(没盖章被 R2 丢掉的那种也算 —— 引擎确实在吐字)。
       * `Date.now()` 而不是 `performance.now()`:两格都要和账本上的 `run/start`
       * (墙钟毫秒)相减,两个时基不能混。
       */
      if (
        chunk.type === 'text-delta' ||
        chunk.type === 'reasoning-delta' ||
        chunk.type === 'tool-input-delta'
      ) {
        lastDelta = { messageId, at: Date.now() }
        // 调用点 ①:**delta 既是 delta 也是活动**。两格在这一处一起写,是因为这一
        // 类事件同时满足两个判据 —— 不是因为它们是一件事(其余三个调用点只写活性)。
        markActivity(messageId)
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
        // 调用点 ②:**工具正在刷输出 = 这一轮活着**(2026-09-09 用户裁定)。
        // 它不是正文,所以 `lastDelta` 一个字不动;而事故里那 7 秒屏幕上一直在变的
        // 正是这一条。`messageId` 那道闸在上面 —— 合批器的直送分支替它盖了章。
        markActivity(messageId)
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
     *
     * 首屏那一页的**两条边**在这里宣布(工单 6 ①,判据见 `data/first-screen.ts`):
     * 出发一条、落地一条,面板类的读排在这两条之间让路。**产地只有这一处**;
     * 落地那一句挂在 `finally` 上 —— 成(页 / 整份都算)、败、池命中当场返回、
     * 没有会话,四种收场是同一件事:「首屏那棵树此刻已经有底了,后面的人可以
     * 出门了」。写在 `runLoad` 里面反而会漏掉「已经起过底所以直接 return」那一支,
     * 而那正是池命中最常走的那一支。
     */
    function load(): Promise<void> {
      if (opening) return opening
      markFirstScreenPending(sessionId)
      const started = runLoad()
      opening = started
      void started.finally(() => {
        if (opening === started) opening = undefined
        markFirstScreenLanded(sessionId)
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
          // 两格事实同生共死:清一格留一格,下一轮会顶着上一轮的读数开张。
          lastActivityAt: undefined,
        })
        return
      }
      if (fold) return
      // 换会话 = 上一条会话那只「等收尾」的表过期了 —— 现在换会话是换机器,
      // 这一句只在同一台机器上重新起底时用得着(拆机器那口在 dispose 里)。
      if (abortWatch) clearTimeout(abortWatch)
      abortWatch = undefined
      clearRetryWatch()
      const token = (openSeq += 1)
      fold = newFold()
      water = new StreamWater()
      lastDelta = undefined
      // 两格一起清:留着上一轮那一格,新一轮开张时读数会顶着别人的静默秒数。
      lastActivity = undefined
      tail = undefined
      tailLens = undefined
      tailReceived = undefined
      pendingLedger = []
      pageBase = undefined
      pageCursor = { hasMoreBefore: false }
      mergeMemo = undefined
      loadingOlder = false
      set({
        sessionId,
        status: 'loading',
        error: undefined,
        messages: [],
        activeMessageId: undefined,
        overlay: [],
        // 起底 = 整棵树重画,车道跟着回到空;真相由这一趟末尾的 `getPending` 说。
        permissions: NO_PERMISSION_ASKS,
        // 重新起底 = 上一次重试的回音已经没有意义了(那棵树整份要重画)。
        retryPending: undefined,
        // 底稿还没到手 —— 「上面还有更早的」此刻是一句说不出口的话。
        hasMoreBefore: false,
        loadingOlder: false,
      })

      // 先订上再拉:拉的那一刻起的事件不能漏(与 D0 / D1 同一条理由)。
      await chatSources.ensureSubscribed()
      if (token !== openSeq || disposed) return
      await resync(token)
    }

    /**
     * 真发送 —— 成败都落在那一格 overlay 上,认领由 `reconcileOverlay` 负责。
     *
     * `messageId` 是这条消息**将来在账本上的 id**(发送前就铸好了,见 `send`),
     * 原样递给端口。重试递的仍然是**同一个** —— 上一次既然没能到账本,这个
     * 位置就还空着;换一个新的等于让重试后的认领又失去身份。
     */
    async function dispatch(entryId: string, target: string, text: string, messageId?: string): Promise<void> {
      try {
        const port = await chatPort()
        const result = await port.sendMessage(target, text, messageId)
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
      // 那只等新一轮的表跟着走 —— 留着它就是一发对着已拆机器的 warn。
      clearRetryWatch()
      // 号一动,在飞的 `resync` / `scheduleRefold` 回来时全部作废。
      openSeq += 1
      // 同一手:在飞的那一发对账回来时手里那份快照当场作废。
      permissionRev += 1
      // 在飞的那一次起底作废(它自己会在 token 那道闸上掉头);别把它的 promise
      // 留给下一个 `open()` —— 那会让「等这一次起底办完」等到一次已经被作废的。
      opening = undefined
      fold = undefined
      water = undefined
      tail = undefined
      tailLens = undefined
      tailReceived = undefined
      lastDelta = undefined
      // 两格一起清:留着上一轮那一格,新一轮开张时读数会顶着别人的静默秒数。
      lastActivity = undefined
      pendingLedger = []
      pageBase = undefined
      pageCursor = { hasMoreBefore: false }
      mergeMemo = undefined
      loadingOlder = false
      resultBodies.clear()
      resultFetching.clear()
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
      permissions: NO_PERMISSION_ASKS,
      sentTick: 0,
      hasMoreBefore: false,
      loadingOlder: false,
      olderTick: 0,
      toolResults: NO_TOOL_RESULT_FETCHES,

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
          /*
           * 这条消息**将来在账本上的 id**,在这里就铸好(09-13)。
           *
           * 它与那一格 overlay 是**同一个动作**里的两半:认领拿的就是它。铸在
           * 端口里不行 —— 隔着一个 `await`,铸出来的东西到不了这一格;铸在引擎里
           * 更不行,那正是从前那条「靠正文认领」的路,而引擎**落库之前就把正文
           * 换掉了**(`@/abs/x.lua` → 34KB 的 `<file>` 块),于是永远认不上。
           *
           * `crypto.randomUUID()` 与 core 的 `createCoreId()` 是同一句话
           * (`packages/core/engine/ids.ts`:Web Crypto,不是 `node:crypto`),
           * 所以形天然过引擎那道判。
           */
          messageId: crypto.randomUUID(),
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
        void dispatch(entry.id, target, body, entry.messageId)
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
        // 同一个 `messageId`(见 `dispatch` 的注)。上一版建的那几格没有这一格,
        // 那就**不给** —— 现铸一个的话,引擎会用一个这台屏幕上没人记得的 id,
        // 而那一格 overlay 只能再回去比正文,等于白铸。
        void dispatch(entryId, target, entry.text, entry.messageId)
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
       *
       * ── 两道闸(2026-09-08,事故 ef079fd7)──────────────────────────────
       * 「core 收下 = 这次重试成了」是假的:`retry-message` 的 `success` 只说明命令
       * 上了总线,**引擎在不在忙、目标消息还在不在**都要等它自己跑到才知道。真机上
       * 一条 129 秒没有任何回包的请求期间,用户连点十几下重试,每一下 core 都答
       * `success`,而引擎只回一条 `stream:error` —— 屏幕上零反馈。所以:
       *
       *  a. **引擎在跑就不发**。重试的语义是「删掉这条回复重新生成」,而正在跑的
       *     那一轮首先该被停止 —— 说一句话(warn)比堆一条注定被拒的命令诚实;
       *  b. **上一条重试还没见回音就不发**(`retryPending`)。这是兜底 ——
       *     钮那边已经禁灰了,这里挡的是「禁灰之前那一下」与非组件调用路。
       *
       * ── 闩怎么清(三条路,少一条它就会永远灰着)────────────────────────
       *  ① 账本开了新一轮(`activeMessageId` 从无到有)—— 落点在 `compose()`,
       *     因为活牌的产地在那里;
       *  ② 收到 `stream:error` 且闩在 —— 那条就是这次重试的回音,清闩 + error 档
       *     通知(落点在 `onEvent` 的终止分支);
       *  ③ 过了 `RETRY_SETTLE_MS` 前两条都没来 —— 清闩 + warn 档「core 收下了但
       *     账本上没长出新 run」。表过期的判据照抄 `abortWatch`:机器拆了 / 换了
       *     会话就闭嘴。
       */
      regenerate: (messageId) => {
        const target = get().sessionId
        if (!target || !messageId) return false
        // 闸 a:引擎在跑。判据用那唯一的产地,不另立忙态。
        if (selectEngineBusy(get())) {
          notify({
            level: 'warn',
            source: 'chat.retry',
            title: t('notify.retryBusy'),
            body: t('notify.retryBusyHint'),
          })
          return false
        }
        // 闸 b:上一条还在飞。不发、不通知 —— 钮已经灰了,再飞一条 toast 是噪音。
        if (get().retryPending) return false

        void (async () => {
          let failure: string | undefined
          try {
            const port = await chatPort()
            const result = await port.retryMessage(target, messageId)
            if (!result?.success) failure = result?.error || 'session-command.emit 未成功'
          } catch (error) {
            failure = error instanceof Error ? error.message : String(error)
          }
          if (failure) {
            notify({
              level: 'error',
              source: 'chat.retry',
              title: t('notify.retryFailed'),
              body: failure,
              detail: failure,
            })
            return
          }
          // 机器拆了 / 换了会话:这一次的回音已经没有收件人了。
          const now = get()
          if (disposed || now.sessionId !== target) return
          /*
           * 账本比这只 promise 跑得快的那一格:`run/start` 已经到了(SSE 与 RPC 应答
           * 是两条路,谁先到不一定)。回音已经拿到手,闩就不该再立 —— 立了就只能等
           * ③ 那条保险丝去清,钮白灰 3 秒。
           */
          if (selectEngineBusy(now)) return
          set({ retryPending: { messageId, at: Date.now() } })
          clearRetryWatch()
          retryWatch = setTimeout(() => {
            retryWatch = undefined
            const later = get()
            // 表过期的三种样子:机器拆了、换了会话、闩早被 ①② 清掉了。
            if (disposed || later.sessionId !== target) return
            if (later.retryPending?.messageId !== messageId) return
            set({ retryPending: undefined })
            notify({
              level: 'warn',
              source: 'chat.retry',
              title: t('notify.retryStuck'),
              body: t('notify.retryStuckHint'),
            })
          }, RETRY_SETTLE_MS)
        })()
        return true
      },

      respondPermission: (toolCallId, decision) => {
        const target = get().sessionId
        if (!target) return
        const ask = get().permissions[toolCallId]
        // 没有这张卡 / 排队中 / 已经答过 —— 三种情况都是**恒等**:发一条打空的
        // 应答只会在核那头多一次「no pending request」的 warn(与 `abort` 那条
        // 「没在跑就什么都不做」同判)。
        if (!ask || !ask.canRespond || ask.answered) return
        /*
         * **先把卡置成「已答」再发** —— 律③那一拍。它同时是这一格的连点闸:
         * `canRespond` 当场变假,第二下点不着。
         */
        patchPermissions((prev) => {
          const current = prev[toolCallId]
          if (!current) return prev
          return { ...prev, [toolCallId]: { ...current, canRespond: false, answered: decision } }
        })
        void (async () => {
          let failure: string | undefined
          try {
            const port = await chatPort()
            const result = await port.respondPermission(target, toolCallId, decision)
            if (!result?.success) failure = result?.error || 'session-command.emit 未成功'
          } catch (error) {
            failure = error instanceof Error ? error.message : String(error)
          }
          if (!failure) return
          /*
           * 命令**没离开壳**(网断 / core 拒收)—— 把那一格退回去,人才有第二次
           * 机会点它。真正结算了的那条路不走这里:那由 `permission:settled` 收尾。
           */
          if (disposed || get().sessionId !== target) return
          patchPermissions((prev) => {
            const current = prev[toolCallId]
            if (!current || current.answered !== decision) return prev
            const { answered: _answered, ...rest } = current
            return { ...prev, [toolCallId]: { ...rest, canRespond: true } }
          })
          notify({
            level: 'error',
            source: 'chat.permission',
            title: t('notify.permissionFailed'),
            body: failure,
            detail: failure,
          })
        })()
      },

      /**
       * **再往前接一页**(工单 5 ⑥)。判据三条,缺一条就是恒等:
       * 底稿在(这一台走的是页那条路)、上面还有、此刻没有在飞的那一发。
       */
      loadOlder: () => {
        const before = pageCursor.nextBefore
        if (loadingOlder || !pageBase || !pageCursor.hasMoreBefore || !before) return false
        loadingOlder = true
        set({ loadingOlder: true })
        const token = openSeq
        void (async () => {
          try {
            const port = await chatPort()
            const page = await port.readPage(sessionId, { limit: CHAT_PAGE_LIMIT, before })
            if (token !== openSeq || disposed || !pageBase) return
            const known = new Set(pageBase.map((message) => message.id))
            // 游标那一条本身可能又回来一次(边界重叠)—— 按 id 去重,不按条数。
            const older = rehangPageResults(page.messages, page.results, resultBodies)
              .filter((message) => !known.has(message.id))
            pageBase = [...older, ...pageBase]
            pageCursor = {
              hasMoreBefore: page.hasMoreBefore,
              ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}),
            }
            mergeMemo = undefined
            set((prev) => ({ hasMoreBefore: page.hasMoreBefore, olderTick: prev.olderTick + 1 }))
            compose()
          } catch {
            /*
             * 取不到就**一格不动**:顶端那行读数回到「还有更早的」,人再翻一次就是
             * 再发一次。不落 error、不清屏 —— 手里那几页是好的(律②)。
             */
          } finally {
            if (token === openSeq && !disposed) {
              loadingOlder = false
              set({ loadingOlder: false })
            }
          }
        })()
        return true
      },

      /** 取一格大结果的正文(工单 5 ②)。判词在类型上。 */
      fetchToolResult: (ref) => {
        const key = pageResultKey(ref)
        if (resultBodies.has(key) || resultFetching.has(key)) return
        resultFetching.add(key)
        patchToolResultFetch(key, 'loading')
        const token = openSeq
        void (async () => {
          try {
            const port = await chatPort()
            const value = await port.readToolResult(sessionId, ref.toolCallId, ref.slot)
            if (token !== openSeq || disposed) return
            if (value === undefined) {
              patchToolResultFetch(key, 'failed')
              return
            }
            resultBodies.set(key, value)
            patchToolResultFetch(key, undefined)
            /*
             * **就地换掉**挂着这枚引用的那几条消息(律①③:禁清屏)。底稿改了要
             * 顺手作废合并 memo —— 不然下一帧还是上一份那个数组对象。
             */
            if (pageBase) {
              pageBase = applyToolResultBody(pageBase, key, value)
              mergeMemo = undefined
            }
            compose()
          } catch {
            if (token === openSeq && !disposed) patchToolResultFetch(key, 'failed')
          } finally {
            resultFetching.delete(key)
          }
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
/** 归零之后排着的那一拍**停靠**(键 = sessionId)—— 见 `release` 的注。 */
const sweeping = new Set<string>()

/* ── 停靠池:归零之后不拆,先停一会儿(C1 · §5.1)────────────────────────
 *
 * ── 病与真因 ────────────────────────────────────────────────────────────
 * 用户原话:「tab 切换 session 我还需要 load session」。真因不在网络也不在 core:
 * 一片叶换掉会话 ref → 旧会话的引用归零 → 下一拍把**整台机器**拆了;切回来
 * `acquire` 重新 `runLoad`,从 core 再拉一遍账本。**不是网络慢,是壳把它扔了。**
 *
 * 所以归零之后不 `dispose`,改成**停靠**:机器原样活着(那对推送订阅是全进程
 * 共用的一对,停靠的机器照样在 `find` 的收件人表上,所以内容仍旧跟着核心走),
 * 只是没人持有它。切回来 `acquire` 把它从池里取回,`open()` 撞上 `runLoad` 那句
 * `if (fold) return` 当场返回 —— 一发 `listRaw` 都不打。
 *
 * ── 为什么有上限,为什么是 8 ────────────────────────────────────────────
 * 一台机器手里攥着那条会话的**整棵折出来的树**。单条会话可以很大:07 月那次
 * 事故里一条会话脱水前 14.6MB(脱水后 567KB),而这里停着的是折完的活树。
 * 所以池是 **LRU 且有封顶**,不是「留着不管」:最近看过的几条零加载,更早的
 * 那些老老实实拆掉。8 是拍点 ④ 的缺省 —— 够覆盖「在几条会话之间来回切」这个
 * 真实用法,又不至于把八条以上的大树全钉在内存里。改这个数是一次拍板。
 *
 * ── 出池的四条路,其中**三条会把机器拆掉** ─────────────────────────────
 *  · 被取回(`acquire` / `retain` / `ensure` 命中)—— 机器回到在册那一头,
 *    **不拆**,这是停靠池存在的全部理由;
 *  · 池满逐出 —— 最早停的那条真 `dispose`(`dock` 里那个 while);
 *  · 会话**真的被删** —— `forget`,接在名册的 `onSessionsDeleted` 上;
 *  · 整张表归零 —— `resetAll()`(HMR 退役与测试的那一口,在册的与停靠的一起拆)。
 *
 * 名单到此为止:**换工作区不在里面**(C3 之前它在,病历见 `forget` 头上)。
 */

/** 停靠池上限(拍点 ④)。**Map 的插入序就是 LRU 序**:最早停的排在最前。 */
export const CHAT_SOURCE_DOCK_LIMIT = 8

const docked = new Map<string, ChatSource>()

/** 停一台。已经在池里就挪到队尾(重新算「最近」),满了从队首挤。 */
function dock(id: string, source: ChatSource): void {
  ensureRosterHook()
  docked.delete(id)
  docked.set(id, source)
  while (docked.size > CHAT_SOURCE_DOCK_LIMIT) {
    const oldest = docked.keys().next()
    if (oldest.done) break
    evict(oldest.value)
  }
}

/** 挤出去 = 这一台**真的**拆掉。池里没有它就是一次恒等。 */
function evict(id: string): void {
  const parked = docked.get(id)
  if (!parked) return
  docked.delete(id)
  parked.dispose()
}

/** 取回。池里没有 = undefined(调用方去造一台新的)。 */
function undock(id: string): ChatSource | undefined {
  const parked = docked.get(id)
  if (!parked) return undefined
  docked.delete(id)
  return parked
}

/**
 * 一批会话**真的被删了** —— 停靠池里那几台立刻拆掉。
 *
 * ── 它订的为什么不是 `onSessionsRemoved`(C1 的留账,09-10 结清)────────
 * 那一条**把「被删」与「离开这个工作区」说成同一句话**(两个产地:
 * `sessions-source` 的 `onLifecycle` 与 `onSpaceChanged`),而对形态机来说两者
 * 确实是同一件事(那张卡不在序列里了)。C1 落地时先接了它,理由是「保守的
 * 那一侧:换空间再换回来最坏重载一次」—— 那句话低估了代价:换个工作区再换
 * 回来,**整池八台机器一起被 `forget → evict → dispose`**,每一条会话都得重新
 * 拉一遍账本,正是停靠池要治的那个病本身。
 *
 * C3(a9d8e7e2)为伴随面立的 `onSessionsDeleted` 正是缺的那一格:它只从
 * `onLifecycle` 的 `deleted` 那一支发,`onSpaceChanged` 不发。停靠池与伴随面
 * 要的是同一句话 —— **「这条会话没了」而不是「它不在这个屏幕上了」**,所以
 * 两处订同一条,理由整段写在 `sessions-source.onSessionsDeleted` 上。
 *
 * 换工作区之后停靠池原样留着:那些机器还挂在收件人表上跟着核心走(全进程
 * 共用的那一对推送订阅不按工作区分),切回去照旧零 `listRaw`。而一台**为一条
 * 已经删掉的会话活着的机器**仍然当场拆 —— 它不可观测,只会让内存长起来。
 *
 * **在册的那些一格不动**:它们有人持有着(屏幕上正开着),该由引用账收走。
 */
function forget(sessionIds: readonly string[]): void {
  for (const id of sessionIds) evict(id)
}

/**
 * 接上名册那条「真的被删了」的接缝(**不是**「离场」那一条,判词在 `forget` 上)。
 * **惰性**(第一次真的停靠时才接)—— 模块作用域里接线会在
 * 这台壳那条存量 import 环上读到 TDZ(判例写在 `content/session-projection.ts`
 * 头上),而第一次停靠一定发生在整棵树跑起来之后。
 */
let stopRoster: (() => void) | undefined
function ensureRosterHook(): void {
  if (stopRoster) return
  stopRoster = onSessionsDeleted(forget)
}
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

/**
 * 在册的那一台;没有就**先问停靠池**,还没有才造一台新的。
 *
 * 问池那一句就是「不重载」的全部入口:取回的是**同一个对象**,它的折叠状态、
 * 水位、活尾巴一格没动,所以随后那一句 `open()` 撞上 `runLoad` 的 `if (fold) return`
 * 当场返回。造一台新的才会有 `listRaw`。
 */
function ensure(id: string): ChatSource {
  const hit = entries.get(id)
  if (hit) return hit.source
  const parked = undock(id)
  const source = parked ?? createChatSource(id)
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
 *
 * **归零之后是停靠,不是拆卸**(C1 · §5.1)。那一拍到了、还是没人要,机器从在册
 * 那一头挪进停靠池;真正的 `dispose` 只发生在被挤出池或会话没了的时候。
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
    dock(id, still.source)
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
 * 这条会话此刻**活着的**那一台 —— 在册的,或者停靠着的。
 *
 * 停靠的机器与在册的机器在这里**没有区别**:两者都是活的,区别只在有没有人
 * 持有着。这一句是「停靠期间内容仍旧跟着核心走」的全部实现(C1 · §5.1)。
 */
function find(id: string): ChatSource | undefined {
  return entries.get(id)?.source ?? docked.get(id)
}

/**
 * **分发 —— 从前那两处 `!== get().sessionId` 的过滤,现在是这一句查表**。
 *
 * 收件人不在表上(那条会话既没人在看、也没停在池里)= 丢掉,和从前一模一样;
 * 区别是从前只有「当前那一条」能收,现在每一条活着的会话各收各的。
 */
function dispatchSessionEvent(envelope: SessionEventEnvelope): void {
  find(envelope.sessionId)?.handleEvent(envelope)
}

function dispatchSessionStream(payload: SessionStreamPayload): void {
  find(payload.sessionId)?.handleStream(payload)
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
  /** 只看不持有:在册的或停靠着的那一台,都没有就是 undefined(不造)。 */
  get: (id: string): ChatSource | undefined => find(id),
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
  /**
   * **会话没了 → 停靠池里那几台立刻拆掉**。名册那条接缝自己会调它;
   * 导出这一口是为了让它可被直接反证(见 `forget` 头上的注)。
   */
  forget,
  /** 测试用:整张表回到未启动的干净态(退订 + 拆掉每一台机器,含停靠着的)。 */
  resetAll: (): void => {
    unsubscribeAll()
    for (const entry of [...entries.values()]) entry.source.dispose()
    entries.clear()
    for (const parked of [...docked.values()]) parked.dispose()
    docked.clear()
    stopRoster?.()
    stopRoster = undefined
    sweeping.clear()
    currentRef = undefined
    currentId = ''
    notifyCurrent()
  },
  /** 只读快照:**在册**(有人持有着)的是哪几条会话(测试与排障用)。 */
  ownedIds: (): string[] => [...entries.keys()],
  /** 只读快照:**停靠池**里此刻是哪几条,队首 = 最早停的那条(测试与排障用)。 */
  dockedIds: (): string[] => [...docked.keys()],
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

/**
 * 答一张权限卡的**非组件写法**(权限卡那颗键的落点)。
 *
 * 为什么是自由函数而不是让卡自己 `useChatSourceOf(sessionId, s => s.respondPermission)`:
 * 那是**第二格订阅**。壳里一条长会话可以有两百张工具卡,每一张挂一个槽 ——
 * 槽已经为「我这一次调用有没有卡」订着一格(它靠 `Object.is` 恒等在九成的帧里
 * 不重渲染),再为一个**身份恒定的动作**订第二格,是白付两百份订阅的钱。
 * 与 `sendChatMessage` / `abortChatRun` 同一条判例、同一种形状。
 */
export function respondChatPermission(
  toolCallId: string,
  decision: PermissionResponse,
  sessionId?: string,
): void {
  sourceFor(sessionId)?.getState().respondPermission(toolCallId, decision)
}

/**
 * **再往前接一页**的非组件写法(工单 5 ⑥)。
 *
 * 与 `sendChatMessage` / `respondChatPermission` 同一条判例:调用方是一个滚动
 * 回调(`ChatStream` 的 `expandOnScroll`),它在 React 之外跑、要的是「此刻那台
 * 机器」而不是一格订阅 —— 为一个身份恒定的动作订一格 store,是白付订阅的钱。
 *
 * 返回 `true` = 这一下真的发出去了(调用方据此决定要不要留那格补偿)。
 */
export function loadOlderChatMessages(sessionId?: string): boolean {
  return sourceFor(sessionId)?.getState().loadOlder() ?? false
}

/**
 * **取一格大结果的正文**的非组件写法(工单 5 ②)。
 *
 * 调用方是工具抽屉 —— 一条长会话里两百张卡,每张为一个身份恒定的动作订一格
 * store 正是 `respondChatPermission` 那条判例在治的病,所以这里同样是自由函数。
 */
export function fetchChatToolResult(ref: PageResultReference, sessionId?: string): void {
  sourceFor(sessionId)?.getState().fetchToolResult(ref)
}

/** 缺省 = 当前会话那一台;显式给了 id 就只认表上那一台(没有就什么都不做)。 */
function sourceFor(sessionId: string | undefined): ChatSource | undefined {
  return sessionId === undefined ? chatSources.currentSource() : chatSources.get(sessionId)
}
