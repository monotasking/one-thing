/**
 * Public entry for the variable subsystem (scalar variables only).
 *
 * Bootstrap:
 *  1. Initialize the variables store (loads variables.json).
 *  2. Register the three built-in providers.
 *  3. Bridge registry change events onto the EventBus as
 *     `session:variables-updated` for the renderer.
 *
 * Project directories live in their own module — see
 * `src/main/project-dirs/`. Bootstrap order in `src/main/index.ts`
 * runs both modules' bootstraps separately; they have no boot-time
 * coupling.
 *
 * Idempotent — `bootstrapVariableSystem` can be called multiple times
 * but only takes effect once. Tests bypass this and use registry
 * directly with isolated providers.
 */

import path from "node:path";
import { getEventBus } from "../events/index.js";
import { getProjectsStore } from "../project-dirs/index.js";
import { resolveSessionSpaceId } from "../stores/sessions.js";
import * as appStore from "../store.js";
import { enforcePermissionPolicy } from "../tools/core/permission-policy.js";
import { getVariableRegistry } from "@onething/runtime/variables/registry";
import { registerStandardVariableProviders } from "@onething/runtime/variables/bootstrap";
import { getVariablesStore } from "./store/index.js";
import type { SetInput, VariableProvider } from "@onething/runtime/variables";
import { createChannelSessionGuard } from "./channel-guard.js";
import {
	notesGateway,
	globalStoreGateway,
	sessionStoreGateway,
	workdirGateway,
	goalVariableGateway,
	musicRadioGateway,
	agentStoreGateway,
	agentSelfGateway,
	projectStoreGateway,
} from "./gateways.js";
import {
	formatStateVariablesForPrompt,
	type FormatOptions,
} from "@onething/runtime/variables/format";
import type { ContextVariable } from "@onething/runtime/variables";

import { SESSION_EVENT_TYPES } from "@shared/events/index.js";
import { getLogger } from '../logging/index.js'

const log = getLogger('variables')


let bootstrapped = false;
let unsubscribeBridge: (() => void) | null = null;

export function bootstrapVariableSystem(): void {
	if (bootstrapped) return;
	bootstrapped = true;

	// Persistence layer comes online first — providers read from it.
	getVariablesStore().initialize();

	const registry = getVariableRegistry();
	registerStandardVariableProviders(registry, {
		workdir: workdirGateway,
		notes: notesGateway,
		globalStore: globalStoreGateway,
		sessionStore: sessionStoreGateway,
		goal: goalVariableGateway,
		musicRadio: musicRadioGateway,
		agentSelf: agentSelfGateway,
		agentStore: agentStoreGateway,
		projectStore: projectStoreGateway,
		core: {
			enforcePermission: enforcePermissionPolicy,
			// Registered project directories are user-blessed: switching the
			// workdir into one (or a subdirectory) never prompts.
			//
			// 批 B4:名册 per-space,所以判据只认**这条会话归属的**那一份名册。
			// 调用链上有会话语境(CoreProvider.enforceSetPermission 手里就有
			// ctx.sessionId),所以取的是真值而不是保守回退;真要没有 sessionId,
			// `resolveSessionSpaceId` 给的是 default —— 更严,绝不做全空间并集
			// (那等于让任一空间的名册替所有空间免审批)。
			isPreauthorizedDirectory: (dir, ctx) => {
				try {
					const target = path.resolve(dir);
					return getProjectsStore(resolveSessionSpaceId(ctx?.sessionId))
						.list()
						.some((project) =>
							project.paths.some((projectRoot) => {
								const root = path.resolve(projectRoot);
								return target === root || target.startsWith(root + path.sep);
							}),
						);
				} catch {
					return false;
				}
			},
		},
	});

	// Bridge registry change events to the EventBus so the renderer
	// refreshes via the existing session:variables-updated channel.
	unsubscribeBridge = registry.subscribe((ctx, snapshot) => {
		if (ctx.sessionId) {
			emitVariablesSnapshot(ctx.sessionId, snapshot);
			return;
		}
		// Broadcast (empty sessionId): a shared-scope write (global/agent/
		// project) or an external variables.json change. The affected variables
		// are visible from other sessions whose panels would otherwise go
		// stale, so re-snapshot every recently-active (LRU-cached) session.
		// Coalesced per tick — a write emits its own session snapshot AND a
		// broadcast back-to-back.
		scheduleBroadcastRefresh(registry);
	});

	log.info("variables subsystem bootstrapped");
}

function emitVariablesSnapshot(
	sessionId: string,
	snapshot: ContextVariable[],
): void {
	const workdirVariable = snapshot.find((v) => v.name === "workdir");
	const workdir = workdirVariable?.value || undefined;
	const workdirRoots = workdirVariable?.values?.slice(workdir ? 1 : 0);
	try {
		getEventBus()
			.emit(sessionId, {
				type: SESSION_EVENT_TYPES.SESSION_VARIABLES_UPDATED,
				workingDirectory: workdir,
				workingDirectoryRoots: workdirRoots,
				variables: snapshot,
			})
			.catch((err) => log.error("variables snapshot emit failed", { sessionId }, err));
	} catch {
		// EventBus not initialized (test or pre-bootstrap path) — ignore.
	}
}

let broadcastRefreshScheduled = false;

function scheduleBroadcastRefresh(
	registry: ReturnType<typeof getVariableRegistry>,
): void {
	if (broadcastRefreshScheduled) return;
	broadcastRefreshScheduled = true;
	queueMicrotask(() => {
		broadcastRefreshScheduled = false;
		let sessionIds: string[];
		try {
			sessionIds = appStore.getSessionCacheStats().cachedSessionIds;
		} catch {
			return;
		}
		for (const sessionId of sessionIds) {
			registry
				.list({ sessionId })
				.then((snapshot) => emitVariablesSnapshot(sessionId, snapshot))
				.catch((err) =>
					log.error(
						"broadcast refresh failed",
						{ sessionId },
						err,
					),
				);
		}
	});
}

/**
 * Tear down the subsystem. Used in tests; the runtime app does not
 * normally need this since the process exits on shutdown.
 */
export function shutdownVariableSystem(): void {
	if (unsubscribeBridge) {
		unsubscribeBridge();
		unsubscribeBridge = null;
	}
	getVariableRegistry().reset();
	bootstrapped = false;
}

// ── Helpers used by call sites ──────────────────────

export async function listContextVariables(
	sessionId: string,
): Promise<ContextVariable[]> {
	return channelGuard.filterVariablesForSession(
		sessionId,
		await getVariableRegistry().list({ sessionId }),
	);
}

// Channel-session trust guard — see ./channel-guard.ts for the rules.
const channelGuard = createChannelSessionGuard((sessionId) =>
	appStore.getSession(sessionId),
);

/**
 * Registry facade for the `variable` tool: enforces the channel-session
 * trust guard on top of the raw registry. The raw registry stays available
 * for host-internal callers (IPC inspector, prompt build funnels through
 * listContextVariables above).
 */
export function getGuardedVariableRegistryForTools(): Pick<
	VariableRegistryLike,
	"list" | "set" | "append" | "remove" | "delete"
> {
	const registry = getVariableRegistry();
	// Unscoped writes follow the variable to the store that already holds it
	// (see VariableRegistry.resolveStoreClaimant). For an external session
	// that redirect could land on a shared scope the guard just blocked, so
	// external unscoped writes are pinned to session scope.
	const pinScope = (sessionId: string, input: SetInput): SetInput =>
		!input.scope && channelGuard.isExternalIdentitySession(sessionId)
			? { ...input, scope: "session" }
			: input;
	return {
		list: async (ctx) =>
			channelGuard.filterVariablesForSession(
				ctx.sessionId,
				await registry.list(ctx),
			),
		set: (ctx, input) => {
			channelGuard.assertExternalWriteAllowed(
				ctx.sessionId,
				input.name,
				input.scope,
			);
			return registry.set(ctx, pinScope(ctx.sessionId, input));
		},
		append: (ctx, input) => {
			channelGuard.assertExternalWriteAllowed(
				ctx.sessionId,
				input.name,
				input.scope,
			);
			return registry.append(ctx, pinScope(ctx.sessionId, input));
		},
		remove: (ctx, input) => {
			channelGuard.assertExternalWriteAllowed(
				ctx.sessionId,
				input.name,
				input.scope,
			);
			return registry.remove(ctx, pinScope(ctx.sessionId, input));
		},
		delete: (ctx, name, scope) => {
			channelGuard.assertExternalWriteAllowed(ctx.sessionId, name, scope);
			return registry.delete(
				ctx,
				name,
				!scope && channelGuard.isExternalIdentitySession(ctx.sessionId)
					? "session"
					: scope,
			);
		},
	};
}

type VariableRegistryLike = ReturnType<typeof getVariableRegistry>;

/**
 * state 变量渲染成 `<context-update>` 尾部块的正文;非 state 变量不进请求。
 * 这是变量进入模型的唯一数据通道(§R.4)—— system prompt 那一段只剩一句常量
 * 指路,所以写变量永远不再打穿缓存前缀,也就没有"静态段变了"这种遥测对象了。
 *
 * Workdir is skipped inside the formatter itself (the prompt builder renders
 * it in its own "# Work Directory" section).
 *
 * `options` 只为调用方需要调整渲染细节时留一个口子,生产路径一律用默认值。
 */
export async function buildStateVariablesPromptText(
	sessionId: string,
	options: FormatOptions = {},
): Promise<string> {
	return formatStateVariablesForPrompt(
		await listContextVariables(sessionId),
		options,
	);
}

/**
 * Plugin entry point. External code calls this to add a custom
 * provider to the live registry. Must be called after
 * `bootstrapVariableSystem()`. Throws PROVIDER_CONFLICT on
 * duplicate IDs.
 */
export function registerVariableProvider(provider: VariableProvider): void {
	getVariableRegistry().register(provider);
}

// Re-exports for ergonomic imports at call sites.
export { getVariableRegistry } from "@onething/runtime/variables/registry";
export {
	formatStateVariablesForPrompt,
	type FormatOptions,
} from "@onething/runtime/variables/format";
export { VariableError } from "@onething/runtime/variables";
export type {
	ContextVariable,
	SetInput,
	VariableContext,
	VariableProvider,
} from "@onething/runtime/variables";
export {
	notifyNotesDirChanged,
	notifySessionVariablesChanged,
	notifyWorkdirChanged,
} from "./gateways.js";
export { getVariablesStore } from "./store/index.js";
