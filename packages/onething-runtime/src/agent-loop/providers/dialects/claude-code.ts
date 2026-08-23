/**
 * `claude-code` —— Claude Code 的 OAuth 通路:凭据在 `authorization` 头里
 * (所以 `x-api-key` 不发),外加固定的 system 首块与四个 beta 头。
 *
 * 那两个常量原本在 `factory.ts` 里,P1-a 随注册块一起搬到配方旁边 —— 它们是
 * 这份配方的一部分,不是工厂的。
 */
import {
	ANTHROPIC_DEFAULT_BASE_URL,
	defineAnthropicDialect,
} from "./anthropic-recipe.js";

export const CLAUDE_CODE_HEADER =
	"You are Claude Code, Anthropic's official CLI for Claude.";

export const CLAUDE_CODE_OAUTH_BETA_HEADERS = [
	"oauth-2025-04-20",
	"claude-code-20250219",
	"interleaved-thinking-2025-05-14",
	"fine-grained-tool-streaming-2025-05-14",
].join(",");

export const CLAUDE_CODE_DIALECT = defineAnthropicDialect({
	id: "claude-code",
	defaultBaseUrl: ANTHROPIC_DEFAULT_BASE_URL,
	promptCaching: true,
	systemHeader: CLAUDE_CODE_HEADER,
});
