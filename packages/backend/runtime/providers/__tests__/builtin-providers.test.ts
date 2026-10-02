import { describe, expect, it } from "vitest";
import {
	ONETHING_ACP_PROVIDER_ID,
	acpBuiltinProvider,
	onethingBaseBuiltinProviders,
	onethingPortableBuiltinProviders,
} from "../builtin-providers.js";

// 三个按名导出的单家定义已删(服务商自述试点 P3):按 id 从内置表取。
const builtinById = (id: string) => onethingBaseBuiltinProviders.find((provider) => provider.id === id)!;
const claudeCodeBuiltinProvider = builtinById("claude-code");
const kimiCodeBuiltinProvider = builtinById("kimi-code");
const codexBuiltinProvider = builtinById("codex");

describe("onething builtin provider metadata", () => {
	it("declares portable builtin providers in runtime", () => {
		expect(
			onethingPortableBuiltinProviders.map((provider) => provider.id),
		).toEqual([
			"openai",
			"claude",
			"deepseek",
			"kimi",
			"zhipu",
			"qwen",
			"openrouter",
			"gemini",
			"claude-code",
			"grok",
			"grok-oauth",
			"kimi-code",
			"github-copilot",
			"codex",
		]);
	});

	it("keeps OAuth and ACP metadata in runtime", () => {
		expect(claudeCodeBuiltinProvider.info).toMatchObject({
			requiresApiKey: false,
			requiresOAuth: true,
			oauthFlow: "authorization-code",
		});
		// 订阅档:凭证是 OAuth token,地址钉死在套餐 host(给个能改的框 = 给一条 401 的路)。
		expect(kimiCodeBuiltinProvider.info).toMatchObject({
			requiresApiKey: false,
			requiresOAuth: true,
			oauthFlow: "device",
			supportsCustomBaseUrl: false,
			defaultBaseUrl: "https://api.kimi.com/coding/v1",
		});
		expect(acpBuiltinProvider.id).toBe(ONETHING_ACP_PROVIDER_ID);
		expect(codexBuiltinProvider.info).toMatchObject({
			requiresApiKey: false,
			requiresOAuth: true,
			oauthFlow: "authorization-code",
		});
		// Base list = portable + local-machine agent providers (Electron only).
		expect(
			onethingBaseBuiltinProviders
				.slice(onethingPortableBuiltinProviders.length)
				.map((provider) => provider.id),
		).toEqual(["acp"]);
	});
});
