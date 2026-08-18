import type {
	AgentContentPart,
	AgentMessage,
	AgentMessageContent,
} from "@onething/core/agent-loop";

/**
 * 相邻同角色消息合并 —— **传输层的适配**,不是历史的改写。
 *
 * 起因(C5,2026-08-14):压缩摘要的注入从「一条 user + 一条伪造的 assistant
 * 握手」改成只有一条 user。历史里不再有模型从没说过的话,代价是注入之后紧跟
 * 的最近一轮真 user 消息会与它相邻 —— 而部分 provider 严格要求 user/assistant
 * 交替(DeepSeek 系,deepseek-reasoner 尤甚),连续两条 user 直接 400。
 *
 * 修法归传输层:谁的方言不接受相邻同角色,谁在自己的适配层把它们合成一条。
 * 历史层不为了迁就某一家 provider 而保留伪造消息。
 *
 * 三条守则:
 *  - 只合并 user / assistant 两种角色。system 与 tool 各有自己的位置语义
 *    (tool 消息按 tool_call_id 配对,合并会直接毁掉工具协议)。
 *  - 任何一侧带 toolCalls / toolCallId / providerData / reasoningContent 的
 *    都不合并 —— 那些字段是逐消息的协议载荷,一合并就没法还原到哪一条。
 *  - 内容形态守恒:两侧都是字符串就用 `\n\n` 连接;只要有一侧是多模态 parts
 *    数组,就都归一成 parts 数组再拼接(图片/文件不会被压成文本丢掉)。
 */
export function mergeAdjacentSameRoleMessages(
	messages: AgentMessage[],
): AgentMessage[] {
	const result: AgentMessage[] = [];

	for (const message of messages) {
		const previous = result[result.length - 1];
		if (previous && canMerge(previous, message)) {
			result[result.length - 1] = {
				...previous,
				content: mergeContent(previous.content, message.content),
			};
			continue;
		}
		result.push(message);
	}

	return result;
}

function canMerge(previous: AgentMessage, next: AgentMessage): boolean {
	if (previous.role !== next.role) return false;
	if (previous.role !== "user" && previous.role !== "assistant") return false;
	return !carriesProtocolPayload(previous) && !carriesProtocolPayload(next);
}

function carriesProtocolPayload(message: AgentMessage): boolean {
	return Boolean(
		message.toolCalls?.length ||
			message.toolCallId ||
			message.providerData?.length ||
			message.reasoningContent,
	);
}

function mergeContent(
	previous: AgentMessageContent,
	next: AgentMessageContent,
): AgentMessageContent {
	if (typeof previous === "string" && typeof next === "string") {
		if (!previous) return next;
		if (!next) return previous;
		return `${previous}\n\n${next}`;
	}
	return [...toParts(previous), ...toParts(next)];
}

function toParts(content: AgentMessageContent): AgentContentPart[] {
	if (content === null || content === undefined) return [];
	if (typeof content === "string") {
		return content ? [{ type: "text", text: content }] : [];
	}
	return content;
}
