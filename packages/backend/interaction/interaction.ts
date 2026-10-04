/**
 * interaction —— 向人提问:一次 `ask_user` / 外部 agent 的提问从发出、等回答、超时到撤销的登记表。
 *
 * 对外交出一类东西:登记表 `Interaction` 与它的缺省超时、几种收场理由,以及总线事件与回答命令的形状。
 * 「这间房里有没有人能回答」那只判据(`interaction-no-human.ts`)不经入口交出:它读会话,
 * 而会话入口又引这只入口,交出就成环;三处读者仍直接引它。依赖 logging。
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
