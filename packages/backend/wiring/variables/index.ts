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
import { getEventBus } from "../../events/index.js";
import { getProjectsStore } from "../project-dirs/index.js";
import { resolveSessionSpaceId } from "../../stores/sessions.js";
import * as appStore from "../../store.js";
import { enforcePermissionPolicy } from "../tools/core/permission-policy.js";
import { getVariableRegistry } from "@onething/runtime/variables/registry";
import { registerStandardVariableProviders } from "@onething/runtime/variables/bootstrap";
import { getVariablesStore } from "@onething/runtime/variables/store-bound";
import type { SetInput, VariableProvider } from "@onething/runtime/variables";
import { createChannelSessionGuard } from "@onething/runtime/variables/channel-guard";
import {
	noteVaultsGateway,
	globalStoreGateway,
	sessionStoreGateway,
	workdirGateway,
	goalVariableGateway,
	musicRadioGateway,
	agentStoreGateway,
	agentSelfGateway,
	projectStoreGateway,
	resourceStateVariableGateway,
} from "./gateways.js";
import {
	formatStateVariablesForPrompt,
	type FormatOptions,
} from "@onething/runtime/variables/format";
import type { ContextVariable } from "@onething/runtime/variables";

import { createVariableSnapshotBridge } from './snapshot-bridge.js'
import { getLogger } from '../logging/index.js'
import type { CoreProviderAdapters } from '@onething/runtime/variables/providers/core'

const log = getLogger('variables')


let bootstrapped = false;
let unsubscribeBridge: (() => Promise<void>) | null = null;

/**
 * A3(方案 §2.5,(b) 类闩):注册返回 disposer,由 `assembleSteps` 的 `own()`
 * 接住。
 *
 * 这个闩必须能放回去,而且**只能**跟 disposer 一起放回去:`VariableRegistry.register`
 * 撞 id 是 `throw new VariableError('PROVIDER_CONFLICT')`(registry.ts:50),
 * 所以"闩放回去但 provider 没摘"这条路上第二次装配是**抛错**而不是重复注册。
 * disposer 走 `registry.reset()` —— 它一次清掉 providers / listeners /
 * externalUnsubs / writeChains 四样,正是这里装进去的那四样。
 */
export function bootstrapVariableSystem(): () => Promise<void> {
	if (bootstrapped) return async () => {};
	bootstrapped = true;

	// Persistence layer comes online first — providers read from it.
	getVariablesStore().initialize();

	const registry = getVariableRegistry();
	const corePort: CoreProviderAdapters = {
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
	};
	registerStandardVariableProviders(registry, {
		workdir: workdirGateway,
		// 只读派生变量 `note_vaults`(P1)。晚绑定:它在每次 list() 里现取 registry,
		// 因为这一行跑在 `bootstrapNotes` 之前(backend.ts :830 vs :838)。
		noteVaults: noteVaultsGateway,
		globalStore: globalStoreGateway,
		sessionStore: sessionStoreGateway,
		goal: goalVariableGateway,
		musicRadio: musicRadioGateway,
		agentSelf: agentSelfGateway,
		// K4-a:资源自述的 `state` 投影成只读 state 变量。gateway **晚绑定** ——
		// 这一行跑在资源内核装配**之前**(`backend.ts` 里 :806 vs :852),所以它
		// 读内核是在每次 `list()` 里读的,不是在这里抓一次句柄。
		resourceState: resourceStateVariableGateway,
		agentStore: agentStoreGateway,
		projectStore: projectStoreGateway,
		core: corePort,
	});

	// Bridge registry change events to the EventBus so the renderer
	// refreshes via the existing session:variables-updated channel.
	let bus: ReturnType<typeof getEventBus> | undefined
	try { bus = getEventBus() } catch { /* Pre-bootstrap tests have no event bus. */ }
	const stopBridge = createVariableSnapshotBridge(registry, bus,
		() => appStore.getSessionCacheStats().cachedSessionIds,
		error => log.error('variables snapshot refresh failed', {}, error))

	log.info("variables subsystem bootstrapped");

	const dispose = async () => {
		await stopBridge();
		if (unsubscribeBridge !== dispose) return
		unsubscribeBridge = null;
		// providers / listeners / 外部变更订阅一并清掉 —— 下一次装配从空表开始。
		registry.reset();
		bootstrapped = false;
		log.info("variables subsystem shut down");
	};
	unsubscribeBridge = dispose
	return dispose
}

/**
 * Tear down the subsystem. Used in tests; the runtime app does not
 * normally need this since the process exits on shutdown.
 */
export async function shutdownVariableSystem(): Promise<void> {
	if (unsubscribeBridge) { await unsubscribeBridge(); return }
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

// Channel-session trust guard — see runtime/variables/channel-guard.ts for the rules.
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
	notifySessionVariablesChanged,
	notifyWorkdirChanged,
} from "./gateways.js";
export { getVariablesStore } from "@onething/runtime/variables/store-bound";
