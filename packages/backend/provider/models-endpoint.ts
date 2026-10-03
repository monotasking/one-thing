/**
 * 直连拉目录(批 3 §6.2,`docs/design/provider-settings-rework-2026-09.md`)。
 *
 * 自定义服务商(以及任何 manifest `models.kind === 'endpoint'`、又没登记专属拉取器、
 * 用 API 密钥认证的家)的模型表,问它自己的 `/models`。一个实现,吃四种常见形状:
 *
 *  - `{ data: [{ id }] }`                      —— OpenAI 及绝大多数兼容站;
 *  - `{ data: [{ id, display_name }] }`        —— Anthropic;
 *  - `{ models: [{ name }] }`                  —— Ollama `/api/tags`、Gemini;
 *  - `["id-a", "id-b"]`                         —— 纯字符串数组。
 *
 * **能拿的参数拿全,拿不到的说「没报」**。OpenRouter 形的 `context_length` /
 * `top_provider.max_completion_tokens` / `architecture.*_modalities` / `pricing`、
 * vLLM 的 `max_model_len` 都读;接口压根没说的那几项记进 `unreported`,读者按「不知道」
 * 处理 —— 一个只报了 id 的列表不是在说「这些模型都不支持工具」(那样会把自定义服务商
 * 的工具调用整条关掉)。Ollama `/api/show` 那一发(`num_ctx`)不做,留账。
 *
 * 都不中 → 抛一个带接口原话的错误,壳原样放进 Tooltip。
 *
 * 纯函数 + 注入 fetch:不碰 node / electron,单测直接喂假响应。
 */
import { expandHeaderTemplates } from "./base/auth-strategy.js";
import { getPath } from "./base/path.js";
import type { CustomAdapterSpec } from "@shared/contracts/adapter-spec";
import type {
	OnethingOpenRouterModel,
	OnethingUnreportedFact,
} from "./model-registry.js";

export type ProviderDirectModelsFetch = (
	input: string,
	init?: RequestInit,
) => Promise<Response>;

export interface FetchProviderDirectModelsOptions {
	/** 接口地址(与聊天同一格,如 `http://localhost:8000/v1`)。 */
	baseUrl: string;
	/** 模型列表地址:绝对地址原样用;相对路径接在 `baseUrl` 后面。空 = `baseUrl + '/models'`。 */
	modelsUrl?: string;
	/** 用户的自定义头(明文模板,值里 `{{apiKey}}` 换成密钥)。 */
	headers?: Record<string, string>;
	apiKey?: string;
	/** 批 4 适配表的模型列表映射。给了就**先**按它读,读不出再退回四种常见形状。 */
	modelsList?: ModelsListMapping;
	fetchImpl: ProviderDirectModelsFetch;
	signal?: AbortSignal;
}

/** 「按 spec 映射」那一档(批 4 §7.1 `modelsList`):路径是点号 + 下标。 */
export type ModelsListMapping = NonNullable<CustomAdapterSpec["modelsList"]>;

/** 原话截多长进错误信息 —— 够认出是哪种错,又不至于把一整页 HTML 塞进 Tooltip。 */
const RAW_SNIPPET_LIMIT = 200;

function snippet(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > RAW_SNIPPET_LIMIT ? `${flat.slice(0, RAW_SNIPPET_LIMIT)}…` : flat;
}

/** 模型列表地址。相对路径**接在接口地址后面**(与「留空按接口地址 + /models」同一把尺)。 */
export function resolveModelsEndpointUrl(baseUrl: string, modelsUrl?: string): string {
	const base = baseUrl.trim().replace(/\/+$/, "");
	const override = modelsUrl?.trim();
	if (!override) return `${base}/models`;
	if (/^https?:\/\//i.test(override)) return override;
	return `${base}/${override.replace(/^\/+/, "")}`;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
	const lower = name.toLowerCase();
	return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

/**
 * 请求头:自定义头(`{{apiKey}}` 已替换)+ 默认 `Authorization: Bearer <key>`。
 * 用户自己写了 `Authorization` 就让位 —— 与聊天请求的 `BearerApiKeyAuth` 同一条规矩。
 */
export function directModelsRequestHeaders(
	headers: Record<string, string> | undefined,
	apiKey: string | undefined,
): Record<string, string> {
	const expanded = expandHeaderTemplates(headers, apiKey) ?? {};
	const key = apiKey?.trim();
	return {
		Accept: "application/json",
		...(key && !hasHeader(expanded, "Authorization")
			? { Authorization: `Bearer ${key}` }
			: {}),
		...expanded,
	};
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInt(value: unknown): number | undefined {
	const n = typeof value === "string" ? Number(value) : value;
	return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function stringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((item): item is string => typeof item === "string");
}

/** 列表在哪一格。认不出 = undefined(调用方抛带原话的错)。 */
function listOf(body: unknown): unknown[] | undefined {
	if (Array.isArray(body)) return body;
	if (!isRecord(body)) return undefined;
	if (Array.isArray(body.data)) return body.data;
	if (Array.isArray(body.models)) return body.models;
	return undefined;
}

/**
 * OpenRouter 的 `pricing.prompt` 是**每 token 美元**的字符串;这张目录里的价是
 * **每百万 token**(与 models.dev 的 `cost` 同一口径,见 `onethingCapabilityEntryToOpenRouterModel`)。
 * 换算在这里做一次,并抹掉浮点尾巴。
 */
function perMillion(value: unknown): string {
	const n = typeof value === "string" ? Number(value) : value;
	if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return "0";
	return String(Math.round(n * 1_000_000 * 1e6) / 1e6);
}

/** 一条列表项 → 目录信封。认不出 id 的一条跳过(不让一条脏数据拖垮整张表)。 */
export function directModelOf(item: unknown): OnethingOpenRouterModel | undefined {
	if (typeof item === "string") {
		const id = item.trim();
		return id ? envelope({ id }) : undefined;
	}
	if (!isRecord(item)) return undefined;
	const id = text(item.id) ?? text(item.name) ?? text(item.model);
	if (!id) return undefined;
	return envelope({ id, raw: item });
}

function envelope({ id, raw }: { id: string; raw?: JsonRecord }): OnethingOpenRouterModel {
	const record = raw ?? {};
	const topProvider = isRecord(record.top_provider) ? record.top_provider : {};
	const architecture = isRecord(record.architecture) ? record.architecture : undefined;
	const pricing = isRecord(record.pricing) ? record.pricing : undefined;

	const contextLength =
		positiveInt(record.context_length) ??
		positiveInt(topProvider.context_length) ??
		positiveInt(record.max_model_len) ??
		positiveInt(record.context_window) ??
		0;
	const maxOutput =
		positiveInt(topProvider.max_completion_tokens) ??
		positiveInt(record.max_output_tokens) ??
		0;

	const inputModalities = stringList(architecture?.input_modalities);
	const outputModalities = stringList(architecture?.output_modalities);
	const supportedParameters = stringList(record.supported_parameters);

	// 接口没说的那几项:读者按「不知道」处理,不按「不支持」。
	const unreported: OnethingUnreportedFact[] = [];
	if (!supportedParameters) unreported.push("tools", "reasoning", "temperature");
	if (!inputModalities) unreported.push("vision", "fileInput");
	if (!outputModalities) unreported.push("imageOutput");

	const name =
		text(record.display_name) ??
		(raw && text(record.name) && text(record.name) !== id ? text(record.name) : undefined) ??
		id;

	return {
		id,
		name,
		...(text(record.description) ? { description: text(record.description) } : {}),
		context_length: contextLength,
		architecture: {
			modality: inputModalities?.includes("image") ? "multimodal" : "text",
			input_modalities: inputModalities ?? ["text"],
			output_modalities: outputModalities ?? ["text"],
			tokenizer: "unknown",
		},
		pricing: {
			prompt: perMillion(pricing?.prompt),
			completion: perMillion(pricing?.completion),
			request: "0",
			image: "0",
		},
		top_provider: {
			context_length: contextLength,
			max_completion_tokens: maxOutput,
			is_moderated: false,
		},
		supported_parameters: supportedParameters ?? [],
		source: "endpoint",
		...(unreported.length > 0 ? { unreported } : {}),
	};
}

/**
 * 按映射读一条:`idField` / `nameField` / `contextField` 是相对列表项的路径。读出来的
 * 几格折成常见形状的字段名(`id` / `display_name` / `context_length`)再交给同一个
 * `directModelOf` —— 能力位的「没报」判法只有一份。
 */
function mappedModelOf(item: unknown, mapping: ModelsListMapping): OnethingOpenRouterModel | undefined {
	const id = text(getPath(item, mapping.idField));
	if (!id) return undefined;
	const name = mapping.nameField ? text(getPath(item, mapping.nameField)) : undefined;
	const context = mapping.contextField ? positiveInt(getPath(item, mapping.contextField)) : undefined;
	return directModelOf({
		...(isRecord(item) ? item : {}),
		id,
		...(name ? { display_name: name } : {}),
		...(context ? { context_length: context } : {}),
	});
}

/** 映射那一档:列表在 `itemsPath`。读不出列表 = undefined(调用方退回常见形状)。 */
function mappedListOf(body: unknown, mapping: ModelsListMapping | undefined): unknown[] | undefined {
	if (!mapping?.itemsPath?.trim() || !mapping.idField?.trim()) return undefined;
	const list = getPath(body, mapping.itemsPath);
	return Array.isArray(list) ? list : undefined;
}

/** 响应体 → 目录信封。形状认不出就抛(带原话)。重复 id 只留第一条。 */
export function parseProviderDirectModels(
	body: unknown,
	rawText: string,
	mapping?: ModelsListMapping,
): OnethingOpenRouterModel[] {
	const mapped = mappedListOf(body, mapping);
	const list = mapped ?? listOf(body);
	if (!list) {
		throw new Error(`Unrecognized model list response: ${snippet(rawText)}`);
	}
	const seen = new Set<string>();
	const out: OnethingOpenRouterModel[] = [];
	for (const item of list) {
		const model = mapped && mapping ? mappedModelOf(item, mapping) : directModelOf(item);
		if (!model || seen.has(model.id)) continue;
		seen.add(model.id);
		out.push(model);
	}
	return out;
}

export async function fetchProviderDirectModels(
	options: FetchProviderDirectModelsOptions,
): Promise<OnethingOpenRouterModel[]> {
	if (!options.baseUrl?.trim() && !/^https?:\/\//i.test(options.modelsUrl?.trim() ?? "")) {
		throw new Error("No endpoint URL configured");
	}
	const url = resolveModelsEndpointUrl(options.baseUrl ?? "", options.modelsUrl);
	const response = await options.fetchImpl(url, {
		method: "GET",
		headers: directModelsRequestHeaders(options.headers, options.apiKey),
		...(options.signal ? { signal: options.signal } : {}),
	});
	const rawText = await response.text().catch(() => "");
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}${rawText ? `: ${snippet(rawText)}` : ""}`);
	}
	let body: unknown;
	try {
		body = JSON.parse(rawText);
	} catch {
		throw new Error(`Model list is not JSON: ${snippet(rawText) || "(empty body)"}`);
	}
	return parseProviderDirectModels(body, rawText, options.modelsList);
}
