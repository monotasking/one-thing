/**
 * 系统通知与 dock 徽标(docs/design/agent-dm-user.md §4)。
 *
 * 分工:**决策在 renderer,执行在主进程**。窗口焦点、会话可见性、未读水位全在
 * renderer 的 store 里,主进程对"用户是否正看着这间房"一无所知;而 renderer 的
 * Web Notification 权限被 session 安全策略明确拒绝(嵌入的浏览器页面不该弹通知
 * ——那道门是对的,不放行)。所以判定留在 renderer,弹窗走主进程的 Notification。
 */

export interface ShowNotificationRequest {
	/** 通知标题。私聊场景 = 发言 agent 的名字。 */
	title: string;
	/** 正文摘要:已剥 mention token 与 markdown 标记、已截断。 */
	body: string;
	/** 点击后要打开的会话。主进程原样回传给 renderer,自己不解释它。 */
	sessionId: string;
}

/**
 * 徽标是「有/无」而不是数字(agent-im-dm.md D9 的定调:系统只知道有没有,
 * 编数字不可靠),所以 dock 画的是一枚墨点字符,不是 setBadgeCount。
 */
export interface SetBadgeRequest {
	hasUnread: boolean;
}

/** 主进程 → renderer:用户点了那条通知。 */
export interface NotifyActivateEvent {
	sessionId: string;
}

export interface NotifySimpleResponse {
	success: boolean;
	error?: string;
}

/**
 * 系统通知与 dock 徽标的**宿主壳路由**(结构债 P4 终态批 A1-a,2026-08-23)。
 *
 * 两条执行面从手写通道搬到 `shell:invoke`。处理者要的是 `Notification` 与
 * `app.dock`,只能住在 `apps/electron` —— 所以是壳路由不是 `rpc:invoke`。
 * 判定仍然全在 renderer(这一层只执行),这次搬家一格没动。
 *
 * `NOTIFY_ACTIVATE`(用户点了通知)是推送,留在 `IPC_CHANNELS` 上。
 *
 * web 侧刻意降级为"只剩未读墨点":浏览器的 Notification 要先问权限,而一个页面
 * 在用户没要求的情况下弹权限框是骚扰。两条都如实回成功(同迁移前的桩)。
 */
import { defineRouter } from "./router.js";

export type NotifyRoutes = {
	show: { input: ShowNotificationRequest; output: NotifySimpleResponse };
	setBadge: { input: SetBadgeRequest; output: NotifySimpleResponse };
};

export const notifyRouter = defineRouter<NotifyRoutes>("notify", [
	"show",
	"setBadge",
]);
