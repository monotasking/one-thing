import type { TerminalInfo } from '@shared/ipc/terminal'
import type { ACPAgentState } from '@shared/ipc/acp'

/**
 * **一格终端是谁开的**(ACP A3-d · 壳半边;后端 A3-b 给 `TerminalInfo.owner`)。
 *
 * agent 的 `terminal/create` 与人自己开的终端走的是同一个 `TerminalService`,于是
 * 终端名单里两种混在一起。人要一眼分得出「这一格是我开的,还是 Claude 替我开的」——
 * 后者关掉会让 agent 那一轮读不到输出,不该跟自己的 shell 混成一列。
 *
 * 两件纯函数,菜单(`terminal-launcher.tsx`)只读它们:
 *  · `splitTerminalsByOwner` —— 人自己的一组、agent 开的一组。**缺席 `owner` 读作
 *    「人自己的」**:A3-b 之前的后端、以及人手开的终端都不带这一格,
 *    把它们当 agent 的会凭空多出一组;
 *  · `agentNameOf` —— 名字取名册(`acpAgentsQuery`)里那一台的显示名,名册没那台或还没
 *    拉到就退回 agent id —— 写一个 id 比写「未知 agent」诚实,人至少能拿它去设置页找。
 */
export function splitTerminalsByOwner(rows: readonly TerminalInfo[]): {
  mine: TerminalInfo[]
  agents: TerminalInfo[]
} {
  const mine: TerminalInfo[] = []
  const agents: TerminalInfo[] = []
  for (const row of rows) (row.owner?.kind === 'acp' ? agents : mine).push(row)
  return { mine, agents }
}

export function agentNameOf(agentId: string | undefined, roster: readonly ACPAgentState[] | undefined): string {
  if (!agentId) return ''
  const state = roster?.find((row) => row.config.id === agentId)
  return state?.config.name || state?.manifest?.name || agentId
}
