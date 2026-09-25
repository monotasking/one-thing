/**
 * 手填模型 = 目录条目(批 2,`docs/design/provider-settings-rework-2026-09.md` §4)。
 *
 * 批 2 之前,手填的 id 只活在 `selectedModels` 里,目录行 = 目录 ∪「勾了但目录不认识」
 * 的孤儿 —— 取消勾选就等于把这个 id 在世上唯一的记录删了。现在手填是目录里的一条
 * `source: 'manual'` 条目(参数全空),勾不勾是另一件事。
 *
 * 这个文件只有纯函数:建条目、认条目、折孤儿、刷新时保留手填、加 / 删的守卫。
 * 落盘在装配层(`backend/rpc/domains/models.ts` 的 `addManual` / `removeManual`,
 * 与 `spaces.setProviderSettings` 的随手落盘)。
 */
import type {
	OnethingCatalogModelEntry,
	OnethingManualModelEntry,
	OnethingModelCapabilityEntry,
} from "./model-registry.js";

/** 一条手填条目。**参数全空**,`name` = id。 */
export function createOnethingManualModelEntry(
	providerId: string,
	modelId: string,
): OnethingManualModelEntry {
	return { id: modelId, name: modelId, provider: providerId, source: "manual" };
}

export function isOnethingManualModelEntry(
	entry: { source?: string } | undefined | null,
): entry is OnethingManualModelEntry {
	return entry?.source === "manual";
}

/**
 * 「目录对这一型说过什么」。手填条目什么都没说过 → undefined,
 * 于是所有能力 / 容量 / 价格的读者对它的读法与批 2 之前「目录里没有」逐字相同。
 */
export function catalogFactsOf(
	entry: OnethingCatalogModelEntry | undefined | null,
): OnethingModelCapabilityEntry | undefined {
	if (!entry || isOnethingManualModelEntry(entry)) return undefined;
	return entry;
}

/**
 * `catalogFactsOf` 的结构版:给那些不 import 目录类型、只按形状读条目的读者
 * (provider 运行期配置那几张结构表)。手填条目 → undefined,别的原样。
 */
export function catalogEntryFacts<TEntry extends { source?: string }>(
	entry: TEntry | undefined,
): TEntry | undefined {
	return entry?.source === "manual" ? undefined : entry;
}

/** 折孤儿要读的那几格。 */
export interface ManualFoldableConfig {
	models?: Record<string, OnethingCatalogModelEntry>;
	selectedModels?: readonly string[];
	model?: string;
}

function configuredIdsOf(config: ManualFoldableConfig): string[] {
	const ids: string[] = [];
	for (const raw of [...(config.selectedModels ?? []), config.model]) {
		if (typeof raw !== "string") continue;
		const id = raw.trim();
		if (id && !ids.includes(id)) ids.push(id);
	}
	return ids;
}

/**
 * 老数据惰性归位:在 `selectedModels` ∪ `model` 里、但目录里没有的 id,折成
 * `source: 'manual'` 条目。**纯函数、不写盘**:没有可折的就原样交回同一个对象
 * (调用方靠引用相等判断「要不要落盘」)。
 */
export function foldOrphansIntoManual<TConfig extends ManualFoldableConfig>(
	config: TConfig,
	providerId: string,
): TConfig & Pick<ManualFoldableConfig, "models"> {
	const models = config.models ?? {};
	let folded: Record<string, OnethingCatalogModelEntry> | undefined;
	for (const id of configuredIdsOf(config)) {
		if (models[id]) continue;
		folded ??= { ...models };
		folded[id] = createOnethingManualModelEntry(providerId, id);
	}
	return folded ? { ...config, models: folded } : config;
}

/**
 * 刷新目录:**只替换非手填条目**,手填条目原样保留(同 id 时手填那条留下 ——
 * 它是用户亲手写的,刷新不替人删)。`previous` 缺席 = 一条手填都没有。
 */
export function mergeRefreshedCatalog(
	previous: Record<string, OnethingCatalogModelEntry> | undefined,
	refreshed: Record<string, OnethingCatalogModelEntry>,
): Record<string, OnethingCatalogModelEntry> {
	const merged: Record<string, OnethingCatalogModelEntry> = { ...refreshed };
	for (const [id, entry] of Object.entries(previous ?? {})) {
		if (isOnethingManualModelEntry(entry)) merged[id] = entry;
	}
	return merged;
}

export type ManualModelEditResult<TConfig> =
	| { ok: true; config: TConfig }
	| { ok: false; reason: "empty" | "duplicate" | "not-manual" | "last-selected" };

/**
 * 手填一个 id。已经勾着 = `duplicate`(用户看得见的事实,不是错误);目录里有、只是
 * 没勾 = 只勾上,不另造一条;目录里没有 = 写一条手填条目并勾上。
 */
export function applyAddManualModel<TConfig extends ManualFoldableConfig>(
	config: TConfig,
	providerId: string,
	modelId: string,
): ManualModelEditResult<TConfig> {
	const id = modelId.trim();
	if (!id) return { ok: false, reason: "empty" };
	const base = foldOrphansIntoManual(config, providerId);
	const selected = base.selectedModels ?? [];
	if (selected.includes(id)) return { ok: false, reason: "duplicate" };
	const models = base.models ?? {};
	return {
		ok: true,
		config: {
			...base,
			models: models[id]
				? models
				: { ...models, [id]: createOnethingManualModelEntry(providerId, id) },
			selectedModels: [...selected, id],
		},
	};
}

/**
 * 删一条手填条目(行尾 ✕)。条目整条删掉并从勾选里去掉;它是当前模型时换到剩下的
 * 第一个勾选的。守卫照批 2 之前的 `removeManualModel`:勾着的最后一个不许删
 * (`last-selected`);目录条目不许经这一口删(`not-manual`)。
 */
export function applyRemoveManualModel<TConfig extends ManualFoldableConfig>(
	config: TConfig,
	providerId: string,
	modelId: string,
): ManualModelEditResult<TConfig> {
	const base = foldOrphansIntoManual(config, providerId);
	const models = base.models ?? {};
	if (!isOnethingManualModelEntry(models[modelId])) {
		return { ok: false, reason: "not-manual" };
	}
	const selected = base.selectedModels ?? [];
	if (selected.includes(modelId) && selected.length <= 1) {
		return { ok: false, reason: "last-selected" };
	}
	const nextSelected = selected.filter((id) => id !== modelId);
	const nextModels = { ...models };
	delete nextModels[modelId];
	return {
		ok: true,
		config: {
			...base,
			models: nextModels,
			selectedModels: nextSelected,
			...(base.model === modelId ? { model: nextSelected[0] ?? "" } : {}),
		},
	};
}
