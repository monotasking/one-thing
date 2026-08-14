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
 * 后续切片往这个接口里加 defaultModel / selectedModels / persona,文件形状不变。
 */
export interface SpaceOverlayPayload {
	connectedDirectories?: string[];
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
	source: string;
	cooldownUntil?: number;
}

export interface SpaceProviderCredentialSummary {
	entries: SpaceCredentialEntrySummary[];
	/** 本切片恒 `'single'`;轮换策略是批 D。 */
	policy: string;
}

export interface SpaceCredentialsSummary {
	providers: Record<string, SpaceProviderCredentialSummary>;
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

export interface SpacesSetCredentialRequest {
	id: string;
	providerId: string;
	apiKey: string;
	baseUrl?: string;
}
export interface SpacesSetCredentialResponse {
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
