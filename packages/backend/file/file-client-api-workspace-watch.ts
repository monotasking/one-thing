/**
 * HTTP 服务器那一侧的工作区文件监视推送(文件第二入口的一个方面,决策 D26)。
 *
 * `GET /api/files/watch/events` 那条 SSE 的货源。监视器登记簿是 `file/file-workspace-watch.ts`,
 * 按沙箱根分表 —— `watchStart` / `watchStop`(请求面,在 router 上)与这里(推送面)指的是同一张表,
 * 订阅一律落在请求者自己的沙箱根上。这条面同时拥有 RPC 的监视与 SSE 的订阅,包括装起来那一步;
 * 收尾时 `close()` 先关新登记的门,再等已有的监视停完。
 *
 * 2026-10-04 从 `http-server/http-server-runtime.ts` 原样搬来(决策 D219),代码一行没改。
 */
import {
	createWorkspaceWatchService,
	type WorkspaceFileChangedHandler,
} from "@onething/backend/file";
import { defaultRequestContext } from "@onething/backend/http-server/http-server-tenant-paths.js";
import { workspaceSandboxRoot } from "@onething/backend/http-server/http-server-sandbox.js";
import type { RuntimeFilesAdapter } from "@onething/backend/http-server/http-server-runtime-facade.js";

/** 返回门面的 `files` 一格与收尾用的 `close()`。 */
export function createServerWorkspaceWatches(ports: { workspaceRoot: string }) {
	const { workspaceRoot } = ports;
	// This surface owns both RPC watches and SSE subscriptions, including setup.
	const workspaceWatches = createWorkspaceWatchService();
	const filesPort: RuntimeFilesAdapter = {
		startWorkspaceWatch: (scope, root) => workspaceWatches.start(scope, root),
		stopWorkspaceWatch: (scope, root) => workspaceWatches.stop(scope, root),
		subscribeWorkspaceFileChanged: (
			handler,
			context = defaultRequestContext(),
		) =>
			workspaceWatches.subscribe(
				workspaceSandboxRoot(workspaceRoot, context),
				handler as WorkspaceFileChangedHandler,
			),
	};
	return { port: filesPort, close: () => workspaceWatches.close() };
}
