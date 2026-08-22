/**
 * 深链确认门的渲染侧(H4)。
 *
 * 主进程算好了"给用户看什么"(agent 存不存在、插件叫什么、动作还在不在),
 * 这里只做三件事:排队显示、把那一按回传、以及 `ask` 确认之后**照普通用户消息
 * 的既有路径**把它发出去 —— 新建会话 + 打开它 + sendMessage,和用户自己在
 * 输入框敲一遍走的是同一条路。
 *
 * 为什么 ask 在这一侧跑:那条路径要既建会话又**打开**它,而"打开哪个会话"只有
 * 渲染层知道。主进程另造一条,得到的是一个用户看不见的会话在后台自己跑。
 *
 * 排队而不是覆盖:用户可能连点两条深链(或者 app 冷启动时队列里压着几条)。
 * 后到的盖掉先到的,会让第一条无声消失 —— 而它已经被用户点过一次了。
 */
import { ref, shallowRef } from "vue";
import type {
	DeepLinkConfirmRequest,
	DeepLinkRespondResponse,
} from "@shared/ipc/deeplink";
import { platformApi } from "@/platform";
import { deeplinkApi } from "@/platform/deeplink-client";
import { toast } from "@/composables/useToast";

/** 当前正在显示的那一张(null = 没有卡)。 */
export const activeDeepLink = shallowRef<DeepLinkConfirmRequest | null>(null);

/** 确认按钮按下之后、respond 回来之前 —— 防连点。 */
export const deepLinkBusy = ref(false);

const queue: DeepLinkConfirmRequest[] = [];
let unsubscribe: (() => void) | null = null;

function showNext(): void {
	activeDeepLink.value = queue.shift() ?? null;
}

/**
 * 接上监听,然后**告诉主进程我们准备好了** —— 那句话是冷启动队列的放行信号。
 *
 * 顺序不能反:先说 ready 再订阅,会让冷启动排队的那几条投在没人听的时刻。
 */
export function initDeepLinkListener(): void {
	if (unsubscribe) return;
	// 面缺失 = 这个宿主没有深链(web、以及任何只搭了一半 electronAPI 的测试宿主)。
	// 那是**不存在**而不是失败,所以安静返回 —— 这个服务挂在无条件可用的
	// overlay host 上,在这里抛会连累一条与深链无关的确认框。
	if (typeof platformApi.onDeepLinkRequest !== "function") return;
	unsubscribe = platformApi.onDeepLinkRequest((request) => {
		if (!request?.requestId || !request.card) return;
		queue.push(request);
		if (!activeDeepLink.value) showNext();
	});
	void deeplinkApi.ready({}).catch(() => {
		// 放行信号发不出去只影响冷启动那几条(它们会一直排在主进程队列里)。
		// 已经在跑的 app 不受影响,所以这里不打扰用户。
	});
}

/** 测试 / HMR 拆除。 */
export function disposeDeepLinkListener(): void {
	unsubscribe?.();
	unsubscribe = null;
	queue.length = 0;
	activeDeepLink.value = null;
	deepLinkBusy.value = false;
}

/**
 * 用户按了钮。
 *
 * 取消 = 什么也不发生(主进程把 pending 条目删掉,插件永远不知道有过这一次)。
 */
export async function settleDeepLink(approved: boolean): Promise<void> {
	const request = activeDeepLink.value;
	if (!request || deepLinkBusy.value) return;
	deepLinkBusy.value = true;
	try {
		const response = await deeplinkApi.respond({
			requestId: request.requestId,
			approved,
		});
		if (approved) await applyDeepLinkResponse(response);
	} catch (error) {
		toast.error(
			error instanceof Error ? error.message : "The deep link could not be handled",
		);
	} finally {
		deepLinkBusy.value = false;
		showNext();
	}
}

/** 一张拒绝卡上只有"知道了" —— 关掉即可,不回传。 */
export function dismissDeepLink(): void {
	activeDeepLink.value = null;
	showNext();
}

async function applyDeepLinkResponse(
	response: DeepLinkRespondResponse,
): Promise<void> {
	if (!response.success) {
		toast.error(response.error || "The deep link could not be handled");
		return;
	}
	if (response.notice) toast.info(response.notice);
	if (!response.ask) return;
	await startAskSession(response.ask.text, response.ask.agentId);
}

/**
 * `ask` 的落地:新建会话 → 绑 agent(有的话)→ 发消息。
 *
 * 三步都是**既有函数**,一个新入口都不开:深链的 text 在这里之后就是一条普通的
 * 用户消息,与它从外面来这件事再无关系(文件头第一条纪律的落点)。
 */
async function startAskSession(text: string, agentId?: string): Promise<void> {
	// 惰性引入:store 模块拖着整棵渲染树,顶层 import 会让这个服务在 boot 早期
	// 就把它们拽起来。
	const { useSessionsStore } = await import("@/stores/sessions");
	const { useChatStore } = await import("@/stores/chat");
	const sessionsStore = useSessionsStore();
	const chatStore = useChatStore();

	const session = await sessionsStore.createSession(deriveSessionTitle(text));
	if (!session) {
		toast.error("Could not start a new chat for this link");
		return;
	}
	if (agentId) await sessionsStore.updateSessionAgent(session.id, agentId);
	await chatStore.sendMessage(session.id, text, undefined, {
		// 来源如实标注:账本与调试里要分得出"这条是外面点进来的"。
		source: "deeplink",
	});
}

/** 标题取第一行的前 40 字 —— 与用户手敲第一条消息之后的效果一致。 */
function deriveSessionTitle(text: string): string {
	const firstLine = text.split("\n").find((line) => line.trim()) ?? "";
	const trimmed = firstLine.trim().slice(0, 40);
	return trimmed || "New Chat";
}
