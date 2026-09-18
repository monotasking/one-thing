import { defineRouter } from "./router.js";

/**
 * notes 域的契约(P4,`docs/design/notes-obsidian-cli-2026-09.md` §4.6)。
 *
 * ── 三条,全是**只读 + 一个前台动作** ────────────────────────────────────
 *  · `list` —— 名册的全貌。**一条 CLI 命令都不发**:它读一次 `obsidian.json`、
 *    试连一次 socket,两样都不会把 Obsidian 拉起来。
 *  · `refresh` —— 先让子系统重问一遍驱动,再答同一份。给「我刚在 Obsidian 里
 *    新建了一个库」那一下用。
 *  · `openInApp` —— **这个域里唯一允许 `mayLaunch: true` 的一条**,因为它是
 *    用户按下去的(纪律 4:后台永不拉起,前台由用户点)。
 *
 * **写面不在这里**:改一格开关走的是既有的 `settings.saveSettings`(整份写回),
 * 加一条写路等于给同一份设置开第二个产地。
 *
 * ── `systems` 是一张表,不是一格 `obsidian` ──────────────────────────────
 * 与 `settings.notes.systems` 逐字同一条判例(P1 的陌生能力演练把
 * `obsidian: { enabled }` 打回过):契约层里出现一个笔记系统的名字,就等于
 * 「加一种笔记系统要改契约」。键由驱动自述;**缺席 = 这个系统在这台机器上
 * 没有状态可说**(没装、或者这台宿主不该交出本机笔记库),壳按「没有找到」画。
 */

/** 一个**有 app 的**笔记系统此刻的状态。没有 app 的系统(目录库)不在表里。 */
export type NoteSystemState =
	| "running"
	| "not-running"
	| "cli-not-registered"
	| "not-installed";

export interface NoteSystemStatusDto {
	state: NoteSystemState;
	/**
	 * `settings.notes.systems[id].enabled` 的投影,**缺席算开**。
	 *
	 * 它与 `state` 是两件事:`state` 是「那台 app 此刻怎么样」(机器的事实,只读),
	 * `enabled` 是「用户要不要用它」(用户的决定,写得动)。放在同一行上是因为
	 * 屏幕上它们就挨着 —— 一句状态话 + 一格总开关。
	 */
	enabled: boolean;
}

/** 名册里的一个库。**含被用户关掉的那些** —— 关掉的库画得出来才关得回来。 */
export interface NoteVaultDto {
	id: string;
	name: string;
	/** 绝对路径,已归一。 */
	root: string;
	/** 驱动 id。只给 UI / 日志看,壳不许按它分叉出第二套行为。 */
	system: string;
	/**
	 * 此刻在它自己的 app 里开着吗。
	 * 没有「开 / 不开」这个概念的系统(目录库)一律 `true` —— 一个文件夹永远在那儿。
	 */
	open: boolean;
	/** 来自 `settings.notes.vaults[id]`,缺席算开。 */
	enabled: boolean;
	/** 来自 `settings.notes.vaults[id]`,缺席算关。 */
	skills: boolean;
	/** 是不是 `settings.notes.primaryVaultId` 指着的那个。 */
	primary: boolean;
}

export interface NotesListResponse {
	/** 键 = 驱动 id。见文件头。 */
	systems: Record<string, NoteSystemStatusDto>;
	vaults: NoteVaultDto[];
	/** `settings.notes.folders` 原样。 */
	folders: string[];
	/**
	 * `settings.notes.dailyFormat` 原样(**空串就是空串** —— 回落到缺省是后端
	 * 那一侧的事,壳不替它编一个)。它只管 `folders` 里那些目录。
	 */
	dailyFormat: string;
}

export interface NotesOpenInAppRequest {
	vaultId: string;
	/**
	 * 库内的一份笔记(绝对路径或库相对路径)。
	 * 缺席 = 把这个库本身唤到前台。
	 */
	path?: string;
}

/**
 * `reason` 是**码不是句子**(与 `search.status.vectorErrorKind` 同一条判例,R12):
 * 后端只说发生了什么,人话由壳的字典画。
 *
 * 今天的码:`not-found`(不在名册里 / 被关掉了)、`unsupported`(这个系统没有
 * 「在 app 里打开」这件事)、`system-not-running` / `vault-not-open` /
 * `cli-not-registered` / `no-snapshot`(领域自己那四个)、`failed`(别的)。
 */
export interface NotesOpenInAppResponse {
	ok: boolean;
	reason?: string;
}

export type NotesRoutes = {
	list: { input: Record<string, never>; output: NotesListResponse };
	refresh: { input: Record<string, never>; output: NotesListResponse };
	openInApp: {
		input: NotesOpenInAppRequest;
		output: NotesOpenInAppResponse;
	};
};

export const notesRouter = defineRouter<NotesRoutes>("notes", [
	"list",
	"refresh",
	"openInApp",
]);
