/**
 * interaction —— 向人提问:一次 `ask_user` / 外部 agent 的提问从发出、等回答、超时到撤销的登记表。
 *
 * 对外交出一类东西:登记表 `Interaction` 与它的缺省超时、几种收场理由,以及总线事件与回答命令的形状。
 * 另交出提问链的记账接线(把问答的时刻与决定记进会话事件日志,装配在 `initialize` 之后装一次,D202 从 session 搬来)。
 * 「这间房里有没有人能回答」那只判据住在 session(`noHumanInTheRoom`,D191 从这里搬走):它只读会话记录。
 * 依赖(入口值闭包实测,480 只文件):session(记账接线写会话事件日志,经它带进 agent-loop、provider、settings、
 * storage 等)、logging。
 */
export {
  DEFAULT_INTERACTION_ABORTED_REASON,
  DEFAULT_INTERACTION_DECLINED_REASON,
  DEFAULT_INTERACTION_TIMEOUT_MS,
  DEFAULT_INTERACTION_TIMEOUT_REASON,
  Interaction,
} from './interaction-registry.js'
export type {
  InteractionBusEvent,
  InteractionCommandEnvelope,
  InteractionEventBusLike,
  InteractionRespondCommandLike,
} from './interaction-registry.js'

// 提问链的记账接线(D202)。
export { installInteractionSessionLedger, uninstallInteractionSessionLedger } from './interaction-session-ledger.js'
