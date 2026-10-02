import { agentTombstoneLabel } from "../agents/model.js";
import { buildCollabCommonRules } from "./agent-rules.js";
import { formatCollabAgentHandle } from "./handles.js";
import type { CollabAgentLike } from "./types.js";

/**
 * 变量板的一句事实(agent-self-state-variables.md §4.3)。
 *
 * 群房此前把 `context-variables` 与 `context-update-convention` 一起禁掉了,
 * 于是模型**握着 `variable` 工具、却看不到任何变量的值**——工具在,数据不在。
 * 解禁之后这句话补上另一半:这个场子里那块板也在。
 *
 * 只陈述事实,不指挥(roster 铁律):不写"聊完记得记下来"。W22 的教训是措辞层
 * 的督促换来的是废话行为,而这块板值不值得读,agent 自己看得见就会判断。
 *
 * 曾经还跟了一句「历史长了会被摘要压掉,而板每一轮都整份重发」——那是在卖
 * 这块板的耐久性,等于变着法儿说"把状态存这儿"。变量不再承担状态语义之后,
 * 这半句连同它的暗示一并删掉:板是可读的运行时信息,不是 agent 的存档位。
 */
const VARIABLE_BOARD_FACT =
	"The context-variable board is here too — the `variable` tool reads it.";

export interface BuildCollabRoomContextOptions {
	self: CollabAgentLike;
	/** All room members, self included. */
	members: readonly CollabAgentLike[];
	roomName: string;
	/** Label the human user goes by in relayed messages. Default: 用户 */
	userLabel?: string;
	/**
	 * 用户的句柄(agent-dm-user.md §2.3)。只在群版花名册里出现,写法与同事行
	 * 一致(`一天#yitian(用户)`)—— agent 能从花名册学到同事的句柄,却学不到
	 * 用户的,那 `dm to:"一天#yitian"` 就永远只能靠猜。
	 *
	 * 不给就只写 label:私聊两版的情况说明是散文(「这是你和 X 的私聊」),
	 * 往里面塞句柄只会让句子读不通,所以句柄只进花名册那一行。
	 */
	userHandle?: string;
	/**
	 * 这间房是**用户 ↔ 你的托管式私聊**吗(单成员 dm 房,agent-im-dm.md §2.3)。
	 *
	 * true 时情况说明换成私聊那一版:场子里只有用户和你,没有花名册可念、没有
	 * "@ 某位成员"可用、没有"指派给别人"这件事。群房那一版一个字不动 —— 两个
	 * 场子的事实本来就不一样,共用一段文案的代价是两边各有一半是假话。
	 */
	dm?: boolean;
	/**
	 * 这间房是**你和另一位同事的私聊**吗(双成员 dm 房,agent-im-dm.md §3.1/D4)。
	 *
	 * 单独一支而不是复用群版花名册,是因为 D4 的透明制必须进 agent 的认知:这间房
	 * 里有一个不说话的第三方(用户)在旁观,而群版情况说明会把用户说成"群成员"之一
	 * ——那会让 agent 以为用户是这场对话的参与者,进而对着 TA 汇报/请示。
	 *
	 * 与 `dm` 互斥(人数即形态);两者都为 true 时以 pair 为准,因为它更具体。
	 */
	dmPair?: boolean;
	/**
	 * 花名册写在 `<room>` 里吗?缺省 **true**。
	 *
	 * 曾经有过一个反向开关 `rosterInPayload`:那时真回合的房间投影是一整块
	 * `<ChatRoom>`,`<Members>` 就在里面,`<room>` 再列一遍是逐字副本。v3 之后
	 * 那块载荷没有了(drive 只带 `<message>` 信封),开关却还开着 —— 于是真回合的
	 * 花名册指向一段不存在的文本,模型把用户与自己数成两个人(2026-08-02 真机
	 * 「幽灵成员」)。
	 *
	 * 现在它与「消息以什么形状到达」(`driveEnvelope`)是**两个正交的开关**:
	 * 名单在哪,和视野说明该不该出现,本来就是两件事 —— 上一版把它们焊在一个
	 * 布尔上,才让一次翻转同时改错了两处措辞。
	 */
	rosterInSystemPrompt?: boolean;
	/**
	 * 这一次调用是**真回合的 drive** 吗?
	 *
	 * true:消息以 `<message from="名字#句柄">` 信封到达,未读裹在 `<Notification>` 里,
	 * 折叠段写成 `<Folded/>` —— 视野说明因此必须在场。
	 * false(缺省):意愿判定那一路,读的是压缩窗口(`名字: 内容`),既没有信封
	 * 也没有未读块,凭空描述它们就是一句关于载荷的假话。
	 */
	driveEnvelope?: boolean;
	/**
	 * 意愿判定的**薄档**(collab-turn-protocol-and-identity.md D.1)。
	 *
	 * 判定是一次裸 `generateChatResponse`:零工具、不读看板、不写变量。带着
	 * `<your_tools>`/状态板/`<board>` 去问"要不要开口",说的是一整段关于载荷的
	 * 假话 —— 它此刻手上一个工具都没有。
	 */
	judgement?: boolean;
}

/**
 * The factual room-context note appended after the persona (v3, 用户反馈):
 * the agent's OWN prompt is the entire identity — verbatim, untouched. This
 * note only states the situation: which room, who is in it, how messages are
 * relayed. No rules, no role-play framing, no behavioral instructions —
 * impersonation/narration/mechanics are handled STRUCTURALLY by the harness
 * (other voices arrive as user turns; drives and pass turns never enter the
 * projection; un-addressed agents are simply not activated).
 */
/**
 * `<where_you_are>` —— 三版共用的那张图(2026-08-02 换隐喻)。
 *
 * 隐喻决定行为。旧版把这里说成「后台会话 + 发言权」,工具又叫 `say`(言说动作)
 * —— 模型读完就把接下来写的正文当成"自己的发言",然后我们再用四层提示词劝它
 * "你的发言其实不算发言"。隐喻说 A、机制要 B,模型跟着隐喻走,这是「写而未发」
 * 顽固复发的真正原因(2026-08-02 真机 + 用户裁决)。
 *
 * 新隐喻是模型在训练数据里最熟的那一个:**工位 + 推送通知 + 发送按钮**。
 * 「要让消息出现在聊天里就调 send」是它的既有行为,框架对了,训练习惯为我们
 * 工作。随之退役的还有「turn text」这个自造行话 —— 工位上的字就是笔记,不需要
 * 一个术语去解释一个反直觉的机制。
 *
 * 这段是**全篇唯一**一次陈述这件事:通用规则块、驱动信封尾注、say 描述里的
 * 那三份重复都已删除(念经裁撤)。
 */
function buildWhereYouAre(options: { place: string; audience: string }): string {
	return [
		"<where_you_are>",
		// 工具名跟着合并走(collab-send-channel-and-wake.md §4):`dm` 已经是
		// `send_message` 的 `to` 参数,提示词里不该再出现一个模型看不见的工具名。
		//
		// 全部是**事实陈述**(v3 铁律):这是什么地方、字停在哪、按钮是哪个。
		// 措辞层的劝导(「不发送别人就看不到/会孤单」一类)已被真机实证只降频
		// 不归零 —— 服从率交给结构保证(收养式兜底,app/collab/turn.ts),这里
		// 只负责把图画对。
		`You are at your own desk, working as yourself. What happens in ${options.place} is delivered to you here, like notifications.`,
		"This desk is not a chat input box. Text written here stays here: what you write is a note to yourself, and your reasoning stays with it.",
		// 后半句原本是绝对化的「nothing sends on its own」,而收养式兜底
		// (app/collab/turn.ts)恰恰会代发 —— 在被收养的那一轮里那是一句假话,
		// 而模型据以推断"我没发送 = 群里没有这段话"正是重复发言的由头(A6)。
		// 改成如实说出那道兜底,并把它钉成**补救**而不是第二个按钮:一个可用的
		// 备选出口会把发送率往下拉,而一次事后修补不会。
		`\`send_message\` is the send button that carries words to ${options.audience} — there is no other send button.`,
		"If a turn ever ends with a finished reply written here and never sent, the system delivers that text for you and tells you it did — a repair after the fact, not a second way to send.",
		"</where_you_are>",
	].join("\n");
}

/**
 * `<messaging>` —— `send_message` 的机制。群版多两行(@ 与句柄),私聊两版没有
 * 点名这件事。
 *
 * 2026-08-02 从 `<speaking>` 改名:speak/speaking/silence 这一组词属于"发言权"
 * 隐喻(上台、听众在等),而机制是聊天应用的发送按钮。词换成 send/reply 之后,
 * 「不回复」不再需要"沉默是合法结局"这种带自辩味道的说法 —— 没什么可回的就
 * 不回,本来就是聊天里最普通的事。
 *
 * 同期删掉的负例句(「The one mistake to avoid: composing your reply as turn
 * text…」):劝导文本整体裁撤,由框架一致性替代。四层劝导都在场时真机照样复发,
 * 说明失效的不是服从性而是隐喻。
 */
function buildMessagingSection(options: {
	mentions: boolean;
	/** 花名册就在上面(`<room>` 里)吗 —— 这句话得指对地方。 */
	rosterInSystemPrompt: boolean;
}): string {
	// 句柄在名单里长什么样,随名单的形状走。指错地方 = 指向一段不存在的文本。
	const handleSource = options.rosterInSystemPrompt
		? "the handle is the string after their name in the roster above"
		: "take `name` and `handle` straight off that person's `<Member>` entry in the room payload";
	return [
		"<messaging>",
		"`send_message` delivers one message. One call is one message — call it as many times as you have things to say, the way people send a few short lines instead of one essay.",
		...(options.mentions
			? [
					`To address someone, write \`@name#handle\` in the text — ${handleSource}. A bare \`@name\` resolves too, but wakes everyone who goes by that name. What the chat displays is still \`@name\`; the handle is only how you tell people apart.`,
				]
			: []),
		// 合并后的发送面(collab-send-channel-and-wake.md §4)。这两句是**事实**,
		// 不是指挥:`to` 换的是收件人(这间房 → 你和某个人的私聊),`wake` 是
		// 私聊之后那一声 @ 的机械保证 —— 措辞嘱咐「看完请回群」不构成保证(W22),
		// 接口才构成。
		// 措辞约束(dm.test「群房文案零改动」):群版一个字都不能沾 dm 情况说明的
		// 标志语("private chat" / "one-on-one"),判定薄档又禁指令词("respond")
		// —— 所以这两句用 "a direct line" / "reply" 表述同一件事。
		"`to` sends the message to ONE person instead of into this chat — a direct line between you and them. Write them as the roster does (`name#handle`), or 用户 for the user.",
		...(options.mentions
			? [
					"With `to`, `wake: true` also posts an @ in this chat once they have read it, asking them to reply here. Nothing of what you wrote is carried over — only the fact that you wrote to them.",
				]
			: []),
		"`replyTo` takes a message id and quotes that message.",
		"Not sending anything is fine — with nothing to reply to, reply to nothing.",
		"</messaging>",
	].join("\n");
}

/**
 * 托管私聊的情况说明(agent-im-dm.md §2.3 + §5 规则 1)。
 *
 * 与群版同源同体例:**只陈述事实,不指挥**——这是什么场子、消息怎么走、手上有
 * 什么工具。唯一的行为线索是轻重活分界,而它有机械兜底(断路器 + 墙钟 + 工作台
 * 的可恢复性),照 agent-rules.ts 那张"每条规则都要指得出防线"的表是合格的。
 *
 * 工具面措辞与 D7 的 union 严格一致:私聊里 agent 的全部工具都在,所以这里说的
 * 是"你平时的工具都在",绝不能出现群房曾经短暂用过的"除 send_message 和 board 外没有
 * 其他工具"那类收紧口径——那会与实际工具面直接对撞。
 */
/**
 * 「消息以什么形状到你这里」——三版共用一句(collab-chatroom-payload.md)。
 *
 * 真回合(drive)里每条消息各自裹一层 `<message from="名字#句柄">` 信封;判定那一路
 * 读的是压缩窗口,仍然是 `名字: 内容`。两种形状都真实存在,所以这句话必须跟着
 * 调用方走 —— 一句关于载荷形状的假话比没有这句话贵得多,而私聊房同样是
 * `kind='room'`,同样吃这条链路。
 */
function buildRelayLine(driveEnvelope: boolean): string {
	return driveEnvelope
		? "What they say is delivered to you as `<message from=\"名字#句柄\">` lines."
		: "What they say reaches you as `name: text`.";
}

/** 句首大写:`the room 「x」` → `The room 「x」`。地名是拼出来的,所以在这里补。 */
function capitalizeFirst(text: string): string {
	return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/**
 * 视野的两条说明(collab/history-window.ts):未读块与折叠行。
 *
 * 两句都是**事实陈述**,不是指令:说清 `<Notification>` 是什么、`<Folded>` 意味着
 * 什么,剩下的判断留给模型。写成「你必须回应新消息」就等于把 @ 短路那套硬规则
 * 用措辞再造一遍,而整个视野模型存在的理由正是让"要不要说"变成可判断的。
 *
 * 只在真回合(drive 形态)出现,而且**与花名册在哪无关** —— 这两件事此前共用
 * 一个开关,于是翻转花名册的位置顺手把视野说明也关掉了。判定那一路读的是压缩
 * 窗口,没有这两个块,凭空描述它们就是一句关于载荷的假话。
 */
function buildViewLines(driveEnvelope: boolean): string[] {
	if (!driveEnvelope) return [];
	return [
		// drive 形态下没有 `<History>` 标签:读过的消息就散在这个工作区往上的历史
		// 里,不再被一层壳包着(v3 V1 之后房间内容随 drive 逐条落盘)。原句照抄
		// 过来就是指向一个不存在的标签。
		"Anything that arrived since your last turn comes in a `<Notification>` block at the very end — that block is the reason this turn is happening, and each line's `rel` says how it touches you (`mentions-you`, `quotes-you`, `bystander`). Everything above it you have already read.",
		"A `<Folded count=… from=… to=…/>` line means older messages exist but are not shown. It is not the start of the conversation.",
	];
}

function buildCollabDmContext(options: BuildCollabRoomContextOptions): string {
	const userLabel = options.userLabel ?? "用户";
	const driveEnvelope = options.driveEnvelope === true;
	return [
		buildWhereYouAre({
			place: `your conversation with ${userLabel}`,
			audience: userLabel,
		}),
		`<chat with="${userLabel}">`,
		`A one-on-one conversation — just the two of you. What ${userLabel} asks for here is your work to do, on their behalf.`,
		// 私聊房也是 kind='room',消息以什么形状到达跟着调用方走,说错了就是一句
		// 关于载荷的假话(群版同处理)。
		buildRelayLine(driveEnvelope),
		...buildViewLines(driveEnvelope),
		"</chat>",
		buildMessagingSection({ mentions: false, rosterInSystemPrompt: true }),
		...(options.judgement
			? []
			: [
					"<your_tools>",
					// D7 union:私聊常驻会话就是"替 TA 干活"的地方,工具面完整。
					"Everything you normally have works here. Light work — look something up, read a file, make a small edit — just do it, then `send_message` the result.",
					// §5 规则 1 的重活那一半:兜底是断路器/墙钟,以及工作台会话本身的可恢复性。
					// 「no turn limit」已改为如实(C3-5):工作会话有 maxTurns 与 30 分钟
					// 墙钟。这一段是情况说明,所以只陈述闸的存在,不给"分段落地"那类
					// 动作建议 —— 那句归 `<rules>`(agent-rules.ts),两处各写一版会打架。
					"Sizeable work (many files, long-running) starts with `board` start: that gives you a separate work session where the context survives, bounded by a turn budget and a 30-minute wall clock. No card for it yet, `start` makes one. `send_message` as you hit milestones.",
					"</your_tools>",
				]),
	]
		.filter((line) => line.length > 0)
		.join("\n");
}

/**
 * agent ↔ agent 私聊的情况说明(agent-im-dm.md §3.1 + D4 透明制)。
 *
 * 体例与另外两版同源:只陈述事实。这一版必须说清的三件事,每一件都对应一条真实
 * 的机制,漏了哪一条 agent 就会按错误的世界模型行动:
 *
 *  1. **对面是谁**——两个人的花名册,名字/职位与群版取值一致;
 *  2. **用户在旁边**——dm 房在侧栏可见、用户随时能插话(D4)。不说这一条,agent
 *     会以为这是背着人的暗通道,而系统里根本不存在那种通道;
 *  3. **没有搬运上下文**——私聊刻意不转运群历史(§3.4 防滥用),所以对面
 *     很可能不知道你在说哪件事。这句直接决定了它会不会先交代背景。
 *
 * 工具面走群房那一路(D7:union 是单成员私聊的特权),所以措辞与群版一致:
 * "平时的工具都在",但正经活回大群立卡 —— 后半句的兜底是通用规则那三条。
 */
function buildCollabPairDmContext(
	options: BuildCollabRoomContextOptions,
): string {
	const userLabel = options.userLabel ?? "用户";
	const peer = options.members.find((member) => member.id !== options.self.id);
	const peerLabel = peer
		? peer.title
			? `${peer.name}(${peer.title})`
			: peer.name
		: "另一位同事";
	return [
		buildWhereYouAre({
			place: `your private chat with ${peerLabel}`,
			audience: "that chat",
		}),
		`<chat with="${peerLabel}">`,
		`A private chat between the two of you. ${userLabel} can see this conversation and may step in at any point.`,
		// §3.4:dm 不自动搬运上下文 —— 这是事实陈述,不是叮嘱。
		`It was opened on its own: ${peerLabel} cannot see the context you are coming from. Whatever this is about, spell it out in the message.`,
		buildRelayLine(options.driveEnvelope === true),
		...buildViewLines(options.driveEnvelope === true),
		"</chat>",
		buildMessagingSection({ mentions: false, rosterInSystemPrompt: true }),
		...(options.judgement
			? []
			: [
					"<your_tools>",
					"Everything you normally have works here. This is a place to talk: anything hands-on goes back to the room as a card.",
					"</your_tools>",
				]),
	]
		.filter((line) => line.length > 0)
		.join("\n");
}

export function buildCollabRoomContext(
	options: BuildCollabRoomContextOptions,
): string {
	if (options.dmPair) return buildCollabPairDmContext(options);
	if (options.dm) return buildCollabDmContext(options);
	const userLabel = options.userLabel ?? "用户";
	const others = options.members.filter(
		(member) => member.id !== options.self.id,
	);
	// 花名册是 agent **唯一**能学到句柄的地方(docs/design/collab-agent-handle.md)。
	// 没有它,send_message 的 @ 与 to、board 的 assignee 就都只能靠猜名字 ——
	// dm 那条更是直接断的(它的适配器按 id 严格解析)。
	//
	// 句柄拼在**名字**后面而不是整个标签后面(`小李#3f9c…(后端)`,不是
	// `小李(后端)#3f9c…`):这样花名册里出现的 `名字#句柄` 与它待会儿要写进正文的
	// token 逐字一致,模型照抄即可,不需要先把职位剥掉。
	//
	// 用户行与同事行同一书写法(agent-dm-user.md §2.3):`一天#yitian(用户)`。
	// 「(用户)」占同事行「(职位)」那一格 —— 用户不是成员(memberAgentIds 仍是
	// 纯 agent 数组),但 TA 在这个场子里,而 dm 认得出这个写法。
	const userEntry = options.userHandle
		? `${userLabel}#${options.userHandle}(用户)`
		: userLabel;
	// 花名册一人一行(2026-08-01 整理):此前是顿号串成的一长句,而这份名单的
	// 用处是**被照抄**(send_message 的 @ 与 to、board 的 assignee 都要指认「谁」),
	// 一行一个的形状比一句话好抄,也好数。
	const memberLines = [
		`- ${userEntry}`,
		...others.map((member) => {
			const handled = formatCollabAgentHandle(member.id, member.name);
			return member.title ? `- ${handled}(${member.title})` : `- ${handled}`;
		}),
	];
	/**
	 * 名单与「消息以什么形状到达」是**两件事**,各归各的开关。
	 *
	 * 名单默认写在这里:它是 agent 唯一能学到句柄的地方,而 drive 里已经没有
	 * `<ChatRoom><Members>` 了(v3 V2 删掉了那块载荷)。指向一段不存在的文本 =
	 * 模型把用户与花名册上的名字数成两个人。
	 */
	const rosterInSystemPrompt = options.rosterInSystemPrompt !== false;
	const driveEnvelope = options.driveEnvelope === true;
	const roomBody = [
		...(rosterInSystemPrompt
			? ["Who is in it, written the way you address them:", ...memberLines]
			: [
					"Who is in it arrives as a `<ChatRoom>` block in the conversation below.",
				]),
		buildRelayLine(driveEnvelope),
		...buildViewLines(driveEnvelope),
	];

	return [
		// W25: 后台执行的事实(执行会话分离 W18 的提示层)。模型默认套「assistant
		// 输出=聊天回复」的训练先例,必须先把「你不在聊天界面里、写下的不会自动
		// 发出」说成字面事实,再讲机制。只陈述事实,不指挥(v3 铁律)。
		buildWhereYouAre({
			place: `the room 「${options.roomName}」`,
			audience: "the room",
		}),
		// 花名册是 agent **唯一**能学到句柄的地方(collab-agent-handle.md)。
		`<room name="${options.roomName}">`,
		...roomBody,
		"</room>",
		// W14a: the @ mechanic is stated as the FACT it now is — the system pins
		// the member's id behind the name, so a rename never orphans a mention.
		// Still only FACTS: what the mechanism is, not what the agent ought to do
		// with it (v3 铁律)。
		//
		// W22:stay_silent 已退役(判定层已经决定了这一轮要不要说话),
		// 这里连带删掉它的事实行——群里没有的工具不该出现在情况说明里。
		buildMessagingSection({ mentions: true, rosterInSystemPrompt }),
		// 判定薄档(D.1):`<board>` / `<your_tools>` / 状态板全部裁掉 —— 判定是
		// 一次零工具的裸调用,这三段对它而言字字是假话。
		...(options.judgement
			? []
			: [
					"<board>",
					"The room shares a task board; the `board` tool lists, creates, assigns and reviews cards.",
					"@-ing someone only asks them to speak. To get something actually done by them, put a card on the board and assign it: they pick it up in their own work session with full tools (reading and writing files, running commands) and deliver back to the room themselves.",
					"</board>",
					"<your_tools>",
					"Everything you normally have works here too. Light work — look something up, read a file — just do it, then send it.",
					// 事实句,不给动作建议:「该 board start」归 `<rules>`(agent-rules.ts),
					// 两处各写一版动作指引会直接打架(一致性审计 D.2)。
					"Sizeable work belongs on the board, not inside a room turn.",
					// 变量板在这个场子里也有(P3 解禁了变量通道)。此前 `<your_cards>` 那段
					// 手写的在飞卡片就在这个位置,现在由 `my_cards` 变量从同一块板上产出。
					VARIABLE_BOARD_FACT,
					"</your_tools>",
				]),
	]
		.filter((line) => line.length > 0)
		.join("\n");
}

export interface BuildCollabRoomSystemPromptOptions
	extends BuildCollabRoomContextOptions {
	/** The agent's own persona prompt (its systemPrompt field), used VERBATIM. */
	personaPrompt: string;
	/**
	 * Append the shared 通用规则 block (collab-team-v2 §8). Opt-IN because the
	 * other caller of this builder is the willingness judgement — a yes/no call
	 * that produces no message, writes no tags and reads no board, so every line of
	 * it would be pure cost. A real room turn passes true.
	 */
	includeCommonRules?: boolean;
}

/**
 * The ENTIRE system message for a room turn: the agent's own prompt verbatim
 * (nothing prepended, nothing rewritten), then everything the harness supplies,
 * inside ONE `<workspace>` element.
 *
 * persona 留在 XML **外面**是铁律,不是排版偏好:它是这个 agent 的身份原文,
 * 包进一个 harness 造的标签里就变成了"系统提供的一段资料",而它必须读起来
 * 就是这个 agent 自己。标签里装的全是系统事实与规约 —— 那些才是资料。
 */
export function buildCollabRoomSystemPrompt(
	options: BuildCollabRoomSystemPromptOptions,
): string {
	const persona = options.personaPrompt.trim() || `你是${options.self.name}。`;
	const inner = [
		buildCollabRoomContext(options),
		// 私聊房拿的是同一块通用规则的 dm / pair 版:群版逐字不动(行为守恒),另两
		// 版只把「结论回哪儿」「干活现场在哪」的地名换掉,其余规则与兜底防线完全
		// 相同。
		...(options.includeCommonRules
			? [
					buildCollabCommonRules({
						...(options.dmPair ? { pair: true } : {}),
						...(options.dm ? { dm: true } : {}),
					}),
				]
			: []),
	].join("\n");
	return [persona, `<workspace>\n${inner}\n</workspace>`].join("\n\n");
}

export interface BuildCollabWorkContextOptions {
	/** 母房的名字 —— 结论发回哪里、这张卡是谁家的活。 */
	roomName: string;
	/** 卡 id。给全 id:`<card id="…"/>` 与 `board` 的 taskId 都照抄这一串。 */
	taskId?: string;
	/** 卡标题(会话 meta 里的快照,`CollabWorkRef.taskTitle`)。 */
	taskTitle?: string;
}

/**
 * 工作台会话的**工作身份**——常驻 system prompt 的那一段(架构收敛 C3-5)。
 *
 * A3 抓到的病灶是「工作会话零 system prompt 身份」:`collabRoomOverrides` 只认
 * room/agent 两种 kind,work 落空,于是一条工作会话拿到的是**完整产品提示词**
 * (一个通用助理的身份)+ 一条 briefing user 消息。那条 briefing 是任务框架唯一
 * 的入口,而它跟其余历史一样会被压缩摘要化 —— 干到第三个小时的 agent 于是既不
 * 记得自己在做哪张卡,也不记得产出该往哪儿报。
 *
 * 这一段解决的正是「压不掉」:它每一轮整份重发。所以它只装**不会过期**的事实:
 * 场子、卡的身份、回报的两条路。会过期的(看板现状、群聊尾巴、评审意见)留在
 * briefing 里,那本来就是它该待的地方。
 *
 * 体例与房版同源:**只陈述事实,不指挥**。「什么时候 complete」是交付协议,归
 * briefing;「怎么写标签」是书写约定,归 `<rules>`(agent-rules.ts)。
 */
export function buildCollabWorkContext(
	options: BuildCollabWorkContextOptions,
): string {
	const card = [
		options.taskId ? `id: ${options.taskId}` : "",
		options.taskTitle ? `标题: ${options.taskTitle}` : "",
	].filter((line) => line.length > 0);
	return [
		"<where_you_are>",
		// 隐喻与房版同源(工位),但这里的工位上摆着一张卡,而不是一条通知流:
		// 工作会话没有推送进来,它是被一张卡开出来的。
		`You are at your own desk, working on one card from the board of the room 「${options.roomName}」.`,
		// W25 的那条事实,搬到了它唯一该在的地方(此前寄在 briefing 里,会被压缩)。
		"This session runs in the background. Everything you produce here — prose, reasoning, tool calls and their results — stays here.",
		// 两条回报路都写出来:少写哪一条,那一条就会在真机里变成"从来没人用过"。
		`\`send_message\` is the send button that carries words to 「${options.roomName}」 — there is no other send button. The \`board\` tool is how the card itself moves (complete when it is delivered, block when it cannot be).`,
		"</where_you_are>",
		...(card.length > 0 ? ["<card>", ...card, "</card>"] : []),
	].join("\n");
}

/**
 * Who said it, as the window signs the line (P2-16).
 *
 * The roster is the ROOM's current members, so a departed member's past lines
 * miss it — and the old fallback then signed them with the raw `agent-a1b2…`
 * id. A model reading that has to guess whether it is a person, and 事故-prone
 * guesses are exactly what an id in a prompt invites. So: the roster first, a
 * global lookup second (a former member still exists, it just left the room),
 * and only then the honest word for what it is.
 *
 * **这个标签只给模型看**(信封的 from、意愿判定窗口的行首;UI 一处都不用它),
 * 所以身份句柄拼在这里 —— 三个调用点因此同时有了 id,而不需要各拼一遍
 * (docs/design/collab-agent-handle.md §2.3)。名字查不到的「成员」/「前成员」
 * 占位:有 id 就照样给句柄(那个 id 是真的),真的没有 id 才只剩一个词。
 */
export function resolveCollabSpeakerLabel(
	agentId: string | undefined,
	agents: readonly CollabAgentLike[],
	resolveAgentName?: (agentId: string) => string | undefined,
): string {
	if (!agentId) return "成员";
	const agent = agents.find((candidate) => candidate.id === agentId);
	if (agent) return formatCollabAgentHandle(agentId, agent.name);
	const known = resolveAgentName?.(agentId)?.trim();
	// 墓碑文案的属主是 agents/model.ts;这一句是**给模型看**的,所以取 'model'
	// 口径(「前成员」——说的是与这间房的关系,不是账号状态)。
	return formatCollabAgentHandle(agentId, known || agentTombstoneLabel("model"));
}
