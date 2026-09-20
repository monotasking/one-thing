import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	corePromptToolSurface,
	type CoreBuildPromptContextOptions,
	type CoreBuildPromptOptions,
	type CoreBuildPromptResult,
	type CorePromptActiveProject,
	type CorePromptFragment,
	type CorePromptKnownProjects,
	type CorePromptRequestMessage,
} from "@onething/core/engine";
import {
	PromptComposer,
	StaticPromptSource,
	type ComposedPrompt,
	type PromptSource,
} from "./composer.js";
import { renderReferenceGuide } from "../references/index.js";
import { promptFragments } from "./fragments.js";
import { PluginPromptContextSource } from "./plugin-context.js";
import {
	ONETHING_DEFAULT_SYSTEM_PROMPT,
	ONETHING_KNOWN_PROJECTS_INSTRUCTIONS,
} from "./system-prompt.js";

import { getLogger } from '../logging/index.js'

const log = getLogger('engine.prompt')

export {
	PROMPT_BLOCK_TOOL_GUIDELINES,
	PROMPT_BLOCK_TOOL_WORKSPACE_RULES,
} from "./composer.js";

import voiceSpeakModeRaw from "./content/voice-speak-mode.md?raw";
import osDarwinRaw from "./content/os-darwin.md?raw";
import osWin32Raw from "./content/os-win32.md?raw";
import osLinuxRaw from "./content/os-linux.md?raw";
import contextUpdateConventionRaw from "./content/context-update-convention.md?raw";
import referencesRaw from "./content/references.md?raw";
import todoRulesRaw from "./content/todo-rules.md?raw";

const normalizeContent = (s: string) => s.replace(/\n+$/, "");

const CONTEXT_UPDATE_CONVENTION = normalizeContent(contextUpdateConventionRaw);
const REFERENCES = normalizeContent(referencesRaw);
const TODO_RULES = normalizeContent(todoRulesRaw);

/**
 * File tools that resolve relative paths against the work directory. Their
 * shared workspace rule is rendered from whichever of them are on the surface —
 * a sentence naming a tool that is not there would be a lie.
 */
const WORKDIR_FILE_TOOL_IDS = ["read", "edit", "write", "bash"] as const;

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
	composer: PromptComposer = defaultOnethingPromptComposer,
): Promise<ComposedPrompt> {
	return composer.compose(resolveOnethingPromptContext(ctx));
}

export async function buildOnethingPrompt(
	options: BuildOnethingPromptOptions,
	composer: PromptComposer = defaultOnethingPromptComposer,
): Promise<BuildOnethingPromptResult> {
	return composer.build({
		...resolveOnethingPromptContext(options),
		providerId: options.providerId,
		historyMessages: options.historyMessages,
		separateDeveloperMessages:
			options.separateDeveloperMessages ?? options.providerId === "codex",
	});
}

/**
 * Fill the product defaults and consult the host adapters — persona lookup,
 * home dir, platform, docs path, todo directory. Pure: hosts call it before
 * handing the context to their own composer.
 */
export function resolveOnethingPromptContext(
	ctx: BuildOnethingPromptContextOptions,
): CoreBuildPromptContextOptions {
	const { host, ...core } = ctx;
	const agent = host?.getAgent?.(ctx.agentId);

	return {
		...core,
		agentName: ctx.agentName ?? agent?.name,
		agentSystemPrompt: ctx.agentSystemPrompt ?? agent?.systemPrompt,
		baseSystemPrompt: ctx.baseSystemPrompt ?? ONETHING_DEFAULT_SYSTEM_PROMPT,
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

/**
 * The builtin fragment table — the product's own sections, in their historical
 * order (100-steps so a contributor can slot between two of them). Tool and
 * plugin fragments are appended by the composer; nothing here knows about a
 * specific tool except through `requiresTools`, the same gate every other
 * contributor uses.
 */
export const BUILTIN_PROMPT_FRAGMENTS: readonly CorePromptFragment[] = [
	{
		id: "agent",
		slot: "section",
		source: "builtin",
		order: 100,
		content: (ctx) => {
			const agentSystemPrompt = ctx.agentSystemPrompt?.trim();
			return (
				agentSystemPrompt &&
				agentPrompt(ctx.agentName || "Agent", agentSystemPrompt)
			);
		},
	},
	// Whether this turn arrived by voice is a per-turn fact: on the turn channel
	// it costs one block when speak mode starts and a tombstone when it ends,
	// instead of forking the static prefix in two.
	{
		id: "voice",
		slot: "section",
		channel: "turn",
		source: "builtin",
		order: 200,
		when: (ctx) => Boolean(ctx.speakMode ?? ctx.voiceConversation),
		content: () => VOICE_SPEAK_MODE,
	},
	{
		id: "runtime-context",
		slot: "section",
		source: "builtin",
		order: 300,
		content: runtimeContext,
	},
	// Constant bytes (cache-safe): documents the <context-update> channel so the
	// model knows the latest block supersedes earlier ones. Unconditional — the
	// blocks can arrive whether or not the `variable` tool is on the surface.
	{
		id: "context-update-convention",
		slot: "section",
		source: "builtin",
		order: 400,
		content: CONTEXT_UPDATE_CONVENTION,
	},
	// Constant bytes (cache-safe): how to point at something, which is exactly
	// one way — a `<ref/>` tag.
	// docs/design/reference-tag-2026-09.md §2.2: the hand-written preamble is
	// the general rule; the type table under it is rendered from the
	// reference-type registry, so neither this table nor the composer names a
	// reference type.
	{
		id: "references",
		slot: "section",
		source: "builtin",
		order: 450,
		content: () => renderReferenceGuide(REFERENCES),
	},
	// There is no `# Work Directory` section any more: the path is a session
	// fact and the `workdir` variable already carries it (with its extra roots)
	// on the board — the section was the same truth stated twice, which is why
	// the variable formatter used to skip it. The composer renders the
	// `workspace-rules` bullets as a standalone static section in its place
	// (id `tool-workspace-rules`, the same name `disabledSections` always used).
	{
		id: "workdir-file-tools",
		slot: "workspace-rules",
		source: "builtin",
		order: 100,
		requiresAnyTools: WORKDIR_FILE_TOOL_IDS,
		content: (ctx) => {
			const surface = corePromptToolSurface(ctx);
			const present = WORKDIR_FILE_TOOL_IDS.filter((id) => surface.has(id));
			return `${joinNames(present)} ${present.length === 1 ? "uses" : "use"} the current work directory by default.`;
		},
	},
	{
		id: "active-project",
		slot: "section",
		channel: "turn",
		source: "builtin",
		order: 600,
		when: (ctx) => Boolean(ctx.activeProject?.hasActive),
		content: (ctx) => activeProject(ctx.activeProject!),
	},
	{
		id: "known-projects",
		slot: "section",
		channel: "turn",
		source: "builtin",
		order: 700,
		when: (ctx) => Boolean(ctx.knownProjects?.hasAny),
		content: knownProjects,
	},
	// Skills are loaded with `read`; without it the list is unreachable.
	{
		id: "skills",
		slot: "section",
		channel: "turn",
		source: "builtin",
		order: 800,
		requiresTools: ["read"],
		content: skills_,
	},
	{
		id: "os",
		slot: "section",
		source: "builtin",
		order: 900,
		content: os_,
	},
	// The todo surface is operated with the file tools; without any of them the
	// instructions cannot be followed.
	{
		id: "todo",
		slot: "section",
		channel: "turn",
		source: "builtin",
		order: 1000,
		requiresAnyTools: ["read", "edit", "write"],
		when: (ctx) => Boolean(ctx.todoPlanDirectory),
		content: (ctx) => todo(ctx, ctx.todoPlanDirectory!),
	},
	{
		id: "agents-md",
		slot: "section",
		channel: "turn",
		source: "builtin",
		order: 1100,
		content: (ctx) => loadAgentsMdInstructions(ctx.workingDirectory),
	},
];

/** The builtin table as a source. */
export const builtinPromptSource: PromptSource = new StaticPromptSource(
	"builtin",
	BUILTIN_PROMPT_FRAGMENTS,
);

/**
 * The default composer: builtin sections + runtime-registered fragments +
 * plugin providers (without host health callbacks). It has **no tool source**
 * — hosts with a tool registry build their own (`app/engine/prompt/`), and
 * tests add a `StaticPromptSource`. Kept for callers that only need the
 * product prompt (`backend.ts` prompt version, evals, unit tests).
 */
export const defaultOnethingPromptComposer: PromptComposer = new PromptComposer([
	builtinPromptSource,
	promptFragments,
	new PluginPromptContextSource(),
]);

function agentPrompt(name: string, systemPrompt: string): string {
	return `# Agent: ${name}\n\n${systemPrompt.trim()}`;
}

const VOICE_SPEAK_MODE = normalizeContent(voiceSpeakModeRaw);

function joinNames(names: readonly string[]): string {
	if (names.length <= 1) return names.join("");
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
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
	if (!ctx.skills?.length) return undefined;
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
			log.warn("project instructions truncated", {
				file: selected,
				bytes: data.length,
				injectedBytes: AGENTS_MAX_BYTES,
			});
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
