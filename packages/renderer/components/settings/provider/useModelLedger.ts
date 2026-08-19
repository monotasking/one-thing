/**
 * Model Ledger Composable
 *
 * Cross-provider aggregation for the model-centric provider settings page:
 * one row per (enabled provider × selected model). All per-model writes
 * (default star, temperature / max-output presets, capability overrides,
 * rename, remove) are keyed by provider id + model id, unlike
 * useProviderSettings which is scoped to a single viewing provider.
 *
 * Storage stays on the existing per-provider maps: temperatureByModel,
 * maxOutputByModel, modelCapabilitiesByModel — no schema changes.
 */

import { ref, computed } from "vue";
import type {
	AppSettings,
	ProviderConfig,
	ProviderInfo,
	ModelCapabilityOverride,
} from "@/types";
import { useSettingsStore } from "@/stores/settings";
import { useSpaceProviderView } from "@/composables/useSpaceProviderView";
import { providerFamilyDisplayName } from "@shared/provider-families";
import {
	hasVision,
	hasImageGeneration,
	hasTools,
	hasReasoning,
	supportsTemperature,
	formatContextLength,
	createCustomModel,
} from "./model-capabilities";
import { getLogger } from "@/services/log";

const log = getLogger("renderer.model-ledger");

export type StylePreset = "precise" | "balanced" | "creative";
export type OutputPreset = "lean" | "standard" | "max";
export type CapabilityFilter =
	| "all"
	| "vision"
	| "tools"
	| "reasoning"
	| "image";

export const STYLE_PRESET_TEMPERATURES: Record<StylePreset, number> = {
	precise: 0.2,
	balanced: 0.7,
	creative: 1.1,
};

export interface LedgerRow {
	key: string;
	providerId: string;
	providerName: string;
	modelId: string;
	displayName: string;
	/** True when the model id is absent from the provider's fetched catalog (hand-added). */
	isCustom: boolean;
	isDefault: boolean;
	contextLabel: string;
	maxOutputLimit: number;
	supportsTemperature: boolean;
	caps: {
		vision: boolean;
		tools: boolean;
		reasoning: boolean;
		image: boolean;
	};
}

export function useModelLedger(
	props: { settings: AppSettings; providers: ProviderInfo[] },
	emit: (event: "update:settings", settings: AppSettings) => void,
) {
	const settingsStore = useSettingsStore();

	/**
	 * 「当前空间的 provider 视图」(批 B7)。总账列的是**当前空间选了哪些模型**;
	 * 逐模型调参(温度/输出上限/能力覆盖)仍写全局 —— 那描述的是「这个模型是
	 * 什么样」,不是「这个空间想用哪些」。
	 */
	const spaceView = useSpaceProviderView({
		settings: () => props.settings,
		providers: () => props.providers,
	});

	const searchQuery = ref("");
	const capabilityFilter = ref<CapabilityFilter>("all");
	const expandedRowKey = ref<string | null>(null);

	// ──────────────── aggregation ────────────────

	function providerConfig(providerId: string) {
		return props.settings.ai.providers[providerId];
	}

	/** The model actually used when this provider is picked (mirrors providerModelLabel). */
	function effectiveProviderModel(providerId: string): string {
		const cfg = providerConfig(providerId);
		return cfg?.model || cfg?.selectedModels?.[0] || "";
	}

	function capabilityOverrides(
		providerId: string,
		modelId: string,
	): ModelCapabilityOverride {
		return providerConfig(providerId)?.modelCapabilitiesByModel?.[modelId] ?? {};
	}

	const rows = computed<LedgerRow[]>(() => {
		const out: LedgerRow[] = [];
		for (const provider of props.providers) {
			// 批 B9:开关也 per-space。视图内部仍走 `isProviderEnabledIn`(家族派生
			// 只此一份),只是多接了空间覆盖这一层读取源。
			if (!spaceView.isProviderEnabled(provider.id)) continue;
			const selected = spaceView.selectedModelsOf(provider.id);
			if (selected.length === 0) continue;
			const catalog = settingsStore.getCachedModels(provider.id);
			// ★ 打在**当前空间的**默认那一行(批 B9):非 default 空间表达过就是
			// overlay 那一对,没表达过落回全局。
			const defaultModel =
				spaceView.defaultSelection.value.provider === provider.id
					? spaceView.defaultSelection.value.model ||
						effectiveProviderModel(provider.id)
					: "";
			for (const modelId of selected) {
				const fetched = catalog.find((m) => m.id === modelId);
				const meta = fetched ?? createCustomModel(modelId);
				const override = capabilityOverrides(provider.id, modelId);
				out.push({
					key: `${provider.id}::${modelId}`,
					providerId: provider.id,
					providerName: providerFamilyDisplayName(provider.id, provider.name),
					modelId,
					displayName:
						meta.name && meta.name !== modelId
							? meta.name
							: settingsStore.getModelDisplayName(modelId) || modelId,
					isCustom: !fetched,
					isDefault: modelId === defaultModel,
					contextLabel: formatContextLength(meta.context_length ?? 0),
					maxOutputLimit: meta.top_provider?.max_completion_tokens ?? 0,
					supportsTemperature: supportsTemperature(meta, provider.id),
					caps: {
						vision: override.vision ?? hasVision(meta, provider.id),
						tools: override.tools ?? hasTools(meta, provider.id),
						reasoning: override.reasoning ?? hasReasoning(meta, provider.id),
						image: override.imageOutput ?? hasImageGeneration(meta, provider.id),
					},
				});
			}
		}
		return out;
	});

	const filteredRows = computed<LedgerRow[]>(() => {
		let list = rows.value;
		if (capabilityFilter.value !== "all") {
			const key = capabilityFilter.value;
			list = list.filter((row) =>
				key === "vision"
					? row.caps.vision
					: key === "tools"
						? row.caps.tools
						: key === "reasoning"
							? row.caps.reasoning
							: row.caps.image,
			);
		}
		const query = searchQuery.value.trim().toLowerCase();
		if (!query) return list;
		return list.filter(
			(row) =>
				row.modelId.toLowerCase().includes(query) ||
				row.displayName.toLowerCase().includes(query) ||
				row.providerName.toLowerCase().includes(query),
		);
	});

	function toggleRowExpanded(row: LedgerRow) {
		expandedRowKey.value = expandedRowKey.value === row.key ? null : row.key;
	}

	// ──────────────── settings writes ────────────────

	function updateSettings(updates: Partial<AppSettings>) {
		emit("update:settings", { ...props.settings, ...updates });
	}

	function patchProvider(
		providerId: string,
		patch: (current: ProviderConfig) => ProviderConfig,
	) {
		const providers = { ...props.settings.ai.providers };
		providers[providerId] = patch({ ...providers[providerId] });
		updateSettings({ ai: { ...props.settings.ai, providers } });
	}

	/**
	 * ★:把这一行设成默认。
	 *
	 * 落点是**当前空间的 overlay**(C1)。批 B9 时 default 空间走的是另一条
	 * (一次 settings 写),而那正是「默认模型不独立」的病根。
	 */
	function setDefault(row: LedgerRow) {
		void spaceView.setDefaultSelection(row.providerId, row.modelId);
	}

	// ──────────────── temperature (style presets) ────────────────

	function effectiveTemperature(row: LedgerRow): number {
		if (!row.supportsTemperature) return 0;
		const cfg = providerConfig(row.providerId);
		const perModel = cfg?.temperatureByModel?.[row.modelId];
		if (typeof perModel === "number") return perModel;
		if (typeof cfg?.temperature === "number") return cfg.temperature;
		return props.settings.ai.temperature;
	}

	/** 'default' = no per-model override; 'custom' = override off the preset grid. */
	function styleState(row: LedgerRow): StylePreset | "default" | "custom" {
		const override =
			providerConfig(row.providerId)?.temperatureByModel?.[row.modelId];
		if (typeof override !== "number") return "default";
		for (const [preset, value] of Object.entries(STYLE_PRESET_TEMPERATURES)) {
			if (Math.abs(override - value) < 0.001) return preset as StylePreset;
		}
		return "custom";
	}

	/** Pass null to clear the override (back to provider/global default). */
	function setStylePreset(row: LedgerRow, preset: StylePreset | null) {
		patchProvider(row.providerId, (current) => {
			const map = { ...(current.temperatureByModel ?? {}) };
			if (preset === null) {
				delete map[row.modelId];
			} else {
				map[row.modelId] = STYLE_PRESET_TEMPERATURES[preset];
			}
			if (Object.keys(map).length === 0) {
				delete current.temperatureByModel;
			} else {
				current.temperatureByModel = map;
			}
			return current;
		});
	}

	// ──────────────── max output (output presets) ────────────────

	function outputPresetValue(row: LedgerRow, preset: OutputPreset): number {
		const limit = row.maxOutputLimit;
		if (limit <= 0) return 0;
		if (preset === "lean") return Math.max(1, Math.floor(limit / 4));
		if (preset === "max") return limit;
		return Math.max(1, Math.floor(limit / 2));
	}

	function effectiveMaxOutput(row: LedgerRow): number {
		const override =
			providerConfig(row.providerId)?.maxOutputByModel?.[row.modelId];
		if (typeof override === "number" && override > 0) return override;
		return outputPresetValue(row, "standard");
	}

	/** 'standard' = no override (backend default is half the limit). */
	function outputState(row: LedgerRow): OutputPreset | "custom" {
		const override =
			providerConfig(row.providerId)?.maxOutputByModel?.[row.modelId];
		if (typeof override !== "number") return "standard";
		if (override === outputPresetValue(row, "lean")) return "lean";
		if (override === outputPresetValue(row, "max")) return "max";
		if (override === outputPresetValue(row, "standard")) return "standard";
		return "custom";
	}

	function setOutputPreset(row: LedgerRow, preset: OutputPreset) {
		patchProvider(row.providerId, (current) => {
			const map = { ...(current.maxOutputByModel ?? {}) };
			if (preset === "standard") {
				delete map[row.modelId];
			} else {
				map[row.modelId] = outputPresetValue(row, preset);
			}
			if (Object.keys(map).length === 0) {
				delete current.maxOutputByModel;
			} else {
				current.maxOutputByModel = map;
			}
			return current;
		});
	}

	// ──────────────── capability overrides (tristate) ────────────────

	function capabilityOverrideState(
		row: LedgerRow,
		key: keyof ModelCapabilityOverride,
	): boolean | undefined {
		return capabilityOverrides(row.providerId, row.modelId)[key];
	}

	function hasCapabilityOverride(row: LedgerRow): boolean {
		return (
			Object.keys(capabilityOverrides(row.providerId, row.modelId)).length > 0
		);
	}

	/** Pass null to clear that key (fall back to detection). */
	function setCapabilityOverride(
		row: LedgerRow,
		key: keyof ModelCapabilityOverride,
		value: boolean | null,
	) {
		patchProvider(row.providerId, (current) => {
			const map: Record<string, ModelCapabilityOverride> = {
				...(current.modelCapabilitiesByModel ?? {}),
			};
			const entry: Record<string, boolean> = { ...(map[row.modelId] ?? {}) };
			if (value === null) {
				delete entry[key];
			} else {
				entry[key] = value;
			}
			if (Object.keys(entry).length === 0) {
				delete map[row.modelId];
			} else {
				map[row.modelId] = entry as ModelCapabilityOverride;
			}
			if (Object.keys(map).length === 0) {
				delete current.modelCapabilitiesByModel;
			} else {
				current.modelCapabilitiesByModel = map;
			}
			return current;
		});
	}

	function resetCapabilityOverrides(row: LedgerRow) {
		patchProvider(row.providerId, (current) => {
			if (!current.modelCapabilitiesByModel?.[row.modelId]) return current;
			const map = { ...current.modelCapabilitiesByModel };
			delete map[row.modelId];
			if (Object.keys(map).length === 0) {
				delete current.modelCapabilitiesByModel;
			} else {
				current.modelCapabilitiesByModel = map;
			}
			return current;
		});
	}

	// ──────────────── remove / rename ────────────────

	/**
	 * Remove a model from its provider's selection. Refuses to remove the
	 * provider's last model (same guard as the catalog checklist).
	 */
	function removeModel(row: LedgerRow): { ok: boolean; reason?: string } {
		const selected = spaceView.selectedModelsOf(row.providerId);
		if (!selected.includes(row.modelId)) return { ok: true };
		if (selected.length === 1) {
			return { ok: false, reason: "last" };
		}
		// 摘一个模型 = 改这个空间的 overlay(C1:default 也一样)。
		void spaceView.setSelectedModels(
			row.providerId,
			selected.filter((id) => id !== row.modelId),
		);
		if (expandedRowKey.value === row.key) expandedRowKey.value = null;
		return { ok: true };
	}

	/**
	 * Rename a hand-added model id, migrating every per-model override map
	 * (same semantics as useProviderSettings.renameModel, keyed by provider).
	 */
	function renameModel(
		row: LedgerRow,
		newId: string,
	): { ok: boolean; reason?: string } {
		const trimmed = newId.trim();
		if (!trimmed) return { ok: false, reason: "empty" };
		if (trimmed === row.modelId) return { ok: true };

		const selected = spaceView.selectedModelsOf(row.providerId);
		if (selected.includes(trimmed)) {
			return { ok: false, reason: "duplicate" };
		}

		// 改名要动两层:id 清单按空间走(C1:default 也一样),逐模型调参的 key
		// 迁移永远在全局层 —— 那些 map 是「这个模型是什么样」,全空间共享。
		void spaceView.setSelectedModels(
			row.providerId,
			selected.map((id) => (id === row.modelId ? trimmed : id)),
		);

		patchProvider(row.providerId, (current) => {

			const moveKey = <T>(
				map: Record<string, T> | undefined,
			): Record<string, T> | undefined => {
				if (!map || !(row.modelId in map)) return map;
				const next: Record<string, T> = { ...map };
				next[trimmed] = next[row.modelId];
				delete next[row.modelId];
				return next;
			};
			current.maxOutputByModel = moveKey(current.maxOutputByModel);
			current.temperatureByModel = moveKey(current.temperatureByModel);
			current.thinkingByModel = moveKey(current.thinkingByModel);
			current.thinkingEffortByModel = moveKey(current.thinkingEffortByModel);
			current.serviceTierByModel = moveKey(current.serviceTierByModel);
			current.modelCapabilitiesByModel = moveKey(
				current.modelCapabilitiesByModel,
			);
			return current;
		});
		settingsStore.addCustomModelToCache(
			row.providerId,
			createCustomModel(trimmed),
		);
		if (expandedRowKey.value === row.key) {
			expandedRowKey.value = `${row.providerId}::${trimmed}`;
		}
		return { ok: true };
	}

	// ──────────────── warm-up ────────────────

	/** Cache-first metadata load for every provider that has ledger rows. */
	async function warmModelCaches() {
		const ids = props.providers
			.filter((provider) => {
				return (
					spaceView.isProviderEnabled(provider.id) &&
					spaceView.selectedModelsOf(provider.id).length > 0
				);
			})
			.map((provider) => provider.id);
		if (ids.length === 0) return;
		try {
			await settingsStore.preloadModels(ids);
		} catch (err) {
			log.error("model cache preload failed", { providerIds: ids }, err);
		}
	}

	return {
		// state
		searchQuery,
		capabilityFilter,
		expandedRowKey,
		// computed
		rows,
		filteredRows,
		// methods
		toggleRowExpanded,
		setDefault,
		effectiveTemperature,
		styleState,
		setStylePreset,
		effectiveMaxOutput,
		outputPresetValue,
		outputState,
		setOutputPreset,
		capabilityOverrideState,
		hasCapabilityOverride,
		setCapabilityOverride,
		resetCapabilityOverrides,
		removeModel,
		renameModel,
		warmModelCaches,
	};
}

export type ModelLedgerReturn = ReturnType<typeof useModelLedger>;
