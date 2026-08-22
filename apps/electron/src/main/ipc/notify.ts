/**
 * 系统通知与 dock 徽标(docs/design/agent-dm-user.md §4.2)。
 *
 * 这一层**只执行**:弹一条通知、画一个墨点、把点击回传。"该不该弹"全部在
 * renderer 判定(窗口焦点、会话可见性、未读水位、冷却窗都在那边的 store 里),
 * 把那些状态搬进主进程等于造第二份真源。
 *
 * 两条执行面于 2026-08-23(结构债 P4 终态批 A1-a)从手写通道改为**宿主壳路由**上
 * 的一份处理者表(`notifyRouter` → `@onething/electron-host/ipc/shell/notify`)。
 *
 * 窗口从 `ShellDispatchContext.callerId` 认(从前是 `event.sender`),不另立主窗
 * 注册表:这两条的唯一调用方就是主窗(徽标"只主窗口驱动"是水位那条纪律的延伸),
 * 而 `callerId` 指的恰好是发起这次调用的那扇窗 —— 点击要唤回的也正是它。
 */

import { BrowserWindow, Notification, app, webContents } from "electron";
import type {
	NotifySimpleResponse,
	SetBadgeRequest,
	ShowNotificationRequest,
} from "@shared/ipc.js";
import { IPC_CHANNELS } from "@shared/ipc.js";
import { registerNotifyShellDomain } from "@onething/electron-host/ipc/shell/notify";

/** dock 上的墨点。徽标是「有/无」不是数字(D9),所以画的是一个字符。 */
const BADGE_MARK = "•";

export function registerNotifyHandlers(): void {
	registerNotifyShellDomain({
		async show(
			request: ShowNotificationRequest,
			callerId: number | undefined,
		): Promise<NotifySimpleResponse> {
			const title = request?.title?.trim();
			const body = request?.body?.trim();
			if (!title && !body) return { success: false, error: "empty notification" };
			// 系统不支持时静默成功:通知是锦上添花,拿不到它不该让调用方进错误分支。
			if (!Notification.isSupported()) return { success: true };

			const sender =
				typeof callerId === "number" ? webContents.fromId(callerId) : undefined;
			const senderWindow = sender ? BrowserWindow.fromWebContents(sender) : null;
			const notification = new Notification({
				title: title || body || "",
				body: title ? body : "",
				silent: false,
			});
			notification.on("click", () => {
				if (senderWindow && !senderWindow.isDestroyed()) {
					// show 在 focus 之前:最小化/隐藏的窗只 focus 是不会回来的。
					senderWindow.show();
					senderWindow.focus();
				}
				if (sender && !sender.isDestroyed() && request?.sessionId) {
					sender.send(IPC_CHANNELS.NOTIFY_ACTIVATE, {
						sessionId: request.sessionId,
					});
				}
			});
			notification.show();
			return { success: true };
		},

		async setBadge(request: SetBadgeRequest): Promise<NotifySimpleResponse> {
			// macOS only for now. Windows/Linux 的 overlay icon 需要一张位图资源,
			// 那是另一件事 —— 留空实现好过画一个和 mac 不一样的东西。
			if (process.platform !== "darwin" || !app.dock) return { success: true };
			app.dock.setBadge(request?.hasUnread ? BADGE_MARK : "");
			return { success: true };
		},
	});
}
