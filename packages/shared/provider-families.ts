/**
 * Provider families: one vendor exposed through two credential channels —
 * a pay-per-token API provider and a subscription OAuth provider. The two
 * remain distinct providers everywhere it matters (routing, wire protocol,
 * billing's subscription-vs-api split, persisted sessions); a family only
 * merges how they are PRESENTED: one connection card, one display name.
 */
export interface ProviderFamily {
	/** Family key — equals the API member's provider id. */
	id: string;
	/** Vendor display name shown on the merged card. */
	label: string;
	apiProviderId: string;
	subscriptionProviderId: string;
	/** Short tag for the subscription channel, e.g. "Codex". */
	subscriptionTag: string;
}

export const PROVIDER_FAMILIES: ProviderFamily[] = [
	{
		id: "grok",
		label: "Grok",
		apiProviderId: "grok",
		subscriptionProviderId: "grok-oauth",
		subscriptionTag: "Subscription",
	},
	{
		id: "openai",
		label: "OpenAI",
		apiProviderId: "openai",
		subscriptionProviderId: "codex",
		subscriptionTag: "Codex",
	},
	{
		id: "claude",
		label: "Claude",
		apiProviderId: "claude",
		subscriptionProviderId: "claude-code",
		subscriptionTag: "Claude Code",
	},
	{
		id: "kimi",
		label: "Kimi",
		apiProviderId: "kimi",
		subscriptionProviderId: "kimi-code",
		subscriptionTag: "Kimi Code",
	},
];

export function providerFamilyOf(providerId: string): ProviderFamily | null {
	return (
		PROVIDER_FAMILIES.find(
			(family) =>
				family.apiProviderId === providerId ||
				family.subscriptionProviderId === providerId,
		) ?? null
	);
}

export function isSubscriptionFamilyMember(providerId: string): boolean {
	return providerFamilyOf(providerId)?.subscriptionProviderId === providerId;
}

/**
 * Display name for lists that mix members of a family, e.g. the model ledger:
 * API member reads as the vendor ("OpenAI"), the subscription member as
 * vendor · tag ("OpenAI · Codex"). Non-family providers keep their own name.
 */
export function providerFamilyDisplayName(
	providerId: string,
	fallback: string,
): string {
	const family = providerFamilyOf(providerId);
	if (!family) return fallback;
	if (family.subscriptionProviderId === providerId) {
		// "Claude" + "Claude Code" would read "Claude · Claude Code" — when the
		// tag already carries the vendor name, the tag alone is the full name.
		if (family.subscriptionTag.startsWith(family.label)) {
			return family.subscriptionTag;
		}
		return `${family.label} · ${family.subscriptionTag}`;
	}
	return family.label;
}

/**
 * Single home for the "is this provider enabled" read: an unset flag means
 * enabled. Every surface must call this instead of hand-writing the
 * `enabled !== false` idiom so the default semantics cannot drift.
 *
 * Prefer `isProviderEnabledIn` when a providers map is at hand — it knows
 * about families; this one only sees a single config.
 */
export function isProviderConfigEnabled(config?: { enabled?: boolean } | null): boolean {
	return config?.enabled !== false
}

/**
 * per-space 的 provider 开关覆盖(批 B9)。`{ [providerId]: boolean }`。
 *
 * **缺席 = 回落全局**,两层都算:整个对象缺席 = 这个空间一个都没表达过;某个 id
 * 的键缺席 = 那个 provider 没表达过。默认空间恒为 `undefined` —— 它的开关就是
 * `settings.ai.providers[*].enabled`,一字未改。
 */
export type ProviderEnabledOverride = Record<string, boolean> | null | undefined

/**
 * Family-aware enabled read. A provider family (API + subscription channel of
 * one vendor, `@shared/provider-families`) is presented as ONE card with ONE
 * switch that writes both members. Legacy data predates that card, though,
 * and the two flags can disagree in either direction:
 *
 *   - api ON / subscription OFF — the API member existed and was on before
 *     its subscription sibling shipped (kimi true / kimi-code false). The
 *     card shows ON, yet the models checked under the subscription tab never
 *     reach the model picker or the ledger, and no control can turn the
 *     sibling on individually.
 *   - api OFF / subscription ON — the old per-provider switches, set on
 *     purpose (openai false / codex true): the user wants Codex, not the
 *     stale API defaults.
 *
 * The rule that honors both: the family switch lives on the API member (the
 * family key IS the API member's id), so a member is enabled when the API
 * member is; the subscription member's own flag survives as the legacy
 * per-provider override that can still switch it on when the API side is off.
 */
export function isProviderEnabledIn(
	providers: Record<string, { enabled?: boolean } | undefined> | undefined | null,
	providerId: string,
	spaceOverride?: ProviderEnabledOverride,
): boolean {
	// per-space 覆盖(批 B9)接在**这里**,不接在调用点:家族派生(下面那两行)
	// 必须看见每个成员经过空间层之后的开关,否则「家族卡上打开、模型选择器里
	// 不出现」这种分家会在每个调用点各长一次。逐 id 缺席 = 回落全局。
	const enabledOf = (id: string): boolean =>
		spaceOverride?.[id] ?? isProviderConfigEnabled(providers?.[id])
	const own = enabledOf(providerId)
	const family = providerFamilyOf(providerId)
	if (!family) return own
	/*
	 * 家族开关挂在 API 成员上,但「没设过 = 开着」只对**配过的**成员成立。
	 * API 成员一格配置都没有(从没碰过 API 那一坑,只用订阅那一坑)时,它的
	 * 「开着」是缺省值,不是用户说过的话 —— 拿它去把订阅成员捞出来,会让设置里
	 * 明明关掉的 Claude Code 模型照样出现在模型选择器里(09-17 报障)。
	 * 这时整张卡的开关就是订阅成员自己那一格。
	 */
	const expressed = (id: string): boolean =>
		spaceOverride?.[id] !== undefined || providers?.[id] != null
	const api = family.apiProviderId
	const sub = family.subscriptionProviderId
	const familyOn = expressed(api) || !expressed(sub) ? enabledOf(api) : enabledOf(sub)
	if (providerId === api) return familyOn
	return own || familyOn
}
