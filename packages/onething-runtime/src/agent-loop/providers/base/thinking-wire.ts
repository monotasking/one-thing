/**
 * `ThinkingWire` —— 一种思考线型的**编码 / 解码 / 回传**三件事在一个对象里
 * (设计稿 §3)。
 *
 * 实现按账本的 `OnethingReasoningWire` 值建表 —— Dialect **不持有线型**
 * (§2.7):某个模型走哪条线由 `ModelProfile.reasoningWire` 说了算,方言只
 * 声明「我这家可能出现哪几条」。
 */
import type { AgentMessage } from "@onething/core/agent-loop";
import type { OnethingReasoningWire } from "../../../providers/model-capability.js";
import type { RequestBodyBuilder } from "./request-body-builder.js";
import type { TurnContext } from "./turn-context.js";

export interface ThinkingWire {
	readonly id: OnethingReasoningWire | string;
	/** 把回合的思考意图写进请求体。发不出去就 `turn.warn()`,不静默。 */
	encode(turn: TurnContext, builder: RequestBodyBuilder): void;
	/** 从流块里认出思考增量。认不出返回 undefined。 */
	decode?(chunk: unknown): { reasoningDelta?: string } | undefined;
	/** 多轮回传:这条线型要求把思维链原样送回去时,产出它的线上形状。 */
	replay?(message: AgentMessage, turn: TurnContext): unknown;
}

/** 不发任何思考参数 —— 账本说 `'none'`,或者方言压根没登记线型时的兜底。 */
export class NoThinkingWire implements ThinkingWire {
	readonly id = "none";
	encode(): void {}
}

export const noThinkingWire: ThinkingWire = new NoThinkingWire();

export class ThinkingWireRegistry {
	private readonly wires = new Map<string, ThinkingWire>();

	register(wire: ThinkingWire): this {
		this.wires.set(wire.id, wire);
		return this;
	}

	get(id: string | undefined): ThinkingWire | undefined {
		return id === undefined ? undefined : this.wires.get(id);
	}

	/** 取不到就是接线漏了 —— 与其静默不发思考参数,不如当场说清楚。 */
	require(id: string): ThinkingWire {
		const wire = this.wires.get(id);
		if (!wire) throw new Error(`Unknown thinking wire: ${id}`);
		return wire;
	}

	list(): ThinkingWire[] {
		return [...this.wires.values()];
	}
}

/** 进程级的一张表。方言从这里取自己那几条,而不是各自 new 一份。 */
export const thinkingWires = new ThinkingWireRegistry();
