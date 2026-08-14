import { createReadTool } from "@onething/runtime/tools";
import { getConnectedDirectoriesForSession } from "../../stores/connected-directories.js";
import { getSettings } from "../../stores/settings.js";
import { getDefaultReadRoots } from "../core/sandbox.js";

export const ReadTool = createReadTool({
	getDefaultWorkingDirectory: () =>
		getSettings().tools?.bash?.defaultWorkingDirectory,
	/**
	 * 读根里的接入目录按**会话归属的 space** 解析(批 B2)。走 adaptersOverride
	 * 而不是改 `configureAppToolSandbox` 的全局适配器:那份适配器服务的是**没有
	 * 会话语境**的调用面(checkFileAccess 等),它退回全局层是对的。
	 */
	getDefaultReadRoots: (sessionId) =>
		getDefaultReadRoots({
			getConnectedDirectories: () =>
				getConnectedDirectoriesForSession(sessionId),
		}),
});
