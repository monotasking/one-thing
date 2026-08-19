import {
	promptFragmentsFromToolContribution,
	type CoreToolPromptContribution,
} from "@onething/core/engine";
import {
	EDIT_TOOL_PROMPT,
	VARIABLE_TOOL_PROMPT,
	WRITE_TOOL_PROMPT,
} from "../../../toolkit/index.js";
import { defaultOnethingPromptComposer } from "../../builder.js";
import { PromptComposer, StaticPromptSource } from "../../composer.js";

/**
 * The prompt declarations of the builtin tools that carry one, keyed by tool
 * id — the same objects the tools register with, so a test that names a tool
 * gets exactly the paragraph the desktop would.
 */
export const BUILTIN_TOOL_PROMPTS: Readonly<Record<string, CoreToolPromptContribution>> = {
	edit: EDIT_TOOL_PROMPT,
	write: WRITE_TOOL_PROMPT,
	variable: VARIABLE_TOOL_PROMPT,
};

/**
 * A `tools` source carrying every builtin tool prompt. Each fragment requires
 * its own tool, so one static source serves every scene: the composer keeps
 * exactly the ones whose tool is on `ctx.toolNames` — the same gate the
 * desktop's registry-backed source relies on.
 */
export const builtinToolPromptSource = new StaticPromptSource(
	"tools",
	Object.entries(BUILTIN_TOOL_PROMPTS)
		.sort(([a], [b]) => a.localeCompare(b))
		.flatMap(([id, prompt]) => promptFragmentsFromToolContribution(id, prompt)),
);

/** The default composer plus the builtin tool prompts — what the desktop sends, minus MCP/plugins. */
export const testPromptComposer: PromptComposer =
	defaultOnethingPromptComposer.with(builtinToolPromptSource);
