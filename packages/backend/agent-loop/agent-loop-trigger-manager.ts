/**
 * 回合结束后跑的触发器表:进程里只有这一张(`triggerManager`)。
 *
 * 表与表里条目的形状住在内核,因为跑表的是 agent-loop 的执行器(每轮收尾时
 * `triggerManager.runPostResponse(...)`);往表里登记哪几只内置触发器是装配的事,
 * 在包根 `assemble-engine.ts` 的 `registerBuiltinTriggers`。各只触发器住在它的主人那里
 * (目标续推 → goals、目录记录 → toc、技能复盘 → skills、回合评估 → engine)。
 *
 * 这一只文件从前是 `engine/triggers/index.ts` 的前半截(2026-10 engine 归位时与登记函数分开)。
 */
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
} from "./agent-loop-triggers.js";

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
