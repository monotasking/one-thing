import { NOOP_GEOMETRY_REPORT, type GeometryReport } from '../geometry-report'

/**
 * **站在 Provider 上面的那几个消费者怎么拿到同一个口**(G 线 P2-c)。
 *
 * ── 为什么要它 ────────────────────────────────────────────────────────────
 * `GeometryReportContext.Provider` 摆在 `ChatStream` 里(值由那只薄 hook 现做),
 * 而 `toc/useChatToc` 住在**会话叶**上 —— 它是 `ChatStream` 的兄弟兼父级的邻居,
 * 结构上够不着那条 context。可它要报的那一件(点钢琴键 / 点检索命中落到某条消息)
 * 恰恰是 `jump` 那个动词。
 *
 * 三条路里选了这一条:
 *  · 把 Provider 提到会话叶上 —— 那要把 `useViewportAnchor` 整只搬出 `ChatStream`,
 *    是 P2-d 的改动面,这一单不动骨架;
 *  · 给 TOC 自己再写一发滚动 —— 那正是这一单要收编掉的病(§13.1.4 ③);
 *  · **按 `sessionId` 登记同一只对象**,两条路交出的是**同一个实例**。选它。
 *
 * ── 它不是第二条通道 ──────────────────────────────────────────────────────
 * 这里没有第二份行为:登记进来的就是 context 里那一只。所以「一个口」这句话仍然
 * 成立 —— 变的只是**够不够得着**,不是**有几种报法**。
 *
 * ── 为什么按 `sessionId` ──────────────────────────────────────────────────
 * 会话多开之后同一时刻屏上有好几片聊天区,每片一只锚定器;`useChatToc(sessionId, …)`
 * 手上正好有这个 id,而它与 `ChatStream` 的 `sessionId` 是**同一份事实**。
 *
 * ── 寿命 ──────────────────────────────────────────────────────────────────
 * 一次挂载一格,卸载时**按身份**摘(`if (map.get(id) === report)`)—— 换会话时
 * React 先绑新的、再跑旧的 cleanup,不按身份摘会把刚登记的那一只摘掉。
 * 模块级表 + HMR dispose(仓法:寿命 = 这个模块实例的东西要配 dispose)。
 */
const ports = new Map<string, GeometryReport>()

/** 登记这一片聊天区的口。返回摘除函数(按身份摘,判词在文件头)。 */
export function registerGeometryPort(sessionId: string, report: GeometryReport): () => void {
  ports.set(sessionId, report)
  return () => {
    if (ports.get(sessionId) === report) ports.delete(sessionId)
  }
}

/**
 * 取这一片聊天区的口。没人登记(样例页 / 单测 / 这一片还没挂上)就是**缺省那一只**
 * —— 与 context 的缺省逐字同一个对象,所以「够不着」与「不在流里」得到同一种行为。
 */
export function geometryPortOf(sessionId: string): GeometryReport {
  return ports.get(sessionId) ?? NOOP_GEOMETRY_REPORT
}

/** 单测用:把表清空。 */
export function resetGeometryPorts(): void {
  ports.clear()
}

if (import.meta.hot) import.meta.hot.dispose(() => resetGeometryPorts())
