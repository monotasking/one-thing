import { describe, expect, it } from "vitest";
import { builtinProviderFamilyLookup as providerFamilyOf } from "../provider-builtin-manifests.js";

/*
 * P4 从 `packages/shared/__tests__/` 搬来:家族表从 `@shared` 搬进了 runtime 名册,
 * `providerFamilyOf` 换成名册算出来的查询(`builtinProviderFamilyLookup`),断言逐字未改。
 * 原文件里 `isSubscriptionFamilyMember` / `providerFamilyDisplayName` 两组随那两个函数一起删了:
 * 它们在产品代码里零调用者(只剩这份测试),是死代码。
 */
describe("providerFamilyOf", () => {
	it("resolves both members of a family to the same family", () => {
		expect(providerFamilyOf("openai")?.id).toBe("openai");
		expect(providerFamilyOf("codex")?.id).toBe("openai");
		expect(providerFamilyOf("grok")?.id).toBe("grok");
		expect(providerFamilyOf("grok-oauth")?.id).toBe("grok");
		expect(providerFamilyOf("claude")?.id).toBe("claude");
		expect(providerFamilyOf("claude-code")?.id).toBe("claude");
	});

	it("returns null for providers without a family", () => {
		expect(providerFamilyOf("deepseek")).toBeNull();
		expect(providerFamilyOf("github-copilot")).toBeNull();
	});
});
