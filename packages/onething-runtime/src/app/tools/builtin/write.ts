import { createWriteTool } from "@onething/runtime/tools";
import { getSettings } from "../../stores/settings.js";
import { getConnectedDirectoriesForSession } from "../../stores/connected-directories.js";
import { getFileMutationsDir } from "../../stores/paths.js";

export const WriteTool = createWriteTool({
	getDefaultWorkingDirectory: () =>
		getSettings().tools?.bash?.defaultWorkingDirectory,
	getFileMutationsDir,
	// per-space:按**会话归属**取,不是当前空间(批 B2 / 设计盲点 1)。
	getConnectedDirectories: (sessionId) =>
		getConnectedDirectoriesForSession(sessionId),
});
