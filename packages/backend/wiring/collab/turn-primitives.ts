/**
 * 房回合(turn.ts)与任务回合(worker.ts)共用的那几件小事(C2-5)。
 *
 * 两条路各自成篇 —— 房回合答的是群里的话,任务回合做的是看板上的卡 —— 但它们
 * 起跑与收尾的机械动作是**同一件事**:同一个 drive 信封、同一套模型绑定取舍、
 * 同一个超时后的僵尸流兜底、同一趟房内 say 的倒序收割。这四块此前逐字重复在
 * 两个文件里,而重复的代价已经现过一次形:僵尸 abort 先在 worker 那边补上,
 * 房那条路被落下了整整一版(turn.ts 里那句「worker.ts:363 fixed the same hole
 * on the work path; the room path was left behind」就是它的墓志铭)。
 *
 * 放成一个**叶子模块**而不是让 worker 反向 import turn:coordinator.ts 与
 * index.ts 都 import worker.js,而 turn 的级联本来就是靠注入拆环的 —— 再添一条
 * turn ↔ worker 的实边,等于把好不容易拆开的那个环换个方向重新接上。这里只依赖
 * 引擎句柄、纯产品层谓词与线上契约类型,谁 import 它都不会成环。
 *
 * 有意保留的分歧做成**参数**而不是抹平:`usageSource` 两侧各持自己的常量
 * (房回合记 ROOM、任务回合记 WORK),那是计费归属的真实差别,不是漂移。
 */
import type { AgentDefinition, ChatMessage } from "@shared/ipc.js";
import {
	COLLAB_MESSAGE_SOURCE,
	isCollabHarvestMessage,
	isCollabSayMessage,
	isCollabThinkingMessage,
} from "@onething/runtime/collab";
import { getStreamEngineSafe } from "../../engine/index.js";

import { SESSION_COMMAND_TYPES } from "@shared/events/index.js";

/**
 * 一条 collab drive 的信封骨架 —— 把「这是谁发的、算谁的账、别给它起标题」
 * 一次说清。
 *
 * `source` 与 `origin.source` 同为 `COLLAB_MESSAGE_SOURCE`:前者是消息自己的
 * 标记(`isCollabDriveMessage` 认它,于是这条 drive 永远不会被投进别人读的房间
 * 投影,也不会开一轮自己的意愿判定),后者是渠道身份那一层的来源。两处必须同源,
 * 分开写就是给它们各自漂移的机会。
 *
 * `receivedAt` 现取:一条 drive 的「收到时刻」就是它被组装出来的时刻。
 */
export interface CollabDriveEnvelope {
	type: typeof SESSION_COMMAND_TYPES.SEND_MESSAGE;
	channel: string | undefined;
	content: string;
	source: string;
	origin: { transport: "api"; source: string; receivedAt: number };
	suppressTitleGeneration: true;
	usageSource: string;
}

export function collabDriveEnvelope(options: {
	/**
	 * 房间的连接器 —— 回合可能跑在别处,但它答的是这间房。允许 undefined:
	 * 解析不出连接器时字段照旧缺席(两个调用点原本就是这个行为)。
	 */
	channel: string | undefined;
	content: string;
	/**
	 * 计费归属(W13.3)。房回合 `COLLAB_USAGE_SOURCE_ROOM`、任务回合
	 * `COLLAB_USAGE_SOURCE_WORK` —— **归属而已**,预算闸仍按 sessionId 求和。
	 */
	usageSource: string;
}): CollabDriveEnvelope {
	return {
		type: SESSION_COMMAND_TYPES.SEND_MESSAGE,
		channel: options.channel,
		content: options.content,
		source: COLLAB_MESSAGE_SOURCE,
		origin: {
			transport: "api",
			source: COLLAB_MESSAGE_SOURCE,
			receivedAt: Date.now(),
		},
		// 后台驱动的回合不该在会话列表里生出一个模型编的标题:这条会话的名字由
		// 它的身份决定(执行会话/工作会话),不由某一轮的正文决定。
		suppressTitleGeneration: true,
		usageSource: options.usageSource,
	};
}

/**
 * 这一轮要不要带上 agent 的模型绑定(P1-4)。
 *
 * 会话被用户钉过(`modelPinned`)就一个字段都不带:命令级 override 会整个盖过
 * 会话本身(`withAgentModelBinding` 见 command 带了 providerId 就短路),于是
 * 用户在那个会话 UI 里挑的模型永远生效不了。不带,引擎就去解析会话自己的配置
 * —— 那正是用户挑的那个。
 *
 * thinking 的形状转换也在这里:绑定存的是档位字符串,而命令契约要的是
 * `thinking:boolean` + `thinkingEffort`。三个字段同进同退。
 */
export interface CollabAgentModelFields {
	providerId?: string;
	model?: string;
	thinking?: boolean;
	thinkingEffort?: string;
}

export function collabAgentModelFields(
	agent: Pick<AgentDefinition, "model">,
	pinned: boolean,
): CollabAgentModelFields {
	if (pinned) return {};
	return {
		...(agent.model?.providerId ? { providerId: agent.model.providerId } : {}),
		...(agent.model?.modelId ? { model: agent.model.modelId } : {}),
		...(agent.model?.thinking && agent.model?.providerId
			? { thinking: true, thinkingEffort: agent.model.thinking }
			: {}),
	};
}

/**
 * 等待超时了就把流真的掐掉 —— 绝不留僵尸(两条路同一个理由)。
 *
 * 等待放弃了,请求并没有:它会继续拿整个上下文来回打,而这一轮已经没有任何人
 * 在听;与此同时锁/槽位正要交给下一个。房回合那边丢的是 agent 锁,任务回合那边
 * 丢的是「一张卡同时只有一个 worker」这条不变式 —— 症状不同,病根是同一个。
 */
export function abortCollabZombieStream(
	outcome: string,
	sessionId: string,
): void {
	if (outcome !== "timeout") return;
	getStreamEngineSafe()?.abort(sessionId);
}

/** 一趟倒序收割的结果。`legacySpeech` 只有 pre-W18 的旧转录才会有。 */
export interface CollabRoomSayScan {
	says: ChatMessage[];
	legacySpeech?: ChatMessage;
}

/**
 * 这一轮里这位同事在**房间**里说过什么(倒序扫到 drive 那一刻为止)。
 *
 * 房间转录是唯一诚实的落点:不论回合跑在执行会话还是工作会话,`say` 落地的
 * 地方都是房间,署的都是它自己的名字。
 *
 * 收割方向是**从后往前**、遇到早于 `sinceTs` 的第一条就停:再往前是上一轮的事,
 * 而把上一轮的发言算进这一轮,正是 pre-W14b `latestAssistantMessageSince` 时代
 * 那个「拿旧回复当新回复」的陷阱。`unshift` 让结果保持时间正序。
 *
 * harvest 帖跳过:它写在同一个 agent 名下,却是编排方代笔的 —— 一条中途落地的
 * harvest 不能被当成这一轮产出的东西。
 */
export function scanCollabRoomSays(
	messages: readonly ChatMessage[],
	agentId: string,
	sinceTs: number,
): CollabRoomSayScan {
	const says: ChatMessage[] = [];
	let legacySpeech: ChatMessage | undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.timestamp < sinceTs) break;
		if (message.role !== "assistant" || message.agentId !== agentId) continue;
		if (isCollabSayMessage(message)) {
			says.unshift(message);
			continue;
		}
		if (isCollabHarvestMessage(message)) continue;
		// 既不是 say 也不是 harvest:只有 pre-W18 的房内回合会是这个形状,
		// 而那时候它本身**就是**发言。
		if (!legacySpeech && !isCollabThinkingMessage(message))
			legacySpeech = message;
	}
	return { says, ...(legacySpeech ? { legacySpeech } : {}) };
}
