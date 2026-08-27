export * from './types.js'
export * from './codec.js'
// F4-c 定律二(§16.19):打包是**存储编码**,不是语义 —— 编码器(含 U0 的段边界
// 状态机)与解码器同住一处,唯一合同 decode(encode(x)) ≡ x。
export * from './chunk-codec.js'
