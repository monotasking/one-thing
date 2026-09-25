import type { ACPSessionOption } from '@shared/ipc/acp'
import type { AcpSessionState } from '@shared/contracts/acp'

/**
 * **composer 上本来就有的控件,按协议的 `category` 认领 agent 自报的选项**
 * (A2-c,正本 `docs/design/acp-integration-2026-09.md` §3.8 那张表)。
 *
 * | composer 控件 | 认领 category | 屏上的样子 |
 * | --- | --- | --- |
 * | 模型药丸 | `model` | 药丸写当前那一格的名字;点开抽屉,右卡第一行就是这张表 |
 * | 思考档(药丸右半 + 右卡的竖排阶梯) | `thought_level` | 档位表 = 这一格的 choices,同一只阶梯 |
 * | 模式粒(药丸旁边新长的一粒) | `mode`;没有就退到协议的 `modes` | 写当前模式;能不能改看下面 |
 * | 右卡其余几行 | 其余一切(`model_config` / 未知 category / boolean) | select 画 `Select`,boolean 画 `Switch` |
 *
 * **判据只有 `category`,不认 agent 的名字、不认选项的 id** —— Claude 的 `effort`、
 * 别家叫 `reasoning` 的那一格,只要标着 `thought_level` 就进阶梯。每一类只认领**第一格**:
 * 一台 agent 报两格 `model` 是它自己的事,第二格照旧留在右卡,不丢。
 *
 * ── 模式那一格为什么有两个来处 ───────────────────────────────────────────
 * 协议里「模式」有两种说法:一格 `category: 'mode'` 的 config option(能改:走
 * `acp.setSessionOption`,后端发 `session/set_config_option`),或者会话答复里的 `modes`
 * (`session/set_mode` 才改得动它,而那条 RPC 今天**还没有** —— A2-b / A3 补)。
 * 前者在场就用前者;只有后者时模式粒照样画,但**只读**(`settable: false`),右卡里那一行
 * 说一句「这台 agent 的模式今天只能在它自己那边改」—— 不画一个点了没反应的下拉。
 */

export type AgentModeClaim =
  | { kind: 'option'; option: ACPSessionOption; name: string; settable: true }
  | { kind: 'modes'; current: string; name: string; settable: false }

export interface AgentClaims {
  model: ACPSessionOption | null
  thought: ACPSessionOption | null
  mode: AgentModeClaim | null
  /** 没人认领的:右卡里按原顺序一格一行。 */
  rest: ACPSessionOption[]
}

/** 一格选项此刻那个值的**名字**(不是值)。choices 里找不到就照实写值 —— 不编一个名字。 */
export function choiceNameOf(option: ACPSessionOption): string {
  return option.choices.find((choice) => choice.value === option.currentValue)?.name ?? option.currentValue
}

function isSelect(option: ACPSessionOption): boolean {
  return option.type !== 'boolean'
}

/**
 * 按 category 认领。boolean 型永远不进药丸 / 阶梯 / 模式粒(它们都是「从几个里挑一个」的控件),
 * 于是一格标着 `model` 的 boolean(协议没禁)照样留在右卡画成开关。
 */
export function claimAgentOptions(
  options: readonly ACPSessionOption[],
  modes?: AcpSessionState['modes'],
): AgentClaims {
  let model: ACPSessionOption | null = null
  let thought: ACPSessionOption | null = null
  let modeOption: ACPSessionOption | null = null
  const rest: ACPSessionOption[] = []
  for (const option of options) {
    if (isSelect(option) && option.category === 'model' && !model) model = option
    else if (isSelect(option) && option.category === 'thought_level' && !thought) thought = option
    else if (isSelect(option) && option.category === 'mode' && !modeOption) modeOption = option
    else rest.push(option)
  }
  let mode: AgentModeClaim | null = null
  if (modeOption) {
    mode = { kind: 'option', option: modeOption, name: choiceNameOf(modeOption), settable: true }
  } else if (modes?.current) {
    const found = modes.available.find((entry) => entry.id === modes.current)
    mode = { kind: 'modes', current: modes.current, name: found?.name ?? modes.current, settable: false }
  }
  return { model, thought, mode, rest }
}

/** 会话状态 → 认领表。没有状态(非 agent / 还没开过)= null,调用方据此一格都不改。 */
export function claimsOfState(state: AcpSessionState | null): AgentClaims | null {
  return state ? claimAgentOptions(state.configOptions, state.modes) : null
}
