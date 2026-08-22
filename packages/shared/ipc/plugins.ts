/**
 * 统一插件请求通道的过线形状(R2)。
 *
 * 这一段是 CLAUDE.md「加 IPC 通道五步」的第 2 步:类型定义在这里,
 * electron 的 portable host、preload、renderer 类型、web platform 四处
 * **一律 import 复用**。四份手写副本没有任何编译期防护 —— 谁多加一个字段,
 * 另外三处会静默漂移到下一个真机 bug 才被发现。
 *
 * 全段必须 JSON-可序列化(宪法第 2 条):它过 IPC,也过 HTTP。
 */
// 枚举本体在 core(`@onething/core/plugins`)—— 与 `shared/tool-errors.ts` 从
// `@onething/core/permission` 再导出同一条做法:契约只有一份,过线形状引用它。
import type { PluginNotifySound } from "@onething/core/plugins/notify-sound";
import { defineRouter } from "./router.js";

export type { PluginNotifySound };

export interface PluginRequestPayload {
	pluginId: string;
	action: string;
	payload?: unknown;
	/**
	 * 省略即由 core 生成(带单调序列号)。调用方不要自己拿时间戳拼 ——
	 * 同毫秒并发会撞号。真正生效的 id 随结果回传。
	 */
	requestId?: string;
	/**
	 * 绕过降级闸放行**一次**(R7)。
	 *
	 * 只有用户在降级态上明确点"再试一次"时才为真 —— 自动重试、轮询、刷新都不带它,
	 * 否则降级就白降了。
	 */
	bypassDegraded?: boolean;
}

export interface PluginRequestResult {
	success: boolean;
	/** 本次调用的地址;abort 用它。 */
	requestId: string;
	result?: unknown;
	error?: string;
	/** 被撤销(调用方 abort、插件被禁用、宿主拆除)。 */
	aborted?: boolean;
	/** 超出请求预算。 */
	timedOut?: boolean;
	/**
	 * 被**降级短路**掉的:插件根本没有被调用(R7)。
	 *
	 * UI 据此渲染专门的降级态,而不是又一个普通错误 + Retry —— 连败达阈之后
	 * 再点一次没有意义,除非用户明确说"再试一次"(那一次带 bypassDegraded)。
	 */
	degraded?: boolean;
	/** 被降级的界面,例如 `panel:logs`。 */
	surface?: string;
}

export interface PluginRequestProgressPayload {
	requestId: string;
	pluginId: string;
	action: string;
	payload: unknown;
}

export interface AbortPluginRequestResult {
	success: boolean;
	/** 是否真的撤销了一个在飞请求(false = 那个 id 已经不在飞)。 */
	aborted: boolean;
	error?: string;
}

export interface PluginNotificationPayload {
	pluginId: string;
	message: string;
	level: "info" | "warn" | "error";
	/**
	 * 机械同步信号(不给人看)。`config-changed` 只触发刷新,不弹 toast ——
	 * 保存是用户自己点的,再弹一条就是噪音。
	 * `panel-refresh` 同理:插件说"我的面板该重画了",带 panelId。
	 */
	kind?: "config-changed" | "panel-refresh" | "catalog-changed" | "layout";
	/** kind = panel-refresh 时的面板 id。 */
	panelId?: string;
	/**
	 * kind = layout 时的布局动词(I 期)。
	 *
	 * 搭的是同一条 `plugin:notification` 车而不是新开一条 IPC 家族:带 kind 的
	 * 通知本来就是"机械信号,不弹 toast",新增一个 kind 因此不动 toast 那一侧。
	 *
	 * **手势闸与 unsupported 都在主进程判完了** —— renderer 见到这条消息就执行,
	 * 不再判第二遍(判两遍 = 两份口径,多窗口下还会各判一次)。
	 */
	layout?: {
		verb: "toggle-sidebar" | "open-workbench";
		/** open-workbench 才有:要聚焦的插件面板 id(缺省 = 只展开右栏)。 */
		panelId?: string;
	};
	/**
	 * 这一条要不要出声(M1)—— **宿主已经裁决完的结果**,不是插件的请求。
	 *
	 * 主进程在发出这条事件之前就把三件事算完了:枚举校验、每插件/全局静音、
	 * 每插件限频。所以 renderer 见到什么就播什么,不再自己判 —— 判两遍就会有
	 * 两份口径,而多窗口下每个窗口判一遍还会各响一次。
	 *
	 * 缺省(字段不存在)= 'none' = 不出声,与 M1 之前的行为逐字节一致。
	 */
	sound?: PluginNotifySound;
}

/**
 * 插件自有配置的过线形状(R3)。
 *
 * schema 的唯一事实源是 manifest 的 contributes.settings.schema;这里过线的是
 * 宿主已经归约好的**字段表**(控件、标签、默认值),renderer 因此不必自己解
 * JSON Schema —— 两端各写一份解析器就是形状漂移的开始。
 */
export interface PluginConfigFieldDescriptor {
	key: string;
	/** 校验依据(control 只管长相)。 */
	type: "boolean" | "string" | "string-enum" | "number" | "integer" | "string-array";
	control:
		| "switch"
		| "text"
		| "number"
		| "select"
		| "string-list"
		| "file-import"
		/**
		 * F1 第二根:选一个用户磁盘上的目录。宿主拉原生目录对话框,存绝对路径。
		 * 值语义标记见 `directoryPick` —— control 只管长相,管不着值。
		 */
		| "directory-pick";
	label: string;
	hint?: string;
	required: boolean;
	options?: string[];
	minimum?: number;
	maximum?: number;
	integer?: boolean;
	/**
	 * file-import 的**已裁决**声明:accept 已 ⊕ 宿主白名单,maxBytes 已被硬顶
	 * 钳住。设置页拿它直接发起一次导入 —— 不在 UI 侧重算一遍裁决。
	 */
	accept?: string[];
	maxBytes?: number;
	/**
	 * `format: 'directory-pick'` 的**值语义**标记(F1 第二根):这条 string 只接受
	 * 绝对路径或空串。设置页拿它决定"画一个选目录的按钮而不是文本框",宿主拿它
	 * 定位插件的外部根 —— 两边读的是同一个字段,不各猜各的。
	 */
	directoryPick?: boolean;
	defaultValue: unknown;
}

export interface PluginConfigRequest {
	pluginId: string;
}

export interface PluginConfigResponse {
	success: boolean;
	/** schema 声明的字段表;schema 不受支持时为空数组。 */
	fields?: PluginConfigFieldDescriptor[];
	/** 已校验、已填默认值的当前值。 */
	config?: Record<string, unknown>;
	title?: string;
	/** 该插件是否声明了 settings schema。 */
	declared?: boolean;
	/** 值是"schema 默认值"而非宿主真实存量(server 只读镜像时为 true)。 */
	valuesAreDefaults?: boolean;
	/** schema 超出宿主控件集时的逐条原因(不崩,照实说)。 */
	unsupportedReasons?: string[];
	/** 本宿主是否允许编辑(方案 A 下 web 永远 false)。 */
	editable?: boolean;
	/** editable=false 时的解释。 */
	readOnlyReason?: string;
	error?: string;
}

export interface SetPluginConfigRequest {
	pluginId: string;
	config: Record<string, unknown>;
}

/**
 * 结构化错误:带 key 才能让设置页把红态挂到**出错的那个字段**上,
 * 而不是在配置区底下堆一行拼接字符串。coerce 内部本来就知道 key。
 */
export interface PluginConfigErrorDetail {
	/** 出错的字段;缺省表示整体性错误。 */
	key?: string;
	message: string;
}

export interface SetPluginConfigResponse {
	success: boolean;
	/** 落盘后的有效值(已剥未知键、已填默认)。 */
	config?: Record<string, unknown>;
	/** 校验未通过的逐条原因。 */
	errors?: PluginConfigErrorDetail[];
	error?: string;
}

/**
 * 卸载(R4)。数据被**归档**而不是删除 —— 停用保留数据、卸载归档数据,
 * 两者的差别要在对话框里说清楚。
 */
export interface UninstallPluginRequest {
	pluginId: string;
}

/**
 * 一个插件的全部落盘足迹(宪法第 6 条数据侧)。
 *
 * R4 建了 core 侧的枚举,R5 给它接上出口 —— 卸载确认框据此告诉用户
 * "将被归档的是这些东西",而不是让他凭空相信。
 */
export interface PluginDataFootprint {
	pluginId: string;
	dataDir: string;
	dataDirExists: boolean;
	entries: string[];
	legacyKvExists: boolean;
	/** plugin-settings 里为它保留的键。 */
	settingsKeys: string[];
}

export interface PluginFootprintResponse {
	success: boolean;
	footprint?: PluginDataFootprint;
	error?: string;
}

export interface UninstallPluginResponse {
	success: boolean;
	/** 数据归档到了哪儿(用于告诉用户"你的东西还在这")。 */
	archivePath?: string;
	error?: string;
}

/**
 * 安装(P1):npm 形态命令链 —— 脚手架 → npm install(--ignore-scripts)
 * → 装后校验(零运行时依赖 / SRI)→ 全量刷新。失败已回滚,错误原样透传。
 */
export interface InstallPluginRequest {
	/** 包名(可带 scope);必须与包内 package.json 的 name 一致。 */
	pkg: string;
	/** 市场通道:tarball URL。与 path 二选一。 */
	tarballUrl?: string;
	/** file: 开发通道:本地目录或本地 .tgz。与 tarballUrl 二选一。 */
	path?: string;
	/** 市场索引给的 sha512-SRI;file: 通道通常不给。 */
	integrity?: string;
}

export interface InstallPluginResponse {
	success: boolean;
	pluginId?: string;
	error?: string;
}

/**
 * 装前清单预读(file: 开发通道):选中 tarball 即可安装。
 *
 * 包名写在 tarball 内的 `package/package.json` 里,宿主自己读得到 —— 让用户
 * 再抄一遍是纯冗余。预读结果只用于 UI 预填与披露:安装链自己的名字一致性、
 * SRI、零运行时依赖、内置撞名、失败回滚一概照旧,**不以预读为信任来源**。
 */
export interface ReadPluginTarballRequest {
	/** 本地 .tgz 路径。 */
	path: string;
}

/**
 * 拒绝的分类 —— UI 据此说清"为什么这个文件装不了",而不是一律"读取失败"。
 * `not-supported`:本宿主没有插件安装能力(方案 A 下的 web)。
 */
export type ReadPluginTarballErrorCode =
	| "not-found"
	| "unreadable"
	| "too-large"
	| "not-gzip"
	| "not-tar"
	| "missing-package-json"
	| "invalid-package-json"
	| "missing-name"
	| "missing-version"
	| "name-contract"
	| "not-supported";

export interface PluginTarballSummary {
	/** 预读的那个文件(原样回传:UI 拿它当安装参数,免得两边各自 trim)。 */
	path: string;
	/** 包内 package.json 的 name;安装链要的 pkg 就是它。 */
	pkg: string;
	/** 包名去 scope。 */
	pluginId: string;
	version: string;
	/** manifest 的显示名(package.json 的 name 是包名,不是给人看的标题)。 */
	displayName?: string;
	description?: string;
	author?: string;
	minAppVersion?: string;
	/** plugin.json 的 contributes **原文** —— 与市场索引条目同形,披露同一套。 */
	contributes?: unknown;
	/**
	 * plugin.json 缺失/坏时的说明。这种包装得上却永远不会被加载,
	 * 所以不拒绝、但必须摆到确认页上。
	 */
	manifestIssue?: string;
}

export interface ReadPluginTarballResponse {
	success: boolean;
	summary?: PluginTarballSummary;
	errorCode?: ReadPluginTarballErrorCode;
	error?: string;
}

/** 更新(P1):索引比对 + install 新 URL;装后闸不通过自动回退旧版。 */
export interface UpdatePluginRequest {
	pluginId: string;
}

export interface UpdatePluginResponse {
	success: boolean;
	pluginId: string;
	/** 装上的新版本(成功时)。 */
	version?: string;
	/** 装后闸不通过时是否已回退旧版。 */
	rolledBack?: boolean;
	error?: string;
}

/** "有更新"徽标的数据源:已装版本 vs 市场索引版本。 */
export interface PluginUpdateOffer {
	pluginId: string;
	current: string;
	latest: string;
}

export interface CheckPluginUpdatesResponse {
	success: boolean;
	offers: PluginUpdateOffer[];
	error?: string;
}

/**
 * 生命周期能力面(裁决 8:v1 依赖本机 npm)—— 无 npm 环境下
 * Install/Update 置灰并说明,而不是点了才炸。
 */
export interface PluginLifecycleInfoResponse {
	success: boolean;
	npmAvailable: boolean;
	error?: string;
}

export interface PluginCommandInfo {
  id: string
  name: string
  description: string
  usage: string
}

export interface GetPluginCommandsResponse {
  success: boolean
  commands?: PluginCommandInfo[]
  error?: string
}

export interface ExecutePluginCommandRequest {
  commandName: string
  args?: string
  sessionId: string
}

export interface ExecutePluginCommandResponse {
  success: boolean
  message?: string
  error?: string
}

// ── P3:市场 ──

/**
 * 市场索引 URL(裁决:纯硬编码;fork/私有市场改这一处)。
 * 桌面宿主启动时经 configurePluginMarketIndex 注入;测试走注入覆盖。
 */
export const PLUGIN_MARKET_INDEX_URL =
	'https://raw.githubusercontent.com/monotasking/plugin/main/index.json'

/** 市场条目视图(主进程 join 好:索引声明 + 本机安装态 + 版本兼容)。 */
export interface PluginMarketEntryView {
	id: string
	pkg: string
	version: string
	description?: string
	author?: string
	minAppVersion?: string
	/** 原始 contributes 声明 —— 装前确认页呈现的就是 manifest,不是营销文案。 */
	contributes?: unknown
	tarballUrl: string
	integrity?: string
	repository?: string
	/** 已装版本;未装 = null。 */
	installedVersion: string | null
	/** 已装且索引版本更新。 */
	hasUpdate: boolean
	/** minAppVersion 不满足时的说明(Install 置灰依据);满足 = null。 */
	versionBlockedReason: string | null
}

export interface GetPluginMarketRequest {
	/** true = 强制重新拉取;省略/false = 有缓存先用缓存。 */
	refresh?: boolean
}

export interface GetPluginMarketResponse {
	success: boolean
	entries: PluginMarketEntryView[]
	/** 上次成功拉取时间(epoch ms);从未成功 = null。 */
	fetchedAt: number | null
	/** 本次拉取失败、展示的是上次缓存(断网容忍)。 */
	stale: boolean
	error?: string
}

/**
 * `file-pick` 描述树节点的宿主托管导入(B 期,用户壁纸)。
 *
 * renderer 递的是**节点上的声明**(哪个插件、accept、maxBytes),不是路径 ——
 * 路径由主进程的原生对话框产生,并且一步也不回到 renderer:回来的只有一个
 * `storage:` 地址。**字节不过插件的手**,也不过 renderer 的手。
 */
export interface PickPluginFileRequest {
	pluginId: string;
	/** 节点声明的 accept(扩展名,不带点);省略 = 宿主全白名单。 */
	accept?: string[];
	/** 节点声明的上限;省略或超过宿主硬顶 = 硬顶(10MB)。 */
	maxBytes?: number;
	/** 对话框标题(节点的 label)。 */
	label?: string;
}

export interface PickPluginFileResponse {
	/** 用户按了取消 —— **不是失败**,调用方什么也不做(不发 action)。 */
	canceled?: boolean;
	/** 拷贝成功时的地址,可直接喂 `api.theme.updateBackground({ image })`。 */
	path?: string;
	/** 清洗后的落盘文件名(不是用户磁盘上的原名)。 */
	name?: string;
	size?: number;
	/** 闸不过 / IO 失败时给用户看的一句人话。 */
	error?: string;
}

// ============================================================================
// Router
// ============================================================================

/**
 * 目录清单里的一条(列表投影的**过线形状**)。
 *
 * 这里只声明每个宿主都保证给出的那几格 —— 主进程的投影
 * (`@onething/runtime/plugins` 的 `OnethingRendererPluginInfo`)在此之上还带着
 * `contributes` / `configFields` / `source` 等等,渲染侧按自己的局部形状读它们
 * (`services/ipc-hub.ts` 的 `PluginCatalogEntry`、设置页的 `PluginInfo`)。
 * **契约不复述那棵投影树**:它的单源在产品层,抄一份到 `@shared` 只会多一处
 * 静默漂移 —— 与迁移前 `renderer/types/index.ts` 上 `getPlugins` 的声明逐字同宽。
 */
export interface PluginCatalogEntryView {
	id: string;
	name: string;
	version: string;
	description: string;
	author: string;
	loaded: boolean;
	enabled: boolean;
	commands: string[];
	error: string;
	dirPath: string;
}

export interface ListPluginsResponse {
	success: boolean;
	plugins?: PluginCatalogEntryView[];
	/**
	 * 胜出的插件背景 / 氛围层(G 期)。搭清单响应这一班车,零新通道;
	 * 形状的单源是产品层的 `PluginBackgroundDescriptor` / `PluginAmbientDescriptor`,
	 * 渲染侧按自己的局部形状读(`workspace/background-registry.ts`)。
	 */
	background?: unknown;
	ambient?: unknown;
	error?: string;
}

/** enable / disable / footprint / uninstall 共用的"点名一个插件"。 */
export interface PluginToggleRequest {
	pluginId: string;
}

/** enable / disable / refresh 的统一回执。 */
export interface PluginToggleResponse {
	success: boolean;
	error?: string;
}

export interface AbortPluginRequestRequest {
	requestId: string;
}

/**
 * plugins 域 —— 结构债 P4 终态批 C2,十九条 invoke 数据面整只从手写 IPC 通道
 * 搬到通用 `rpc:invoke` / `POST /api/rpc`。
 *
 * **两条推送留在 `IPC_CHANNELS`**(router 今天没有推送面):
 * `PLUGINS_NOTIFICATION`(总线事件,IPCBridge 扇给所有窗)与
 * `PLUGINS_REQUEST_PROGRESS`(按 `callerId` 定向回发起窗,经
 * `configurePluginRequestProgressBroadcaster` 注入)。
 *
 * **http 分叉在域里**(`packages/backend/rpc/domains/plugins.ts`),不在这里:
 * 六条读/开关面沿用 server 自己那本只读镜像目录,其余写面按「插件管理器在不在场」
 * 判定 —— 与迁移前 `platform/web.ts` 那批硬桩逐字相同的答案。
 */
export type PluginsRoutes = {
	list: { input: Record<string, never>; output: ListPluginsResponse };
	enable: { input: PluginToggleRequest; output: PluginToggleResponse };
	disable: { input: PluginToggleRequest; output: PluginToggleResponse };
	refresh: { input: Record<string, never>; output: PluginToggleResponse };
	commands: { input: Record<string, never>; output: GetPluginCommandsResponse };
	executeCommand: {
		input: ExecutePluginCommandRequest;
		output: ExecutePluginCommandResponse;
	};
	request: { input: PluginRequestPayload; output: PluginRequestResult };
	requestAbort: {
		input: AbortPluginRequestRequest;
		output: AbortPluginRequestResult;
	};
	configGet: { input: PluginConfigRequest; output: PluginConfigResponse };
	configSet: { input: SetPluginConfigRequest; output: SetPluginConfigResponse };
	uninstall: { input: UninstallPluginRequest; output: UninstallPluginResponse };
	footprint: { input: UninstallPluginRequest; output: PluginFootprintResponse };
	install: { input: InstallPluginRequest; output: InstallPluginResponse };
	update: { input: UpdatePluginRequest; output: UpdatePluginResponse };
	checkUpdates: {
		input: Record<string, never>;
		output: CheckPluginUpdatesResponse;
	};
	lifecycleInfo: {
		input: Record<string, never>;
		output: PluginLifecycleInfoResponse;
	};
	readTarball: {
		input: ReadPluginTarballRequest;
		output: ReadPluginTarballResponse;
	};
	market: { input: GetPluginMarketRequest; output: GetPluginMarketResponse };
	pickFile: { input: PickPluginFileRequest; output: PickPluginFileResponse };
};

export const pluginsRouter = defineRouter<PluginsRoutes>("plugins", [
	"list",
	"enable",
	"disable",
	"refresh",
	"commands",
	"executeCommand",
	"request",
	"requestAbort",
	"configGet",
	"configSet",
	"uninstall",
	"footprint",
	"install",
	"update",
	"checkUpdates",
	"lifecycleInfo",
	"readTarball",
	"market",
	"pickFile",
]);
