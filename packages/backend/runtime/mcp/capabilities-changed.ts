/**
 * Capabilities-changed fan-out (P2-1).
 *
 * When a server pushes `notifications/{tools,prompts,resources}/list_changed`
 * (legacy unsolicited delivery, or routed through an auto-opened
 * `subscriptions/listen` on a 2026-07-28 connection), the client runtime
 * re-reads the capability lists and updates its own state. The MODEL-facing
 * side — the tools catalog + router definitions — must regenerate too, but
 * the client cannot reach the bridge without closing an import cycle
 * (bridge ← manager ← client). Late-bound port, like the other configure*
 * seams: host IPC assemblies wire it to their `registerTools` path at boot.
 */

let handler: ((serverId: string) => void) | null = null

export function configureMCPCapabilitiesChangedHandler(h: ((serverId: string) => void) | null): void {
  handler = h
}

/**
 * R2b(§13.7 裁定 5)—— 新工具树的 MCP 目录挂点。
 *
 * **第二个口子而不是顶掉第一个**:上面那个 handler 归宿主的 `registerTools` 路
 * (旧注册表),新树的目录是并行的另一份。切换期两条路同时活着,所以通知点也要
 * 同时通知两边;R4 删旧树时这里只剩一个。开关关时它永远是 null。
 */
let toolkitHandler: ((serverId: string) => void) | null = null

export function configureToolkitMCPCapabilitiesChangedHandler(h: ((serverId: string) => void) | null): void {
  toolkitHandler = h
}

export function notifyMCPCapabilitiesChanged(serverId: string): void {
  handler?.(serverId)
  toolkitHandler?.(serverId)
}

/**
 * K5-a —— 「这台进程上的 MCP 工具表可能变了」的订阅口。
 *
 * 上面那两格是**单槽**,而且只覆盖「服务器推来 list_changed」这一种变化。资源面的
 * 投影驱动(`backend/wiring/resource/mcp-mount.ts`)要的是更宽的那一句:**连上了、
 * 断开了、换了设置、整个关掉了、工具表变了**,五种都要知道,而且它不能去抢那两格
 * 里的任何一格(抢一格就是让工具目录或者宿主的 registerTools 失聪)。
 *
 * 唯一同时覆盖那五种的汇合点是 `registerMCPTools()`(`bridge.wiring.ts`)——
 * connect / disconnect / refresh / update / remove / 设置保存 / list_changed 的收尾
 * 一律经过它。所以这一族是**多播**的订阅表,通知点在那只函数的第一行。
 *
 * 它住在这只文件而不是 `bridge.wiring.ts`:这里是「MCP 的能力面变了」这件事的门面,
 * 零依赖、可以被任何一层 import;那一只吃 zod、吃存储路径、吃跨进程契约。
 */
const toolTableListeners = new Set<() => void>()

/** 订阅。返回退订(幂等)。 */
export function onMCPToolTableChanged(listener: () => void): () => void {
  toolTableListeners.add(listener)
  return () => {
    toolTableListeners.delete(listener)
  }
}

/**
 * 广播。
 *
 * 逐个 try/catch:这一发跑在 `registerMCPTools()` 里,而那是一次连接变更的**收尾**
 * —— 一个抛出的监听者会把剩下的监听者和那次收尾一起打断。这里吞掉异常不等于它
 * 消失:**监听者自己负责记录**(这只文件零依赖,手上没有 logger,而为了一句日志
 * 把整个日志栈拉进这个门面是更坏的交换)。
 *
 * 快照后遍历:一个在回调里退订自己的监听者不该让遍历漏掉后面的人。
 */
export function notifyMCPToolTableChanged(): void {
  for (const listener of [...toolTableListeners]) {
    try {
      listener()
    } catch {
      // 见上:监听者自己记账。
    }
  }
}

/** Test hook. */
export function resetMCPCapabilitiesChangedHandlerForTests(): void {
  handler = null
  toolkitHandler = null
  toolTableListeners.clear()
}
