/**
 * `openai` —— 官方 chat/completions。与 `factory.ts` 今天那条注册逐项对照:
 * `defaultBaseUrl` / `supportsVision:true` / `supportsReasoning:true` /
 * `maxTokensField:'max_completion_tokens'` / `reasoningStyle:'openai-effort'`;
 * `includeAssistantReasoning` 没给 —— OpenAI 官方不收 `reasoning_content`。
 *
 * `filePdf:'openai-file'`(P3-1)—— chat-completions 认 `file` 内容块
 * (`{filename, file_data}`),PDF 从此真进请求体而不是留一行占位文本。
 */
import { openAIEffortWire } from "../thinking/index.js";
import {
	defineOpenAIChatDialect,
	openAIChatTransportCapabilities,
	promptCacheKeyExtraBody,
} from "./recipe.js";

export const OPENAI_DIALECT = defineOpenAIChatDialect({
	id: "openai",
	defaultBaseUrl: "https://api.openai.com/v1",
	maxTokensField: "max_completion_tokens",
	reasoning: openAIEffortWire,
	filePdf: "openai-file",
	extraBody: promptCacheKeyExtraBody,
	transport: openAIChatTransportCapabilities({ vision: true, reasoning: true }),
});
