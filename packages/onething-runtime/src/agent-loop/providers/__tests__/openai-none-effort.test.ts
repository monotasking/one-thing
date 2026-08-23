/**
 * `reasoning_effort: 'none'`(P3-3,设计稿 §12 OpenAI 摘要)。
 *
 * OpenAI 的推理家族**没有** `thinking` 参数 —— 一直以来「关思考」在这条线上就
 * 是发不出去的话,所以 `disabled` 什么都不发。gpt-5.1 起多了一个 `none` 档,
 * 那才是这一家的关闭开关。
 *
 * 判据只有账本一个:`profile.reasoningProfile.efforts` 里有没有 `'none'`。
 * wire 自己不认模型名 —— 所以这份门用**同一条 wire、两个模型**来证:
 * gpt-5.5 发 `none`,gpt-5 一个字节都不多。`enabled` 一路照旧(四档钳位)。
 */
import { describe, expect, it } from "vitest";
import type { AgentTurnRequest } from "@onething/core/agent-loop";
import {
	captureWireRequest,
	sseResponse,
	SYSTEM_MESSAGE,
	USER_MESSAGE,
} from "./wire-snapshots/snapshot-harness.js";

const SSE = [
	'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
	"data: [DONE]",
	"",
].join("\n\n");

async function bodyFor(
	model: string,
	request: Partial<AgentTurnRequest>,
): Promise<Record<string, unknown>> {
	const dump = await captureWireRequest({
		providerId: "openai",
		config: { apiKey: "sk-openai", model },
		request: {
			messages: [SYSTEM_MESSAGE, USER_MESSAGE],
			model,
			turn: 1,
			...request,
		},
		respond: () => sseResponse(SSE),
	});
	return dump.requestBody as Record<string, unknown>;
}

describe("openai-effort — the `none` rung", () => {
	it("gpt-5.1+:thinking off 发 reasoning_effort: 'none'", async () => {
		expect((await bodyFor("gpt-5.5", { thinking: "disabled" })).reasoning_effort)
			.toBe("none");
		expect((await bodyFor("gpt-5.1", { thinking: "disabled" })).reasoning_effort)
			.toBe("none");
	});

	it("gpt-5.0 与 o 系列:thinking off 仍旧什么都不发", async () => {
		expect(await bodyFor("gpt-5", { thinking: "disabled" }))
			.not.toHaveProperty("reasoning_effort");
		expect(await bodyFor("o3", { thinking: "disabled" }))
			.not.toHaveProperty("reasoning_effort");
	});

	it("thinking 没说话的回合两边都不发(`none` 只答 disabled 那一问)", async () => {
		expect(await bodyFor("gpt-5.5", {})).not.toHaveProperty("reasoning_effort");
		expect(await bodyFor("gpt-5", {})).not.toHaveProperty("reasoning_effort");
	});

	it("enabled 一路逐字未变:四档钳位,`none` 不是可选的强度", async () => {
		expect(
			(await bodyFor("gpt-5.5", { thinking: "enabled", reasoningEffort: "low" }))
				.reasoning_effort,
		).toBe("low");
		// xhigh / max 仍旧夹到 high — 而不是掉进 `none`。
		expect(
			(await bodyFor("gpt-5.5", { thinking: "enabled", reasoningEffort: "max" }))
				.reasoning_effort,
		).toBe("high");
		expect(
			(await bodyFor("gpt-5", { thinking: "enabled", reasoningEffort: "xhigh" }))
				.reasoning_effort,
		).toBe("high");
	});
});
