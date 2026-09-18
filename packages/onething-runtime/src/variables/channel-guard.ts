import {
	VariableError,
	isReservedName,
	type ContextVariable,
	type VariableScope,
} from "./index.js";

/**
 * Trust guard for variable access from externally-routed sessions.
 *
 * Sessions routed from external identities (gateway IM contacts, API callers)
 * carry originIdentityKey; desktop/voice sessions never do. Shared-scope
 * variables (global/agent/project custom vars) reach other sessions — letting
 * an external contact write them would inject text into the owner's prompts,
 * and listing them would leak owner context.
 *
 * P3(2026-09-18)删掉了 `GLOBAL_EFFECT_NAMES`——「声明的 scope 不是 global、
 * 写的却是全局状态」这一档只有 `user_note_dir` / `work_note_dir` 两个名字,而
 * 它们随笔记领域一起退役了。今天的判据回到一句话:**看 scope**。再出现这样一个
 * 名字时,把它加回来的地方是这里,不是调用方。
 */

const SHARED_SCOPES = new Set<VariableScope>(["global", "agent", "project"]);

export interface ChannelGuardSession {
	originIdentityKey?: string;
}


export function createChannelSessionGuard(
	getSession: (sessionId: string) => ChannelGuardSession | undefined,
): {
  isExternalIdentitySession(sessionId: string): boolean;
  /** Hide custom global variables from externally-routed sessions. */
  filterVariablesForSession(
  	sessionId: string,
  	variables: ContextVariable[],
  ): ContextVariable[];
  /**
   * Throw FORBIDDEN when an external session writes shared-scope state.
   *
   * `name` 今天没有读者(判据只剩 scope),但留在签名上:调用方递的就是
   * 「谁要被写」,少了它,下一个「按名字判」的规则就得改所有调用点。
   */
  assertExternalWriteAllowed(
  	sessionId: string,
  	name: string | undefined,
  	scope: VariableScope | undefined,
  ): void;
} {
	const isExternalIdentitySession = (sessionId: string): boolean =>
		Boolean(getSession(sessionId)?.originIdentityKey);

	return {
		isExternalIdentitySession,

		filterVariablesForSession(sessionId, variables) {
			if (!isExternalIdentitySession(sessionId)) return variables;
			// Custom shared-scope variables are owner context; reserved global
			// names (note dirs) stay visible because workspace plumbing relies
			// on them.
			return variables.filter(
				(variable) =>
					!(
						variable.scope &&
						SHARED_SCOPES.has(variable.scope) &&
						!isReservedName(variable.name)
					),
			);
		},

		assertExternalWriteAllowed(sessionId, _name, scope) {
			if (!isExternalIdentitySession(sessionId)) return;
			if (!(scope && SHARED_SCOPES.has(scope))) return;
			throw new VariableError(
				"FORBIDDEN",
				"Global, agent and project scoped variables are shared beyond this session and cannot be modified from a channel or API session. Use a session-scoped variable instead.",
			);
		},
	};
}
