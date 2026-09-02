import type {
	AppSettings,
	ChatMessage,
	ChatSession,
	ProviderConfig,
} from "@shared/ipc.js";
import {
	CoreTriggerManager,
	type CoreTrigger,
	type CoreTriggerContext,
} from "@onething/core/engine";
import { createGoalContinuationTrigger } from "./goal-continuation.js";
import { createTurnEvaluationTrigger } from "./turn-evaluation.js";
import { createSessionTocTrigger } from "./session-toc.js";

export interface TriggerContext
	extends CoreTriggerContext<
		AppSettings,
		ChatSession,
		ChatMessage,
		ProviderConfig
	> {}

export interface Trigger extends CoreTrigger<TriggerContext> {}

export class TriggerManager extends CoreTriggerManager<TriggerContext> {}

export const triggerManager = new TriggerManager();

let builtinTriggersRegistered = false;

/**
 * A3(`docs/design/backend-composition-root-2026-09.md` §2.5,(b) 类闩):注册
 * 返回 disposer,由 `assembleSteps` 的 `own()` 接住。
 *
 * 从前这个闩是单向的:`triggerManager` 是**模块级**单例,而它挂着的三只触发器
 * 里有引擎与总线的引用。装配 → dispose → 再装配时闩还是 true,于是第二份装配
 * 一只都不注册 —— 表里留着的是第一份的尸体,`runPostResponse` 会拿着已经关掉的
 * 总线跑。现在 dispose 把三只摘干净并把闩放回去,第二份装配注册的是新的三只。
 *
 * `unregister` 按 id 摘(core 的 `CoreTriggerManager.unregister`),所以摘的只有
 * 这三只 —— 别人(feature / 插件)往同一张表里注册的不受影响。
 */
export function registerBuiltinTriggers(): () => void {
	if (builtinTriggersRegistered) return () => {};
	builtinTriggersRegistered = true;
	// Skill review is intentionally not registered: createSkillReviewTrigger()
	// still exists in ./skill-review.ts — re-add the register() call to bring it
	// back.
	const triggers = [
		createGoalContinuationTrigger(),
		createTurnEvaluationTrigger(),
		createSessionTocTrigger(),
	];
	for (const trigger of triggers) triggerManager.register(trigger);
	return () => {
		for (const trigger of triggers) triggerManager.unregister(trigger.id);
		builtinTriggersRegistered = false;
	};
}
