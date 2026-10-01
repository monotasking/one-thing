/**
 * 协议层思考线型里,用户能在思考覆盖(`reasoningProfile.wire`)里点名的那几条的 id
 * (服务商自述试点 P3,`docs/design/architecture-direction-2026-10.md` §4)。
 *
 * 从前合法取值是 `providers/model-capability.ts` 里一行手写名单,连各家专属的线型一起列。
 * 现在分两半:名字说的是**线协议**的写在这里;名字点了**某一家**的由那家 manifest 的
 * `reasoningWires` 声明 —— 不论线型代码住在那家的 `vendors/<id>/thinking.ts`(智谱 / 千问 / xAI)
 * 还是本目录(OpenRouter 的 `reasoning` 对象、Responses 线型的旧 id `codex`,别家也借用)。
 * `normalizeOnethingReasoningProfileOverride` 读两半的并集。
 *
 * 零 import 的纯数据:`model-capability.ts` 要读它,而壳与 web 构建直接 import 那个模块 ——
 * 这里一旦拉起线型注册表(`./index.ts`),整条 agent-loop 就跟进了壳。所以是名单而不是
 * 「已登记的线型」:登记表在壳里不存在,而且登记表里还有用户不许点名的线型
 * (DeepSeek 的推断线型)。名单与登记表对得上由 `providers/__tests__/reasoning-wire-ids.test.ts` 钉着。
 */
export const PROTOCOL_DECLARABLE_REASONING_WIRE_IDS: readonly string[] = [
  'anthropic-adaptive',
  'anthropic-budget',
  'anthropic-always',
  'openai-effort',
  'gemini-level',
  'gemini-budget',
  'thinking-type',
  'none',
]
