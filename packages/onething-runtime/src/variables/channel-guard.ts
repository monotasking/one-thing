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
 * variables (global/agent/project custom vars, note directories) reach other
 * sessions — letting an external contact write them would inject text into
 * the owner's prompts, and listing them would leak owner context.
 */

const SHARED_SCOPES = new Set<VariableScope>(["global", "agent", "project"]);

// Reserved names that write to global state even without scope="global"
// (NotesProvider claims them regardless of the declared scope).
const GLOBAL_EFFECT_NAMES = new Set(["user_note_dir", "work_note_dir"]);

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
  /** Throw FORBIDDEN when an external session writes shared-scope state. */
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

		assertExternalWriteAllowed(sessionId, name, scope) {
			if (!isExternalIdentitySession(sessionId)) return;
			if (
				!(scope && SHARED_SCOPES.has(scope)) &&
				!(name && GLOBAL_EFFECT_NAMES.has(name))
			)
				return;
			throw new VariableError(
				"FORBIDDEN",
				"Global, agent and project scoped variables are shared beyond this session and cannot be modified from a channel or API session. Use a session-scoped variable instead.",
			);
		},
	};
}
