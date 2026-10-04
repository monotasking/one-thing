
// 行编解码是纯逻辑,住共享层(D202:检索 Worker 与会话两边都从 shared 拿);这里原样转交,会话自己的读者不改说明符。
export * from '@shared/session/events/codec.js'
// F4-c 定律三(§16.19 / §17):短命事实必须被证明会被取代 —— 封闭策略表住在
// 词汇表旁边,`canonical.ts` 的豁免表从它这里读该丢哪几格。
export * from './session-events-ephemeral-policy.js'
