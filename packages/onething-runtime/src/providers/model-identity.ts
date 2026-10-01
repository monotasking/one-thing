/**
 * 模型认亲(批 3 §6.3,`docs/design/provider-settings-rework-2026-09.md`)。
 *
 * 转发站、聚合站、本地推理框架报出来的模型十有八九是别家的现成模型:`openai/gpt-5.5`、
 * `anthropic/claude-fable-5-1`、`deepseek-chat`、`qwen3-max:free`。它们的上下文、最大输出、
 * 能力位 models.dev 全有,只是挂在别家名下。这里做的是「这一个 id 大概是谁」——
 * **只做确定性匹配,不用 AI、不做编辑距离**(用户 09-26 裁定):认错亲会让 32k 的模型按
 * 200k 跑,错的上下文比不知道更糟,所以认不出就答 `null`。
 *
 * 三级逐级降,任一级**唯一**命中即停:
 *  ① 带厂牌前缀:`厂牌/型号` 按第一个 `/` 切开,厂牌经别名表映射到 models.dev 的 provider
 *     键,型号在那家下**精确**匹配;不中则在 models.dev 的 `openrouter` 目录里精确匹配整串。
 *  ② 裸 ID 精确:全目录找同名;多家同名时取**第一方**(provider 键属于某个厂牌的那家),
 *     第一方不唯一 / 没有第一方 → 不认。
 *  ③ 规范化精确:两边做同一套规范化(小写、去厂牌路径、去 `:free` / `:latest` / `-latest` /
 *     `-preview`、去日期尾、`_` 与 `-` 同视)后精确匹配,仍要求唯一。两边都带日期尾而日期
 *     不同 = 不同版本,不认。
 *
 * 纯函数,Electron-free;索引按 models.dev 缓存建一次,内存 memo 按缓存的 `fetchedAt` 失效。
 */
import { BUILTIN_PROVIDER_MANIFESTS } from "./builtin-manifests.js";
import type { OnethingModelsDevModel, OnethingModelsDevResponse } from "./model-registry.js";

/**
 * 厂牌 → models.dev 的 provider 键。`brands` 是 id 前缀里可能出现的写法(小写),`keys`
 * 是这家在 models.dev 里的键,**按偏好排**(同一厂牌的国内 / 海外两本目录取前一本)。
 * 这张表同时定义了「第一方」:键在某一行 `keys` 里的那家就是第一方。
 */
const LEGACY_MODEL_VENDOR_ALIASES: ReadonlyArray<{
	readonly brands: readonly string[];
	readonly keys: readonly string[];
}> = [
	{ brands: ["openai"], keys: ["openai"] },
	{ brands: ["anthropic"], keys: ["anthropic"] },
	{ brands: ["google", "gemini"], keys: ["google"] },
	{ brands: ["x-ai", "xai", "grok"], keys: ["xai"] },
	{ brands: ["mistralai", "mistral"], keys: ["mistral"] },
];

/**
 * 搬回家的服务商自己带认亲那一行(`manifest.modelIdentity`,`vendors/<id>/manifest.ts`);
 * 还没搬的仍在上面那张表里(服务商自述试点 P1/P2 的过渡期)。行与行互不重叠,行序不是行为。
 */
export const MODEL_VENDOR_ALIASES: ReadonlyArray<{
	readonly brands: readonly string[];
	readonly keys: readonly string[];
}> = [
	...LEGACY_MODEL_VENDOR_ALIASES,
	...BUILTIN_PROVIDER_MANIFESTS.flatMap((manifest) => (manifest.modelIdentity ? [manifest.modelIdentity] : [])),
];

export type ModelTwinLevel = "prefix" | "exact" | "normalized";

export interface ModelTwin {
	/** models.dev 的 provider 键 + 那本目录里的模型 id。 */
	twin: { provider: string; id: string };
	level: ModelTwinLevel;
}

interface TwinCandidate {
	provider: string;
	id: string;
}

export interface ModelIdentityIndex {
	readonly data: OnethingModelsDevResponse;
	/** 原样 id → 有它的 provider 键(按目录里出现的次序)。 */
	readonly byId: ReadonlyMap<string, readonly string[]>;
	/** 规范化 id → 候选。 */
	readonly byNorm: ReadonlyMap<string, readonly TwinCandidate[]>;
}

const DATE_TAIL = /-(\d{8}|\d{4}-\d{2}-\d{2})$/;
const SUFFIXES = [/:free$/, /:latest$/, /-latest$/, /-preview$/];

/** 规范化一个 id,顺手交出剥掉的日期尾(没有 = undefined)。 */
export function normalizeModelId(id: string): { norm: string; date?: string } {
	let value = id.trim().toLowerCase();
	const slash = value.lastIndexOf("/");
	if (slash >= 0) value = value.slice(slash + 1);
	value = value.replace(/_/g, "-");
	let date: string | undefined;
	for (let changed = true; changed; ) {
		changed = false;
		for (const suffix of SUFFIXES) {
			if (suffix.test(value)) {
				value = value.replace(suffix, "");
				changed = true;
			}
		}
		const hit = DATE_TAIL.exec(value);
		if (hit) {
			date ??= hit[1].replace(/-/g, "");
			value = value.slice(0, hit.index);
			changed = true;
		}
	}
	return { norm: value, ...(date ? { date } : {}) };
}

function vendorOfBrand(brand: string) {
	return MODEL_VENDOR_ALIASES.find((vendor) => vendor.brands.includes(brand));
}

function vendorOfKey(key: string) {
	return MODEL_VENDOR_ALIASES.find((vendor) => vendor.keys.includes(key));
}

export function buildModelIdentityIndex(data: OnethingModelsDevResponse): ModelIdentityIndex {
	const byId = new Map<string, string[]>();
	const byNorm = new Map<string, TwinCandidate[]>();
	for (const [provider, entry] of Object.entries(data ?? {})) {
		const models = entry?.models;
		if (!models || typeof models !== "object") continue;
		for (const id of Object.keys(models)) {
			const providers = byId.get(id);
			if (providers) providers.push(provider);
			else byId.set(id, [provider]);
			const { norm } = normalizeModelId(id);
			if (!norm) continue;
			const list = byNorm.get(norm);
			if (list) list.push({ provider, id });
			else byNorm.set(norm, [{ provider, id }]);
		}
	}
	return { data, byId, byNorm };
}

/**
 * 一组候选里挑**唯一**的那一个。只剩一个 → 它;多个 → 先按 id 里的厂牌前缀收窄,
 * 再按「第一方」收窄;收窄后必须落在**同一个厂牌**,且那家里只有一个 id(同一家两个 id
 * 规范化到一处时,只认 id 本身就等于规范化结果的那条)。
 */
function pickUnique(
	candidates: readonly TwinCandidate[],
	brandVendor: ReturnType<typeof vendorOfBrand>,
	norm?: string,
): TwinCandidate | null {
	if (candidates.length === 0) return null;
	const distinct = dedupe(candidates);
	if (distinct.length === 1) return distinct[0];

	let pool: TwinCandidate[] = [];
	if (brandVendor) pool = distinct.filter((c) => brandVendor.keys.includes(c.provider));
	if (pool.length === 0) pool = distinct.filter((c) => vendorOfKey(c.provider) !== undefined);
	if (pool.length === 0) return null;

	const vendors = new Set(pool.map((c) => vendorOfKey(c.provider)));
	if (vendors.size !== 1) return null;
	const vendor = [...vendors][0];
	if (!vendor) return null;

	for (const key of vendor.keys) {
		const inKey = pool.filter((c) => c.provider === key);
		if (inKey.length === 0) continue;
		if (inKey.length === 1) return inKey[0];
		const canonical = norm
			? inKey.filter((c) => c.id.toLowerCase().replace(/_/g, "-") === norm)
			: [];
		return canonical.length === 1 ? canonical[0] : null;
	}
	return null;
}

function dedupe(candidates: readonly TwinCandidate[]): TwinCandidate[] {
	const seen = new Set<string>();
	const out: TwinCandidate[] = [];
	for (const candidate of candidates) {
		const key = `${candidate.provider}\u0000${candidate.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(candidate);
	}
	return out;
}

export function resolveModelTwin(modelId: string, index: ModelIdentityIndex): ModelTwin | null {
	const raw = modelId.trim();
	if (!raw) return null;
	const slash = raw.indexOf("/");
	const brand = slash > 0 ? raw.slice(0, slash).toLowerCase() : undefined;
	const rest = slash > 0 ? raw.slice(slash + 1) : raw;
	const brandVendor = brand ? vendorOfBrand(brand) : undefined;

	// ① 带厂牌前缀:厂牌那家精确匹配型号,不中再查 openrouter 那张「厂牌/型号」总表。
	if (brand && rest) {
		const keys = brandVendor?.keys ?? (index.data[brand] ? [brand] : []);
		for (const key of keys) {
			if (index.data[key]?.models?.[rest]) {
				return { twin: { provider: key, id: rest }, level: "prefix" };
			}
		}
		if (index.data.openrouter?.models?.[raw]) {
			return { twin: { provider: "openrouter", id: raw }, level: "prefix" };
		}
	}

	// ② 裸 ID 精确。
	const exact = (index.byId.get(raw) ?? []).map((provider) => ({ provider, id: raw }));
	const exactHit = pickUnique(exact, brandVendor);
	if (exactHit) return { twin: exactHit, level: "exact" };

	// ③ 规范化精确;两边都有日期尾而日期不同 = 不同版本,剔掉。
	const query = normalizeModelId(raw);
	if (!query.norm) return null;
	const candidates = (index.byNorm.get(query.norm) ?? []).filter((candidate) => {
		if (!query.date) return true;
		const theirs = normalizeModelId(candidate.id).date;
		return !theirs || theirs === query.date;
	});
	const normalizedHit = pickUnique(candidates, brandVendor, query.norm);
	return normalizedHit ? { twin: normalizedHit, level: "normalized" } : null;
}

/* ── 索引 memo:按缓存的 fetchedAt 失效 ──────────────────────────────────── */

let memo: { fetchedAt: number; data: OnethingModelsDevResponse; index: ModelIdentityIndex } | undefined;

/** 一份 models.dev 快照的认亲索引。同一份(`fetchedAt` 与数据引用都没变)只建一次。 */
export function modelIdentityIndexOf(snapshot: {
	data: OnethingModelsDevResponse;
	fetchedAt: number;
}): ModelIdentityIndex {
	if (memo && memo.fetchedAt === snapshot.fetchedAt && memo.data === snapshot.data) {
		return memo.index;
	}
	const index = buildModelIdentityIndex(snapshot.data);
	memo = { fetchedAt: snapshot.fetchedAt, data: snapshot.data, index };
	return index;
}

/* ── 建议:只在「不知道」的那几格上给 ────────────────────────────────────── */

export const MODEL_SUGGESTION_CAPABILITY_KEYS = [
	"tools",
	"vision",
	"reasoning",
	"imageOutput",
	"fileInput",
] as const;

export type ModelSuggestionCapabilityKey = (typeof MODEL_SUGGESTION_CAPABILITY_KEYS)[number];

export interface OnethingModelParameterSuggestion {
	from: { provider: string; id: string; providerName?: string };
	contextLength?: number;
	maxOutput?: number;
	capabilities?: Partial<Record<ModelSuggestionCapabilityKey, boolean>>;
}

/** 这一行哪几格「谁都没说」(= 可以建议)。 */
export interface ModelSuggestionGaps {
	contextLength: boolean;
	maxOutput: boolean;
	capabilities: Record<ModelSuggestionCapabilityKey, boolean>;
}

const FILE_INPUT_MODALITIES = ["pdf", "file"];

/** 认出来的那一型在 models.dev 里说了哪几项能力(只取**支持**的那几项)。 */
export function twinCapabilitiesOf(
	model: OnethingModelsDevModel,
): Partial<Record<ModelSuggestionCapabilityKey, boolean>> {
	const input = (model.modalities?.input ?? []).map((m) => m.toLowerCase());
	const output = (model.modalities?.output ?? []).map((m) => m.toLowerCase());
	const caps: Partial<Record<ModelSuggestionCapabilityKey, boolean>> = {};
	if (model.tool_call === true) caps.tools = true;
	if (input.includes("image")) caps.vision = true;
	if (model.reasoning === true) caps.reasoning = true;
	if (output.includes("image")) caps.imageOutput = true;
	if (input.some((m) => FILE_INPUT_MODALITIES.includes(m))) caps.fileInput = true;
	return caps;
}

/**
 * 一行的建议:认亲 → 只在 `gaps` 说「不知道」的那几格上给那一型的值。**参考价不进建议**
 * (转发站的价不等于官方价)。能力只建议「支持」—— 建议一个 `false` 会在行上画一枚
 * 划掉的图标,说的是「人说不支持」,而那不是人说的。什么都给不出 = undefined。
 */
export function modelParameterSuggestionOf(input: {
	modelId: string;
	index: ModelIdentityIndex;
	gaps: ModelSuggestionGaps;
}): { suggestion: OnethingModelParameterSuggestion; twin: ModelTwin; model: OnethingModelsDevModel } | undefined {
	const { gaps } = input;
	const anyGap =
		gaps.contextLength ||
		gaps.maxOutput ||
		MODEL_SUGGESTION_CAPABILITY_KEYS.some((key) => gaps.capabilities[key]);
	if (!anyGap) return undefined;

	const twin = resolveModelTwin(input.modelId, input.index);
	if (!twin) return undefined;
	const provider = input.index.data[twin.twin.provider];
	const model = provider?.models?.[twin.twin.id];
	if (!model) return undefined;

	const suggestion: OnethingModelParameterSuggestion = {
		from: {
			provider: twin.twin.provider,
			id: twin.twin.id,
			...(provider?.name ? { providerName: provider.name } : {}),
		},
	};
	const context = model.limit?.context;
	if (gaps.contextLength && typeof context === "number" && context > 0) {
		suggestion.contextLength = context;
	}
	const output = model.limit?.output;
	if (gaps.maxOutput && typeof output === "number" && output > 0) {
		suggestion.maxOutput = output;
	}
	const twinCaps = twinCapabilitiesOf(model);
	const caps: Partial<Record<ModelSuggestionCapabilityKey, boolean>> = {};
	for (const key of MODEL_SUGGESTION_CAPABILITY_KEYS) {
		if (gaps.capabilities[key] && twinCaps[key]) caps[key] = true;
	}
	if (Object.keys(caps).length > 0) suggestion.capabilities = caps;

	const hasValue =
		suggestion.contextLength !== undefined ||
		suggestion.maxOutput !== undefined ||
		suggestion.capabilities !== undefined;
	return hasValue ? { suggestion, twin, model } : undefined;
}
