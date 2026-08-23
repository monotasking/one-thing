/**
 * `BaseAgentProvider` —— 每个 provider 都是它的子类(设计稿 §3)。
 *
 * 它只给四样东西:身份、能力(静态 + per-model)、`runTurn`、logger。
 * 非 HTTP 的 provider(acp / external-agents)继承它而**不**继承
 * `HttpAgentProvider`,顺带保住自述能力(§2.9)。
 *
 * 实例无可写字段 —— 所有回合级的量活在 `TurnContext` 里。
 */
import { collectAgentTurnFromStream } from "@onething/core/agent-loop";
import type {
	AgentModelCapabilities,
	AgentProvider,
	AgentTurn,
	AgentTurnRequest,
	AgentTurnStreamEvent,
} from "@onething/core/agent-loop";
import type { BaseProviderContext, Logger } from "./provider-context.js";

export abstract class BaseAgentProvider implements AgentProvider {
	protected constructor(protected readonly ctx: BaseProviderContext) {}

	get id(): string {
		return this.ctx.providerId;
	}

	/**
	 * provider 自己的**传输**声明:模态、结构化工具结果、流式与否。
	 * per-model 的布尔不在这里翻 —— 那是账本的事。
	 */
	protected abstract get transportCapabilities(): AgentModelCapabilities;

	/**
	 * 静态 `capabilities` 字段 = 默认档 profile 的投影。解析器给不出默认档
	 * (没配默认模型)就退回传输声明 —— 与今天 `buildCapabilities(options)`
	 * 的口径一致。
	 */
	get capabilities(): AgentModelCapabilities {
		const base = this.transportCapabilities;
		if (this.selfDeclared) return base;
		// 没有账本解析器 = 自述能力的 provider(acp / external-agents):
		// 能力就是它自己声明的那份,一个字都不覆盖。
		const profile = this.ctx.profiles?.defaultProfile?.(this.id);
		return profile ? profile.toAgentModelCapabilities(base) : base;
	}

	/**
	 * per-model 能力 = `ModelProfile` 对传输声明的投影(P2-a 起这是**唯一**
	 * 一条路:`factory.ts` 的 `withPerModelCapabilities` 退役,四条 wire 的
	 * 常量覆盖删除)。
	 */
	async getModelCapabilities(model: string): Promise<AgentModelCapabilities> {
		const base = this.transportCapabilities;
		if (this.selfDeclared) return base;
		const profile = await this.ctx.profiles?.resolve(this.id, model);
		return profile ? profile.toAgentModelCapabilities(base) : base;
	}

	/**
	 * 自述能力的短路(旧 `createAgentProviderFromRuntime` 里那一句):账本对
	 * 一个它没见过的模型没有真话可说,猜一个正好是 `supportsTools: false` 那类
	 * bug。**读自己身上的那个可选字段**而不是声明它 —— 声明会给每个 provider
	 * 凭空长出一个 `capabilitiesAreSelfDeclared: false`。
	 */
	private get selfDeclared(): boolean {
		return (this as AgentProvider).capabilitiesAreSelfDeclared === true;
	}

	abstract streamTurn(
		request: AgentTurnRequest,
	): AsyncGenerator<AgentTurnStreamEvent, void, void>;

	runTurn(request: AgentTurnRequest): Promise<AgentTurn> {
		return collectAgentTurnFromStream(this.streamTurn(request), request.onEvent);
	}

	protected get logger(): Logger {
		return this.ctx.logger;
	}

	/** 每回合一个 child logger —— 排障时一行就能看出是哪家哪轮。 */
	protected turnLogger(request: AgentTurnRequest): Logger {
		return this.ctx.logger.child({
			provider: this.id,
			model: request.model,
			turn: request.turn,
		});
	}
}
