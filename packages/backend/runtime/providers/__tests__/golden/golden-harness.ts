/**
 * 批 4 golden 夹具的公共半边(`docs/design/provider-settings-rework-2026-09.md` §7.2)。
 *
 * 五份真实转发站形状的 SSE(DeepSeek 直连 / 聚合站 `reasoning` / Ollama / vLLM / LM Studio)
 * 加一份「默认读不出」的 `thinking-field`,再加一份老格式工具调用 `function-call-legacy`。
 * 每份都经**真的** `createAgentProviderFromRuntime`
 * 跑一遍:没有 spec 时走 `custom-openai` 方言(今天的路),事件序列逐字钉进
 * `<name>.events.json` —— 那几份 JSON 是在批 4 改动**之前**录的。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import type { AgentTurnRequest, AgentTurnStreamEvent } from "@onething/backend/runtime/agent-loop/loop-primitives";
import {
	createAgentProviderFromRuntime,
	type AgentProviderRuntimeConfig,
} from "../../factory.js";
import type { AgentProviderRequestDumper } from "../../request-dumper.js";
import { drain, sseResponse, SYSTEM_MESSAGE, TOOLS, USER_MESSAGE } from "../wire-snapshots/snapshot-harness.js";

export const GOLDEN_DIR = dirname(fileURLToPath(import.meta.url));

export const GOLDEN_FIXTURES = [
	"deepseek-direct",
	"aggregator-reasoning",
	"ollama",
	"vllm",
	"lmstudio",
	"thinking-field",
	// 老格式 `delta.function_call` + 非标 `finish_reason: "function_call"`(§7.5 演练)。
	// 无 spec 时这份期望是用**搬之前**的线录的:工具调用解不出,如实钉住。
	"function-call-legacy",
] as const;

export type GoldenFixture = (typeof GOLDEN_FIXTURES)[number];

export function goldenSse(name: GoldenFixture): string {
	return readFileSync(join(GOLDEN_DIR, `${name}.sse`), "utf8");
}

export function goldenExpectedPath(name: GoldenFixture): string {
	return join(GOLDEN_DIR, `${name}.events.json`);
}

export const GOLDEN_REQUEST: AgentTurnRequest = {
	turn: 1,
	model: "golden-model",
	messages: [SYSTEM_MESSAGE, USER_MESSAGE],
	tools: TOOLS,
	thinking: "enabled",
	reasoningEffort: "high",
};

export interface GoldenCapture {
	body: Record<string, unknown>;
	events: AgentTurnStreamEvent[];
}

export async function runGolden(
	providerId: string,
	name: GoldenFixture,
	config: Partial<AgentProviderRuntimeConfig> = {},
): Promise<GoldenCapture> {
	let body: Record<string, unknown> = {};
	const provider = createAgentProviderFromRuntime(
		providerId,
		{ apiKey: "sk-golden", baseUrl: "https://relay.golden.test/v1", model: GOLDEN_REQUEST.model, ...config },
		{
			requestDumper: vi.fn(async () => undefined) as AgentProviderRequestDumper,
			fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
				body = JSON.parse(String(init?.body ?? "null"));
				return sseResponse(goldenSse(name));
			}) as typeof globalThis.fetch,
		},
	);
	if (!provider?.streamTurn) throw new Error(`no provider for ${providerId}`);
	const events = await drain(provider.streamTurn(GOLDEN_REQUEST));
	return { body, events };
}
