/**
 * 请求侧与能力侧的同一口径 —— 真机 `Agent provider does not support image output`
 * 的回归门。
 *
 * 症状:Codex 下选 gpt-5.5,请求侧读目录条目的
 * `providerMetadata.codex.nativeTools: ['image_generation']` 推出
 * `requestedOutputModalities: ['image']`,能力侧却读同一条目的
 * `supportsImageOutput: false`(Codex /models 从不报 output_modalities,
 * 条目生成时便写死了 `['text']`)把 provider 自己声明的 image 输出删掉,
 * 于是 core 在 runner 里抛。
 *
 * 现在两侧同读一条规则:原生 image_generation 工具可用 ⇒ 具备 image 输出。
 */
import { describe, expect, it } from "vitest";
import { assertAgentOutputModalitiesSupportedByCapabilities } from "@onething/core";
import { createAgentProviderFromRuntime } from "../factory.js";

/** 真机 `~/.onething/settings.json` 里 /codex/models/gpt-5.5 那条的形状。 */
const STALE_CODEX_ENTRY = {
	supportsTools: true,
	supportsVision: true,
	supportsReasoning: true,
	supportsImageOutput: false,
	supportsTemperature: false,
	providerMetadata: {
		codex: {
			defaultReasoningEffort: "medium",
			supportedReasoningEfforts: [{ effort: "medium" }],
			supportsReasoningSummaries: true,
			serviceTiers: [],
			nativeTools: ["image_generation"],
		},
	},
};

describe("codex per-model capabilities", () => {
	it("keeps image output when a cached entry says supportsImageOutput:false but carries the native tool", async () => {
		const provider = createAgentProviderFromRuntime("codex", {
			model: "gpt-5.5",
			apiKey: "test-token",
			models: { "gpt-5.5": STALE_CODEX_ENTRY },
		});
		expect(provider).toBeDefined();

		const caps = await provider!.getModelCapabilities!("gpt-5.5");
		expect(caps.outputModalities).toContain("image");
		expect(caps.capabilities).toContain("image-output");

		// 这是真机上炸的那一句(core runner → capabilities.ts)。
		expect(() =>
			assertAgentOutputModalitiesSupportedByCapabilities(["image"], caps),
		).not.toThrow();
	});

	it("still strips image output when the ledger genuinely says no", async () => {
		const provider = createAgentProviderFromRuntime("codex", {
			model: "gpt-5.5",
			apiKey: "test-token",
			models: {
				"gpt-5.5": {
					...STALE_CODEX_ENTRY,
					providerMetadata: { codex: { nativeTools: [] } },
				},
			},
		});

		const caps = await provider!.getModelCapabilities!("gpt-5.5");
		expect(caps.outputModalities).not.toContain("image");
		expect(() =>
			assertAgentOutputModalitiesSupportedByCapabilities(["image"], caps),
		).toThrow(/does not support image output/);
	});
});
