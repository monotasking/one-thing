import os from "node:os";
import path from "node:path";
import { ensureDir } from "@onething/core/storage";

export const ONETHING_STORE_DIR_NAME = ".onething";
export const ONETHING_SESSION_DATABASE_FILENAME = "onething.sqlite";

export interface OnethingStorePathOptions {
	storePath?: string;
	envStorePath?: string;
	defaultStoreDirName?: string;
	sessionDatabaseFilename?: string;
	cwd?: string;
	resourcesPath?: string;
	isPackaged?: boolean;
}

export function onethingStorePathOptions(
	options: OnethingStorePathOptions = {},
): OnethingStorePathOptions {
	return {
		...options,
		envStorePath: options.envStorePath ?? process.env.ONETHING_STORE_PATH,
		defaultStoreDirName: options.defaultStoreDirName ?? ONETHING_STORE_DIR_NAME,
		sessionDatabaseFilename:
			options.sessionDatabaseFilename ?? ONETHING_SESSION_DATABASE_FILENAME,
	};
}

export function getOnethingStorePath(
	options: OnethingStorePathOptions = {},
): string {
	const resolved = onethingStorePathOptions(options);
	return (
		resolved.storePath ||
		resolved.envStorePath ||
		path.join(
			os.homedir(),
			resolved.defaultStoreDirName ?? ONETHING_STORE_DIR_NAME,
		)
	);
}

export function getOnethingLogDir(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingStorePath(options), "log");
}

export function getOnethingDebugDir(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingStorePath(options), "debug");
}


export function getOnethingSettingsPath(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingStorePath(options), "settings.json");
}

export function getOnethingAgentsDir(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingStorePath(options), "agents");
}

export function getOnethingAgentsPath(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingStorePath(options), "agents.json");
}

export function getOnethingVariablesPath(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingStorePath(options), "variables.json");
}

export function getOnethingPromptsPath(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingStorePath(options), "prompts.json");
}

export function getOnethingAppStatePath(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingStorePath(options), "app-state.json");
}

export function getOnethingWindowStatePath(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingStorePath(options), "window-state.json");
}

export function getOnethingSessionsDir(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingStorePath(options), "sessions");
}

export function getOnethingSessionPath(
	sessionId: string,
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingSessionsDir(options), `${sessionId}.json`);
}

export function getOnethingSessionDatabasePath(
	options: OnethingStorePathOptions = {},
): string {
	const resolved = onethingStorePathOptions(options);
	return path.join(
		getOnethingStorePath(resolved),
		resolved.sessionDatabaseFilename ?? ONETHING_SESSION_DATABASE_FILENAME,
	);
}

export function getOnethingWorkspacesDir(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingStorePath(options), "workspaces");
}

export function getOnethingWorkspacePath(
	workspaceId: string,
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingWorkspacesDir(options), `${workspaceId}.json`);
}

export function getOnethingWorkspaceAvatarsDir(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingWorkspacesDir(options), "avatars");
}

export function getOnethingWorkspaceAvatarPath(
	workspaceId: string,
	extension: string,
	options: OnethingStorePathOptions = {},
): string {
	return path.join(
		getOnethingWorkspaceAvatarsDir(options),
		`${workspaceId}.${extension}`,
	);
}

export function getOnethingUserProfileDir(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingStorePath(options), "user-profile");
}

export function getOnethingUserProfilePath(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingUserProfileDir(options), "profile.json");
}

export function getOnethingScreenshotsDir(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingStorePath(options), "screenshots");
}

export function getOnethingMediaDir(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingStorePath(options), "media");
}

export function getOnethingMediaImagesDir(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingMediaDir(options), "images");
}

export function getOnethingMediaFilesDir(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingMediaDir(options), "files");
}

export function getOnethingMediaIndexPath(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingMediaDir(options), "index.json");
}

export function getOnethingSchedulerDir(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingStorePath(options), "scheduler");
}

export function getOnethingSchedulerTasksPath(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingSchedulerDir(options), "tasks.json");
}

export function getOnethingSchedulerRunsDir(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingSchedulerDir(options), "runs");
}

export function getOnethingToolOutputsDir(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingStorePath(options), "tool-outputs");
}

/**
 * 审计账本的目录(K2a,`docs/design/atom-2026-09.md` §9 K2)。
 *
 * `<store>/audit/` 住的是**没有发起会话**的那些「做」的证词:调度、deeplink、CLI、
 * 界面上一个与当前会话无关的按钮。有会话的照旧落 `sessions/<id>/events.jsonl` ——
 * 那本账才是会话自己的账,把一次与它无关的操作记进去是在污染抄本。
 *
 * **它不是日志。** `log/` 那棵树有唯一一个管家(`LogDirJanitor` + `LOG_DIR_POLICY`,
 * 会按份数 / 天数 / 总量删归档),而这里是产品数据、append-only、谁都不许替它做
 * 保留策略 —— 与 `sessions/<id>/events.jsonl`、`usage/*.jsonl`、调度日志同一档
 * (CLAUDE.md 那句「事件账本是产品数据,不是日志,管家永远不碰」)。它落在
 * `log/` 之外正是为了让这件事**结构性**成立,而不是靠管家自觉绕开。
 */
export function getOnethingAuditDir(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingStorePath(options), "audit");
}

/** 无会话「做」的那一本(一行一条 `ToolAuditRecord`)。 */
export function getOnethingResourceAuditPath(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingAuditDir(options), "resource.jsonl");
}

export function getOnethingFileMutationsDir(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingStorePath(options), "file-mutations");
}

export function getOnethingToolOutputPath(
	filename: string,
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingToolOutputsDir(options), filename);
}

export function getOnethingMCPToolsCatalogPath(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingStorePath(options), "mcp-tools-catalog.md");
}

export function getOnethingMCPOAuthCredentialsPath(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingStorePath(options), "mcp-oauth-credentials.json");
}

export function getOnethingPluginDataDir(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingStorePath(options), "plugin-data");
}

export function getOnethingDocsDir(
	options: OnethingStorePathOptions = {},
): string {
	if (options.isPackaged && options.resourcesPath) {
		return path.join(options.resourcesPath, "docs");
	}
	return path.join(options.cwd || process.cwd(), "resources", "docs");
}

export function getOnethingMacOSAutomationDocsPath(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingDocsDir(options), "macos-automation.md");
}

export function getOnethingToolUsageDocsPath(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingDocsDir(options), "tool-usage-guide.md");
}

export function getOnethingPermissionsDir(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingStorePath(options), "permissions");
}

/**
 * 运行期瞬时文件目录:`daemon.sock` / `daemon.pid` / `backend.lock` /
 * `http.json`(A 期发现文件)都住这里。
 *
 * 从前这条路径只写在 CLI 那份 runtime-paths 助手里,发现文件要用它
 * 就得抄一遍 —— 抄第二份就意味着两边可以悄悄漂开。提到这里做唯一定义。
 */
export function getOnethingRunDir(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingStorePath(options), "run");
}

/** 宠物系统的目录:`<store>/pets/<id>/ledger.jsonl` 与 `current.json` 住这里。 */
export function getOnethingPetsDir(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingStorePath(options), "pets");
}

export function getOnethingEvalsDir(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingStorePath(options), "evals");
}

export function getOnethingEvalsOnlineDir(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingEvalsDir(options), "online");
}

export function getOnethingEvalsOnlineRecordsPath(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingEvalsOnlineDir(options), "records.jsonl");
}

export function getOnethingEvalsFixturesAutoDir(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingEvalsDir(options), "fixtures", "auto");
}

export function getOnethingEvalsIncidentsDir(
	options: OnethingStorePathOptions = {},
): string {
	return path.join(getOnethingEvalsDir(options), "incidents");
}

export function getOnethingStoreDirs(
	options: OnethingStorePathOptions = {},
): string[] {
	return [
		getOnethingStorePath(options),
		getOnethingLogDir(options),
		getOnethingAgentsDir(options),
		getOnethingSessionsDir(options),
		getOnethingWorkspacesDir(options),
		getOnethingWorkspaceAvatarsDir(options),
		getOnethingUserProfileDir(options),
		getOnethingScreenshotsDir(options),
		getOnethingMediaDir(options),
		getOnethingMediaImagesDir(options),
		getOnethingMediaFilesDir(options),
		getOnethingSchedulerDir(options),
		getOnethingSchedulerRunsDir(options),
		getOnethingToolOutputsDir(options),
		getOnethingFileMutationsDir(options),
		getOnethingPermissionsDir(options),
		getOnethingPluginDataDir(options),
		getOnethingEvalsDir(options),
		getOnethingEvalsOnlineDir(options),
		getOnethingEvalsFixturesAutoDir(options),
		getOnethingEvalsIncidentsDir(options),
	];
}

export function ensureOnethingStoreDirs(
	options: OnethingStorePathOptions = {},
): void {
	for (const dir of getOnethingStoreDirs(options)) {
		ensureDir(dir);
	}
}
