/**
 * Settings Module
 * Application settings type definitions for IPC communication
 */

import type { AISettings, EffectiveAISettings } from "./providers.js";
import type { ToolSettings } from "./tools.js";
import type { MCPSettings } from "./mcp.js";
import type { ACPSettings } from "./acp.js";
import type { SkillSettings } from "./skills.js";
import type { TodoPlanSettings } from "./todo-plan.js";
import type { VoiceSettings } from "./voice.js";
import type { MusicSettings } from "./music.js";

export type ColorTheme =
	| "blue"
	| "purple"
	| "green"
	| "orange"
	| "pink"
	| "cyan"
	| "red";

// Message list density mode
export type MessageListDensity = "compact" | "comfortable" | "spacious";

// Global typography density mode
export type TypographyDensity = "compact" | "comfortable";

/**
 * 输入区宽度档位。
 *
 * 四档映射到**输入区自己的量尺** `--chat-composer-measure`(ChatPanel):
 *  - `narrow` = 34rem;
 *  - `standard`(缺省)= 内容列量尺,即改造前的行为 —— **现状值不在这里
 *    再抄一份**,它就是 `--chat-content-width`;
 *  - `wide` = 56rem(既有的 `--content-measure-wide`);
 *  - `full` = 100%,由 `--chat-measure-cap` 收口(撑满内容列)。
 *
 * 四档之上永远还有 cap 一道钳:窄窗下不管选哪档都不会顶破面板。
 */
export type ComposerWidth = "narrow" | "standard" | "wide" | "full";

// Base theme controls the overall look (backgrounds, text colors, etc.)
export type BaseTheme =
	| "obsidian"
	| "ocean"
	| "forest"
	| "rose"
	| "ember" // Original themes
	| "nord"
	| "dracula"
	| "tokyo"
	| "catppuccin"
	| "gruvbox"
	| "onedark"
	| "github"
	| "rosepine"; // New themes

// Keyboard shortcut configuration
export interface KeyboardShortcut {
	key: string; // Main key (e.g., 'Enter', 'n', '/')
	ctrlKey?: boolean;
	metaKey?: boolean; // Cmd on Mac
	shiftKey?: boolean;
	altKey?: boolean;
	sequence?: "double-shift";
}

export interface ShortcutSettings {
	sendMessage: KeyboardShortcut; // Send message
	newChat: KeyboardShortcut; // New chat
	closeChat: KeyboardShortcut; // Close current chat
	toggleSidebar: KeyboardShortcut; // Toggle sidebar
	focusInput: KeyboardShortcut; // Focus input (default /)
	searchEverywhere?: KeyboardShortcut; // Toggle Search Everywhere window
	searchOverlay?: KeyboardShortcut; // Deprecated: legacy Search Everywhere shortcut
	toggleTodoPlanWindow?: KeyboardShortcut; // Toggle standalone todo/plan window
	toggleTodoPlan?: KeyboardShortcut; // Toggle todo/plan card
}

// Quick command button configuration for InputBox toolbar
export interface QuickCommandConfig {
	commandId: string; // Command ID, e.g., 'cd', 'git', 'files'
	enabled: boolean; // Whether to show this button
}

export interface EditorSettings {
	tabSize?: number;
	lineWrapping?: boolean;
	softWrapColumn?: number;
	syntaxHighlighting?: boolean;
	completionEnabled?: boolean;
	composerMaxHeight?: number;
	markdownNoteAttachmentDirectory?: string;
	markdownProjectAttachmentDirectory?: string;
}

export interface GeneralSettings {
	animationSpeed: number; // 0.1 - 0.5 seconds, default 0.25
	sendShortcut: "enter" | "ctrl-enter" | "cmd-enter"; // Legacy, kept for compatibility
	colorTheme: ColorTheme; // Accent color theme
	baseTheme: BaseTheme; // Base theme (overall colors) - DEPRECATED, use themeId
	themeId?: string; // Theme ID - DEPRECATED, use darkThemeId/lightThemeId
	darkThemeId?: string; // Theme ID for dark mode (e.g., 'dracula', 'nord')
	lightThemeId?: string; // Theme ID for light mode (e.g., 'flexoki')
	shortcuts?: ShortcutSettings; // Custom keyboard shortcuts
	typographyDensity?: TypographyDensity; // Global typography density, default 'compact'
	composerWidth?: ComposerWidth; // Composer (input area) width gear, default 'standard' = 现状
	messageListDensity?: MessageListDensity; // Message list display density, default 'comfortable'
	messageLineHeight?: number; // Message line height, 1.2-2.2, default 1.6
	quickCommands?: QuickCommandConfig[]; // Quick command buttons shown above InputBox
	todoPlan?: TodoPlanSettings;
	editor?: EditorSettings;
	// User profile for lightweight context injection
	userProfile?: UserProfileSettings;
	/**
	 * 私聊来消息时弹系统通知(agent-dm-user.md §4.4)。缺省开。
	 *
	 * 静音面只做这一个开关:按 agent 静音已经有冻结房了,粒度更细的开关是重复造。
	 */
	dmNotifications?: boolean;
	maxTabs?: number; // Maximum open tabs per panel, 3-30, default 15
	maxFilePreviewKB?: number; // Maximum file preview size in KB, 64-1024, default 256
	/**
	 * @deprecated Migrated to `variables.json` (variables subsystem). The
	 * field is retained so that older installs can be migrated on first
	 * boot post-upgrade. New code should NOT read this; consult the
	 * variables store via `getVariablesStore().getUserNoteDir()` instead.
	 *
	 * (The sibling `aiNoteDir` was dropped with the `ai_note_dir` variable's
	 * retirement, 2026-08-12 — long-term memory lives in the memory-wiki
	 * plugin now. Old settings.json files may still carry the key; nothing
	 * reads it.)
	 */
	userNoteDir?: string;
}

// Lightweight user profile for system prompt injection (low token, high value)
/**
 * 「我」这一侧的身份(docs/design/agent-dm-user.md §2.1)。
 *
 * agent 一直有完整身份(name/avatar/avatarImage),用户没有 —— 于是模型面只能
 * 叫「用户」,dm 无从定位,UI 署名写死「我」。这三个新字段补的就是那一半。
 *
 * 存 settings 而不是 `<store>/user-profile/profile.json`:资料就是几个标量,
 * settings 已有缓存/同步/落盘全套,单开一个 json 要新的读写链路与水合时机。
 *
 * `handle` 是**称呼层的定位符**,不是 userId:消息结构仍然只有 `role:'user'`,
 * 旧会话零迁移。
 */
export interface UserProfileSettings {
	name?: string; // User's name
	handle?: string; // 句柄(@ 与 dm 的目标写法);清洗为 [a-z0-9_-]{1,24},缺省 'user'
	avatar?: string; // Emoji avatar
	avatarImage?: string; // Media library file name — wins over the emoji (与 AgentDefinition 同约定)
	timezone?: string; // Timezone (e.g., 'Asia/Shanghai')
	language?: string; // Preferred language (e.g., 'zh-CN', 'en')
	customInfo?: string; // Brief custom info (max 100 chars)
}

// Chat settings for model parameters
export interface ChatSettings {
	temperature: number; // 0-2, default 0.7
	// `maxTokens` 于 2026-09-09 退役(裁定:两个设置管一个值,只留按模型那一格)。
	// 请求侧的 max_tokens 只有两个来源:`maxOutputByModel[model]` 的覆盖,否则
	// 模型目录上限的一半;两个都缺席就不带 `max_tokens`。老设置文件里残留的
	// `chat.maxTokens` 是死数据,没人读。
	topP?: number; // Nucleus sampling, 0-1, default 1
	presencePenalty?: number; // -2 to 2, default 0
	frequencyPenalty?: number; // -2 to 2, default 0
	branchOpenInSplitScreen?: boolean; // Whether branches open in split screen, default true
	chatFontSize?: number; // Chat font size in px, 12-20, default 15
	chatFontEn?: string; // English body font registry ID (e.g., 'system-ui', 'public-sans', 'lora')
	chatFontZh?: string; // Chinese body font registry ID (e.g., 'system-cjk', 'noto-sans-sc', 'lxgw-wenkai')
	contextCompactEnabled?: boolean; // Enable automatic context compacting, default true
	contextCompactThreshold?: number; // Context usage % to trigger compacting, 50-100, default 85
	contextCompactKeepRecentTurns?: number; // Recent user/assistant turns to keep verbatim, default 6
	contextCompactChunkTimeoutSeconds?: number; // Per-chunk summary request timeout in seconds, 30-1800, default 300
	agentLoopStream?: boolean; // Legacy compatibility flag; supported providers always use the agent-loop stream runtime
	maxTurns?: number; // Max agent-loop model round-trips per chat run before finishReason 'max_turns', default 100
	goalContinuationLimit?: number; // Max automatic goal continuations per resume, default 10
	goalDefaultTokenBudget?: number; // Optional token cap for goals without an explicit budget; unset = no cap
	goalErrorRetryLimit?: number; // Consecutive failed goal runs retried with backoff before blocking, default 3
}

export interface ProxySettings {
	enabled: boolean;
	url: string;
	bypassRules?: string;
}

export interface NetworkSettings {
	proxy: ProxySettings;
}

export interface WechatChannelSettings {
	enabled: boolean;
	accounts?: Array<{
		id: string;
		label?: string;
		enabled: boolean;
	}>;
}

export interface ChannelSettings {
	wechat: WechatChannelSettings;
}

export interface StorageSettings {
	/** 新建会话的持久化格式;已有会话跟随其盘上格式。默认 legacy-json。 */
	sessionFormat?: "legacy-json" | "jsonl";
	/**
	 * provider 配置迁进空间层的时间戳(C1)。**缺席 = 还没迁**,装配序列会在
	 * 下一次启动时跑一次 `migrateProviderConfigToDefaultSpace`。
	 *
	 * 它是**幂等闸**,不是审计字段:手动删掉它会让迁移重跑一遍(重跑是安全的 ——
	 * 搬运只补不覆盖),这也正是回滚流程里的一步。
	 */
	providerConfigMigratedAt?: number;
	/**
	 * `settings.ai` **整体**搬进 default 空间 `providers.json` 的时间戳(C2)。
	 *
	 * 与上面那格是两段迁移,各有各的闸:C1 只搬了凭证与三格偏好,C2 把剩下的
	 * (每 provider 的 model/enabled/selectedModels/端点·档位/逐模型覆盖、默认
	 * provider、自定义 provider 定义)整体搬走。C1 版本已经跑过的机器上第一格
	 * 在、第二格不在 —— 那正是二段迁移的触发条件。
	 */
	spaceProviderSettingsMigratedAt?: number;
}

/*
 * `ShellMode` / `UISettings`(C0 的 workbench↔classic 逐像素回滚闸)已于 2026-08-05
 * 退役 —— 见 docs/design/product-two-forms-chatgpt-shell.md D2。Actor v3 大 break
 * 之后 classic 那一侧已事实上不可回滚(旧壳画不对 say/drive 语义),留着只会让房
 * 一直有两套渲染。外壳形态自此恒为 workbench,不再有开关。
 */

export interface EvalsSettings {
	repoDir?: string;
	/** Total-size cap for .context.jsonl failure snapshots (bytes, default 2MB). */
	snapshotMaxBytes?: number;
	/** Cheap model used for incident analysis / rubric judging / diagnosis. */
	analysisModel?: { providerId: string; model: string };
}

/**
 * 插件的**宿主侧**偏好(M1)。
 *
 * 与插件自己的 `config.json`(schema 由 manifest 声明、插件读得到)分得很开:
 * 这里是用户对插件行使主权的地方,插件既读不到也改不了。所以它落在 app settings
 * 而不是每插件目录 —— "谁被静音"是宿主的账,不是插件的数据。
 */
export interface PluginPreferences {
	/** 提示音总开关。关掉 = 所有插件都不出声(横幅照常显示)。 */
	notifySoundsEnabled: boolean;
	/** 被单独静音的插件 id。静音只掐声音,通知横幅不受影响。 */
	notifySoundMutedPluginIds: string[];
	/**
	 * 氛围效果总闸(G2 —— 全窗动画覆盖)。关掉 = 一键停掉所有插件的氛围层
	 * (整窗飘雪之类)。缺省开:能力不显式声明就永远没被看见过。
	 */
	ambientEnabled: boolean;
	/** 被单独关掉氛围的插件 id。关掉只撤这一层,插件其余能力照常。 */
	ambientMutedPluginIds: string[];
}

/**
 * 「诊断模式」(logging L1,拍板 E②)。**一个开关**,打开 = 全域日志降到 debug
 * + provider 请求正文转储打开;关掉 = 回到 env `ONETHING_LOG` 给的等级、转储关。
 *
 * 精细控制仍然只有 env(`ONETHING_LOG=info,engine.*=debug`)—— 设置页不长出
 * 第二套等级面板,那与「设置极简」相悖。
 */
export interface DiagnosticsSettings {
	enabled: boolean;
}

/**
 * 宠物的设置(宠物 P5,`docs/design/pet-system-2026-09.md` §12.4)。
 *
 * 只有一格:多久开口一次。三档是档位词,不是秒数(「设置极简」:调参收敛成档位);
 * 每档对应的冷却住产品层 `runtime/src/pets/chattiness.ts` 那张表,这里不写数。
 * 换哪一只宠物**不在这里**:那是 `pet:` 资源自己的状态(`<store>/pets/current.json`)。
 */
export type PetChattinessSetting = "quiet" | "balanced" | "chatty";

export const DEFAULT_PET_CHATTINESS: PetChattinessSetting = "balanced";

export interface PetSettings {
	chattiness: PetChattinessSetting;
}

/**
 * 笔记库的设置(`docs/design/notes-obsidian-cli-2026-09.md` §3.3,R6)。
 *
 * **全局,不 per-space**:笔记库是这台机器的东西,不是某个空间的。要 per-space
 * 是另一单。
 *
 * 每个库一行开关,`enabled` 管的是**全部**(检索、附件、技能根、AI 可读范围 ——
 * R9 拍定一个开关管全部,不拆四个);`skills` 单独一格,因为「把这个库当技能根
 * 加载」是一件比「AI 能读它」重得多的事。
 */
export interface NotesSettings {
	/**
	 * 每种笔记系统一行总开关,键 = 驱动 id(`obsidian` / `folder` / …)。
	 *
	 * **这里是一张表,不是一格 `obsidian`**(2026-09-18 陌生能力演练打回的那一处):
	 * 写成 `obsidian: { enabled }` 的话,加一种笔记系统就要改这个契约文件 ——
	 * 那正是「按能力枚举」。表的键由驱动自述,契约层一个笔记系统的名字都不认识。
	 *
	 * 缺席 = 开着。关掉某一行 = 那个系统整个退场,一条命令都不发。
	 */
	systems: Record<string, NoteSystemPreference>;
	/** 键 = 库 id(Obsidian 是 `obsidian.json` 的键)。缺席 = `{enabled:true, skills:false}`。 */
	vaults: Record<string, NoteVaultPreference>;
	/** 「今天的日记」「新建笔记」的缺省落点。指着一个已经不在册的库时按第一个算。 */
	primaryVaultId?: string;
	/** 非 Obsidian 的笔记目录(绝对路径)。归一同 `normalizeConnectedDirectories`。 */
	folders: string[];
	/** 只管 `folders` 里那些库;Obsidian 的日记格式由它自己的 daily-notes 插件说了算。 */
	dailyFormat: string;
	/**
	 * `folders` 里那些库的附件目录。P3 把 `editor.markdownNoteAttachmentDirectory`
	 * 并进来;本单两格并存。
	 */
	attachmentDirectory?: string;
	/** 一次性播种迁移的标记(P1)。有值 = 已播种,不再重跑。 */
	migratedAt?: number;
}

export interface NoteSystemPreference {
	enabled?: boolean;
}

export interface NoteVaultPreference {
	enabled?: boolean;
	skills?: boolean;
}

/**
 * 检索的设置(S7,`docs/design/search-index-2026-09.md` §15;拍点壬 a)。
 *
 * **只有一格开关和一个模型 id** —— 「设置极简」那条:暴露必填项,技术参数走默认值。
 * 索引本身没有开关(它是账本的投影,一直在建);这里说的只是**语义召回**那一半:
 * 它要下载约 110MB 模型、冷嵌占几分钟 CPU,所以**默认关**,由用户一键打开。
 *
 * 关着的时候 Worker 连 sqlite-vec 扩展都不装,库与 S3 那时逐字一样。
 */
export interface SearchSettings {
	semantic?: SemanticSearchSettings;
}

/**
 * 缺省模型 id。**契约层记它**,因为 defaults 与设置页都要用同一个值,而 runtime 的
 * 嵌入器模块不该被契约层 import(方向反了)。真正的模型知识住
 * `runtime/src/search/embedding/transformers-onnx.ts`,那边的 `E5_SMALL_EMBEDDER_ID`
 * 与这一行必须是同一个串——一处改了另一处不改,注册表就解析不到,开关会自己关回去。
 */
export const DEFAULT_SEMANTIC_MODEL_ID = "multilingual-e5-small";

export interface SemanticSearchSettings {
	/** 默认 false(拍点壬 a)。打开才下载模型、才开始嵌。 */
	enabled: boolean;
	/**
	 * 嵌入器注册表里的 id(§15.3)。**是数据不是枚举**:换运行时 = 注册一条新的、
	 * 把这一格换个值。缺省 `multilingual-e5-small`。
	 */
	modelId: string;
}

/**
 * 内置浏览器的设置(B2′,`apps/desktop-react/docs/terminal-browser-2026-09.md`
 * §2.2-5 / §9-4 / §9-13)。
 *
 * 今天**只有 CDP 那一格** —— 内嵌浏览器本身没有开关(它随桌面壳一起在),
 * 这里说的是「要不要把这台浏览器的调试口开出来,让 AI 与外部工具驱动它」。
 *
 * **缺省关**(拍点 ②,用户按推荐拍定)。理由两条,都写进了设置页那一行:
 * 开着 = 本机任何程序都能驱动一个登着账号的浏览器;而且 CDP 口一开,**壳自己的
 * 渲染页也是一个 page 目标**,它内存里有 `host:connection` 交来的 Bearer token
 * (§9-13)。
 *
 * **这一格不是主进程的读者**:`--remote-debugging-port` 只能在 app `ready` 之前
 * 加,而设置要装配之后才读得到。宿主把这一格折成 `<store>/run/cdp.json`
 * 启动旗文件(`apps/desktop-react/electron/browser/cdp-flag.ts`),下次启动才生效
 * —— 所以设置页那一行必须写明「重启生效」。
 */
export interface BrowserSettings {
	cdp: BrowserCdpSettings;
	/**
	 * **身份(profile)名册**(B3-b)。一格身份 = 一个持久分区
	 * `persist:browser-<id>` = 一套独立的 cookie / localStorage / 登录态。
	 *
	 * 名册**至少一行**(归一保证):删到空会让每一格 tab 指向一个不存在的分区。
	 * 出厂一行 `default`,名字由字典给(`browser.profileDefaultName`)——
	 * 所以这一格的 `name` 出厂是**空串**,不是一句写死的中文:名册是数据,
	 * 用户改过的名字才进这一格,没改过的那一行由 UI 用字典画。
	 */
	profiles: BrowserProfile[];
	/**
	 * 新 tab 缺省用哪一格身份。归一保证它**总是名册里某一行的 id**
	 * (指着一个已删的身份 = 每开一格 tab 都落进一个新建的空分区,
	 * 而用户以为自己还登着)。
	 */
	defaultProfile: string;
	/** 地址栏那一行输入折成 URL 时用哪家搜索引擎(id,见壳里的 `browser/omnibox.ts`)。 */
	searchEngine: string;
}

/**
 * 一格浏览器身份。**只有身份两格** —— 它跑在哪个分区、屏幕上叫什么。
 *
 * 「这个身份登了什么」不在这里:那是 Chromium 分区里的事,而那份东西的产地
 * 只有一个(浏览器自己)。名册若开始记「已登录 google」之类的格子,就是在
 * 壳里存第二份真相。
 */
export interface BrowserProfile {
	/** 分区名的后半截(`persist:browser-<id>`)。一格身份一辈子不变。 */
	id: string;
	/** 屏幕上那一行写什么。空串 = 还没起过名,由 UI 用字典画。 */
	name: string;
}

/** 出厂那一格身份的 id。**契约层记它** —— 主进程、defaults、壳三边要同一个串。 */
export const DEFAULT_BROWSER_PROFILE_ID = "default";

/**
 * 缺省调试端口。**契约层记它**,理由与 `DEFAULT_SEMANTIC_MODEL_ID` 同款:
 * defaults、设置页的复制片段、主进程的旗文件都要同一个数。
 *
 * 9333 而不是 Chrome 习惯的 9222:9222 是本机上最容易被一个真 Chrome / 一个
 * puppeteer 脚本占着的那个口,而端口被占在这条路上不会报错,只会让 chrome-mcp
 * 连上**别人的**浏览器。
 */
export const DEFAULT_BROWSER_CDP_PORT = 9333;

export interface BrowserCdpSettings {
	/** 默认 false(拍点 ②)。改了要重启 onething 才生效。 */
	enabled: boolean;
	/**
	 * 监听端口(只绑回环)。**UI 上不暴露**(「设置极简」:技术参数走默认值)——
	 * 真要换口的人是在改 `settings.json`,不是在设置页里找输入框。
	 * 归一时夹进 1..65535,`0`(随机口)不收:随机口没人发现得了。
	 */
	port: number;
}

export interface AppSettings {
	/**
	 * **生效形状**:当前空间的 provider 设置 + 全局目录缓存(C2)。
	 *
	 * 落盘时被拆成两半 —— `workspaces/<id>/providers.json`(整套 provider 设置)
	 * 与 `settings.json` 的 `ai` 段(只剩 `AISettings`:温度缺省 + 目录缓存)。
	 * 拆分点只此一处:`app/stores/settings.ts`。持久化形状见
	 * `PersistedAppSettings`。
	 */
	ai: EffectiveAISettings;
	theme: "light" | "dark" | "system";
	general: GeneralSettings;
	voice?: VoiceSettings;
	music?: MusicSettings;
	chat?: ChatSettings;
	tools: ToolSettings;
	network?: NetworkSettings;
	channels?: ChannelSettings;
	mcp?: MCPSettings;
	acp?: ACPSettings;
	skills?: SkillSettings;
	storage?: StorageSettings;
	evals?: EvalsSettings;
	plugins?: PluginPreferences;
	diagnostics?: DiagnosticsSettings;
	search?: SearchSettings;
	browser?: BrowserSettings;
	pets?: PetSettings;
	notes?: NotesSettings;
}

/**
 * `settings.json` 真正落盘的形状(C2)。与 `AppSettings` 只差 `ai` 一段:
 * per-space 的那部分已经搬进 `workspaces/<id>/providers.json`。
 *
 * 只有设置仓库(`app/stores/settings.ts`)、defaults 归一与一次性迁移认识它;
 * 其余所有消费者拿到的都是 `AppSettings`(生效形状)。
 */
export type PersistedAppSettings = Omit<AppSettings, "ai"> & { ai: AISettings };

// Settings IPC Request/Response types
export interface GetSettingsResponse {
	success: boolean;
	settings?: AppSettings;
	error?: string;
}

export interface SaveSettingsRequest extends AppSettings {}

export interface SaveSettingsResponse {
	success: boolean;
	settings?: AppSettings;
	error?: string;
}

export interface TestProxyRequest {
	proxy: ProxySettings;
}

export interface TestProxyResponse {
	success: boolean;
	error?: string;
	status?: number;
}

// ============================================================================
// Router
// ============================================================================

/**
 * settings(应用设置)域 —— 结构债 P4c 第十一批,四条数据面从手写 IPC 通道迁到
 * 通用 `rpc:invoke` / `POST /api/rpc`。
 *
 * 四条逐条对应从前 `IPC_CHANNELS` 上的 `settings:get` / `settings:save` /
 * `settings:get-system-theme` / `network:test-proxy`(旧线是
 * `apps/electron/src/settings/ipc-host.ts` 那只裸 `ipcMain.handle` 工厂 +
 * `@main/ipc/settings.ts` 的壳适配 —— 这一域从来没有 `apps/electron/src/ipc/*`
 * 那层可移植工厂)。请求/响应形状一字未改;变的只是通道。
 *
 * **两条要 Electron 本体的事**(开设置窗 / 原生对话框)不在这个 router 上,但它们
 * 也不再是手写通道了 —— 2026-08-23(P4 终态批 A1-a)起走**宿主壳路由**
 * (`shell:invoke`):开设置窗是本文件下方的 `settingsWindowRouter`,原生对话框
 * 是 `@shared/ipc/dialog.ts` 的 `dialogRouter`。
 *
 * **三条推送留在原地**(router 今天没有推送面):`SETTINGS_CHANGED` /
 * `SYSTEM_THEME_CHANGED` 改走 `backend/wiring/settings/events.ts` 的
 * `configureSettingsEventBroadcaster` 注入端口;`SETTINGS_NAVIGATE` 本来就是
 * 主进程→设置窗的单向通知,与本域无关。
 *
 * 无参的两条(`getSettings` / `getSystemTheme`)按本仓惯例递 `{}`。
 */
import { defineRouter } from "./router.js";

export type SettingsRoutes = {
    getSettings: { input: Record<string, never>; output: GetSettingsResponse };
    saveSettings: { input: SaveSettingsRequest; output: SaveSettingsResponse };
    getSystemTheme: {
        input: Record<string, never>;
        output: { success: boolean; theme?: "light" | "dark"; error?: string };
    };
    testProxy: { input: TestProxyRequest; output: TestProxyResponse };
};

export const settingsRouter = defineRouter<SettingsRoutes>("settings", [
    "getSettings",
    "saveSettings",
    "getSystemTheme",
    "testProxy",
]);

/**
 * 「开设置窗」的**宿主壳路由**(结构债 P4 终态批 A1-a,2026-08-23)。
 *
 * 它够不上 `settingsRouter`:设置窗是一个 `BrowserWindow`,处理者只能住在
 * `apps/electron`。web 那侧不是"做不到",而是**同一件事的另一种做法** ——
 * 浏览器里没有第二扇窗,于是改页内 hash 路由(逐字沿用迁移前 web.ts 里那段)。
 */
export interface OpenSettingsWindowRequest {
    /** 直接跳到某个标签页。 */
    tab?: string;
}

export interface OpenSettingsWindowResponse {
    success: boolean;
}

export type SettingsWindowRoutes = {
    open: {
        input: OpenSettingsWindowRequest;
        output: OpenSettingsWindowResponse;
    };
};

export const settingsWindowRouter = defineRouter<SettingsWindowRoutes>(
    "settings-window",
    ["open"],
);
