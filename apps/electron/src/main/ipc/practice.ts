/**
 * 本文件在 P4a 之后**只剩广播**:10 条 practice invoke 通道已整只迁到通用 RPC 通道
 * (`@shared/ipc/practice.ts` 的 `practiceRouter` + `app/rpc/domains/practice.ts`),
 * 桌面和 web 走同一条 dispatch。router 没有推送面,所以 `PRACTICE_EVENT` 留在这里。
 *
 * 这条推送本来就是**注入端口**(`configurePracticeEventBroadcaster`):引擎每次相变
 * 加运行中 ~1Hz 往渲染层推一次快照,`settled` 每个会话恰好出现一次(落账那一刻)。
 * 见 docs/design/practice-system.md。
 */
import { configurePracticeEventBroadcaster } from "@onething/app/practice/index.js";
import { IPC_CHANNELS } from "@shared/ipc.js";
import { getIPCBridge } from "../bridges/ipc-bridge-lifecycle.js";

export function registerPracticeHandlers(): void {
	configurePracticeEventBroadcaster(payload => {
		getIPCBridge()?.sendToRenderer(IPC_CHANNELS.PRACTICE_EVENT, payload);
	});
}
