/**
 * 终端输出的**宿主广播器**:把 PTY 的每一批输出放上事件总线,让它骑既有的
 * `GET /api/events` 出网(方案 `apps/desktop-react/docs/terminal-browser-2026-09.md`
 * §2.1-2,T0 单)。
 *
 * ## 为什么是「住装配层的一只小工厂」,而不是宿主自己写
 *
 * `TerminalBroadcaster` 是产品层声明的端口(`@onething/runtime/terminal/
 * service.wiring`),它只说「把这两种事件推给消费者」。**推到哪** 是宿主的事 ——
 * 而今天两扇会用它的壳(React 桌面壳、将来的 web 宿主)推的地方是同一个:这台
 * 进程的事件总线。写在装配层因此不是「替宿主做决定」,而是把那个决定做成一件
 * **可以被宿主表指名的东西**:React 壳的 `host-ports.ts` 那一行从 `null` 改成
 * `{ broadcaster: createEventBusTerminalBroadcaster() }`,server / CLI daemon 照旧
 * `null`(它们没有终端消费者,注入了反而会让 `hasTerminalHost()` 说谎)。
 *
 * 装配层也是唯一能干这件事的层:`EventBus` 住在 `packages/backend/events/`,
 * 而产品层不认识它(那正是端口存在的理由)。
 *
 * ## 为什么每次调用才取总线(惰性,不是构造时抓)
 *
 * 广播器在 `applyHostPorts()` 里被注入 —— 那是 `OnethingBackend.assemble` 的
 * **第一步**,事件系统要到第五步才造出来(`createEventSystem()`)。构造时调
 * `getEventBus()` 会当场抛 `BackendNotAssembledError`,于是这只工厂必须在
 * `sendData` / `sendExit` 里现取。代价是每帧一次访问器调用(读当前实例槽上的
 * 一格字段),收益是它与装配顺序解耦:谁先谁后都对。
 *
 * ## 装配还没完成就有输出 → 丢,不抛
 *
 * 理论上到不了这里:`TerminalService` 是懒单例,第一格 PTY 由 `terminal` RPC 域
 * 的 `create` 拉起来,而 RPC 域要到装配的最后几步才挂上。但端口是个单槽,谁都
 * 能在任何时刻调它 —— 一条输出丢了是一格屏幕少了一批字节(下一次 `attach` 的
 * ring 会补),为它抛一个异常却会顺着 `pty.onData` 的回调炸到 node-pty 的读循环
 * 里。所以这里 `warn` 一行然后丢,与 `stores/sessions.ts` 那处「有就发,没有就
 * 算了」是同一条判例(它用的也是 `isEventSystemInitialized()`)。
 */

import type { TerminalBroadcaster } from '@onething/runtime/terminal/service.wiring'
import type { TerminalDataEvent, TerminalExitEvent } from '@shared/ipc.js'
import { getEventBus, isEventSystemInitialized } from '../../events/index.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('terminal.broadcast')

/**
 * 一只把终端输出转成全局事件的广播器。
 *
 * 两条事件的形状与端口的载荷**逐字相同**,只多一格 `type` —— `@shared/events` 的
 * `TerminalDataGlobalEvent` / `TerminalExitGlobalEvent` 就是这么声明的(`extends`
 * 那两个载荷类型),所以这里不该出现第二份字段表:展开一次原样带过去。
 */
export function createEventBusTerminalBroadcaster(): TerminalBroadcaster {
  return {
    sendData(event: TerminalDataEvent): void {
      if (!isEventSystemInitialized()) {
        log.warn('terminal data dropped before assembly', { terminalId: event.terminalId, seq: event.seq })
        return
      }
      getEventBus().emitGlobal({ type: 'terminal:data', ...event })
    },
    sendExit(event: TerminalExitEvent): void {
      if (!isEventSystemInitialized()) {
        log.warn('terminal exit dropped before assembly', { terminalId: event.terminalId })
        return
      }
      getEventBus().emitGlobal({ type: 'terminal:exit', ...event })
    },
  }
}
