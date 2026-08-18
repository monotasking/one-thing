import { z } from "zod";
import type { JsonObject, JsonObjectProperty } from "@onething/core";
import type { VariableScope, VariableType } from "../../variables/types.js";
import { isCapabilityVariable } from "../../variables/types.js";
import { Tool } from "../tool.js";
import contextVariablesRaw from "./prompts/variable-context.md?raw";

/**
 * The prompt this tool brings along. It rides on the tool: on the surface →
 * injected, off it → gone (readonly tiers, room turns without it, …).
 *
 * `context-variables` is a constant paragraph (cache-safe): it only points at
 * the board — no variable value is ever rendered here; state travels in the
 * `<context-update>` tail blocks and the rest is read with keys/get (§R.4).
 * The section id is a named concept of its own (`disabledSections`, snapshots)
 * so it is spelled out instead of defaulting to the tool id.
 */
export const VARIABLE_TOOL_PROMPT = {
	workspaceRules: [
		'To change the work directory, call `variable` with action="set", name="workdir", value=<directory>.',
	],
	sections: [
		{
			id: "context-variables",
			content: `<context-variables>\n${contextVariablesRaw.replace(/\n+$/, "")}\n</context-variables>`,
		},
	],
} as const satisfies Tool.Info["prompt"];

export type VariableAction =
	| "list"
	| "get"
	| "keys"
	| "set"
	| "append"
	| "remove"
	| "delete";

/**
 * 读操作 —— 不写任何东西,因此也不该触发能力变量的审批效果。
 * (`analyze` 里少了这道门,一次 `get user_note_dir` 就会弹出"重指目录"的审批框。)
 */
const READ_ACTIONS = new Set<VariableAction>(["list", "get", "keys"]);
export type { VariableScope, VariableType };

export interface RuntimeContextVariable {
	name: string;
	value?: string;
	values?: string[];
	type?: VariableType;
	scope?: VariableScope;
	readonly?: boolean;
	state?: boolean;
	description?: string;
	updatedAt?: number;
}

export interface RuntimeVariableContext {
	sessionId: string;
	messageId?: string;
	toolCallId?: string;
}

export interface RuntimeVariableSetInput {
	name: string;
	value: string;
	scope?: VariableScope;
	type?: VariableType;
	description?: string;
	state?: boolean;
}

export interface RuntimeVariableRegistry {
	list(
		ctx: RuntimeVariableContext,
	): Promise<RuntimeContextVariable[]> | RuntimeContextVariable[];
	set(
		ctx: RuntimeVariableContext,
		input: RuntimeVariableSetInput,
	): Promise<RuntimeContextVariable> | RuntimeContextVariable;
	append(
		ctx: RuntimeVariableContext,
		input: RuntimeVariableSetInput,
	): Promise<RuntimeContextVariable> | RuntimeContextVariable;
	remove(
		ctx: RuntimeVariableContext,
		input: RuntimeVariableSetInput,
	): Promise<RuntimeContextVariable> | RuntimeContextVariable;
	delete(
		ctx: RuntimeVariableContext,
		name: string,
		scope?: VariableScope,
	): Promise<void> | void;
}

export interface VariableToolAdapters {
	getRegistry(): RuntimeVariableRegistry;
	isVariableError?(error: unknown): boolean;
}

interface VariableMetadataVariable extends JsonObject {
	name: string;
	value?: string;
	values?: string[];
	type?: VariableType;
	scope?: VariableScope;
	readonly?: boolean;
	state?: boolean;
	description?: string;
	updatedAt?: number;
}

interface VariableMetadata extends JsonObject {
	action: VariableAction;
	name?: string;
	variables: VariableMetadataVariable[];
	[key: string]: JsonObjectProperty;
}

export const VariableParameters = z.object({
	action: z
		.enum(["list", "get", "keys", "set", "append", "remove", "delete"])
		.describe(
			"list: show every variable with its value. get: one variable, value in full. keys: names only (what exists, without paying to read it). set: create or replace a value. append/remove: add or drop an element of a collection variable (or a workdir sandbox root). delete: drop the whole variable.",
		),
	name: z
		.string()
		.optional()
		.describe("Variable name (required for get/set/append/remove/delete)."),
	value: z
		.string()
		.optional()
		.describe(
			"Variable value (required for set/append/remove). Collections take compact JSON on set; append/remove take a single element (JSON, or plain text for a string element) - map append merges a JSON object, map remove takes the key. Directory variables (workdir, note dirs) take an existing directory path.",
		),
	type: z
		.enum(["string", "number", "bool", "list", "map", "set"])
		.optional()
		.describe(
			'Value type. Defaults to the existing type, else "string". number accepts decimals; list/map hold JSON; set is a list with unique elements. append on a missing variable creates it (default list).',
		),
	scope: z
		.enum(["session", "global", "agent", "project"])
		.optional()
		.describe(
			"Where the variable lives: session (default), agent (every session of the current agent), project (the active workdir's project; requires a workdir), global (all sessions). A name lives in one scope; a write without scope follows the variable to its current scope. On keys it filters the listing instead.",
		),
	description: z
		.string()
		.optional()
		.describe(
			'Short description shown next to the value in the prompt and the Context inspector. Sticky: omitted on later writes it is kept; "" clears it.',
		),
	state: z
		.boolean()
		.optional()
		.describe(
			'true: you need to know this at all times — it is delivered in full in every <context-update> block from now on. false (default): it stays on the board but out of your context; read it back with get when you need it. Sticky across writes.',
		),
});

function summarizeForMetadata(
	snapshot: RuntimeContextVariable[],
): VariableMetadata["variables"] {
	return snapshot.map((v) => ({
		name: v.name,
		value: v.value,
		values: v.values,
		type: v.type,
		scope: v.scope,
		readonly: v.readonly,
		state: v.state,
		description: v.description,
		updatedAt: v.updatedAt,
	}));
}

function formatAge(updatedAt: number, now: number): string {
	const minutes = Math.floor(Math.max(0, now - updatedAt) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

function byName(
	a: RuntimeContextVariable,
	b: RuntimeContextVariable,
): number {
	return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * `keys` 的投影:只有 name/type/scope/desc,**不带值**。
 *
 * 非 state 变量一个字节都不进请求,能不能被找回来全靠这一步:它让模型知道
 * 「有什么可读」而不必付出读全量的代价。按名字排序:一份供人照抄的清单,
 * 字典序比 provider 优先级好找。
 */
function renderKeysForOutput(
	snapshot: RuntimeContextVariable[],
	scope?: VariableScope,
): string {
	const rows = snapshot
		.filter((v) => !scope || (v.scope ?? "session") === scope)
		.sort(byName);
	if (rows.length === 0) {
		return scope
			? `No variables in ${scope} scope.`
			: "No context variables are set.";
	}
	return rows
		.map((v) => {
			const flags = `${v.type && v.type !== "string" ? ` [${v.type}]` : ""}${v.scope ? ` [${v.scope}]` : ""}${v.readonly ? " [readonly]" : ""}${v.state ? " [state]" : ""}`;
			return `${v.name}${flags}${v.description ? ` - ${v.description}` : ""}`;
		})
		.join("\n");
}

function renderForOutput(
	snapshot: RuntimeContextVariable[],
	now: number = Date.now(),
): string {
	if (snapshot.length === 0) return "No context variables are set.";
	return snapshot
		.map((v) => {
			// Age makes stale state visible so the model can update or clean it
			// up. Tool output is never part of the cached prompt prefix, so a
			// live relative time is safe here (unlike in the prompt sections).
			const age = v.updatedAt ? ` [updated ${formatAge(v.updatedAt, now)}]` : "";
			const flags = `${v.type && v.type !== "string" ? ` [${v.type}]` : ""}${v.scope ? ` [${v.scope}]` : ""}${v.readonly ? " [readonly]" : ""}${v.state ? " [state]" : ""}${age}`;
			const desc = v.description ? ` - ${v.description}` : "";
			if (v.values && v.values.length > 0) {
				return `${v.name} = ${v.value || "(empty)"}\nvalues:\n${v.values.map((value, index) => `  [${index}] ${value}${index === 0 && v.value ? " (current)" : ""}`).join("\n")}${flags}${desc}`;
			}
			const value = v.value || "(empty)";
			return `${v.name} = ${value}${flags}${desc}`;
		})
		.join("\n");
}

/**
 * 一次 registry.list 之后按 action 投影输出。
 *
 * `get` 走全量渲染但只喂一条:**值不截断**——工具输出不进缓存前缀,所以这里
 * 可以给完整的,而 `<context-update>` 里的 state 变量给的是首行 + 512 字符。
 * 长值因此永远捞得回来。
 */
function renderOutputForAction(
	action: VariableAction,
	snapshot: RuntimeContextVariable[],
	args: { name?: string; scope?: VariableScope },
): string {
	if (action === "keys") return renderKeysForOutput(snapshot, args.scope);
	if (action === "get") {
		const name = args.name?.trim();
		if (!name) throw new Error("name is required for get");
		const found = snapshot.find((v) => v.name === name);
		// 读不到不算错:回一句能自救的话,比抛一个模型只能重试的异常有用。
		if (!found) {
			return `No variable named "${name}". Use action="keys" to see what exists.`;
		}
		return renderForOutput([found]);
	}
	return renderForOutput(snapshot);
}

function metadataTitleForAction(
	action: VariableAction,
	name: string | undefined,
): string {
	if (action === "list") return "Listed variables";
	if (action === "keys") return "Listed variable names";
	return `${action[0].toUpperCase()}${action.slice(1)} ${name ?? ""}`.trim();
}

function rethrowVariableError(
	err: Error | object | string | number | boolean | null | undefined,
	adapters: VariableToolAdapters,
): never {
	if (adapters.isVariableError?.(err) && err instanceof Error) {
		const code =
			"code" in err && typeof err.code === "string" ? err.code : undefined;
		const e = new Error(code ? `[${code}] ${err.message}` : err.message);
		e.name = err.name;
		throw e;
	}
	throw err;
}

export function createVariableTool(
	adapters: VariableToolAdapters,
): Tool.Info<typeof VariableParameters, VariableMetadata> {
	return Tool.define<typeof VariableParameters, VariableMetadata>("variable", {
		name: "Variable",
		description: `Read and manage context variables — the session's board of named runtime facts and kept settings.

The board is context to read, not a place to park your own working state: write only when the user asks for something to be kept or changed, or when operating a lever the board owns (e.g. workdir) — never for progress, findings or intermediate results. System variables (workdir, note dirs, background_jobs, git_branch, ...) explain themselves via their description in list output.

state=true puts a variable in front of you (it arrives in full in every <context-update>); everything else stays on the board until you read it — keys lists names, get reads one in full. Values are typed (string, number, bool, list, map, set; collections support append/remove) with an optional description, in one of four scopes: session, agent, project, global. Custom names are non-reserved snake_case.`,
		category: "builtin",
		enabled: true,
		autoExecute: true,
		permissionGuard: "safe",
		executionMode: "sequential",
		renderKind: "text",
		prompt: VARIABLE_TOOL_PROMPT,

		parameters: VariableParameters,

		// Ordinary variables are plain entries on the session's context board and
		// stay frictionless — no effect, no prompt. A capability variable is different:
		// its value is a directory the system acts on, so repointing one is a
		// proposal the user approves, not something that happens silently.
		analyze(args) {
			const name = args.name?.trim();
			if (!name || READ_ACTIONS.has(args.action)) return { effects: [] };
			if (!isCapabilityVariable(name)) return { effects: [] };

			const value = args.value?.trim();
			const title =
				args.action === "delete"
					? `Reset ${name} to its default`
					: `Repoint ${name} to: ${value || ""}`;

			return {
				effects: [
					{
						kind: "capability_change" as const,
						resources: value ? [value] : [name],
						barrier: true,
						metadata: { variable: name, value, action: args.action },
					},
				],
				preview: { title, metadata: { variable: name, value } },
			};
		},

		async execute(args, ctx) {
			const registry = adapters.getRegistry();
			const variableCtx = {
				sessionId: ctx.sessionId,
				messageId: ctx.messageId,
				toolCallId: ctx.toolCallId,
			};
			const action: VariableAction = args.action;

			try {
				if (action === "set" || action === "append" || action === "remove") {
					if (!args.name) throw new Error(`name is required for ${action}`);
					if (args.value === undefined)
						throw new Error(`value is required for ${action}`);
					const input = {
						name: args.name,
						value: args.value,
						scope: args.scope,
						type: args.type,
						description: args.description,
						state: args.state,
					};
					if (action === "set") {
						await registry.set(variableCtx, input);
					} else if (action === "append") {
						await registry.append(variableCtx, input);
					} else if (action === "remove") {
						await registry.remove(variableCtx, input);
					}
				} else if (action === "delete") {
					if (!args.name) throw new Error("name is required for delete");
					await registry.delete(variableCtx, args.name, args.scope);
				}

				const snapshot = await registry.list(variableCtx);
				const metadataSummary = summarizeForMetadata(snapshot);
				const output = renderOutputForAction(action, snapshot, args);

				ctx.updateResult?.({
					content: [{ type: "text", text: output }],
					details: {
						phase: "ready",
						action,
						name: args.name,
						variables: metadataSummary,
					},
				});

				ctx.metadata({
					title: metadataTitleForAction(action, args.name),
					metadata: {
						action,
						name: args.name,
						variables: metadataSummary,
					},
				});

				return {
					title: READ_ACTIONS.has(action)
						? "Variables"
						: `Variable ${action}`,
					output,
					metadata: {
						action,
						name: args.name,
						variables: metadataSummary,
					},
				};
			} catch (err) {
				const caught =
					err instanceof Error || (err && typeof err === "object")
						? err
						: String(err);
				rethrowVariableError(caught, adapters);
			}
		},
	});
}
