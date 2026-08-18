import type { SpaceProviderSettings } from "./providers.js";

/**
 * IPC types for the space (workspace) subsystem — 批 B1。
 *
 * 后端**没有「当前空间」的概念**:currentSpaceId 是 window 级状态,住在渲染层的
 * localStorage(设计盲点 4,为「两窗口开两 space」留路)。所以每个操作都显式带 id。
 */

export interface SpaceRecord {
	id: string;
	name: string;
	color?: string;
	icon?: string;
	createdAt: number;
}

export interface SpacesListResponse {
	success: boolean;
	spaces?: SpaceRecord[];
	error?: string;
	code?: string;
}

export interface SpacesCreateRequest {
	name: string;
	id?: string;
	color?: string;
	icon?: string;
}
export interface SpacesCreateResponse {
	success: boolean;
	space?: SpaceRecord;
	error?: string;
	code?: string;
}

export interface SpacesUpdateRequest {
	id: string;
	name?: string;
	color?: string;
	icon?: string;
}
export interface SpacesUpdateResponse {
	success: boolean;
	space?: SpaceRecord;
	error?: string;
	code?: string;
}

export interface SpacesRemoveRequest {
	id: string;
}
/** 拒绝码:`DEFAULT_SPACE`(默认空间) / `NOT_EMPTY`(还有会话) / `NOT_FOUND`。 */
export interface SpacesRemoveResponse {
	success: boolean;
	removed?: boolean;
	error?: string;
	code?: string;
}

/**
 * per-space overlay(批 B2)—— 落盘在 `workspaces/<id>/space.json`。
 *
 * 语义是**追加层**,不是替换层:生效接入目录 = 全局 `settings.tools
 * .connectedDirectories` ∪ 本空间 `connectedDirectories`。全局层继续全空间共享,
 * 所以「这个空间看得见哪些目录」永远 ⊇ 全局。
 *
 * 后续切片往这个接口里加东西,文件形状不变(B7 加了 selectedModels,B9 加了
 * defaultSelection / providerEnabled)。
 */
export interface SpaceOverlayPayload {
	connectedDirectories?: string[];
	/**
	 * per-space「选了哪些模型」(批 B7)。`{ [providerId]: modelId[] }`。
	 *
	 * 与接入目录**不是**同一条语义:目录是「全局 ∪ overlay」的追加层,模型选择是
	 * **覆盖层** —— 空间表达过就以它为准(哪怕是空的),没表达过才落回
	 * `settings.ai.providers[*].selectedModels`。理由是这两件事的直觉相反:
	 * 多一个目录不碍事,多一个「这个空间不该出现的模型」就是隔离漏了。
	 *
	 * 模型**目录缓存**(models.dev 那 ~500KB)不在这里 —— 它留在全局 settings,
	 * 全空间共享。空间只决定「选了哪些」。
	 */
	selectedModels?: Record<string, string[]>;
	/**
	 * per-space「默认 provider + 默认模型」(批 B9)。
	 *
	 * 推翻 B7 的「默认模型有意留全局」(用户 08-17:「不同的空间,它的默认模型
	 * 以及这个模型列表都是要不一样的」)。与 selectedModels 同为**覆盖层**:
	 * 缺席 = 回落全局 `settings.ai.provider` + `settings.ai.providers[pid].model`,
	 * 表达过即以空间为准。provider 与 model 是一对 —— 拆成两格就会出现
	 * 「provider=deepseek / model=glm-5」这种解释不清的组合。
	 */
	defaultSelection?: { provider: string; model?: string };
	/**
	 * per-space「provider 启用开关」(批 B9)。`{ [providerId]: boolean }`。
	 *
	 * 逐 provider 缺席 = 那个 provider 没表达过(回落全局
	 * `settings.ai.providers[pid].enabled`,缺省 true)。家族(API + 订阅)的派生
	 * 不在这里,在渲染层的 `isProviderEnabledIn` —— 这里只是它的逐成员数据源。
	 */
	providerEnabled?: Record<string, boolean>;
}

export interface SpacesGetOverlayRequest {
	id: string;
}
export interface SpacesGetOverlayResponse {
	success: boolean;
	overlay?: SpaceOverlayPayload;
	error?: string;
	code?: string;
}

/** 整层写入:传什么就是什么(缺字段 = 该字段被清空)。 */
export interface SpacesSetOverlayRequest {
	id: string;
	overlay: SpaceOverlayPayload;
}
export interface SpacesSetOverlayResponse {
	success: boolean;
	overlay?: SpaceOverlayPayload;
	error?: string;
	code?: string;
}

/**
 * per-space **整套 provider 设置**(C2)—— 落盘在 `workspaces/<id>/providers.json`。
 *
 * 用户 08-18:「不同的空间,provider 设置应该是完整的、独立的两套。对齐。」
 * 于是 overlay 里 B7/B9 那三格(`selectedModels` / `defaultSelection` /
 * `providerEnabled`)并进这里,而这里装的是**整份** `settings.ai` 减去凭证
 * (在 `credentials.json`)与 models.dev 目录缓存(留全局)。
 *
 * **无回落**:这个空间没表达过的,就是没有 —— 不去看别的空间,也不看全局。
 */
export interface SpacesGetProviderSettingsRequest {
	id: string;
}
export interface SpacesGetProviderSettingsResponse {
	success: boolean;
	ai?: SpaceProviderSettings;
	error?: string;
	code?: string;
}

/** 整层写入:传什么就是什么(缺字段 = 该字段被清空)。 */
export interface SpacesSetProviderSettingsRequest {
	id: string;
	ai: SpaceProviderSettings;
}
export interface SpacesSetProviderSettingsResponse {
	success: boolean;
	ai?: SpaceProviderSettings;
	error?: string;
	code?: string;
}

/**
 * per-space provider 凭证池(批 B3)—— 落盘在 `workspaces/<id>/credentials.json`,
 * 与 space.json 分开(整空间导出默认剔除凭证)。
 *
 * **默认空间不走这条路**:它的凭证源是 `settings.ai`,原地不动 —— 那不是回落,
 * 是身份定义。非默认空间**严格隔离不回落**:没有 entry = 该 provider 在该空间
 * 未配置,起流前置拦截。
 *
 * 传给渲染层的一律是**摘要**:密钥原文永不出后端。
 */
export interface SpaceCredentialEntrySummary {
	id: string;
	label: string;
	authType: "apiKey" | "oauth";
	hasApiKey: boolean;
	apiKeyPreview?: string;
	baseUrl?: string;
	/**
	 * provider 专属旋钮(批 B10)。**不是密钥**,原样出后端 —— 面板要画的就是
	 * 「这条 key 用的是哪个档位 / 哪个地区」。
	 */
	apiMode?: string;
	region?: string;
	source: string;
	cooldownUntil?: number;
	/**
	 * OAuth 型条目的登录态(批 B6)。**同样不含 token 原文** —— 只有「登没登、
	 * 什么时候过期、哪个账号」,与 apiKey 那边给预览不给原文是同一条纪律。
	 */
	hasOAuthToken?: boolean;
	oauthExpiresAt?: number;
	oauthAccount?: string;
}

export interface SpaceProviderCredentialSummary {
	entries: SpaceCredentialEntrySummary[];
	/**
	 * `single` / `priority-failover` / `round-robin`(批 D 起三种全部生效)
	 * 或 `plugin:<id>:<name>`(批 E:插件注册的策略)。形状不认识的取值按
	 * `single` 解析。
	 */
	policy: string;
	/**
	 * 批 E:`policy` 是插件策略但它此刻**不可用**(插件停用/卸载,或该策略被
	 * 熔断降级)。面板据它画灰态并注明"正在使用内置 failover" ——
	 * **字段本身不被改写**,用户的选择保留,插件回来自动生效。
	 */
	policyUnavailable?: boolean;
}

/** 批 E:一个当前注册着的插件凭证策略(面板的策略选择器据它列选项)。 */
export interface SpaceCredentialStrategySummary {
	/** 落盘的 policy 取值:`plugin:<pluginId>:<name>`。 */
	policy: string;
	pluginId: string;
	/** 选择器上显示的人话。 */
	title: string;
	/** 选择器下方的一句说明(策略自己给的)。 */
	description?: string;
}

export interface SpaceCredentialsSummary {
	providers: Record<string, SpaceProviderCredentialSummary>;
	/**
	 * 批 E:**实时**的插件策略清单(注册表快照,不落盘)。插件停用后这里就没了,
	 * 而各 provider 的 `policy` 字段仍然留着那个取值 —— 两者的差就是灰态。
	 */
	strategies?: SpaceCredentialStrategySummary[];
}

export interface SpacesGetCredentialsRequest {
	id: string;
}
export interface SpacesGetCredentialsResponse {
	success: boolean;
	credentials?: SpaceCredentialsSummary;
	error?: string;
	code?: string;
}

/**
 * 写一条凭证。**`entryId` 在就是改那一条,不在就是往池里追加一条**(批 D)。
 * 批 B3 时「不在」= 覆盖头一条 apiKey entry —— 多条目 UI 上来之后那个语义没有
 * 位置了:UI 上的「添加」与「保存」是两个按钮,后端也得是两个意思。
 *
 * 批 B10:三个非密钥字段(baseUrl / apiMode / region)一律 **patch** ——
 * 缺席 = 这次不表达 → 沿用旧值;空串 = 清空。旧写法「缺席即清空」会让换一次 key
 * 顺手把端点和档位抹掉,而用户在界面上看不出发生了什么。
 */
export interface SpacesSetCredentialRequest {
	id: string;
	providerId: string;
	/**
	 * 批 B10 起可选:**带 `entryId` 而不带 key = 只改非密钥字段**
	 * (档位/地区/端点/名称)。渲染层拿不到密钥原文,逼它重填就是逼它重打一遍。
	 * 不带 `entryId`(追加一条)时仍然必填。
	 */
	apiKey?: string;
	baseUrl?: string;
	/** zhipu/qwen/kimi 的档位。缺席 = 不表达(沿用旧值);空串 = 清空。 */
	apiMode?: string;
	/** qwen/kimi 的地区(`cn` / `intl`)。同上 patch 语义。 */
	region?: string;
	entryId?: string;
	label?: string;
}
export interface SpacesSetCredentialResponse {
	success: boolean;
	credentials?: SpaceCredentialsSummary;
	error?: string;
	code?: string;
}

/**
 * 整池写(批 D):排序 + 删除 + 策略一次落盘。
 *
 * `entryIds` 是**期望的最终顺序**(顺序即 failover 优先级);不在列表里的 entry
 * 被删除。密钥原文不在这条通道上 —— 渲染层根本没有它。
 */
export interface SpacesSetCredentialPoolRequest {
	id: string;
	providerId: string;
	entryIds: string[];
	policy?: string;
}
export interface SpacesSetCredentialPoolResponse {
	success: boolean;
	credentials?: SpaceCredentialsSummary;
	error?: string;
	code?: string;
}

export interface SpacesClearCredentialRequest {
	id: string;
	providerId: string;
}
export interface SpacesClearCredentialResponse {
	success: boolean;
	credentials?: SpaceCredentialsSummary;
	error?: string;
	code?: string;
}

/** 新建向导的「从默认空间导入凭证」。**copy 不引用**;OAuth 型跳过并如实报出。 */
export interface SpacesImportCredentialsRequest {
	id: string;
}
export interface SpaceCredentialImportSkip {
	providerId: string;
	reason: "oauth" | "no-api-key";
}
export interface SpacesImportCredentialsResponse {
	success: boolean;
	imported?: string[];
	skipped?: SpaceCredentialImportSkip[];
	credentials?: SpaceCredentialsSummary;
	error?: string;
	code?: string;
}

/**
 * 空间数据变更广播的载荷(批 B9-0,`IPC_CHANNELS.SPACES_CHANGED`)。
 *
 * 主进程在 `writeSpaceCredentials` / `writeSpaceOverlay` 落盘之后广播给所有窗口。
 * 收件方(渲染层 `spaceProviders` store)只在 `spaceId` 等于自己当前空间时重拉 ——
 * 别的空间的变更与它无关,重拉一次纯属浪费。
 */
export interface SpacesChangedEvent {
	spaceId: string;
	kind: "credentials" | "overlay" | "providers";
}
