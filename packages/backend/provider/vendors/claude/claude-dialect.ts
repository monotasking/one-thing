/**
 * `claude` —— 官方 Anthropic Messages 端点。对照同目录 `runtime.ts`:
 * `defaultBaseUrl: 'https://api.anthropic.com/v1'`、`promptCaching: true`、
 * `x-api-key` 走 `config.apiKey`,传输声明是 `CLAUDE_CAPABILITIES` 原样。
 *
 * 服务商自述试点 P2 第 2 批从 `agent-loop/providers/dialects/claude.ts` 搬回家;定义即登记
 * (`defineAnthropicDialect`),由 `vendors/provider-vendor-runtimes.ts` 经 `runtime.ts` 拉起。
 */
import {
	ANTHROPIC_DEFAULT_BASE_URL,
	defineAnthropicDialect,
} from "../../dialects/provider-dialects-anthropic-recipe.js";

export const CLAUDE_DIALECT = defineAnthropicDialect({
	id: "claude",
	label: "Anthropic",
	defaultBaseUrl: ANTHROPIC_DEFAULT_BASE_URL,
	promptCaching: true,
});
