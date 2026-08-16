import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	CoreBuildPromptContextOptions,
	CoreBuildPromptOptions,
	CoreBuildPromptResult,
	CorePromptActiveProject,
	CorePromptKnownProjects,
	CorePromptRequestMessage,
	PromptSection,
} from "@onething/core/engine";
import { collectPluginPromptContext } from "./plugin-context.js";
import {
	ONETHING_DEFAULT_SYSTEM_PROMPT,
	ONETHING_KNOWN_PROJECTS_INSTRUCTIONS,
	ONETHING_TOOL_GUIDELINES,
	ONETHING_TOOL_WORKSPACE_RULES,
} from "./system-prompt.js";

import voiceSpeakModeRaw from "./content/voice-speak-mode.md?raw";
import osDarwinRaw from "./content/os-darwin.md?raw";
import osWin32Raw from "./content/os-win32.md?raw";
import osLinuxRaw from "./content/os-linux.md?raw";
import contextUpdateConventionRaw from "./content/context-update-convention.md?raw";
import contextVariablesIntroRaw from "./content/context-variables-intro.md?raw";
import todoRulesRaw from "./content/todo-rules.md?raw";
import selfEvolutionRaw from "./content/self-evolution.md?raw";

const normalizeContent = (s: string) => s.replace(/\n+$/, "");

const CONTEXT_UPDATE_CONVENTION = normalizeContent(contextUpdateConventionRaw);
const CONTEXT_VARIABLES_INTRO = normalizeContent(contextVariablesIntroRaw);
const TODO_RULES = normalizeContent(todoRulesRaw);

/**
 * 一份项目纪律文件最多带多少进 system prompt。
 *
 * 2026-08-11 由 32KB 提到 64KB:本仓自己的 `CLAUDE.md` 是 41.7KB,32KB 的口径下
 * 它**每一轮都被截掉后 1/4**,而截掉的正是靠后的目录结构与关键系统两节 —— 用
 * onething 开发 onething 时,模型看不见自己代码库的地图。截断本身保留(一份没有
 * 上限的注入迟早会把上下文吃光),但从此在日志里说出来。
 */
export const AGENTS_MAX_BYTES = 64 * 1024;

/**
 * 项目纪律文件的候选名,**按优先级**,同一层目录里取先命中的一份。
 *
 * - `AGENTS.override.md` 最高:名字里就写着「覆盖」,它存在的唯一理由是压过同层
 *   的默认那份;
 * - `AGENTS.md` 次之:这是本产品自己的约定名,也是跨工具的通用名;
 * - `CLAUDE.md` 垫底:它是 Claude Code 的约定名。放在最后不是因为它次要,而是
 *   因为两份同时存在时,`AGENTS.md` 是「写给任何 agent 的」而 `CLAUDE.md` 是
 *   「写给某一个 agent 的」——通用的那份该赢。绝大多数仓库只有其中一份,这条
 *   次序在那里不产生任何差别;它只在两份并存时才被用到。
 *
 * 不做合并:两份并存的仓库里,它们几乎总是同一份内容的两个副本,合并等于把同样
 * 的话对模型说两遍。
 */
const PROJECT_INSTRUCTION_FILENAMES = [
	"AGENTS.override.md",
	"AGENTS.md",
	"CLAUDE.md",
] as const;

export interface OnethingPromptAgent {
	name: string;
	systemPrompt?: string;
}

export interface OnethingPromptHostAdapters {
	getAgent?(agentId: string | undefined): OnethingPromptAgent | undefined;
	getHomeDir?(): string;
	getPlatform?(): NodeJS.Platform | string;
	getMacOSAutomationDocsPath?(): string | undefined;
	getTodoPlanDirectory?(): string | undefined;
}

export interface BuildOnethingPromptContextOptions
	extends CoreBuildPromptContextOptions {
	host?: OnethingPromptHostAdapters;
}

export interface BuildOnethingPromptOptions extends CoreBuildPromptOptions {
	host?: OnethingPromptHostAdapters;
}

export type OnethingPromptRequestMessage = CorePromptRequestMessage;
export type BuildOnethingPromptResult = CoreBuildPromptResult;

export async function buildOnethingSystemPrompt(
	ctx: BuildOnethingPromptContextOptions,
): Promise<{ system: string; developer: string[] }> {
	return buildRuntimeSystemPrompt(coreOptions(ctx));
}

export async function buildOnethingPrompt(
	options: BuildOnethingPromptOptions,
): Promise<BuildOnethingPromptResult> {
	return buildRuntimePrompt({
		...coreOptions(options),
		providerId: options.providerId,
		historyMessages: options.historyMessages,
		separateDeveloperMessages:
			options.separateDeveloperMessages ?? options.providerId === "codex",
	});
}

function coreOptions(
	ctx: BuildOnethingPromptContextOptions,
): CoreBuildPromptContextOptions {
	const { host, ...core } = ctx;
	const agent = host?.getAgent?.(ctx.agentId);

	return {
		...core,
		agentName: ctx.agentName ?? agent?.name,
		agentSystemPrompt: ctx.agentSystemPrompt ?? agent?.systemPrompt,
		baseSystemPrompt: ctx.baseSystemPrompt ?? ONETHING_DEFAULT_SYSTEM_PROMPT,
		toolGuidelines: ctx.toolGuidelines ?? ONETHING_TOOL_GUIDELINES,
		toolWorkspaceRules: ctx.toolWorkspaceRules ?? ONETHING_TOOL_WORKSPACE_RULES,
		knownProjectsInstructions:
			ctx.knownProjectsInstructions ?? ONETHING_KNOWN_PROJECTS_INSTRUCTIONS,
		homeDir: ctx.homeDir ?? host?.getHomeDir?.() ?? os.homedir(),
		platform: ctx.platform ?? host?.getPlatform?.() ?? process.platform,
		macOSAutomationDocsPath:
			ctx.macOSAutomationDocsPath ?? host?.getMacOSAutomationDocsPath?.(),
		todoPlanDirectory:
			ctx.todoPlanDirectory ?? host?.getTodoPlanDirectory?.(),
	};
}

async function buildRuntimeSystemPrompt(
	ctx: CoreBuildPromptContextOptions,
): Promise<{ system: string; developer: string[]; sections: PromptSection[] }> {
	const plugins = await collectPlugins(ctx);
	const agentSystemPrompt = ctx.agentSystemPrompt?.trim();
	const disabled = new Set(ctx.disabledSections ?? []);

	const sections: Array<[string, string | false | 0 | null | undefined]> = [
		[
			"agent",
			agentSystemPrompt &&
				agentPrompt(ctx.agentName || "Agent", agentSystemPrompt),
		],
		["voice", (ctx.speakMode ?? ctx.voiceConversation) && VOICE_SPEAK_MODE],
		["runtime-context", runtimeContext(ctx)],
		// Constant bytes (cache-safe): documents the <context-update> channel
		// so the model knows the latest block supersedes earlier ones.
		["context-update-convention", CONTEXT_UPDATE_CONVENTION],
		["workdir", ctx.workingDirectory && workdir(ctx)],
		[
			"active-project",
			ctx.activeProject?.hasActive && activeProject(ctx.activeProject),
		],
		["known-projects", ctx.knownProjects?.hasAny && knownProjects(ctx)],
		["skills", skills_(ctx)],
		["os", os_(ctx)],
		[
			"todo",
			ctx.hasTools && ctx.todoPlanDirectory
				? todo(ctx, ctx.todoPlanDirectory)
				: undefined,
		],
		["agents-md", loadAgentsMdInstructions(ctx.workingDirectory)],
		// 常量字节(cache-safe):这一段只指路,**不装任何变量值** —— 状态走
		// `<context-update>` 尾部块,其余的靠 keys/get 读(§R.4)。变量因此永远
		// 不再打穿 system 前缀。有没有这一段只取决于 `variable` 工具在不在
		// (readonly 工具档没有它,那时这句话会是假的)。
		[
			"context-variables",
			Boolean(ctx.hasTools && ctx.toolNames?.includes("variable")) &&
				`<context-variables>\n${CONTEXT_VARIABLES_INTRO}\n</context-variables>`,
		],
		// 常量字节(cache-safe):自进化说明只在 `feature_mount` 工具在场时注入
		// (readonly / 无 bash 的宿主拿不到这组工具,那时这段话会是假的)。只写事实:
		// feature 是什么、在哪、契约、流程与当前边界(后端 only)。没有这一段时,模型
		// 不知道应用能被它运行时扩展,会去翻源码目录找 feature —— 真机首验撞到的正是这个。
		[
			"self-evolution",
			Boolean(ctx.hasTools && ctx.toolNames?.includes("feature_mount")) &&
				`<self-evolution>\n${SELF_EVOLUTION}\n</self-evolution>`,
		],
	];
	for (const plugin of plugins) sections.push(["plugins", plugin]);

	const systemContent = core(ctx);
	const activeSections = sections.filter(([name]) => !disabled.has(name));
	const developer = compact(activeSections.map(([, content]) => content));

	// Build named sections: system + each non-falsy developer section; plugins merged
	const namedSections: PromptSection[] = [
		{ name: "system", content: systemContent },
	];
	const pluginContents: string[] = [];
	for (const [name, content] of activeSections) {
		if (typeof content !== "string" || !content) continue;
		if (name === "plugins") {
			pluginContents.push(content);
		} else {
			namedSections.push({ name, content });
		}
	}
	if (pluginContents.length > 0) {
		namedSections.push({
			name: "plugins",
			content: pluginContents.join("\n\n"),
		});
	}

	return { system: systemContent, developer, sections: namedSections };
}

async function buildRuntimePrompt(
	options: CoreBuildPromptOptions,
): Promise<CoreBuildPromptResult> {
	const { system, developer, sections } =
		await buildRuntimeSystemPrompt(options);
	const systemPrompt = [system, ...developer].filter(Boolean).join("\n\n");

	if (options.separateDeveloperMessages) {
		return {
			messages: [
				{ role: "system", content: system },
				...developer.map((content) => ({
					role: "developer" as const,
					content,
				})),
				...options.historyMessages,
			],
			systemPrompt,
			sections,
		};
	}

	return {
		messages: [
			{ role: "system", content: systemPrompt },
			...options.historyMessages,
		],
		systemPrompt,
		sections,
	};
}

function core(ctx: CoreBuildPromptContextOptions): string {
	const baseSystemPrompt =
		ctx.baseSystemPrompt?.trim() ||
		"You are an AI assistant. Help users by reading context, using available tools, and producing clear, useful answers.";
	const guidelines = ctx.toolGuidelines ?? [];

	return [
		baseSystemPrompt,
		...(guidelines.length
			? ["", "Tool Guidelines:", ...guidelines.map((item) => `- ${item}`)]
			: []),
		"",
		`Current date: ${formatDate(ctx.now)}`,
	].join("\n");
}

function agentPrompt(name: string, systemPrompt: string): string {
	return `# Agent: ${name}\n\n${systemPrompt.trim()}`;
}

const VOICE_SPEAK_MODE = normalizeContent(voiceSpeakModeRaw);
const SELF_EVOLUTION = normalizeContent(selfEvolutionRaw);

function workdir(ctx: CoreBuildPromptContextOptions): string {
	const homeDir = ctx.homeDir || os.homedir();
	const lines = [
		"# Work Directory",
		`Current work directory: ${displayPath(ctx.workingDirectory, homeDir) ?? ctx.workingDirectory} (${ctx.workingDirectory})`,
	];
	const roots = displayRoots(ctx.workingDirectoryRoots, homeDir);
	if (roots.length > 0) {
		lines.push("Additional work directories:");
		for (const root of roots)
			lines.push(`- ${root.displayPath} (${root.path})`);
	}
	const rules = ctx.toolWorkspaceRules ?? [];
	if (ctx.hasTools && rules.length) {
		lines.push("", "## Tool Workspace Rules");
		lines.push(
			...rules.map((rule) => (rule.startsWith("- ") ? rule : `- ${rule}`)),
		);
	}
	return lines.join("\n");
}

// The AI todo path is derived from the session id here, in the prompt. That is
// what scopes it: a session can only name its own file, so there is no shared
// bucket for two sessions to collide in.
function todo(
	ctx: CoreBuildPromptContextOptions,
	todoDirectory: string,
): string | undefined {
	if (!ctx.sessionId) return undefined;
	const homeDir = ctx.homeDir || os.homedir();
	const aiTodo = path.join(todoDirectory, "sessions", ctx.sessionId, "ai-todo.md");
	const userNotes = path.join(todoDirectory, "user-notes");
	return [
		"# Todo",
		`Your AI todo for this session: ${displayPath(aiTodo, homeDir) ?? aiTodo}`,
		`The user's todo notes: ${displayPath(userNotes, homeDir) ?? userNotes}`,
		"",
		TODO_RULES,
	].join("\n");
}

function activeProject(project: CorePromptActiveProject): string {
	const extraRoots = (project.displayPaths ?? []).filter(
		(p) => p !== project.displayPath,
	);
	return [
		"# Active Project",
		`- path: ${project.displayPath}`,
		extraRoots.length > 0
			? `- additional roots (same project, writable): ${extraRoots.join(", ")}`
			: "",
		project.description ? `- description: ${project.description}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

function knownProjects(ctx: CoreBuildPromptContextOptions): string {
	const known = ctx.knownProjects;
	if (!known) return "";
	const lines = ["# Known Projects"];
	for (const item of (known as CorePromptKnownProjects).entries ?? []) {
		const extraRoots = (item.displayPaths ?? []).filter(
			(p) => p !== item.displayPath,
		);
		const rootsSuffix = extraRoots.length > 0 ? ` (also: ${extraRoots.join(", ")})` : "";
		lines.push(
			`- ${item.displayPath}${rootsSuffix}${item.description ? ` \u2014 ${item.description}` : ""}`,
		);
	}
	if (ctx.knownProjectsInstructions) {
		lines.push("", ctx.knownProjectsInstructions);
	}
	return lines.join("\n");
}

function skills_(ctx: CoreBuildPromptContextOptions): string | undefined {
	const hasReadTool = Boolean(ctx.hasTools && ctx.toolNames?.includes("read"));
	if (!hasReadTool || !ctx.skills.length) return undefined;
	const skills = ctx.skills
		.filter((skill) => skill.enabled !== false && !skill.disableModelInvocation)
		.slice()
		.sort((a, b) =>
			`${a.category ?? ""}/${a.name}`.localeCompare(
				`${b.category ?? ""}/${b.name}`,
			),
		);
	if (skills.length === 0) return undefined;

	const lines = [
		"# Skills",
		"The following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];
	for (const skill of skills) {
		const location = skill.path || skill.directoryPath || skill.name;
		lines.push("  <skill>");
		lines.push(`    <name>${escapeSkillXml(skill.name)}</name>`);
		lines.push(
			`    <description>${escapeSkillXml(skill.description)}</description>`,
		);
		lines.push(`    <location>${escapeSkillXml(location)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

function escapeSkillXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function os_(ctx: CoreBuildPromptContextOptions): string {
	switch (ctx.platform || process.platform) {
		case "darwin":
			return (
				normalizeContent(osDarwinRaw) +
				"\n" +
				`Detailed examples and syntax: ${ctx.macOSAutomationDocsPath || "resources/docs/macos-automation.md"}`
			);
		case "win32":
			return normalizeContent(osWin32Raw);
		default:
			return normalizeContent(osLinuxRaw);
	}
}

function safeUtf8Truncate(data: Buffer, maxBytes: number): string {
	if (data.length <= maxBytes) return data.toString("utf-8");
	// TextDecoder in streaming mode drops a trailing partial multi-byte
	// sequence instead of emitting the U+FFFD replacement character that
	// Buffer#toString('utf-8') would produce when a cut lands mid-character.
	return new TextDecoder("utf-8", { fatal: false }).decode(
		data.subarray(0, maxBytes),
		{ stream: true },
	);
}

export function loadAgentsMdInstructions(
	workingDirectory?: string,
): string | undefined {
	if (!workingDirectory) return undefined;
	const target = path.resolve(workingDirectory);
	const projectRoot = findProjectRoot(target);
	const root = isPathContained(projectRoot, target) ? projectRoot : target;
	const dirs = dirsFromRootToTarget(root, target);
	const parts: string[] = [];
	for (const dir of dirs) {
		const candidates = PROJECT_INSTRUCTION_FILENAMES.map((name) =>
			path.join(dir, name),
		);
		const selected = candidates.find(
			(file) => fs.existsSync(file) && fs.statSync(file).isFile(),
		);
		if (!selected) continue;
		const data = fs.readFileSync(selected);
		let text: string;
		if (data.length > AGENTS_MAX_BYTES) {
			// 截断以前是无声的:模型少看见几节,而没有任何一方知道少了什么。
			console.warn(
				`[prompts] project instructions truncated: ${selected} is ${data.length} bytes,`
					+ ` only the first ${AGENTS_MAX_BYTES} were injected`,
			);
			text = `${safeUtf8Truncate(data, AGENTS_MAX_BYTES)}\n\n<!-- AGENTS instructions truncated -->`;
		} else {
			text = data.toString("utf-8");
		}
		parts.push(
			`<project_instructions path="${selected}">\n${text}\n</project_instructions>`,
		);
	}
	if (parts.length === 0) return undefined;
	return [
		"<project_context>",
		"",
		"Project-specific instructions and guidelines:",
		"",
		...parts,
		"",
		"</project_context>",
	].join("\n");
}

function findProjectRoot(startDir: string): string {
	let current = path.resolve(startDir);
	try {
		const stats = fs.statSync(current);
		if (stats.isFile()) current = path.dirname(current);
	} catch {
		return current;
	}
	let cursor = current;
	while (true) {
		if (fs.existsSync(path.join(cursor, ".git"))) return cursor;
		const parent = path.dirname(cursor);
		if (parent === cursor) return current;
		cursor = parent;
	}
}

function isPathContained(root: string, target: string): boolean {
	const resolvedRoot = path.resolve(root);
	const resolvedTarget = path.resolve(target);
	const relative = path.relative(resolvedRoot, resolvedTarget);
	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	);
}

function dirsFromRootToTarget(root: string, target: string): string[] {
	const resolvedRoot = path.resolve(root);
	const resolvedTarget = path.resolve(target);
	const relative = path.relative(resolvedRoot, resolvedTarget);
	const parts = relative ? relative.split(path.sep).filter(Boolean) : [];
	const dirs = [resolvedRoot];
	let cursor = resolvedRoot;
	for (const part of parts) {
		cursor = path.join(cursor, part);
		dirs.push(cursor);
	}
	return dirs;
}

function compact(
	parts: Array<string | false | 0 | null | undefined>,
): string[] {
	return parts
		.map((part) => (typeof part === "string" ? part.trim() : ""))
		.filter(Boolean);
}

async function collectPlugins(
	ctx: CoreBuildPromptContextOptions,
): Promise<string[]> {
	const fragments = await collectPluginPromptContext({
		sessionId: ctx.sessionId,
		// F4:身份透传。ctx.agentId 是回合入口解析好的那一个,与 persona 取的是
		// 同一个字段(见 coreOptions/getAgent),所以插件看到的身份与提示词里的
		// 身份恒一致。
		agentId: ctx.agentId,
		providerId: ctx.providerId,
		model: resolvePromptModelId(ctx),
		providerConfig: ctx.providerConfig,
		settings: ctx.settings,
		hasTools: ctx.hasTools,
		skills: ctx.skills,
		workingDirectory: ctx.workingDirectory,
		workingDirectoryRoots: ctx.workingDirectoryRoots,
		activeProject: ctx.activeProject,
		knownProjects: ctx.knownProjects,
		toolNames: ctx.toolNames,
		mcpToolNames: ctx.mcpToolNames,
	});
	return fragments.map((fragment) => fragment.content);
}

function runtimeContext(
	ctx: CoreBuildPromptContextOptions,
): string | undefined {
	const providerId = ctx.providerId?.trim();
	const modelId = resolvePromptModelId(ctx);
	const lines = compact([
		providerId && `- Provider ID: ${providerId}`,
		modelId && `- Model ID: ${modelId}`,
	]);

	return lines.length ? `# Runtime Context\n${lines.join("\n")}` : undefined;
}

function resolvePromptModelId(
	ctx: CoreBuildPromptContextOptions,
): string | undefined {
	if (ctx.model?.trim()) return ctx.model.trim();
	const providerModel = ctx.providerConfig?.model;
	return typeof providerModel === "string" && providerModel.trim()
		? providerModel.trim()
		: undefined;
}

function displayPath(
	input: string | undefined,
	homeDir: string,
): string | undefined {
	if (!input) return undefined;
	return input.startsWith(homeDir) ? input.replace(homeDir, "~") : input;
}

function displayRoots(
	roots: string[] | undefined,
	homeDir: string,
): Array<{ path: string; displayPath: string }> {
	return (roots ?? []).map((root) => ({
		path: root,
		displayPath: displayPath(root, homeDir) ?? root,
	}));
}

function formatDate(date = new Date()): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}
