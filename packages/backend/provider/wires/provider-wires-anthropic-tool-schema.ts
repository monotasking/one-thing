/**
 * Anthropic 的 `input_schema` 顶层不收 `oneOf` / `anyOf` / `allOf`(400:
 * `input_schema does not support oneOf, allOf, or anyOf at the top level`),而资源工具
 * (`resource/resource-schema.ts`,一个 scheme 一只工具)与 `resources` 元工具的入参
 * 恰好是顶层 `oneOf` 可辨识联合。这里在线上把顶层联合摊成一个对象 schema:
 *
 * - `oneOf` / `anyOf`:各支的属性取并集,`required` 取交集;同名属性各支写法不同时,
 *   全是 `const` 的并成 `enum`(判别字段 `op` / `read` 就是这样),其余写成属性级 `anyOf`
 *   (嵌套的 `anyOf` Anthropic 是收的)。各支的说明与必填项写进顶层 `description`,
 *   模型照样知道「恰好选一支」。
 * - `allOf`:属性并集,`required` 并集。
 *
 * 只改线上形状,不改契约:工具执行前的校验仍按原 schema 判,传错一支照旧拿到精确的错。
 */
import type { AgentJsonObject, AgentJsonValue } from "@onething/backend/agent-loop";
import { isJsonObject } from "@shared/json.js";

const COMBINATORS = ["oneOf", "anyOf", "allOf"] as const;

function stringsOf(value: AgentJsonValue | undefined): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function mergePropertySchemas(variants: AgentJsonObject[]): AgentJsonObject {
	const distinct = new Map<string, AgentJsonObject>();
	for (const variant of variants) distinct.set(JSON.stringify(variant), variant);
	const unique = [...distinct.values()];
	if (unique.length === 1) return unique[0];
	const allConst = unique.every((variant) => variant.const !== undefined);
	const type = unique[0].type;
	if (allConst && unique.every((variant) => variant.type === type)) {
		const merged: AgentJsonObject = { enum: unique.map((variant) => variant.const as AgentJsonValue) };
		if (type !== undefined) merged.type = type;
		return merged;
	}
	return { anyOf: unique };
}

function branchSummary(branch: AgentJsonObject, index: number): string {
	const label = typeof branch.description === "string" ? branch.description : `Shape ${index + 1}`;
	const required = stringsOf(branch.required);
	const properties = isJsonObject(branch.properties) ? branch.properties : {};
	const consts = Object.entries(properties)
		.filter(([, value]) => isJsonObject(value) && value.const !== undefined)
		.map(([key, value]) => `${key}=${JSON.stringify((value as AgentJsonObject).const)}`);
	const parts = [...consts, ...required.filter((key) => !consts.some((c) => c.startsWith(`${key}=`)))];
	return parts.length ? `- ${label} (${parts.join(", ")})` : `- ${label}`;
}

/** 顶层没有联合的 schema 原样返回(同一个对象)。 */
export function toAnthropicInputSchema(schema: AgentJsonObject): AgentJsonObject {
	const combinator = COMBINATORS.find((key) => Array.isArray(schema[key]));
	if (!combinator) return schema;

	const branches = (schema[combinator] as AgentJsonValue[]).filter(isJsonObject);
	const { [combinator]: _dropped, ...rest } = schema;
	const ownProperties = isJsonObject(rest.properties) ? rest.properties : {};

	const variantsByKey = new Map<string, AgentJsonObject[]>();
	for (const [key, value] of Object.entries(ownProperties)) {
		if (isJsonObject(value)) variantsByKey.set(key, [value]);
	}
	for (const branch of branches) {
		if (!isJsonObject(branch.properties)) continue;
		for (const [key, value] of Object.entries(branch.properties)) {
			if (!isJsonObject(value)) continue;
			const list = variantsByKey.get(key) ?? [];
			list.push(value);
			variantsByKey.set(key, list);
		}
	}
	const properties: AgentJsonObject = {};
	for (const [key, variants] of variantsByKey) properties[key] = mergePropertySchemas(variants);

	const branchRequired = branches.map((branch) => stringsOf(branch.required));
	const required = new Set(stringsOf(rest.required));
	if (combinator === "allOf") {
		for (const list of branchRequired) for (const key of list) required.add(key);
	} else if (branchRequired.length > 0) {
		for (const key of branchRequired[0]) {
			if (branchRequired.every((list) => list.includes(key))) required.add(key);
		}
	}

	const flattened: AgentJsonObject = { ...rest, type: "object", properties };
	if (required.size > 0) flattened.required = [...required];
	else delete flattened.required;
	if (combinator !== "allOf" && branches.length > 0) {
		const head = typeof rest.description === "string" ? `${rest.description}\n\n` : "";
		flattened.description =
			`${head}Pass exactly one of these shapes:\n` +
			branches.map((branch, index) => branchSummary(branch, index)).join("\n");
	}
	return flattened;
}
