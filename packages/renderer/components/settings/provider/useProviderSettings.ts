import { acpApi } from "@/platform/acp-client";
import { providersApi } from "@/platform/providers-client";
/**
 * Provider Settings Composable
 *
 * Manages AI Provider configuration, OAuth flow, model selection, etc.
 */

import { ref, computed, watch } from "vue";
import type {
	ACPAgentConfig,
	ACPAgentState,
	AppSettings,
	OpenRouterModel,
	ProviderEnvStatus,
	ProviderInfo,
} from "@/types";
import { useSettingsStore } from "@/stores/settings";
import { providerFamilyOf } from "@shared/provider-families";
import { useSpaceProviderView } from "@/composables/useSpaceProviderView";
import { useProviderAuth } from "./useProviderAuth";
import {
	getOnethingQwenBaseUrl,
	normalizeOnethingQwenApiMode,
	normalizeOnethingQwenRegion,
	type OnethingQwenApiMode,
	type OnethingQwenRegion,
} from "@onething/runtime/providers/qwen";
import {
	getOnethingKimiBaseUrl,
	normalizeOnethingKimiApiMode,
	normalizeOnethingKimiRegion,
	onethingKimiRegionApplies,
	type OnethingKimiApiMode,
	type OnethingKimiRegion,
} from "@onething/runtime/providers/kimi";
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

const log = getLogger("renderer.provider-settings");

export type {
	OAuthStatus,
	DeviceFlowInfo,
	CodeEntryInfo,
} from "./useProviderAuth";

const ZHIPU_STANDARD_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const ZHIPU_CODING_PLAN_BASE_URL =
	"https://open.bigmodel.cn/api/coding/paas/v4";

export function useProviderSettings(
	props: { settings: AppSettings; providers: ProviderInfo[] },
	emit: (event: "update:settings", settings: AppSettings) => void,
) {
	const settingsStore = useSettingsStore();

	/**
	 * 「当前空间的 provider 视图」(批 B7)。凭证与 selectedModels 的**唯一**读写口:
	 * default 空间落回 `props.settings`(草稿态,零迁移),非 default 走凭证池 +
	 * space.json overlay。这里传的是**草稿 settings** 而不是 settings store ——
	 * 用户刚敲进去还没保存的 key 必须立刻让状态点亮(见视图头注)。
	 */
	const spaceView = useSpaceProviderView({
		settings: () => props.settings,
		providers: () => props.providers,
		usesEnvApiKey: (providerId) => providerUsesEnvApiKey(providerId),
	});

	// Local state
	const modelSearchQuery = ref("");
	const newModelInput = ref("");
	const modelError = ref("");
	const providerEnvStatuses = ref<Record<string, ProviderEnvStatus>>({});
	const acpAgentStates = ref<Record<string, ACPAgentState>>({});

	// Viewing provider (can be different from active provider)
	const viewingProvider = ref<string>(props.settings.ai.provider);

	// Watch for settings changes to sync viewingProvider
	watch(
		() => props.settings.ai.provider,
		(newProvider) => {
			viewingProvider.value = newProvider;
		},
	);

	// Get models from unified store, then merge in any selected models that aren't
	// present in the fetched list. This keeps user-added custom models visible (and
	// deselectable) after a Refresh wipes them from the models.dev-backed cache.
	const availableModels = computed(() => {
		const fetched = settingsStore.getCachedModels(viewingProvider.value);
		// 目录缓存全空间共享(§3),但「选了哪些」按当前空间取 —— 否则在空间 B 里
		// 刷新一次目录,B 自己勾的自定义模型会从列表上消失。
		const selectedIds = spaceView.selectedModelsOf(viewingProvider.value);
		if (selectedIds.length === 0) return fetched;
		const fetchedIds = new Set(fetched.map((m) => m.id));
		const missing = selectedIds
			.filter((id) => !fetchedIds.has(id))
			.map((id) => createCustomModel(id));
		return missing.length === 0 ? fetched : [...fetched, ...missing];
	});
	const isLoadingModels = computed(() =>
		settingsStore.isModelsLoading(viewingProvider.value),
	);

	// Computed properties
	const currentProviderName = computed(() => {
		return (
			props.providers.find((p) => p.id === viewingProvider.value)?.name ||
			viewingProvider.value
		);
	});

	const currentSelectedModels = computed(() =>
		spaceView.selectedModelsOf(viewingProvider.value),
	);

	// ──────────────── Temperature: per-model with provider/global fallbacks ────────────────
	//
	// Resolution chain (mirrors backend stream parameter resolution):
	//   1. providers[viewing].temperatureByModel[activeModel]
	//   2. providers[viewing].temperature   (legacy per-provider)
	//   3. settings.ai.temperature           (global default)
	//
	// Models whose models.dev metadata says `temperature: false` are reported
	// as unsupported — UI displays 0 and the backend skips sending the param.

	// Whether the currently-active model accepts the `temperature` parameter.
	// Defaults to true when the model isn't in the registry (custom / user-added).
	const activeModelSupportsTemperature = computed(() => {
		const id = props.settings.ai.providers[viewingProvider.value]?.model;
		if (!id) return true;
		const found = availableModels.value.find((m) => m.id === id);
		if (!found) return true;
		return supportsTemperature(found, viewingProvider.value);
	});

	// The effective temperature for the active model.
	// When the model doesn't accept temperature, surface 0 so the slider's
	// displayed value matches what gets sent (i.e. nothing).
	const currentTemperature = computed(() => {
		if (!activeModelSupportsTemperature.value) return 0;
		const cfg = props.settings.ai.providers[viewingProvider.value];
		const id = cfg?.model ?? "";
		const perModel = cfg?.temperatureByModel?.[id];
		if (typeof perModel === "number") return perModel;
		if (typeof cfg?.temperature === "number") return cfg.temperature;
		return props.settings.ai.temperature;
	});

	// True only when the *active model* has its own override. Provider-level and
	// global defaults are not counted as overrides for UI purposes.
	const hasProviderTemperatureOverride = computed(() => {
		const cfg = props.settings.ai.providers[viewingProvider.value];
		const id = cfg?.model ?? "";
		return typeof cfg?.temperatureByModel?.[id] === "number";
	});

	const filteredModels = computed(() => {
		if (!modelSearchQuery.value.trim()) {
			return availableModels.value;
		}
		const query = modelSearchQuery.value.toLowerCase();
		return availableModels.value.filter(
			(model) =>
				model.id.toLowerCase().includes(query) ||
				(model.name && model.name.toLowerCase().includes(query)) ||
				(model.description && model.description.toLowerCase().includes(query)),
		);
	});

	const isOAuthProvider = computed(() => {
		const provider = props.providers.find(
			(p) => p.id === viewingProvider.value,
		);
		return provider?.requiresOAuth === true;
	});

	const isACPProvider = computed(() => viewingProvider.value === "acp");
	const isZhipuProvider = computed(() => viewingProvider.value === "zhipu");

	const currentZhipuApiMode = computed(() => {
		const config = props.settings.ai.providers.zhipu;
		if (
			config?.zhipuApiMode === "coding-plan" ||
			config?.zhipuApiMode === "standard"
		) {
			return config.zhipuApiMode;
		}
		return config?.baseUrl?.includes("/api/coding/paas/v4")
			? "coding-plan"
			: "standard";
	});

	const isQwenProvider = computed(() => viewingProvider.value === "qwen");

	const currentQwenApiMode = computed(() =>
		normalizeOnethingQwenApiMode(
			props.settings.ai.providers.qwen?.qwenApiMode,
		),
	);

	const currentQwenRegion = computed(() =>
		normalizeOnethingQwenRegion(props.settings.ai.providers.qwen?.qwenRegion),
	);

	/**
	 * 千问 has four endpoints (国内/海外 x 按量付费/Token Plan). Writing the base
	 * URL alongside the mode keeps the field showing the address actually in
	 * use — the runtime re-derives it either way.
	 */
	function updateQwenEndpoint(patch: {
		mode?: OnethingQwenApiMode;
		region?: OnethingQwenRegion;
	}) {
		const qwenApiMode = patch.mode ?? currentQwenApiMode.value;
		const qwenRegion = patch.region ?? currentQwenRegion.value;
		const providers = { ...props.settings.ai.providers };
		providers.qwen = {
			...providers.qwen,
			qwenApiMode,
			qwenRegion,
			baseUrl: getOnethingQwenBaseUrl(qwenApiMode, qwenRegion),
		};
		updateSettings({ ai: { ...props.settings.ai, providers } });
	}

	function updateQwenApiMode(mode: string) {
		updateQwenEndpoint({ mode: normalizeOnethingQwenApiMode(mode) });
	}

	function updateQwenRegion(region: string) {
		updateQwenEndpoint({ region: normalizeOnethingQwenRegion(region) });
	}

	const isKimiProvider = computed(() => viewingProvider.value === "kimi");

	const currentKimiApiMode = computed(() =>
		normalizeOnethingKimiApiMode(
			props.settings.ai.providers.kimi?.kimiApiMode,
		),
	);

	const currentKimiRegion = computed(() =>
		normalizeOnethingKimiRegion(props.settings.ai.providers.kimi?.kimiRegion),
	);

	/**
	 * 编程套餐(Kimi Code)只有一个地址,不分国内海外 —— 选到它时那一格没有意义,
	 * 所以设置页据此把「版本」整行收起,而不是留一个拨了不动的选择器。
	 */
	const kimiRegionApplies = computed(() =>
		onethingKimiRegionApplies(currentKimiApiMode.value),
	);

	/**
	 * Kimi 有三个地址(开放平台国内/海外 + Kimi Code)。与千问同一条写法:模式和
	 * 地区一起落盘,base URL 一并写上,让那一栏显示的就是真正在用的地址 ——
	 * 运行时无论如何都会自己再推一次。
	 */
	function updateKimiEndpoint(patch: {
		mode?: OnethingKimiApiMode;
		region?: OnethingKimiRegion;
	}) {
		const kimiApiMode = patch.mode ?? currentKimiApiMode.value;
		const kimiRegion = patch.region ?? currentKimiRegion.value;
		const providers = { ...props.settings.ai.providers };
		providers.kimi = {
			...providers.kimi,
			kimiApiMode,
			kimiRegion,
			baseUrl: getOnethingKimiBaseUrl(kimiApiMode, kimiRegion),
		};
		updateSettings({ ai: { ...props.settings.ai, providers } });
	}

	function updateKimiApiMode(mode: string) {
		updateKimiEndpoint({ mode: normalizeOnethingKimiApiMode(mode) });
	}

	function updateKimiRegion(region: string) {
		updateKimiEndpoint({ region: normalizeOnethingKimiRegion(region) });
	}

	const currentProviderEnvStatus = computed(() => {
		return providerEnvStatuses.value[viewingProvider.value];
	});

	const currentProviderUsesEnvApiKey = computed(() => {
		return providerUsesEnvApiKey(viewingProvider.value);
	});

	const currentProviderEnvVarName = computed(() => {
		return (
			currentProviderEnvStatus.value?.resolvedEnvVar ||
			currentProviderEnvStatus.value?.candidates[0]?.name ||
			""
		);
	});

	const currentProviderEnvKeyPreview = computed(() => {
		return currentProviderEnvStatus.value?.keyPreview || "";
	});

	const providerAuth = useProviderAuth(
		viewingProvider,
		isOAuthProvider,
		async (providerId) => {
			if (providerId !== viewingProvider.value) return;
			await fetchModels(false);
		},
	);

	// Global default computed properties
	const enabledProviders = computed(() => {
		return props.providers.filter((p) => {
			return (
				spaceView.isProviderEnabled(p.id) &&
				spaceView.selectedModelsOf(p.id).length > 0
			);
		});
	});

	const defaultProviderSelectedModels = computed(() => {
		const defaultProvider = props.settings.ai.provider;
		return props.settings.ai.providers[defaultProvider]?.selectedModels || [];
	});

	const defaultProviderModel = computed(() => {
		const defaultProvider = props.settings.ai.provider;
		return props.settings.ai.providers[defaultProvider]?.model || "";
	});

	// Helper functions
	function getDefaultBaseUrl(): string {
		const provider = props.providers.find(
			(p) => p.id === viewingProvider.value,
		);
		return provider?.defaultBaseUrl || "https://api.example.com/v1";
	}

	function isUserCustomProvider(providerId: string): boolean {
		return settingsStore.isCustomProvider(providerId);
	}

	/**
	 * 「这个 provider 在**当前空间**开着没有」(批 B9)。家族(API + 订阅)派生
	 * 仍在 `isProviderEnabledIn` 一处,视图只是把空间覆盖接成它的读取源。
	 */
	function isProviderEnabled(providerId: string): boolean {
		return spaceView.isProviderEnabled(providerId);
	}

	function getProviderEnvStatus(
		providerId: string,
	): ProviderEnvStatus | undefined {
		return providerEnvStatuses.value[providerId];
	}

	function providerUsesEnvApiKey(providerId: string): boolean {
		const config = props.settings.ai.providers[providerId];
		if (config?.apiKey?.trim()) return false;
		return Boolean(providerEnvStatuses.value[providerId]?.resolvedEnvVar);
	}

	function isModelSelected(modelId: string): boolean {
		return spaceView.selectedModelsOf(viewingProvider.value).includes(modelId);
	}

	function getModelName(modelId: string): string {
		const model = availableModels.value.find((m) => m.id === modelId);
		if (model?.name) return model.name;
		return settingsStore.getModelDisplayName(modelId) || modelId;
	}

	// Update functions
	function updateSettings(updates: Partial<AppSettings>) {
		emit("update:settings", { ...props.settings, ...updates });
	}

	function updateProviderApiKey(apiKey: string) {
		const providers = { ...props.settings.ai.providers };
		providers[viewingProvider.value] = {
			...providers[viewingProvider.value],
			apiKey,
		};
		updateSettings({ ai: { ...props.settings.ai, providers } });
	}

	function updateProviderBaseUrl(baseUrl: string) {
		const providers = { ...props.settings.ai.providers };
		providers[viewingProvider.value] = {
			...providers[viewingProvider.value],
			baseUrl,
		};
		updateSettings({ ai: { ...props.settings.ai, providers } });
	}

	function updateZhipuApiMode(mode: string) {
		const zhipuApiMode = mode === "coding-plan" ? "coding-plan" : "standard";
		const providers = { ...props.settings.ai.providers };
		providers.zhipu = {
			...providers.zhipu,
			zhipuApiMode,
			baseUrl:
				zhipuApiMode === "coding-plan"
					? ZHIPU_CODING_PLAN_BASE_URL
					: ZHIPU_STANDARD_BASE_URL,
		};
		updateSettings({ ai: { ...props.settings.ai, providers } });
	}

	// Per-model max output token override map for the currently viewing provider.
	// Read from settings; write via updateModelMaxOutput.
	const currentProviderMaxOutputs = computed<Record<string, number>>(() => {
		return (
			props.settings.ai.providers[viewingProvider.value]?.maxOutputByModel ?? {}
		);
	});

	// The model the slider should configure: the provider's currently active one
	// (i.e. what gets used when you send a message with this provider).
	const activeModelId = computed<string>(() => {
		return props.settings.ai.providers[viewingProvider.value]?.model ?? "";
	});

	const currentACPAgent = computed<ACPAgentConfig | undefined>(() => {
		if (!isACPProvider.value) return undefined;
		const agents = props.settings.acp?.agents ?? [];
		return (
			agents.find((agent) => agent.id === activeModelId.value) ?? agents[0]
		);
	});

	const currentACPAgentState = computed<ACPAgentState | undefined>(() => {
		const agentId = currentACPAgent.value?.id;
		return agentId ? acpAgentStates.value[agentId] : undefined;
	});

	// Hard limit from models.dev for the active model. 0 = unknown.
	const activeModelMaxLimit = computed<number>(() => {
		const id = activeModelId.value;
		if (!id) return 0;
		const found = availableModels.value.find((m) => m.id === id);
		return found?.top_provider?.max_completion_tokens ?? 0;
	});

	// Default value used when no override is set: half of the model's hard limit.
	const activeModelDefaultMaxOutput = computed<number>(() => {
		const limit = activeModelMaxLimit.value;
		if (limit <= 0) return 0;
		return Math.max(1, Math.floor(limit / 2));
	});

	// Effective max output: override -> half-default. Used to drive the slider.
	const activeModelMaxOutput = computed<number>(() => {
		const id = activeModelId.value;
		const override = currentProviderMaxOutputs.value[id];
		if (typeof override === "number" && override > 0) return override;
		return activeModelDefaultMaxOutput.value;
	});

	const hasActiveModelMaxOverride = computed<boolean>(() => {
		const id = activeModelId.value;
		return id in currentProviderMaxOutputs.value;
	});

	// Step size that gives ~100 ticks across the slider for smooth dragging.
	const activeModelMaxOutputStep = computed<number>(() => {
		const limit = activeModelMaxLimit.value;
		if (limit <= 0) return 1;
		if (limit <= 1024) return 1;
		if (limit <= 8192) return 64;
		if (limit <= 32_768) return 128;
		if (limit <= 131_072) return 256;
		return 1024;
	});

	function updateActiveModelMaxOutput(value: number) {
		if (!activeModelId.value) return;
		updateModelMaxOutput(activeModelId.value, value);
	}

	function resetActiveModelMaxOutput() {
		if (!activeModelId.value) return;
		updateModelMaxOutput(activeModelId.value, null);
	}

	// Set the provider's active model — this is the row that the
	// Temperature / Max Output sliders below the list will configure.
	//
	// C1(接批 B10 移交):落点是**当前空间的 overlay defaultSelection**,不再是
	// 全局 `providers[pid].model`。B10 时非 default 空间点这一行会写进全局那一格,
	// 于是「在空间 2 里选个模型」把空间 1 的默认也改了 —— 那是两套形状的又一次
	// 显形。统一之后 default 也走这条。
	function setActiveModel(modelId: string) {
		if (!modelId) return;
		void spaceView.setDefaultSelection(viewingProvider.value, modelId);
	}

	function updateModelMaxOutput(modelId: string, value: number | null) {
		const providers = { ...props.settings.ai.providers };
		const current = { ...providers[viewingProvider.value] };
		const map = { ...(current.maxOutputByModel ?? {}) };
		if (value === null || !Number.isFinite(value) || value <= 0) {
			delete map[modelId];
		} else {
			// Clamp to a sensible upper bound so a fat-fingered 99999999 doesn't poison settings.
			map[modelId] = Math.min(Math.floor(value), 1_000_000);
		}
		if (Object.keys(map).length === 0) {
			delete current.maxOutputByModel;
		} else {
			current.maxOutputByModel = map;
		}
		providers[viewingProvider.value] = current;
		updateSettings({ ai: { ...props.settings.ai, providers } });
	}

	/**
	 * Per-model context-window override. Needed because a hand-added model has
	 * no registry entry, and the resolver's 128k fallback silently mis-budgets
	 * context compaction for anything with a different window.
	 */
	function updateModelContextLength(modelId: string, value: number | null) {
		const providers = { ...props.settings.ai.providers };
		const current = { ...providers[viewingProvider.value] };
		const map = { ...(current.contextLengthByModel ?? {}) };
		if (value === null || !Number.isFinite(value) || value <= 0) {
			delete map[modelId];
		} else {
			map[modelId] = Math.min(Math.floor(value), 100_000_000);
		}
		if (Object.keys(map).length === 0) {
			delete current.contextLengthByModel;
		} else {
			current.contextLengthByModel = map;
		}
		providers[viewingProvider.value] = current;
		updateSettings({ ai: { ...props.settings.ai, providers } });
	}

	const currentProviderContextLengths = computed<Record<string, number>>(() => {
		return (
			props.settings.ai.providers[viewingProvider.value]
				?.contextLengthByModel ?? {}
		);
	});

	// Per-model capability overrides (settings.ai.providers[id].modelCapabilitiesByModel).
	// Pass `value: null` (or `undefined`) to clear the override for that key
	// and fall back to models.dev / name-pattern detection.
	const currentProviderModelCapabilities = computed<
		Record<string, import("@/types").ModelCapabilityOverride>
	>(() => {
		return (
			props.settings.ai.providers[viewingProvider.value]
				?.modelCapabilitiesByModel ?? {}
		);
	});

	function updateModelCapability(
		modelId: string,
		key: keyof import("@/types").ModelCapabilityOverride,
		value: boolean | null,
	) {
		const providers = { ...props.settings.ai.providers };
		const current = { ...providers[viewingProvider.value] };
		const map: Record<string, import("@/types").ModelCapabilityOverride> = {
			...(current.modelCapabilitiesByModel ?? {}),
		};
		const entry: Record<string, boolean> = {
			...(map[modelId] ?? {}),
		} as Record<string, boolean>;
		if (value === null) {
			delete entry[key as string];
		} else {
			entry[key as string] = value;
		}
		if (Object.keys(entry).length === 0) {
			delete map[modelId];
		} else {
			map[modelId] = entry as import("@/types").ModelCapabilityOverride;
		}
		if (Object.keys(map).length === 0) {
			delete current.modelCapabilitiesByModel;
		} else {
			current.modelCapabilitiesByModel = map;
		}
		providers[viewingProvider.value] = current;
		updateSettings({ ai: { ...props.settings.ai, providers } });
	}

	/**
	 * Rename a hand-added model id. Migrates the id across every per-model
	 * map on the provider config so capability / max-output / thinking
	 * overrides survive the rename. No-op if the new id is empty, equals
	 * the old one, or already exists in selectedModels.
	 */
	function renameModel(
		oldId: string,
		newId: string,
	): { ok: boolean; reason?: string } {
		const trimmed = newId.trim();
		if (!trimmed) return { ok: false, reason: "empty" };
		if (trimmed === oldId) return { ok: true };

		const providers = { ...props.settings.ai.providers };
		const current = { ...providers[viewingProvider.value] };
		const selected = current.selectedModels ?? [];

		if (selected.includes(trimmed)) {
			return { ok: false, reason: "duplicate" };
		}

		current.selectedModels = selected.map((id) =>
			id === oldId ? trimmed : id,
		);
		if (current.model === oldId) current.model = trimmed;

		const moveKey = <T>(
			map: Record<string, T> | undefined,
		): Record<string, T> | undefined => {
			if (!map || !(oldId in map)) return map;
			const next: Record<string, T> = { ...map };
			next[trimmed] = next[oldId];
			delete next[oldId];
			return next;
		};
		current.maxOutputByModel = moveKey(current.maxOutputByModel);
		current.contextLengthByModel = moveKey(current.contextLengthByModel);
		current.temperatureByModel = moveKey(current.temperatureByModel);
		current.thinkingByModel = moveKey(current.thinkingByModel);
		current.thinkingEffortByModel = moveKey(current.thinkingEffortByModel);
		current.serviceTierByModel = moveKey(current.serviceTierByModel);
		current.modelCapabilitiesByModel = moveKey(
			current.modelCapabilitiesByModel,
		);

		providers[viewingProvider.value] = current;
		updateSettings({ ai: { ...props.settings.ai, providers } });
		return { ok: true };
	}

	function resetModelCapabilities(modelId: string) {
		const providers = { ...props.settings.ai.providers };
		const current = { ...providers[viewingProvider.value] };
		if (!current.modelCapabilitiesByModel?.[modelId]) return;
		const map = { ...current.modelCapabilitiesByModel };
		delete map[modelId];
		if (Object.keys(map).length === 0) {
			delete current.modelCapabilitiesByModel;
		} else {
			current.modelCapabilitiesByModel = map;
		}
		providers[viewingProvider.value] = current;
		updateSettings({ ai: { ...props.settings.ai, providers } });
	}

	// Writes the per-model temperature override. Falls back to provider/global when unset.
	// Function name kept for backwards compat with template; it now writes per-model.
	function updateProviderTemperature(temperature: number) {
		const cfg = props.settings.ai.providers[viewingProvider.value];
		const id = cfg?.model ?? "";
		if (!id) return;
		const providers = { ...props.settings.ai.providers };
		const current = { ...providers[viewingProvider.value] };
		const map = { ...(current.temperatureByModel ?? {}) };
		map[id] = temperature;
		current.temperatureByModel = map;
		providers[viewingProvider.value] = current;
		updateSettings({ ai: { ...props.settings.ai, providers } });
	}

	// Clear the active model's per-model override, letting it fall back to
	// provider-level then global temperature.
	function resetProviderTemperature() {
		const cfg = props.settings.ai.providers[viewingProvider.value];
		const id = cfg?.model ?? "";
		if (!id) return;
		const providers = { ...props.settings.ai.providers };
		const current = { ...providers[viewingProvider.value] };
		const map = { ...(current.temperatureByModel ?? {}) };
		delete map[id];
		if (Object.keys(map).length === 0) {
			delete current.temperatureByModel;
		} else {
			current.temperatureByModel = map;
		}
		providers[viewingProvider.value] = current;
		updateSettings({ ai: { ...props.settings.ai, providers } });
	}

	/**
	 * A family (API + subscription channel) is one enable unit — the read side
	 * (`isProviderEnabledIn`) treats it so, and the write side must not be able
	 * to pull the two members apart again.
	 */
	function toggleProviderEnabled(providerId: string) {
		if (!props.settings.ai.providers[providerId]) return;
		const family = providerFamilyOf(providerId);
		const ids = family
			? [family.apiProviderId, family.subscriptionProviderId]
			: [providerId];
		setProvidersEnabled(ids, !isProviderEnabled(providerId));
	}

	/**
	 * Set several providers' enabled flag in one settings write. Family cards
	 * toggle both members together; sequential toggleProviderEnabled calls would
	 * each spread the not-yet-updated props and lose the earlier write.
	 */
	function setProvidersEnabled(providerIds: string[], enabled: boolean) {
		// 落点永远是**当前空间的 overlay**(C1)。批 B9 时这里还分了一支
		// (default 写全局),而那正是「开关不独立」的病根。
		void spaceView.setProvidersEnabled(providerIds, enabled);
	}

	async function switchViewingProvider(provider: string) {
		viewingProvider.value = provider;
		modelError.value = "";
		modelSearchQuery.value = "";
		await refreshProviderEnvStatus(provider);
		providerAuth.resetOAuthState();
		await providerAuth.checkOAuthStatus();
		if (isOAuthProvider.value && providerAuth.oauthStatus.value.isLoggedIn) {
			await fetchModels(false);
		} else if (isACPProvider.value) {
			await loadACPAgents();
			await fetchModels(false);
		} else {
			// Warm-load from cache (no force) so capability icons show without a manual Fetch click.
			loadCachedModels();
		}
	}

	async function loadACPAgents() {
		try {
			const response = await acpApi.getAgents({});
			if (response.success && response.agents) {
				acpAgentStates.value = Object.fromEntries(
					response.agents.map((agent) => [agent.config.id, agent]),
				);
			}
		} catch (err) {
			log.error("acp agents load failed", {}, err);
		}
	}

	function updateACPAgent(updates: Partial<ACPAgentConfig>) {
		const current = currentACPAgent.value;
		if (!current) return;
		const acp = {
			enabled: props.settings.acp?.enabled ?? true,
			agents: [...(props.settings.acp?.agents ?? [])],
		};
		const index = acp.agents.findIndex((agent) => agent.id === current.id);
		if (index === -1) return;
		acp.agents[index] = { ...current, ...updates };
		updateSettings({ acp });
	}

	function updateACPArgs(value: string) {
		updateACPAgent({
			args: value
				.split(/\s+/)
				.map((part) => part.trim())
				.filter(Boolean),
		});
	}

	async function connectACPAgent() {
		const agentId = currentACPAgent.value?.id;
		if (!agentId) return;
		const response = await acpApi.connectAgent({ agentId });
		if (response.success && response.agent) {
			acpAgentStates.value = {
				...acpAgentStates.value,
				[agentId]: response.agent,
			};
		}
	}

	async function disconnectACPAgent() {
		const agentId = currentACPAgent.value?.id;
		if (!agentId) return;
		await acpApi.disconnectAgent({ agentId });
		await loadACPAgents();
	}

	async function refreshACPAgent() {
		const agentId = currentACPAgent.value?.id;
		if (!agentId) return;
		const response = await acpApi.refreshAgent({ agentId });
		if (response.success && response.agent) {
			acpAgentStates.value = {
				...acpAgentStates.value,
				[agentId]: response.agent,
			};
		}
	}

	/**
	 * 非默认空间的模型勾选落进 space.json overlay(批 B7)。
	 *
	 * 只搬 `selectedModels` 这一格:`providerConfig.model`(该 provider 的默认
	 * 模型)、maxOutput/contextLength/capabilities 这些**逐模型调参**仍在全局层 ——
	 * 它们描述的是「这个模型是什么样」,不是「这个空间想用哪些」。
	 */
	function toggleSpaceModelSelection(modelId: string) {
		const current = spaceView.selectedModelsOf(viewingProvider.value);
		const index = current.indexOf(modelId);
		if (index === -1) {
			void spaceView.setSelectedModels(viewingProvider.value, [...current, modelId]);
			return;
		}
		// 与全局那一支同一条守则:不允许把最后一个模型摘掉。
		if (current.length <= 1) return;
		void spaceView.setSelectedModels(
			viewingProvider.value,
			current.filter((id) => id !== modelId),
		);
	}

	// C1:一条路 —— 勾选永远写当前空间的 overlay。
	function toggleModelSelection(modelId: string) {
		toggleSpaceModelSelection(modelId);
	}

	/**
	 * 「默认用哪个 provider / 哪个模型」——**当前空间的默认**(C1)。
	 *
	 * 批 B9 之前这两个函数写的是全局 `settings.ai.provider` / `providers[pid].model`;
	 * 迁移之后那两格已经不是真相了(default 空间的默认住在它自己的 space.json)。
	 */
	function setDefaultProvider(providerId: string) {
		const model = spaceView.selectedModelsOf(providerId)[0] ?? "";
		void spaceView.setDefaultSelection(providerId, model);
	}

	function setDefaultModel(modelId: string) {
		const provider =
			spaceView.defaultSelection.value.provider || viewingProvider.value;
		void spaceView.setDefaultSelection(provider, modelId);
	}

	function addCustomModel() {
		const modelId = newModelInput.value.trim();
		if (!modelId) return;

		const current = spaceView.selectedModelsOf(viewingProvider.value);
		if (current.includes(modelId)) {
			modelError.value = `"${modelId}" is already in this provider's model list.`;
			return;
		}
		// 目录缓存是全局共享的(§3):自定义模型进缓存这一步两种空间下都一样,
		// 空间只决定「选了哪些」。
		if (!availableModels.value.find((m) => m.id === modelId)) {
			settingsStore.addCustomModelToCache(
				viewingProvider.value,
				createCustomModel(modelId),
			);
		}
		void spaceView.setSelectedModels(viewingProvider.value, [...current, modelId]);
		modelSearchQuery.value = "";
		modelError.value = "";
		newModelInput.value = "";
	}

	// Model loading
	async function refreshProviderEnvStatus(providerId = viewingProvider.value) {
		try {
			const response = await providersApi.getProviderEnvStatus(providerId);
			if (response.success && response.status) {
				providerEnvStatuses.value = {
					...providerEnvStatuses.value,
					[providerId]: response.status,
				};
			}
		} catch (err) {
			log.error("provider env inspect failed", { providerId }, err);
		}
	}

	async function refreshAllProviderEnvStatuses() {
		await Promise.all(
			props.providers
				.filter((provider) => provider.requiresOAuth !== true)
				.map((provider) => refreshProviderEnvStatus(provider.id)),
		);
	}

	async function loadCachedModels() {
		try {
			await settingsStore.fetchModelsForProvider(viewingProvider.value);
		} catch (err) {
			log.error("cached models load failed", { providerId: viewingProvider.value }, err);
		}
	}

	async function fetchModels(forceRefresh = false) {
		modelError.value = "";

		try {
			const models = forceRefresh
				? await settingsStore.refreshModelsForProvider(viewingProvider.value)
				: await settingsStore.fetchModelsForProvider(viewingProvider.value);

			if (models.length === 0) {
				modelError.value = "No models found for this provider";
			}
		} catch (err: any) {
			modelError.value = err.message || "Failed to fetch models";
		}
	}

	// Lifecycle
	async function initialize() {
		providerAuth.initializeOAuthListeners();
		await refreshAllProviderEnvStatuses();
		await providerAuth.checkOAuthStatus();
		if (isOAuthProvider.value && providerAuth.oauthStatus.value.isLoggedIn) {
			await fetchModels(false);
		} else if (isACPProvider.value) {
			await loadACPAgents();
			await fetchModels(false);
		} else {
			// Warm-load models for the initial provider so capability icons render on open.
			loadCachedModels();
		}
	}

	function cleanup() {
		providerAuth.cleanupOAuthListeners();
	}

	return {
		// 当前空间的 provider 视图(批 B7)。连接区复用**同一个实例** —— 各建一个
		// 会各挂一次 onMounted 拉取,也会让「切空间后谁先刷新」变成运气。
		spaceView,

		// State
		viewingProvider,
		modelSearchQuery,
		newModelInput,
		modelError,
		isOAuthLoading: providerAuth.isOAuthLoading,
		oauthStatus: providerAuth.oauthStatus,
		deviceFlowInfo: providerAuth.deviceFlowInfo,
		codeEntryInfo: providerAuth.codeEntryInfo,
		manualCode: providerAuth.manualCode,
		isSubmittingCode: providerAuth.isSubmittingCode,
		codeEntryError: providerAuth.codeEntryError,

		// Computed
		availableModels,
		isLoadingModels,
		currentProviderName,
		currentSelectedModels,
		currentTemperature,
		hasProviderTemperatureOverride,
		activeModelSupportsTemperature,
		currentProviderMaxOutputs,
		currentProviderContextLengths,
		updateModelContextLength,
		activeModelId,
		activeModelMaxLimit,
		activeModelDefaultMaxOutput,
		activeModelMaxOutput,
		hasActiveModelMaxOverride,
		activeModelMaxOutputStep,
		filteredModels,
		isOAuthProvider,
		isACPProvider,
		isZhipuProvider,
		currentZhipuApiMode,
		isQwenProvider,
		currentQwenApiMode,
		currentQwenRegion,
		isKimiProvider,
		currentKimiApiMode,
		currentKimiRegion,
		kimiRegionApplies,
		currentACPAgent,
		currentACPAgentState,
		currentProviderUsesEnvApiKey,
		currentProviderEnvVarName,
		currentProviderEnvKeyPreview,
		enabledProviders,
		defaultProviderSelectedModels,
		defaultProviderModel,

		// Methods
		getDefaultBaseUrl,
		isUserCustomProvider,
		isProviderEnabled,
		getProviderEnvStatus,
		providerUsesEnvApiKey,
		isModelSelected,
		getModelName,
		// Bound to the provider being viewed so the catalog page and the model
		// ledger resolve capabilities through the same provider-aware chain.
		hasVision: (model: OpenRouterModel) => hasVision(model, viewingProvider.value),
		hasImageGeneration: (model: OpenRouterModel) => hasImageGeneration(model, viewingProvider.value),
		hasTools: (model: OpenRouterModel) => hasTools(model, viewingProvider.value),
		hasReasoning: (model: OpenRouterModel) => hasReasoning(model, viewingProvider.value),
		formatContextLength,
		updateProviderApiKey,
		updateProviderBaseUrl,
		updateZhipuApiMode,
		updateQwenApiMode,
		updateQwenRegion,
		updateKimiApiMode,
		updateKimiRegion,
		updateProviderTemperature,
		resetProviderTemperature,
		updateModelMaxOutput,
		updateActiveModelMaxOutput,
		resetActiveModelMaxOutput,
		currentProviderModelCapabilities,
		updateModelCapability,
		resetModelCapabilities,
		renameModel,
		setActiveModel,
		toggleProviderEnabled,
		setProvidersEnabled,
		switchViewingProvider,
		toggleModelSelection,
		setDefaultProvider,
		setDefaultModel,
		addCustomModel,
		loadACPAgents,
		updateACPAgent,
		updateACPArgs,
		connectACPAgent,
		disconnectACPAgent,
		refreshACPAgent,
		startOAuthLogin: providerAuth.startOAuthLogin,
		submitManualCode: providerAuth.submitManualCode,
		logoutOAuth: providerAuth.logoutOAuth,
		fetchModels,
		initialize,
		cleanup,
	};
}

export type ProviderSettingsReturn = ReturnType<typeof useProviderSettings>;
