/**
 * 服务商家族(one vendor, two credential channels):一家服务商经两条凭证通道接入 ——
 * 按量付费的 API 那一半与订阅 OAuth 那一半。两半在路由、线协议、计费(订阅 / 按量)、
 * 会话存档里**始终是两家**;家族只合并它们的**呈现**:一张连接卡、一个显示名、一个开关。
 *
 * ── 名单不在这里(服务商自述试点 P4)──────────────────────────────────────────
 * 从前这里有一张写死的四行家族名单 `PROVIDER_FAMILIES`。P4 起家族是各家 manifest 自己
 * 声明的一格(`family`),
 * runtime 由名册算出两半的对应,经 `providers.getProviders` 的 `ProviderInfo.family` 下发;
 * 后端从 runtime 名册直接取。这里只剩**形状**与**拿家族信息作参数**的纯函数 ——
 * `@shared` 与 `@onething/client` 不点任何服务商的名字。
 */

/** 家族里的哪一半。 */
export type ProviderFamilyRole = 'api' | 'subscription'

/** `ProviderInfo.family`:后端由名册算好下发的那一格。 */
export interface ProviderFamilyInfo {
	/** 家族键 —— 等于 API 那一半的 provider id。 */
	id: string
	role: ProviderFamilyRole
	/** 同家的另一半。名册里只声明了一半时缺席(那时不成家)。 */
	sibling?: string
	/** 合并卡片上的家名(「OpenAI」「Claude」),由 API 那一半声明,两半都带。 */
	label?: string
	/** 订阅那一半在合并卡片上的小标签(「Codex」「Claude Code」)。只在订阅那一半上。 */
	tag?: string
}

/** 一个家族的两半。 */
export interface ProviderFamilyLink {
	/** 家族键(= API 那一半的 id)。 */
	id: string
	apiProviderId: string
	subscriptionProviderId: string
}

/** 「这个 provider 属于哪个家族」的查询。不在任何家族里答 `null`。 */
export type ProviderFamilyLookup = (providerId: string) => ProviderFamilyLink | null

/** 一条带 `family` 的名册记录 → 它所在家族的两半。没有 `family` 或不成对 = `null`。 */
export function providerFamilyLinkOf(info: {
	id: string
	family?: ProviderFamilyInfo | null
}): ProviderFamilyLink | null {
	const family = info.family
	if (!family?.sibling) return null
	return family.role === 'api'
		? { id: family.id, apiProviderId: info.id, subscriptionProviderId: family.sibling }
		: { id: family.id, apiProviderId: family.sibling, subscriptionProviderId: info.id }
}

/**
 * 名册(`ProviderInfo[]`,或任何带 `id` + `family` 的记录)→ 家族查询。
 *
 * 两半里**任一半**在名册上就够了:`family.sibling` 写着另一半是谁,所以名册只交了
 * 一半时,那一半照样答得出完整的家族(与旧表的答案一样,它不看名册里有没有另一半)。
 */
export function providerFamilyLookupOf(
	infos: Iterable<{ id: string; family?: ProviderFamilyInfo | null }>,
): ProviderFamilyLookup {
	const byId = new Map<string, ProviderFamilyLink>()
	for (const info of infos) {
		const link = providerFamilyLinkOf(info)
		if (!link) continue
		byId.set(link.apiProviderId, link)
		byId.set(link.subscriptionProviderId, link)
	}
	return (providerId) => byId.get(providerId) ?? null
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
 * one vendor, declared by each vendor's manifest and handed in here as
 * `familyOf`) is presented as ONE card with ONE
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
	/**
	 * 家族查询(P4 起由调用方给:壳用下发的名册 `providerFamilyLookupOf(providers)`,
	 * 后端用 runtime 名册)。**必填** —— 漏传会悄悄丢掉家族派生,那正是
	 * 「设置里一家、聊天里两家」的病。
	 */
	familyOf: ProviderFamilyLookup,
	spaceOverride?: ProviderEnabledOverride,
): boolean {
	// per-space 覆盖(批 B9)接在**这里**,不接在调用点:家族派生(下面那两行)
	// 必须看见每个成员经过空间层之后的开关,否则「家族卡上打开、模型选择器里
	// 不出现」这种分家会在每个调用点各长一次。逐 id 缺席 = 回落全局。
	const enabledOf = (id: string): boolean =>
		spaceOverride?.[id] ?? isProviderConfigEnabled(providers?.[id])
	const own = enabledOf(providerId)
	const family = familyOf(providerId)
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
