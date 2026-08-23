/**
 * `openai` —— 官方 chat/completions。与 `factory.ts` 今天那条注册逐项对照:
 * `defaultBaseUrl` / `supportsVision:true` / `supportsReasoning:true` /
 * `maxTokensField:'max_completion_tokens'` / `reasoningStyle:'openai-effort'`;
 * `includeAssistantReasoning` 没给 —— OpenAI 官方不收 `reasoning_content`。
 *
 * `filePdf:'openai-file'`(P3-1)—— chat-completions 认 `file` 内容块
 * (`{filename, file_data}`),PDF 从此真进请求体而不是留一行占位文本。
 *
 * `providerOptions`(P3-3)—— 这一家认请求级袋里的两条:`verbosity`
 * (`low|medium|high`,顶层)与 `imageDetail`(`auto|low|high`,写进每个
 * `image_url.detail`)。两条都没有设置 UI,用户手改 settings.json。
 */
import { openAIEffortWire } from "../thinking/index.js";
import { OPENAI_CHAT_IMAGE_DETAIL_VALUES } from "../wires/index.js";
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
	// 请求级袋(P3-3):`verbosity` 上顶层,`imageDetail` 进每个 `image_url`。
	// 这是唯一一家两条都认的 —— 别家只有 detail(见各自配方)。
	providerOptions: {
		verbosity: true,
		imageDetail: OPENAI_CHAT_IMAGE_DETAIL_VALUES,
	},
	transport: openAIChatTransportCapabilities({ vision: true, reasoning: true }),
});
