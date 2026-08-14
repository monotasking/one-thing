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

/**
 * Who is asking — the second argument of `dispatchRpc`, **not a field of
 * `RpcRequest`** (主线 T 批 3).
 *
 * This is the whole security design of the generic channel. The envelope
 * crosses the wire and is therefore attacker-controlled on a networked host;
 * the context never does. It is minted by the shell adapter *after* that
 * shell's own authentication ran — `@main` mints `{ transport: 'ipc' }`
 * unconditionally (desktop is the user's own machine), `apps/server` mints it
 * from the already-authenticated `RuntimeRequestContext`. A client that puts a
 * `context` key in its JSON body is simply ignored: there is no such field to
 * put it in.
 *
 * 批 1 的「不可迁清单」第 2 类（`markdown` / `permission-grants` / `files` /
 * `project-dirs` / `spaces`）成因就是这个信封原本不带 context —— 域一迁走,
 * server 侧那些 owner-scoped / sandbox-scoped 的护栏就没有输入了。
 */
export interface RpcDispatchContext {
	/** Which shell adapter minted this context. */
	transport: "ipc" | "http";
	/**
	 * Authenticated owner id. Undefined on desktop (single local user; a
	 * handler that needs an owner label uses its own local default).
	 */
	ownerUid?: string;
	/** Authenticated workspace id. Undefined on desktop, same reason. */
	workspaceId?: string;
	/**
	 * Absolute path this request's filesystem reach must stay inside.
	 *
	 * Undefined means "unconfined" and is only legal together with
	 * `transport: 'ipc'` — an `'http'` context without a sandbox root is a
	 * host wiring bug, and the app-layer guard denies rather than falls back
	 * to unconfined (fail-closed; see `resolveRpcSandbox`).
	 */
	sandboxRoot?: string;
}

/**
 * The desktop/in-process context. Exported as a constant so the one place that
 * grants unconfined filesystem reach is greppable, and so tests and the
 * `@main` adapter cannot drift apart on what "desktop" means.
 */
export const DESKTOP_RPC_CONTEXT: RpcDispatchContext = Object.freeze({
	transport: "ipc",
});

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
