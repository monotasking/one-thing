/**
 * `claude` —— 官方 Anthropic Messages 端点。与 `factory.ts` 今天那条注册逐项
 * 对照:`defaultBaseUrl: 'https://api.anthropic.com/v1'`、`promptCaching: true`、
 * `x-api-key` 走 `config.apiKey`,传输声明是 `CLAUDE_CAPABILITIES` 原样。
 */
import {
	ANTHROPIC_DEFAULT_BASE_URL,
	defineAnthropicDialect,
} from "./anthropic-recipe.js";

export const CLAUDE_DIALECT = defineAnthropicDialect({
	id: "claude",
	defaultBaseUrl: ANTHROPIC_DEFAULT_BASE_URL,
	promptCaching: true,
});
