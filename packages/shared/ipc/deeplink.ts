/**
 * `onething://` 深链的跨进程契约(H4)。
 *
 * 这里放的是**确认卡过线时的形状** —— 主进程算完"这条链要给用户看什么"之后
 * 推给渲染层的那份数据。为什么形状住在 `@shared` 而不是装配层:卡片要被
 * renderer 直接渲染,而 renderer 不许 import 装配层;放在 core 又要让 shared
 * 反过来依赖 core。`@shared/ipc` 本来就是"两个进程都认的词汇表",这是它的活。
 *
 * 三条约束,和其它 IPC 契约同规:
 *  1. 全部 JSON-可序列化,字段 **append-only**;
 *  2. 卡上**不出现裸 id** —— 主进程已经把 agent / 插件 / 动作翻成人话了,
 *     renderer 只负责显示,不再查一遍(查两遍就会漂);
 *  3. `text` 是**全文**过线。renderer 让它滚动,绝不静默截断 —— 用户要为
 *     "发出去的到底是什么"负责,那就得让他看得见全部。
 */

/** `onething://ask?text=…&agent=…` 的卡。 */
export interface DeepLinkAskCardPayload {
	kind: "ask";
	/** 全文。 */
	text: string;
	/** 命中的 agent(存在时)。 */
	agentId?: string;
	agentName?: string;
	/** URL 点名了一个不存在的 agent —— 卡上要明说"回落默认"。 */
	agentFallbackFrom?: string;
	defaultAgentName?: string;
}

/** `onething://x/<pluginId>/<action>?…` 的卡。 */
export interface DeepLinkPluginCardPayload {
	kind: "plugin";
	text: string;
	/** 除 text 之外的查询参数,原样。卡上折叠显示,handler 原样收到。 */
	params: Record<string, string>;
	pluginId: string;
	action: string;
	/** 插件**显示名**(manifest.name)。 */
	pluginName: string;
	/** 动作的人话标题(注册时给的 title)。 */
	actionTitle: string;
}

/**
 * 一条**看得见的**拒绝。卡上只有一句话和一个"知道了",**没有确认按钮**。
 *
 * 只有少数几种拒绝会走到这里(内容过长、动作不在了/灰着)。形状非法与未知
 * 动词一律静默丢弃,压根不过线 —— 否则任何网页都能拿弹窗骚扰用户。
 */
export interface DeepLinkRejectionCardPayload {
	kind: "rejected";
	/** 机器可读的原因(日志用;界面读的是 message)。 */
	reason: string;
	message: string;
}

export type DeepLinkCardPayload =
	| DeepLinkAskCardPayload
	| DeepLinkPluginCardPayload
	| DeepLinkRejectionCardPayload;

/** 主进程 → 渲染层:请画一张确认卡。 */
export interface DeepLinkConfirmRequest {
	/** 一次深链的地址。响应必须带回它 —— 卡可能排队,答的不一定是最新那张。 */
	requestId: string;
	card: DeepLinkCardPayload;
}

/** 渲染层 → 主进程:用户按了钮。 */
export interface DeepLinkRespondRequest {
	requestId: string;
	approved: boolean;
}

/**
 * 响应结果。
 *
 * `ask` 那一格**不在主进程执行** —— 它回一份 `ask`,由渲染层照普通用户消息的
 * 既有路径(新建会话 + 发送)走完。理由是那条路径要既建会话又把它**打开**,
 * 而"打开哪个会话"这件事只有渲染层知道;主进程另造一条会得到一个用户看不见的
 * 会话在后台自己跑。
 */
export interface DeepLinkRespondResponse {
	success: boolean;
	error?: string;
	/** 用户点了确认吗(取消 = success:true, dispatched:false)。 */
	dispatched?: boolean;
	/** ask:渲染层照此新建会话并发送。 */
	ask?: { text: string; agentId?: string };
	/** 插件动作:handler 说的一句话(可无)。 */
	notice?: string;
}

/**
 * 深链确认门的**请求面**(结构债 P4 终态批 A1-a,2026-08-23)。
 *
 * 三个时刻里有两个是请求/响应(从前是两条 `ipcMain.handle`),它们走**宿主壳
 * 路由**(`shell:invoke`):
 *  - `ready` —— 渲染层给冷启动队列的放行信号。处理者动的是主进程里那只队列闸,
 *    住在 `apps/electron`;
 *  - `respond` —— 用户按了钮,派发的唯一入口。
 *
 * 推卡那一条(主进程 → 渲染层)是真推送,留在 `IPC_CHANNELS.DEEPLINK_REQUEST`。
 *
 * web 侧三条都是诚实的空实现:注册 URL scheme 是操作系统级的事,浏览器里没有
 * "外面点一条链接回到这个标签页"这种东西。
 */
import { defineRouter } from "./router.js";

export type DeepLinkReadyResponse = { success: boolean };

export type DeeplinkRoutes = {
	ready: { input: Record<string, never>; output: DeepLinkReadyResponse };
	respond: { input: DeepLinkRespondRequest; output: DeepLinkRespondResponse };
};

export const deeplinkRouter = defineRouter<DeeplinkRoutes>("deeplink", [
	"ready",
	"respond",
]);
