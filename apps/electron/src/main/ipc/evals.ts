/**
 * 本文件在 P4c 第十批之后**只剩广播**:evals / evalsWorkbench 两域的二十五条
 * invoke 通道已整只迁到通用 RPC 通道(`@shared/ipc/evals.ts` 的 `evalsRouter` +
 * `@shared/ipc/evals-workbench.ts` 的 `evalsWorkbenchRouter`,处理者在
 * `packages/backend/rpc/domains/evals*.ts`),桌面和 web 走同一条 dispatch。
 * router 没有推送面,所以三条进度推送留在这里。
 *
 * 这三条推送如今是**注入端口**(`configureEvalsEventBroadcaster`,同 practice /
 * scratchpad / oauth 判例):谁在跑就由谁决定往哪儿广播 —— 桌面这一侧的答案是
 * 所有活着的窗口,server 那一侧不注入(评估是桌面独占面,渲染侧能力位 `evals`
 * 在 web 上默认关)。递给渲染层的 payload 与迁移前逐字相同。
 *
 * **一处行为变化**:`EVALS_RUN_PROGRESS` 迁移前是单窗定向
 * (`BrowserWindow.fromWebContents(event.sender)`),现在与另外两条一致走全窗
 * 广播;`EVALS_REPLAY_PROGRESS` / `EVALS_DIAGNOSE_PROGRESS` 本来就是全窗。
 *
 * 另一处 electron 触点 `app.isPackaged`(旧 `getRepoDir()`)也不在这里了:
 * 「evals 仓在哪」的判定搬进 `@onething/backend/wiring/evals/host-ports.ts`,
 * 宿主只在 `app/main-process.ts` 注入 `isPackaged` 那一位事实。
 */
import { configureEvalsEventBroadcaster } from "@onething/backend/wiring/evals/events.js";
import { IPC_CHANNELS } from "@shared/ipc.js";
import { broadcastToAllWindows } from "../bridges/ipc-bridge-lifecycle.js";

export function registerEvalsHandlers(): void {
	configureEvalsEventBroadcaster(event => {
		if (event.type === "evals:run-progress") {
			broadcastToAllWindows(IPC_CHANNELS.EVALS_RUN_PROGRESS, event.payload);
			return;
		}
		if (event.type === "evals:replay-progress") {
			broadcastToAllWindows(IPC_CHANNELS.EVALS_REPLAY_PROGRESS, event.payload);
			return;
		}
		broadcastToAllWindows(IPC_CHANNELS.EVALS_DIAGNOSE_PROGRESS, event.payload);
	});
}
