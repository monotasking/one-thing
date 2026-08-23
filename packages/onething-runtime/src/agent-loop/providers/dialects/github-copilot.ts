/**
 * `github-copilot` —— 对照 `factory.ts`:`defaultBaseUrl` /
 * `supportsVision:true` / `supportsReasoning:true` / `supportsTools:true`;
 * **没有** `reasoningStyle` → `none`,也没有 `includeAssistantReasoning`。
 *
 * 已知的今天行为(快照如实记录,P0b 才动):thinking 开着时仍然会丢掉
 * temperature,尽管这条线协议上根本发不出思考参数。
 */
import { openAIChatNoThinkingWire } from "../thinking/index.js";
import { defineOpenAIChatDialect, openAIChatTransportCapabilities } from "./recipe.js";

export const GITHUB_COPILOT_DIALECT = defineOpenAIChatDialect({
	id: "github-copilot",
	defaultBaseUrl: "https://api.individual.githubcopilot.com",
	reasoning: openAIChatNoThinkingWire,
	transport: openAIChatTransportCapabilities({
		vision: true,
		reasoning: true,
		tools: true,
	}),
});
