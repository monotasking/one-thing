/**
 * Kimi 的采样家规(P0b-B 泳道甲 #5a,设计稿 §5.1)。
 *
 * Kimi 把每个模型的 temperature 钉在固定值上,传别的值不是被忽略而是被 API
 * **拒绝**。所以 `KimiSamplingPolicy` 与思考开关无关:一律不发,并留一条
 * `setting-dropped`。
 *
 * 两个层面各一道:回合层(warning 留没留、请求体的字节有没有被这条策略碰过)
 * 与线上层(真发出去的 body 里到底有没有 `temperature`)。
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentTurnRequest } from "@onething/core/agent-loop";
import {
	LedgerModelProfileResolver,
	RequestBodyBuilder,
	TurnContext,
} from "../../base/index.js";
import {
	createAgentProviderFromRuntime,
	type AgentProviderRuntimeConfig,
} from "../../factory.js";
import { getLogger } from "../../../../logging/index.js";
import type { AgentProviderRequestDumper } from "../../request-dump.js";
import {
	drain,
	sseResponse,
	SYSTEM_MESSAGE,
	USER_MESSAGE,
} from "../../__tests__/wire-snapshots/snapshot-harness.js";
import { kimiSamplingPolicy } from "../kimi.js";

const SSE = [
	'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
	"data: [DONE]",
	"",
].join("\n\n");

const CONFIGS: Record<string, AgentProviderRuntimeConfig> = {
	kimi: {
		apiKey: "sk-kimi",
		providerOptions: { kimiApiMode: "standard", kimiRegion: "cn" },
	},
	"kimi-code": {
		authContext: { kind: "oauth", token: { accessToken: "kimi-code-token" } },
	},
};

function turnFor(request: AgentTurnRequest): TurnContext {
	const profile = new LedgerModelProfileResolver().resolveSync(
		"kimi",
		request.model,
	);
	return new TurnContext(
		request,
		profile,
		new RequestBodyBuilder(),
		getLogger("providers.kimi"),
	);
}

async function wireBody(
	providerId: "kimi" | "kimi-code",
	request: Partial<AgentTurnRequest>,
): Promise<Record<string, unknown>> {
	const model = "kimi-k2.6";
	let body: Record<string, unknown> = {};
	const provider = createAgentProviderFromRuntime(
		providerId,
		{ ...CONFIGS[providerId]!, model },
		{
			requestDumper: vi.fn(async () => undefined) as AgentProviderRequestDumper,
			fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
				body = JSON.parse(String(init?.body ?? "null"));
				return sseResponse(SSE);
			}) as typeof globalThis.fetch,
		},
	);
	await drain(
		provider!.streamTurn!({
			turn: 1,
			model,
			messages: [SYSTEM_MESSAGE, USER_MESSAGE],
			...request,
		}),
	);
	return body;
}

describe("KimiSamplingPolicy —— temperature 一律不发", () => {
	for (const thinking of ["enabled", "disabled", undefined] as const) {
		it(`thinking=${thinking ?? "unset"}:丢掉 temperature 并留痕`, () => {
			const turn = turnFor({
				messages: [{ role: "user", content: "hi" }],
				model: "kimi-k2.6",
				turn: 1,
				temperature: 0.3,
				...(thinking ? { thinking } : {}),
			});
			kimiSamplingPolicy.apply(turn, turn.builder);

			// 旁路元数据:这条策略一个字节都没往请求体里写。
			expect(turn.builder.build()).toEqual({});
			expect(turn.warnings.map((warning) => warning.kind)).toEqual([
				"setting-dropped",
			]);
			expect(turn.warnings[0]!.fields).toMatchObject({ temperature: 0.3 });
			expect(turn.warnings[0]!.toText()).toContain("fixed per-model value");
		});
	}

	it("没给 temperature 就没有 warning", () => {
		const turn = turnFor({
			messages: [{ role: "user", content: "hi" }],
			model: "kimi-k2.6",
			turn: 1,
		});
		kimiSamplingPolicy.apply(turn, turn.builder);
		expect(turn.warnings).toEqual([]);
	});

	for (const providerId of ["kimi", "kimi-code"] as const) {
		it(`${providerId}:线上 body 里没有 temperature`, async () => {
			const body = await wireBody(providerId, {
				temperature: 0.3,
				thinking: "disabled",
			});
			expect(body).not.toHaveProperty("temperature");
		});
	}
});
