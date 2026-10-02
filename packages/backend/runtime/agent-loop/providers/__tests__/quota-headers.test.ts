import { describe, expect, it } from "vitest";
import type { AgentTurnRequest, AgentTurnStreamEvent } from "@onething/backend/core/agent-loop";
import { createCodexAgentProvider } from "../../../providers/vendors/codex/agent-provider.js";
import { planOnethingProviderDataPart } from "../provider-data.js";

/**
 * 批 5 被动源:方言实现了 `quotaFromHeaders` 时,模板方法拿到响应头就上抛一条
 * `provider-data { type: 'quota' }`;它不上消息(plan = none)。
 */
function sse(headers: Record<string, string>): Response {
	return new Response(
		[
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hi" })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: {} })}`,
			"data: [DONE]",
			"",
		].join("\n\n"),
		{ status: 200, headers: { "content-type": "text/event-stream", ...headers } },
	);
}

async function collect(events: AsyncIterable<AgentTurnStreamEvent>): Promise<AgentTurnStreamEvent[]> {
	const out: AgentTurnStreamEvent[] = [];
	for await (const event of events) out.push(event);
	return out;
}

const request = {
	turn: 3,
	model: "gpt-5.3-codex",
	messages: [{ role: "user" as const, content: "hello" }],
} as AgentTurnRequest;

describe("被动配额源(codex 响应头)", () => {
	it("头上带限额 → 一条 quota provider-data,在正文之前;plan = none", async () => {
		const provider = createCodexAgentProvider({
			oauthToken: { accessToken: "t" } as never,
			fetchImpl: async () =>
				sse({
					"x-codex-primary-used-percent": "62",
					"x-codex-primary-window-minutes": "300",
					"x-codex-secondary-used-percent": "31",
					"x-codex-secondary-window-minutes": "10080",
				}),
		});
		const events = await collect(provider.streamTurn!(request));
		const quotaIndex = events.findIndex((event) => event.type === "provider-data");
		const textIndex = events.findIndex((event) => event.type === "text-delta");
		expect(quotaIndex).toBeGreaterThanOrEqual(0);
		expect(quotaIndex).toBeLessThan(textIndex);
		const event = events[quotaIndex] as Extract<AgentTurnStreamEvent, { type: "provider-data" }>;
		expect(event.turn).toBe(3);
		expect(event.providerData).toMatchObject({
			provider: "codex",
			type: "quota",
			quota: {
				kind: "windows",
				windows: [
					{ id: "5h", usedPercent: 62 },
					{ id: "7d", usedPercent: 31 },
				],
			},
		});
		expect(planOnethingProviderDataPart(event.providerData)).toBe("none");
	});

	it("头上不带这一族 → 一条都不发", async () => {
		const provider = createCodexAgentProvider({
			oauthToken: { accessToken: "t" } as never,
			fetchImpl: async () => sse({}),
		});
		const events = await collect(provider.streamTurn!(request));
		expect(events.some((event) => event.type === "provider-data")).toBe(false);
	});
});
