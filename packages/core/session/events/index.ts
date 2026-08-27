export * from './types.js'
export * from './codec.js'
// F4-c 定律二(§16.19):打包是**存储编码**,不是语义 —— 编码器(含 U0 的段边界
// 状态机)与解码器同住一处,唯一合同 decode(encode(x)) ≡ x。
export * from './chunk-codec.js'
// F4-c 定律三(§16.19 / §17):短命事实必须被证明会被取代 —— 封闭策略表住在
// 词汇表旁边,`canonical.ts` 的豁免表从它这里读该丢哪几格。
export * from './ephemeral-policy.js'
// §17.7 #2+#1:账本的产地印章(verify 的分栏判据)。
export * from './origin.js'
