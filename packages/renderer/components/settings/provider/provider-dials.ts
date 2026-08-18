/**
 * provider 专属旋钮的**唯一一张表**(批 B10)。
 *
 * 从前这张表散在 `ConnectionsSection.vue` 的模板里:五个 `const *_OPTIONS`
 * 数组 + 三段 `v-if="providerSettings.isXxxProvider"` + 三对
 * `currentXxxApiMode` / `updateXxxApiMode`。默认空间能用,是因为那三段模板恰好
 * 就长在默认空间那一支里 —— 非默认空间走的是凭证池那一支,于是空间 2 的
 * Kimi/Qwen/Zhipu **既设不了也看不见**,静默沿用全局。
 *
 * 把「哪家有哪几格、每格有哪些取值、文案怎么写」收成数据之后,default 那一支与
 * 空间凭证池那一支渲染的是**同一个组件读同一张表**,不可能再分家。
 *
 * 归一函数一律复用 runtime 里那一份(`providers/qwen.ts` / `kimi.ts`):渲染层
 * 自己写一份 `value === 'cn' ? ...` 就是第二份判据,而这两格的错值代价是
 * **在订阅之外再按量扣一次钱**。
 */

import {
	normalizeOnethingQwenApiMode,
	normalizeOnethingQwenRegion,
} from "@onething/runtime/providers/qwen";
import {
	normalizeOnethingKimiApiMode,
	normalizeOnethingKimiRegion,
	onethingKimiRegionApplies,
} from "@onething/runtime/providers/kimi";

/** Select 的对象选项形状是带索引签名的 `SelectObjectValue`,这里跟上它。 */
export interface ProviderDialOption {
	value: string;
	label: string;
	[key: string]: unknown;
}

export interface ProviderDialField {
	/** 行首那个中文标签。 */
	label: string;
	/** 无障碍名。测试也靠它定位 —— 两种空间下必须是同一个字符串。 */
	ariaLabel: string;
	options: ProviderDialOption[];
	/** 归一到合法取值(缺省值由它给)。 */
	normalize(value: unknown): string;
	/**
	 * 这一格此刻有没有意义(Kimi 的编程套餐只有一个全球地址)。缺省恒 true。
	 * 返回 false 时**整行收起**,而不是留一个拨了不动的选择器。
	 */
	appliesTo?(apiMode: string): boolean;
}

export interface ProviderDialSpec {
	providerId: string;
	apiMode: ProviderDialField;
	region?: ProviderDialField;
	/** 选择器下面那句话。说的是**选错的代价**,不是功能介绍。 */
	note?: string;
}

const ZHIPU_DIALS: ProviderDialSpec = {
	providerId: "zhipu",
	apiMode: {
		label: "API mode",
		ariaLabel: "Zhipu API mode",
		options: [
			{ value: "standard", label: "Standard" },
			{ value: "coding-plan", label: "Coding Plan" },
		],
		normalize: (value) => (value === "coding-plan" ? "coding-plan" : "standard"),
	},
};

const QWEN_DIALS: ProviderDialSpec = {
	providerId: "qwen",
	apiMode: {
		label: "计费方式",
		ariaLabel: "Qwen API mode",
		options: [
			{ value: "standard", label: "API 按量付费 (sk-ws-)" },
			{ value: "token-plan", label: "Token Plan 订阅 (sk-sp-)" },
			{ value: "coding-plan", label: "Coding Plan 订阅 (sk-sp-)" },
		],
		normalize: (value) => normalizeOnethingQwenApiMode(value),
	},
	region: {
		label: "版本",
		ariaLabel: "Qwen region",
		options: [
			{ value: "cn", label: "国内版" },
			{ value: "intl", label: "海外版 (QwenCloud)" },
		],
		normalize: (value) => normalizeOnethingQwenRegion(value),
	},
	note: "订阅用户必须选对档位。用通用 Key 和地址调用会走按量计费，在订阅之外额外扣钱。",
};

const KIMI_DIALS: ProviderDialSpec = {
	providerId: "kimi",
	apiMode: {
		label: "计费方式",
		ariaLabel: "Kimi API mode",
		options: [
			{ value: "standard", label: "开放平台 按量付费" },
			{ value: "coding-plan", label: "编程套餐 Kimi Code 订阅" },
		],
		normalize: (value) => normalizeOnethingKimiApiMode(value),
	},
	region: {
		label: "版本",
		ariaLabel: "Kimi region",
		options: [
			{ value: "cn", label: "国内版 (moonshot.cn)" },
			{ value: "intl", label: "海外版 (moonshot.ai)" },
		],
		normalize: (value) => normalizeOnethingKimiRegion(value),
		// 编程套餐(Kimi Code)只有一个全球地址,那一格在这时没有意义。
		appliesTo: (apiMode) =>
			onethingKimiRegionApplies(normalizeOnethingKimiApiMode(apiMode)),
	},
	note: "编程套餐的 Key 与地址(api.kimi.com)和开放平台不通用：留着按量的那一套调用，会在订阅之外再按量扣一次钱。",
};

const DIALS_BY_PROVIDER: Record<string, ProviderDialSpec> = {
	zhipu: ZHIPU_DIALS,
	qwen: QWEN_DIALS,
	kimi: KIMI_DIALS,
};

/** 没有旋钮的 provider 返回 `null` —— 常见情况不该多长出一个空对象。 */
export function providerDialsOf(providerId: string): ProviderDialSpec | null {
	return DIALS_BY_PROVIDER[providerId] ?? null;
}

/** 这一格该显示什么:存过就是存的那个,没存过就是这家 provider 自己的缺省。 */
export function resolveDialValue(
	field: ProviderDialField,
	stored: string | undefined,
): string {
	return field.normalize(stored);
}

/** 地区那一行此刻画不画。 */
export function regionRowApplies(
	spec: ProviderDialSpec,
	apiMode: string,
): boolean {
	if (!spec.region) return false;
	return spec.region.appliesTo?.(apiMode) ?? true;
}
