/**
 * **哪些收场原因要上屏,以及它们各自叫什么** —— 全仓唯一那张表。
 *
 * 事故(2026-09-09,真店会话 `fe5261d9…`):三次重试都以
 * `request/end.stopReason = 'length'` 收场(`maxTokens` 全花在 reasoning 上,
 * 一个字正文都没产出),而 runner 对 `length` 没有特判 —— `run/end` 照旧
 * `outcome: 'completed'`。于是屏幕上什么都不说,用户看到的是「莫名其妙就停了」。
 * 缺的从来不是事实(账本里 `request/end` 早写着 `length`),是**投影 + 渲染**。
 *
 * ## 为什么是一张表,而不是消费方各判各的
 *
 * `stopReason` 是 provider 归一之后的那一格(`AgentFinishReason`:stop /
 * length / tool_calls / content_filter / error / max_turns / unknown),它是
 * **能力面的词汇**。壳一旦自己写 `reason === 'length'`,「哪些原因算异常」这件事
 * 就有了第二个产地,下一次加一档(比方说 `max_turns`)要改两处、而且必然漏一处
 * —— 这正是仓根 CLAUDE.md「凡按能力枚举的地方改成能力自述、别人读表」那条法
 * 管的形。所以:**reason 的字面量只出现在这个文件里**,壳只认 `kind`,拿 kind
 * 去查它自己的文案表。表里加一档新 kind,壳没接上时会落到它的兜底句
 * (`chat.stopGeneric`,原样把 reason 摆出来),不会说错话。
 *
 * ## 为什么只有两档
 *
 * 判据是**「这一轮的结局与用户以为的不一样」**:
 *  - `length` —— 回复被 `maxTokens` 砍断,后面还有话没说完;
 *  - `content_filter` —— 厂商的内容过滤掐掉了。
 *
 * 其余各有各的理由缺席,一条都不是「暂时没做」:
 *  - `stop` / `tool_calls` —— 这就是正常收场,说出来是噪音;
 *  - `error` —— 已经有 `errorDetails` 那条路上屏(错误卡),再说一遍是两个入口;
 *  - `max_turns` —— 那是**这次执行**的闸,不是某一条请求的收场,归属不在这一格;
 *  - `unknown` —— provider 没说,壳跟着编一句是造事实。
 */

/**
 * 归一后的 stopReason → 投影 kind。**只增不改**:kind 是壳的文案键的一半,
 * 改名等于换掉一句已经在用户屏幕上的话。
 */
export const SURFACED_STOP_REASONS = {
  length: 'output-limit',
  content_filter: 'content-filter',
} as const

export type ProjectedStopKind = (typeof SURFACED_STOP_REASONS)[keyof typeof SURFACED_STOP_REASONS]

/**
 * 这个 reason 要不要上屏;要的话叫什么。
 *
 * 收 `string | undefined` 而不是 `AgentFinishReason`:账本里那一格是**老会话也
 * 会有的自由字符串**(记录器原样写 `event.finishReason`,而更早的 provider 归一
 * 表不一定与今天逐字相同)。认不出来的一律 `undefined` —— 不上屏,不猜。
 */
export function surfacedStopKind(reason: string | undefined): ProjectedStopKind | undefined {
  if (reason === undefined) return undefined
  return (SURFACED_STOP_REASONS as Record<string, ProjectedStopKind | undefined>)[reason]
}
