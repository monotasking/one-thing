/**
 * 「自动识别」的探测 + 规则 + 回验(批 4 §7.3 步骤 1/2/4,
 * `docs/design/provider-settings-rework-2026-09.md`)。纯函数 + 注入 fetch,不碰 node / electron。
 *
 *  1. **探两发。** `GET` 模型列表(与目录直连拉取同一套地址与头);按启发式猜线,`POST` 一条
 *     最小流式请求(`"hi"`,16 token,`stream: true`)。先试 `/chat/completions` —— 见
 *     `choices[].delta` 就是 openai-chat,见 `event: response.created` 就是 responses;不是再
 *     依次试 `/responses`、`/messages`(见 `content_block_delta` = anthropic)、Gemini 的
 *     `:streamGenerateContent`(见 `candidates[]`)。两份样本各截前 8KB(截在事件边界上)并脱敏。
 *  2. **规则先判。** 样本里的字段名全部命中默认路径 → 适配表只写 `wire`,不请分析模型。
 *  3. (AI 只填偏差 —— 在装配层,见 `backend/rpc/domains/providers.ts`。这里只给提示词与答案解析。)
 *  4. **回验。** `verifyAdapterSpec` 用 `dialectFromSpec` 编出来的方言,经**真的**那条线把样本
 *     重放一遍:≥1 个文本增量;样本里有 usage 段就得解出 input/output;模型列表 ≥1 项。
 */
import type { AgentTurnStreamEvent } from "@onething/backend/runtime/agent-loop/loop-primitives";
import {
	CUSTOM_ADAPTER_DEFAULT_PATHS,
	CUSTOM_ADAPTER_SPEC_JSON_SCHEMA,
	type CustomAdapterSpec,
	type CustomAdapterWire,
} from "@shared/contracts/adapter-spec";
import { BearerApiKeyAuth, expandHeaderTemplates } from "./base/index.js";
import {
	CUSTOM_ADAPTER_BASE_DIALECT,
	dialectFromSpec,
} from "./dialects/custom-from-spec.js";
import {
	createAnthropicProvider,
	createGeminiProvider,
	createOpenAIChatProvider,
	createResponsesProvider,
} from "./dialects/index.js";
import type {
	AnthropicDialect,
	GeminiDialect,
	OpenAIChatDialect,
	ResponsesDialect,
} from "./wires/index.js";
import customAdapterProbePromptRaw from "../prompts/content/custom-adapter-probe.md?raw";
import {
	directModelsRequestHeaders,
	parseProviderDirectModels,
	resolveModelsEndpointUrl,
	type ProviderDirectModelsFetch,
} from "./models-endpoint.js";

/** 每份样本最多留多少字节(§7.3 ①)。 */
export const PROBE_SAMPLE_LIMIT = 8 * 1024;
const PROBE_TIMEOUT_MS = 20_000;

export interface ProbeSamples {
	/** 模型列表响应体(脱敏、截断)。拿不到 = undefined。 */
	models?: string;
	/** 流式响应体(脱敏、截断在事件边界)。 */
	stream: string;
}

export interface ProbeCustomEndpointOptions {
	baseUrl: string;
	apiKey?: string;
	headers?: Record<string, string>;
	modelsUrl?: string;
	hintModel?: string;
	fetchImpl: ProviderDirectModelsFetch;
	signal?: AbortSignal;
	/** 测试 / 门注入的时钟(`probe.at`)。 */
	now?: () => number;
}

export type ProbeFailureReason = "unreachable" | "unrecognized";

export type ProbeCustomEndpointResult =
	| {
			ok: true;
			wire: CustomAdapterWire;
			/** 规则判出来的表(只有 `wire`,加上 `probe` 那一格)。 */
			spec: CustomAdapterSpec;
			/** 规则判不满,需要分析模型填偏差。 */
			needsAnalysis: boolean;
			/** 判不满的是哪几格(排障用,不上屏)。 */
			deviations: string[];
			samples: ProbeSamples;
			/** 探测用的模型 id。 */
			model: string;
			/** 模型列表按常见形状解出来的条数(解不出 = 0)。 */
			modelCount: number;
	  }
	| { ok: false; reason: ProbeFailureReason; detail: string; samples?: Partial<ProbeSamples> };

// ---------------------------------------------------------------------------
// 脱敏 / 截断
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 密钥原文、`Bearer` 后面的值、`sk-…` 形的密钥、邮箱 —— 统统换成占位。 */
export function redactProbeText(text: string, secrets: readonly (string | undefined)[] = []): string {
	let out = text;
	for (const secret of secrets) {
		const value = secret?.trim();
		if (value && value.length >= 4) out = out.replace(new RegExp(escapeRegExp(value), "g"), "[redacted]");
	}
	return out
		.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
		.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
		.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]");
}

/** 截到 `limit` 字节以内;流式样本截在最后一个完整事件(空行)之后,免得半行 JSON。 */
export function clipProbeSample(text: string, limit = PROBE_SAMPLE_LIMIT, eventBoundary = false): string {
	const bytes = new TextEncoder().encode(text);
	if (bytes.length <= limit) return text;
	const head = new TextDecoder().decode(bytes.slice(0, limit)).replace(/�+$/, "");
	if (!eventBoundary) return head;
	const cut = head.lastIndexOf("\n\n");
	return cut > 0 ? head.slice(0, cut + 2) : head;
}

async function readHead(response: Response, limit: number): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const decoder = new TextDecoder();
	let text = "";
	let size = 0;
	try {
		while (size < limit) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	return text;
}

// ---------------------------------------------------------------------------
// SSE 样本的读法
// ---------------------------------------------------------------------------

interface SampleEvent {
	event?: string;
	data: string;
}

export function sampleEvents(text: string): SampleEvent[] {
	const out: SampleEvent[] = [];
	for (const block of text.replace(/\r/g, "").split(/\n\n+/)) {
		let event: string | undefined;
		const data: string[] = [];
		for (const line of block.split("\n")) {
			if (line.startsWith("event:")) event = line.slice(6).trim();
			else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
		}
		if (data.length > 0) out.push({ ...(event ? { event } : {}), data: data.join("\n") });
	}
	return out;
}

function sampleJson(text: string): unknown[] {
	const out: unknown[] = [];
	for (const event of sampleEvents(text)) {
		try {
			out.push(JSON.parse(event.data));
		} catch {
			// `[DONE]` 与别的非 JSON 行不算
		}
	}
	return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 一份流式样本是哪条线。认不出 = undefined。 */
export function classifyStreamSample(text: string): CustomAdapterWire | undefined {
	const events = sampleEvents(text);
	if (events.some((event) => event.event === "response.created")) return "openai-responses";
	const payloads = sampleJson(text);
	if (payloads.some((p) => isRecord(p) && p.type === "response.created")) return "openai-responses";
	if (
		events.some((event) => event.event === "content_block_delta") ||
		payloads.some((p) => isRecord(p) && p.type === "content_block_delta")
	) {
		return "anthropic-messages";
	}
	if (payloads.some((p) => isRecord(p) && Array.isArray(p.candidates))) return "gemini-generateContent";
	if (
		payloads.some(
			(p) => isRecord(p) && Array.isArray(p.choices) && p.choices.some((c) => isRecord(c) && isRecord(c.delta)),
		)
	) {
		return "openai-chat";
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// 规则
// ---------------------------------------------------------------------------

/** openai-chat 的 `delta` 里,线直接认得的键。别的键带着字符串 = 这家把东西放在了别处。 */
const STANDARD_DELTA_KEYS = new Set(["role", "content", "reasoning_content", "tool_calls", "function_call", "refusal"]);

/**
 * 规则判:样本里的字段名是不是全部命中默认路径。返回判不满的格(空 = 判满)。
 * 只对 openai-chat 看流;四条线都看模型列表能不能按常见形状解出来。
 */
export function adapterDeviations(wire: CustomAdapterWire, samples: ProbeSamples, modelCount: number): string[] {
	const out: string[] = [];
	if (samples.models !== undefined && modelCount === 0) out.push("modelsList");
	if (wire !== "openai-chat") return out;
	const payloads = sampleJson(samples.stream).filter(isRecord);
	let text = false;
	const extraKeys = new Set<string>();
	let usageSeen = false;
	let usageStandard = false;
	let toolCallsSeen = false;
	let legacyFunctionCallSeen = false;
	for (const payload of payloads) {
		const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
		const delta = isRecord(choice) && isRecord(choice.delta) ? choice.delta : undefined;
		if (delta) {
			if (typeof delta.content === "string" && delta.content) text = true;
			if (delta.tool_calls !== undefined && delta.tool_calls !== null) toolCallsSeen = true;
			// 老格式:工具调用挂在 `delta.function_call { name, arguments }`(线默认读不到)。
			if (isRecord(delta.function_call)) legacyFunctionCallSeen = true;
			for (const [key, value] of Object.entries(delta)) {
				if (!STANDARD_DELTA_KEYS.has(key) && typeof value === "string" && value) extraKeys.add(key);
			}
		}
		if (isRecord(payload.usage)) {
			usageSeen = true;
			if (typeof payload.usage.prompt_tokens === "number" || typeof payload.usage.completion_tokens === "number") {
				usageStandard = true;
			}
		}
	}
	if (!text) out.push("response.textDeltaPath");
	for (const key of extraKeys) out.push(`response.delta.${key}`);
	if (usageSeen && !usageStandard) out.push("response.usage");
	if (legacyFunctionCallSeen && !toolCallsSeen) out.push("response.toolCallsStyle");
	return out;
}

// ---------------------------------------------------------------------------
// 探测
// ---------------------------------------------------------------------------

function hasHeader(headers: Record<string, string>, name: string): boolean {
	const lower = name.toLowerCase();
	return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

interface StreamAttempt {
	wire: CustomAdapterWire;
	url: string;
	body: Record<string, unknown>;
	auth: (headers: Record<string, string>, apiKey: string | undefined) => Record<string, string>;
}

function bearer(headers: Record<string, string>, apiKey: string | undefined): Record<string, string> {
	return apiKey && !hasHeader(headers, "Authorization") ? { Authorization: `Bearer ${apiKey}` } : {};
}

function attempts(base: string, model: string): StreamAttempt[] {
	return [
		{
			wire: "openai-chat",
			url: `${base}/chat/completions`,
			body: {
				model,
				messages: [{ role: "user", content: "hi" }],
				max_tokens: 16,
				stream: true,
				stream_options: { include_usage: true },
			},
			auth: bearer,
		},
		{
			wire: "openai-responses",
			url: `${base}/responses`,
			body: { model, input: "hi", max_output_tokens: 16, stream: true },
			auth: bearer,
		},
		{
			wire: "anthropic-messages",
			url: `${base}/messages`,
			body: { model, messages: [{ role: "user", content: "hi" }], max_tokens: 16, stream: true },
			auth: (headers, apiKey) => ({
				...(hasHeader(headers, "anthropic-version") ? {} : { "anthropic-version": "2023-06-01" }),
				...(apiKey && !hasHeader(headers, "x-api-key") && !hasHeader(headers, "Authorization")
					? { "x-api-key": apiKey }
					: {}),
			}),
		},
		{
			wire: "gemini-generateContent",
			url: `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
			body: {
				contents: [{ role: "user", parts: [{ text: "hi" }] }],
				generationConfig: { maxOutputTokens: 16 },
			},
			auth: (headers, apiKey): Record<string, string> =>
				apiKey && !hasHeader(headers, "x-goog-api-key") && !hasHeader(headers, "Authorization")
					? { "x-goog-api-key": apiKey }
					: {},
		},
	];
}

function signalFor(options: ProbeCustomEndpointOptions): AbortSignal {
	const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
	return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function probeCustomEndpoint(options: ProbeCustomEndpointOptions): Promise<ProbeCustomEndpointResult> {
	const base = options.baseUrl.trim().replace(/\/+$/, "");
	if (!base) return { ok: false, reason: "unreachable", detail: "No endpoint URL configured" };
	const apiKey = options.apiKey?.trim() || undefined;
	const secrets = [apiKey, ...Object.values(options.headers ?? {})];
	const redact = (text: string) => redactProbeText(text, secrets);

	// ① 模型列表
	let modelsSample: string | undefined;
	let modelIds: string[] = [];
	let modelsError: string | undefined;
	try {
		const response = await options.fetchImpl(resolveModelsEndpointUrl(base, options.modelsUrl), {
			method: "GET",
			headers: directModelsRequestHeaders(options.headers, apiKey),
			signal: signalFor(options),
		});
		const raw = await readHead(response, PROBE_SAMPLE_LIMIT * 4);
		modelsSample = clipProbeSample(redact(raw));
		if (response.ok) {
			try {
				modelIds = parseProviderDirectModels(JSON.parse(raw), raw).map((model) => model.id);
			} catch (error) {
				modelsError = describeError(error);
			}
		} else {
			modelsError = `HTTP ${response.status}`;
		}
	} catch (error) {
		modelsError = describeError(error);
	}

	const model = options.hintModel?.trim() || modelIds[0];
	if (!model) {
		return {
			ok: false,
			reason: "unreachable",
			detail: `No model to probe with${modelsError ? `: ${modelsError}` : ""}`,
			...(modelsSample !== undefined ? { samples: { models: modelsSample } } : {}),
		};
	}

	// ② 流式一发(按启发式依次试)
	const userHeaders = expandHeaderTemplates(options.headers, apiKey) ?? {};
	const failures: string[] = [];
	for (const attempt of attempts(base, model)) {
		let raw: string;
		let status: number;
		try {
			const response = await options.fetchImpl(attempt.url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "text/event-stream",
					...attempt.auth(userHeaders, apiKey),
					...userHeaders,
				},
				body: JSON.stringify(attempt.body),
				signal: signalFor(options),
			});
			status = response.status;
			raw = await readHead(response, PROBE_SAMPLE_LIMIT);
		} catch (error) {
			failures.push(`${attempt.wire}: ${describeError(error)}`);
			continue;
		}
		const detected = status >= 200 && status < 300 ? classifyStreamSample(raw) : undefined;
		if (!detected) {
			failures.push(`${attempt.wire}: HTTP ${status} ${redact(raw).replace(/\s+/g, " ").slice(0, 160)}`);
			continue;
		}
		const samples: ProbeSamples = {
			stream: clipProbeSample(redact(raw), PROBE_SAMPLE_LIMIT, true),
			...(modelsSample !== undefined ? { models: modelsSample } : {}),
		};
		const deviations = adapterDeviations(detected, samples, modelIds.length);
		return {
			ok: true,
			wire: detected,
			spec: {
				version: 1,
				wire: detected,
				probe: {
					at: options.now?.() ?? Date.now(),
					model,
					confidence: deviations.length === 0 ? "high" : "low",
					notes: deviations.length === 0 ? "standard field names" : `deviations: ${deviations.join(", ")}`,
				},
			},
			needsAnalysis: deviations.length > 0,
			deviations,
			samples,
			model,
			modelCount: modelIds.length,
		};
	}
	const anyAnswered = failures.some((line) => /HTTP 2\d\d/.test(line));
	return {
		ok: false,
		reason: anyAnswered ? "unrecognized" : "unreachable",
		detail: failures.join("; ").slice(0, 600),
		...(modelsSample !== undefined ? { samples: { models: modelsSample } } : {}),
	};
}

// ---------------------------------------------------------------------------
// 分析模型的提示词与答案(AI 只填偏差 —— 调用在装配层)
// ---------------------------------------------------------------------------

export function renderCustomAdapterProbePrompt(wire: CustomAdapterWire, samples: ProbeSamples): string {
	return customAdapterProbePromptRaw
		.replace("{{schema}}", JSON.stringify(CUSTOM_ADAPTER_SPEC_JSON_SCHEMA, null, 2))
		.replaceAll("{{wire}}", wire)
		.replace("{{modelsSample}}", samples.models ?? "(not available)")
		.replace("{{streamSample}}", samples.stream)
		.trim();
}

/**
 * 分析模型的答案 → 适配表。只认一个 JSON 对象(容忍外面包了一层 ``` 围栏);
 * `version` 不是 1、`wire` 不是探测判出来的那条 → undefined(回验路自然失败)。
 */
export function parseAdapterSpecAnswer(text: string, wire: CustomAdapterWire): CustomAdapterSpec | undefined {
	const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(trimmed.slice(start, end + 1));
	} catch {
		return undefined;
	}
	if (!isRecord(value) || value.version !== 1 || value.wire !== wire) return undefined;
	for (const key of ["request", "response", "modelsList", "probe"] as const) {
		if (value[key] !== undefined && !isRecord(value[key])) return undefined;
	}
	return value as unknown as CustomAdapterSpec;
}

// ---------------------------------------------------------------------------
// 回验
// ---------------------------------------------------------------------------

export type VerifyAdapterSpecResult =
	| { ok: true; textDeltas: number; reasoningDeltas: number; usage?: { input: number; output: number }; modelCount: number }
	| { ok: false; reason: "no-models" | "no-text" | "no-usage" | "replay-error"; detail: string };

const VERIFY_PROVIDER_ID = "custom-probe-verify";

function replayProvider(spec: CustomAdapterSpec, stream: string) {
	const dialect = dialectFromSpec(VERIFY_PROVIDER_ID, spec);
	const init = {
		providerId: VERIFY_PROVIDER_ID,
		baseUrl: "http://probe.invalid",
		auth: new BearerApiKeyAuth(undefined),
		fetchImpl: (async () =>
			new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof globalThis.fetch,
	};
	switch (dialect.wire) {
		case "anthropic-messages":
			return createAnthropicProvider(dialect as AnthropicDialect, init);
		case "openai-responses":
			return createResponsesProvider(dialect as ResponsesDialect, init);
		case "gemini-generateContent":
			return createGeminiProvider(dialect as GeminiDialect, init);
		case "openai-chat":
			return createOpenAIChatProvider(dialect as OpenAIChatDialect, init);
	}
}

/** 样本里有没有 usage 段(任一条线的常见位置:顶层 `usage` / `usageMetadata` / message 里的 `usage`)。 */
function sampleHasUsage(stream: string): boolean {
	return sampleJson(stream).some(
		(p) =>
			isRecord(p) &&
			((isRecord(p.usage) && Object.keys(p.usage).length > 0) ||
				isRecord(p.usageMetadata) ||
				(isRecord(p.message) && isRecord(p.message.usage)) ||
				(isRecord(p.response) && isRecord(p.response.usage))),
	);
}

export async function verifyAdapterSpec(
	spec: CustomAdapterSpec,
	samples: ProbeSamples,
): Promise<VerifyAdapterSpecResult> {
	let modelCount = 0;
	if (samples.models !== undefined) {
		try {
			modelCount = parseProviderDirectModels(JSON.parse(samples.models), samples.models, spec.modelsList).length;
		} catch (error) {
			return { ok: false, reason: "no-models", detail: describeError(error) };
		}
		if (modelCount === 0) return { ok: false, reason: "no-models", detail: "model list is empty" };
	}

	const events: AgentTurnStreamEvent[] = [];
	try {
		const provider = replayProvider(spec, samples.stream);
		for await (const event of provider.streamTurn!({
			turn: 0,
			model: spec.probe?.model || "probe",
			messages: [{ role: "user", content: "hi" }],
		})) {
			events.push(event);
		}
	} catch (error) {
		return { ok: false, reason: "replay-error", detail: describeError(error) };
	}
	const textDeltas = events.filter((event) => event.type === "text-delta").length;
	const reasoningDeltas = events.filter((event) => event.type === "reasoning-delta").length;
	if (textDeltas === 0) return { ok: false, reason: "no-text", detail: "replay produced no text delta" };

	const finish = events.find((event) => event.type === "finish");
	const usage = finish?.type === "finish" ? finish.usage : undefined;
	if (sampleHasUsage(samples.stream)) {
		if (!usage || (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) <= 0) {
			return { ok: false, reason: "no-usage", detail: "sample carries usage but none was decoded" };
		}
	}
	return {
		ok: true,
		textDeltas,
		reasoningDeltas,
		...(usage ? { usage: { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0 } } : {}),
		modelCount,
	};
}

/** 摘要里的「思考内容在 X」:适配表点名了就用它,否则样本里真见过默认那一格才说。 */
export function adapterReasoningPath(spec: CustomAdapterSpec, samples: ProbeSamples): string | undefined {
	const named = spec.response?.reasoningDeltaPath?.trim();
	if (named) return named;
	if (spec.wire !== "openai-chat") return undefined;
	const seen = sampleJson(samples.stream).some((p) => {
		const choice = isRecord(p) && Array.isArray(p.choices) ? p.choices[0] : undefined;
		return isRecord(choice) && isRecord(choice.delta) && typeof choice.delta.reasoning_content === "string" && choice.delta.reasoning_content !== "";
	});
	return seen ? CUSTOM_ADAPTER_DEFAULT_PATHS.reasoningDeltaPath : undefined;
}

export { CUSTOM_ADAPTER_BASE_DIALECT };
