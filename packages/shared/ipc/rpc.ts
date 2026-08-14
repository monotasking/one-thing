/**
 * Generic RPC envelope — one channel for every domain (主线 T0,
 * docs/design/dsh-architecture-adoption-2026-08.md §3).
 *
 * The shells (Electron `@main`, preload, apps/server, renderer platform) each
 * carry ONE adapter over this envelope. Adding a domain is a router file plus a
 * backend handler registration — no shell file changes, no new channel
 * constant, no new HTTP route.
 *
 * The response is an explicit result union rather than a rejected promise so
 * that both transports serialize failures identically: Electron's IPC rejection
 * mangles error objects into `Error invoking remote method …` strings, and HTTP
 * has no rejection at all. Every shell hands back the same `{ ok:false, error }`
 * shape and the renderer client is the single place that turns it into a throw.
 */

export interface RpcRequest {
	/** Router domain name (`Router.domain`). */
	domain: string;
	/** Method name; must be one of `Router.methods`. */
	method: string;
	/** The route's input, as-is. Must survive structured clone / JSON. */
	payload: unknown;
}

export interface RpcError {
	message: string;
	code?: string;
}

export type RpcResponse =
	| { ok: true; data: unknown }
	| { ok: false; error: RpcError };

/**
 * Failure codes the dispatcher itself produces. Handler failures carry no code
 * (the message is the handler's own) — a code here always means the request
 * never reached a handler.
 */
export const RPC_ERROR_CODES = {
	/** No handlers registered for `request.domain`. */
	UNKNOWN_DOMAIN: "UNKNOWN_DOMAIN",
	/** Domain exists but `request.method` is not one of its router methods. */
	UNKNOWN_METHOD: "UNKNOWN_METHOD",
	/** The envelope itself was malformed (missing/non-string domain or method). */
	BAD_REQUEST: "BAD_REQUEST",
} as const;

export type RpcErrorCode =
	(typeof RPC_ERROR_CODES)[keyof typeof RPC_ERROR_CODES];
