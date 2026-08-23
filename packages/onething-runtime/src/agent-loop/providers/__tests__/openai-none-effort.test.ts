/**
 * `effort: 'none'`(P3-3 的判据,P4-5 换线之后的拼法,设计稿 §12 OpenAI 摘要)。
 *
 * OpenAI 的推理家族**没有** `thinking` 参数 —— 一直以来「关思考」在这条线上就
 * 是发不出去的话,所以 `disabled` 什么都不发。gpt-5.1 起多了一个 `none` 档,
 * 那才是这一家的关闭开关(官方 gpt-5.5 模型页逐字:「Reasoning.effort
 * supports: none, low, medium (default), high and xhigh.」;gpt-5 那页是
 * 「minimal, low, medium, and high」—— 没有 `none`)。
 *
 * **P4-5:判据一个字没变,落点变了。** 这一家从 chat-completions 换到
 * `/v1/responses` 之后,同一个旋钮从顶层 `reasoning_effort` 挪进
 * `reasoning: { effort }`(`OpenAIResponsesReasoningWire` 与
 * `OpenAIEffortWire` 共用 `clampOpenAIReasoningEffort` /
 * `openAIAcceptsNoneEffort`)。这份门因此改读 `reasoning.effort`,断言的**语义
 * 逐条不变**。
 *
 * 判据只有账本一个:`profile.reasoningProfile.efforts` 里有没有 `'none'`。
 * wire 自己不认模型名 —— 所以这份门用**同一条 wire、两个模型**来证:
 * gpt-5.5 发 `none`,gpt-5 一个字节都不多。`enabled` 一路照旧(四档钳位)。
 *
 * `effort:'none'` 的那一档**不带 `summary`**:一个思考 token 都不产的回合要
 * 一份思考摘要是自相矛盾的(理由写在 `thinking/openai-responses-reasoning.ts`)。
 */
import { describe, expect, it } from "vitest";
import type { AgentTurnRequest } from "@onething/core/agent-loop";
import {
	captureWireRequest,
	sseResponse,
	SYSTEM_MESSAGE,
	USER_MESSAGE,
} from "./wire-snapshots/snapshot-harness.js";

const SSE = `event: response.completed\ndata: ${JSON.stringify({
	type: "response.completed",
	response: {
		id: "resp_none_effort",
		usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
	},
})}\n\n`;

interface ResponsesReasoningBody {
	reasoning?: { effort?: string; summary?: string };
}

async function bodyFor(
	model: string,
	request: Partial<AgentTurnRequest>,
): Promise<ResponsesReasoningBody> {
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
	return dump.requestBody as ResponsesReasoningBody;
}

describe("openai-effort — the `none` rung", () => {
	it("gpt-5.1+:thinking off 发 reasoning.effort: 'none'(且不带 summary)", async () => {
		expect((await bodyFor("gpt-5.5", { thinking: "disabled" })).reasoning)
			.toEqual({ effort: "none" });
		expect((await bodyFor("gpt-5.1", { thinking: "disabled" })).reasoning)
			.toEqual({ effort: "none" });
	});

	it("gpt-5.0 与 o 系列:thinking off 仍旧什么都不发", async () => {
		expect(await bodyFor("gpt-5", { thinking: "disabled" }))
			.not.toHaveProperty("reasoning");
		expect(await bodyFor("o3", { thinking: "disabled" }))
			.not.toHaveProperty("reasoning");
	});

	it("thinking 没说话的回合两边都不发(`none` 只答 disabled 那一问)", async () => {
		expect(await bodyFor("gpt-5.5", {})).not.toHaveProperty("reasoning");
		expect(await bodyFor("gpt-5", {})).not.toHaveProperty("reasoning");
	});

	it("enabled 一路逐字未变:四档钳位,`none` 不是可选的强度", async () => {
		expect(
			(await bodyFor("gpt-5.5", { thinking: "enabled", reasoningEffort: "low" }))
				.reasoning,
		).toEqual({ effort: "low", summary: "auto" });
		// xhigh / max 仍旧夹到 high — 而不是掉进 `none`。
		expect(
			(await bodyFor("gpt-5.5", { thinking: "enabled", reasoningEffort: "max" }))
				.reasoning,
		).toEqual({ effort: "high", summary: "auto" });
		expect(
			(await bodyFor("gpt-5", { thinking: "enabled", reasoningEffort: "xhigh" }))
				.reasoning,
		).toEqual({ effort: "high", summary: "auto" });
	});

	/**
	 * `include` 与 `reasoning` **不同生共死**(与 codex 相反):`store:false` 下
	 * 加密思维链默认回传,恒发 `include` 让回放路径永远拿得到它。
	 */
	it("include 恒发,与这一回合想不想无关", async () => {
		const requests: Partial<AgentTurnRequest>[] = [
			{ thinking: "disabled" },
			{ thinking: "enabled", reasoningEffort: "high" },
			{},
		];
		for (const request of requests) {
			const body = (await bodyFor("gpt-5.5", request)) as { include?: unknown };
			expect(body.include).toEqual(["reasoning.encrypted_content"]);
		}
	});
});
