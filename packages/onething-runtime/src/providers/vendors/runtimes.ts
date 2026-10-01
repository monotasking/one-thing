/**
 * 内置服务商的**行为**名册:每家一行(`docs/design/architecture-direction-2026-10.md` §3)。
 *
 * 数据那一半(manifest)的名册是 `manifests.ts`(纯,壳也 import);这一半带方言与运行时
 * 工厂,只在后端进程里加载。
 *
 *  - import 本文件 = 各家方言登记进 `registerDialect`(方言模块定义即登记),各家思考参数
 *    登记进 `thinkingWires`(下面那个循环);
 *  - 运行时工厂由 `agent-loop/providers/factory.ts` 按名册接进工厂表 —— 那边持有表,
 *    这里只交名册,免得两边互相 import。
 */
import type { AgentProvider } from "@onething/core/agent-loop";
import { thinkingWires, type ModelProfileResolver, type ThinkingWire } from "../../agent-loop/providers/base/index.js";
import type {
	AgentProviderRuntimeConfig,
	CreateAgentProviderFromRuntimeOptions,
} from "../../agent-loop/providers/factory.js";
import { ZHIPU_RUNTIME } from "./zhipu/runtime.js";

/** 工厂交给各家的几件公共工具(各家不必 import 工厂)。 */
export interface VendorRuntimeKit {
	/** 这份配置下的账本型号解析器(每家 provider 都要)。 */
	profiles(config: AgentProviderRuntimeConfig): ModelProfileResolver;
}

export interface VendorRuntime {
	id: string;
	/** 这家自己的思考参数线型(`thinkingWires` 里按 id 取)。 */
	thinkingWires?: readonly ThinkingWire[];
	/** 缺席 = 这家没有专属工厂,按 manifest 的方言走通用那条路。 */
	createProvider?(
		config: AgentProviderRuntimeConfig,
		options: CreateAgentProviderFromRuntimeOptions,
		kit: VendorRuntimeKit,
	): AgentProvider | undefined;
}

export const VENDOR_RUNTIMES: readonly VendorRuntime[] = [ZHIPU_RUNTIME];

for (const vendor of VENDOR_RUNTIMES) {
	for (const wire of vendor.thinkingWires ?? []) thinkingWires.register(wire);
}
