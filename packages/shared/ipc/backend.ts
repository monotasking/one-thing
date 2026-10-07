/**
 * `backend` RPC 域的契约:后端进程自己的生命周期(第④步批 3,`docs/design/two-process-2026-10.md` §2.4 第 4 条)。
 *
 * 今天只有一条:`shutdown` —— 请这台后端进程收尾退出,与给它发一次 SIGTERM 是同一条路(会话落盘、发现文件删掉)。
 * `onething backend stop` 用它停「CLI 自己拉起的那台」;只给本机信任的来访者(与 `memory.trim` 同一档),
 * 而且只在真的是一只独立后端进程时才答应(进程内嵌的后端答「这台不归这条命令停」)。
 * 实现见 `@onething/backend/lifecycle` 的 `lifecycle-client-api.ts`。
 */
import { defineRouter } from "./router.js";

export interface BackendShutdownResponse {
	/** 收下了:这台进程马上开始收尾。 */
	accepted: true;
	/** 收尾的是哪个进程(调用方据此等它退出)。 */
	pid: number;
}

export type BackendRoutes = {
	/** 请这台后端进程退出。仅限本机可信的调用方。 */
	shutdown: { input: Record<string, never>; output: BackendShutdownResponse };
};

export const backendRouter = defineRouter<BackendRoutes>("backend", ["shutdown"]);
