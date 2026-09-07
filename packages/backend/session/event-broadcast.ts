/**
 * **账本词汇的推送接线**(B 期,§17.8)。
 *
 * ## 一句话
 *
 * 唯一那扇写入口(`writeSessionEvent`)每落一条事件,就把**同一条记录原样**放到
 * EventBus 上一份。桌面 IPCBridge 与 web SSE 都是总线的观察者,所以"IPC 与 SSE
 * 同步"是**构造性**的,不是两处各写一遍。
 *
 * ## 为什么挂在写入口的观察者面上,而不是引擎里
 *
 * `registerSessionEventObserver` 是门的契约:门保证在 `writeSessionEvent` 返回
 * **之前**、在同一个同步段里把这条事件交给每一位观察者(§16.6 F1)。挂在这里
 * 意味着**没有第二个产地**——不管事件是谁写的(引擎 / 权限链 / 压缩 / 迁移),
 * 推送面看到的就是账本上的那一条,一条不多一条不少。
 *
 * ## 归属过滤不在这里
 *
 * 这条事件和别的会话事件走**同一条总线**,于是也走同一道归属判据:
 * web 侧 `runtime.events.subscribe('*')` 逐条问 `canReadSession`
 * (`ownerMatchesContext`,87c02798 刚拆干净的那个),桌面侧本来就是单用户单窗口。
 * 这里**不许**自己再判一次 —— 判据只有一把尺。
 *
 * ## 顺序与背压
 *
 * `EventBus.emit` 是异步的,而观察者是同步段。这里按会话串一条 promise 链:
 * 同一条会话的事件按 seq 顺序上总线,不同会话互不阻塞。链上出错只记一行 ——
 * **推送坏了不许影响写账**(账本才是真相,推送是它的影子)。
 *
 * ## 频率
 *
 * 账本行本身就是**打包过的**:`assistant/chunks` 一行装一段 delta(定律二:打包
 * 是存储编码),所以一轮对话的账本行数是个位数到几十条,与既有 `session:event`
 * 同一个量级。**不需要第二套节流**,也不该有——16ms 合批是 `SessionStreamCoalescer`
 * 给 `session:stream` 那条高频面用的,账本行不走那条。
 */

import { SESSION_EVENT_TYPES } from '@onething/core/events'
import type { SessionLogEventRecord } from '@onething/core/session/events'
import { getLogger } from '../wiring/logging/index.js'
import { getEventBus } from '../events/index.js'
import { registerSessionEventObserver } from './event-writer.js'

const log = getLogger('session.ledger-broadcast')

interface BroadcastOwner {
  bus: ReturnType<typeof getEventBus>
  unregister(): void
  chains: Map<string, Promise<void>>
  accepting: boolean
  closing?: Promise<void>
}
let installation: BroadcastOwner | undefined

/** 观察者是同步段:排进链里就返回,绝不 await(写账不等推送)。 */
function enqueue(owner: BroadcastOwner, sessionId: string, record: SessionLogEventRecord): void {
  if (!owner.accepting) return
  const chains = owner.chains
  const previous = chains.get(sessionId) ?? Promise.resolve()
  const next = previous
    .then(() =>
      owner.bus.emit(sessionId, {
        type: SESSION_EVENT_TYPES.SESSION_LEDGER_EVENT,
        record,
      } as never),
    )
    .then(
      () => undefined,
      error => {
        // 推送坏了不影响账本,只留一行。
        log.warn('ledger event broadcast failed', { sessionId, seq: record.seq }, error)
      },
    )
    .finally(() => {
      // 链尾自己收摊,防止 Map 随会话数无界增长。
      if (chains.get(sessionId) === next) chains.delete(sessionId)
    })
  chains.set(sessionId, next)
}

/**
 * 装上广播(幂等)。`createOnethingBackend` 在事件系统与会话层都就位之后调一次。
 */
export function installSessionLedgerEventBroadcaster(): void {
  if (installation) return
  const owner: BroadcastOwner = { bus: getEventBus(), chains: new Map(), accepting: true, unregister() {} }
  owner.unregister = registerSessionEventObserver((sessionId, record) => {
    try {
      enqueue(owner, sessionId, record)
    } catch (error) {
      log.warn('ledger event broadcast enqueue failed', { sessionId }, error)
    }
  })
  installation = owner
}

/** 摘订阅后等待已接收的真实广播，下一只 Backend 不能接手上一只的尾巴。 */
export function uninstallSessionLedgerEventBroadcaster(): Promise<void> {
  const owner = installation
  if (!owner) return Promise.resolve()
  if (owner.closing) return owner.closing
  owner.accepting = false
  owner.unregister()
  owner.closing = Promise.allSettled([...owner.chains.values()]).then(() => {
    owner.chains.clear()
    if (installation === owner) installation = undefined
  })
  return owner.closing
}
