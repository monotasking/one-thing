import { readStateFlag } from "./types.js";

import { getLogger } from '../logging/index.js'

const log = getLogger('variables')

export interface VariablesFileGlobalVariable {
	name: string;
	value: string;
	type?: "string" | "number" | "bool" | "list" | "map" | "set";
	description?: string;
	state?: boolean;
	updatedAt?: number;
}

export interface VariablesFile {
	/**
	 * P3(2026-09-18)删掉了 `user_note_dir` / `work_note_dir` 两格(`ai_note_dir`
	 * 早在 2026-08-12 就退役了)。「笔记在哪」今天是 `settings.notes` 里的库表。
	 *
	 * **没有删除迁移**:`parseVariablesFile` 是**白名单式重建** —— 它只把自己
	 * 认识的键抄进新对象,不认识的顶层键连读都不读。所以老盘上那两个键在下一次
	 * 写回 `variables.json` 时自然消失,不需要谁去剥它。
	 */
	global_variables: VariablesFileGlobalVariable[];
	/** Custom variables shared by every session of an agent, keyed by agent id. */
	agent_variables: Record<string, VariablesFileGlobalVariable[]>;
	/** Custom variables attached to a project directory, keyed by project id. */
	project_variables: Record<string, VariablesFileGlobalVariable[]>;
}

export function createDefaultVariablesFile(): VariablesFile {
	return {
		global_variables: [],
		agent_variables: {},
		project_variables: {},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const VALID_TYPE = new Set(["string", "number", "bool", "list", "map", "set"]);

function parseGlobalVariable(
	value: unknown,
): VariablesFileGlobalVariable | null {
	if (!isRecord(value)) return null;
	if (typeof value.name !== "string") return null;
	if (typeof value.value !== "string") return null;
	return {
		name: value.name,
		value: value.value,
		type:
			typeof value.type === "string" && VALID_TYPE.has(value.type)
				? (value.type as VariablesFileGlobalVariable["type"])
				: undefined,
		description:
			typeof value.description === "string" ? value.description : undefined,
		// 旧盘写的是三档 volatility —— 读到即转成 state(§R.6)。文件本身不重写:
		// 下一次写这个变量时自然按新字段落盘。
		state: readStateFlag(value),
		updatedAt:
			typeof value.updatedAt === "number" ? value.updatedAt : undefined,
	};
}

/**
 * Parse a keyed record of variable lists (agent_variables /
 * project_variables). Lenient: malformed keys or entries are dropped
 * instead of failing the whole file — these maps grow organically and a
 * single bad entry must not reset every stored variable to defaults.
 */
function parseKeyedVariables(
	value: unknown,
): Record<string, VariablesFileGlobalVariable[]> {
	if (!isRecord(value)) return {};
	const output: Record<string, VariablesFileGlobalVariable[]> = {};
	for (const [key, entries] of Object.entries(value)) {
		if (!key || !Array.isArray(entries)) continue;
		const parsed = entries
			.map(parseGlobalVariable)
			.filter((v): v is VariablesFileGlobalVariable => Boolean(v));
		if (parsed.length > 0) output[key] = parsed;
	}
	return output;
}

export function parseVariablesFile(raw: unknown): {
	data: VariablesFile;
	recovered: boolean;
} {
	if (!isRecord(raw)) {
		return { data: createDefaultVariablesFile(), recovered: true };
	}

	const globalsRaw = Array.isArray(raw.global_variables)
		? raw.global_variables
		: [];
	const globalVariables = globalsRaw.map(parseGlobalVariable);
	if (globalVariables.some((value) => !value)) {
		log.warn("persisted variables file failed schema validation, using defaults");
		return { data: createDefaultVariablesFile(), recovered: true };
	}

	const data: VariablesFile = {
		global_variables: globalVariables as VariablesFileGlobalVariable[],
		agent_variables: parseKeyedVariables(raw.agent_variables),
		project_variables: parseKeyedVariables(raw.project_variables),
	};

	return { data, recovered: false };
}
