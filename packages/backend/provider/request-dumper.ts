export type AgentProviderRequestDumpValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| bigint
	| object
	| AgentProviderRequestDumpValue[]
	| { [key: string]: AgentProviderRequestDumpValue };

export interface AgentProviderRequestDump {
	providerId: string;
	model: string;
	/** `codex-http` is Codex's Responses-API shape; everything else is `stream`. */
	mode: "stream" | "codex-http";
	metadata?: Record<string, AgentProviderRequestDumpValue>;
	requestBody: AgentProviderRequestDumpValue;
}

/**
 * Writes the outgoing request body to disk for diagnostics and resolves to the
 * dump path. Every agent-loop provider takes one so a failing turn can be
 * replayed from the exact bytes that went over the wire.
 */
export type AgentProviderRequestDumper = (
	request: AgentProviderRequestDump,
) => Promise<string | undefined>;
