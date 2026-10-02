/**
 * 通用规则 —— 注入所有 agent 的共用文本(docs/design/collab-team-v2.md §8)。
 *
 * 这块文本存在的前提写在设计原文里,值得原样抄在这:**模型行为问题的终局手段
 * 是接口约束(转义/验真/断路器/守卫),措辞只是补充**(W22 教训)。所以这里
 * 的每一条都必须能指向一道机械防线,不能指的就不该写:
 *
 *  | 规则 | 兜底它的机械防线 |
 *  |---|---|
 *  | 只写 card/file 两种标签 | `sanitizeCollabInlineMarkup` 落库转义白名单 |
 *  | 不许指不存在的东西 | 渲染验真(不存在即降级纯文本) |
 *  | 卡状态现查 | 无(纯粹省一次误判;写错了 board 会用 rev 冲突顶回来) |
 *
 * 与 `roster.ts` 情况说明的分工:情况说明陈述**这个场子是什么样**(谁在、消息
 * 怎么转发、有哪些工具),这里陈述**怎么用手上的东西**。前者是事实,后者是
 * 规约 —— 混在一起写,情况说明"只陈述不指挥"的铁律就没了边界。
 *
 * **形态(2026-08-01 整理)**:全英文 + XML 分段,块边界靠标签闭合。此前是
 * 全角括号包一段中英混排的散文,而那段文本里最吃重的两条事实(后台执行 /
 * send_message 才送达)恰好是仅有的英文行 —— 夹在中文里的英文不会因为显眼而被更认真
 * 对待,只会读成从别处粘来的免责声明。同期去掉的还有**逐字重复**:
 * 「Nothing you produce this turn…」当时在 roster 情况说明与这里各有一份,
 * 驱动信封里还有第三份。同一句话说三遍不会变成三倍重要,只会变成模板套话
 * —— 现在它只在 `<where_you_are>` 里出现一次,这里不再复述场子。
 */

/**
 * 群聊常驻会话(room turn)看到的规则,一个 `<rules>` 元素。
 *
 * 三个人数档共用同一块文本,只有「结论往哪回」「干活现场在哪」两处地名不同 ——
 * 底下每一条规则与它的机械防线逐字不变:
 *
 *  - 缺省 = 群聊房;
 *  - `dm: true` = 单成员 dm 房(用户 ↔ agent 托管私聊,agent-im-dm.md §2.3);
 *  - `pair: true` = 双成员 dm 房(agent ↔ agent 私聊,§3.1)。
 *
 * "你在什么场子里"那句事实**不在这里** —— 它归 `<where_you_are>`(roster.ts),
 * 而这个块永远跟在它后面(`buildCollabRoomSystemPrompt` 是唯一调用者)。
 *
 * §5 规则 2/3/4 三条(2026-07-30,IM P3)也在这里,同样对三档一视同仁 —— dm 是
 * 一个所有人都能用的工具,规矩不该只讲给群里的人听。它们各自的机械防线:
 *  | 规则 | 兜底 |
 *  |---|---|
 *  | 想单独对齐用 dm、结论回来说一句 | 透明制 UI(dm 房侧栏可见、用户可插话) |
 *  | dm 不是干活现场,正经活回大群立卡 | 断路器 + 墙钟 + 工作台才有的可恢复性 |
 *  | 不客套空转 | 双成员房链长闸默认 6 + 发送幂等窗 |
 */
export function buildCollabCommonRules(
	options: { dm?: boolean; pair?: boolean } = {},
): string {
	// 「结论回哪儿」的地名:群里就是这个群,私聊里就是当前这场对话 —— 双成员 dm
	// 房里说"回大群"是句假话(那间房没有大群),而假话正是规则失效的开始。
	const backHere =
		options.dm || options.pair ? "back into this chat" : "back to the room";
	return [
		"<rules>",
		'- Two inline tags exist and no others: `<card id="…"/>` points at a board card, `<file path="…"/>` points at a file. Any other angle bracket is treated as ordinary text.',
		"- Both are verified when they render: a card that is not on the board, a file that is not on disk, becomes dead text nobody can click. Point only at things that exist.",
		"- Read a card's status live with `board` list. The status quoted in an older message is what it was then, not what it is now.",
		// 「no turn limit」是一句假话(C3-5,审计 §7 第 8 项):工作会话照样跑在
		// `maxTurns`(缺省 100)与 30 分钟墙钟之下(app/collab/worker.ts)。承诺无限
		// 的代价不是模型失望,是它把交付全压在最后一轮 —— 而被墙钟掐掉的那一轮
		// 什么都留不下。改成如实说出两道闸,再把「分段落地」写成它的推论。
		"- Light versus heavy: look something up, answer a question, make a small edit — just do it. Many files, or long-running work — `board` start first: that gives you a work session where the context survives, and an interruption is resumed rather than restarted. It still ends — a turn budget and a 30-minute wall clock — so land your work in stages instead of saving it all for one final push. No card for it yet, `start` makes one.",
		"- Being assigned a card is not an order to begin: ask first if anything is unclear, and `block` the card with a reason if you cannot do it.",
		// 后半句是 2026-08-01 事故补上的对称面(collab-agent-view-p5.md §1):原来
		// 只讲了"对方没有你的上下文",没讲**你也拿不回你在那儿说过的话** —— dm 房
		// 是另一间房,这一轮的输入里一个字都没有,而 `dm` 的回执也不回显正文。
		// 狼人杀上帝就是栽在这后半句上:牌发出去了,下一个回合它自己不知道发了什么。
		`- To settle a detail with one colleague, use \`send_message\` with \`to\`: it opens a chat with just the two of you (the user can see it and step in). They have none of your context, so write the background into the message. That chat is a different room: what is said there is never part of this turn's input, yours included. Bring the conclusion ${backHere} with a plain \`send_message\`.`,
		// agent-dm-user.md §3.4:dm 的目标现在也包括用户本人。措辞与工具描述那一段
		// 必须一致(该文件既有纪律)。
		// 只讲给群房与 pair 房听:用户私聊房里 agent 就在和 TA 说话,那里说这句是废话。
		...(options.dm
			? []
			: [
					"- When something needs the user personally — a call only they can make, a heads-up, a deliverable — `send_message` with `to: 用户` reaches them directly. They may be away: send it and carry on, do not stop and wait for a reply.",
				]),
		// 「干活现场在哪」随场子改,而且必须改:用户私聊里 agent 就该在这间房里干活
		// (D7 union 工具面),对着它说"正经活回大群"会与上一条轻重活分界直接打架。
		options.dm
			? "- A private chat is for settling things with someone, not for handing work off: work that is yours gets a card and gets done right here."
			: "- A private chat is a place to talk, not a place to work: anything hands-on goes back to the room as a card.",
		"- Do not fill air. With nothing new to add, stop — 「收到」 and 「辛苦了」 do not need a message of their own.",
		"</rules>",
	].join("\n");
}

/**
 * 工作台会话(work session)看到的规则。
 *
 * **它比群/私聊两版短,而短掉的那几条是被删的,不是被忘的**(架构收敛 C3-5,
 * 审计 docs/audit/collab-prompt-rules-map-2026-08-02.md §5):
 *
 *  - 「Being assigned a card is not an order to begin: ask first」与
 *    「重活先 `board` start」两条,在**已经开工的工作会话**里字字自相矛盾 ——
 *    读到它们的那个 agent 已经在这张卡的工作会话里跑着了,照做只会回群问一句
 *    废话,或者去调一个必然被拒的 `start`(卡已经是 `doing`,reducer 直接早退)。
 *    它们是**房间回合**的规则,所以留在 `buildCollabCommonRules` 里一字不动 ——
 *    在那个语境里两条都真:那时卡还没开,而 start 正是开它的动作。
 *  - `<where_you_are>` 整块移进了 system prompt(engine/prompt/system-prompt.ts
 *    的 work 分支)。此前它必须自己带,因为这份文本拼进的是 worker.ts 那条
 *    briefing user 消息,前面没有场子说明可以依赖;现在工作身份常驻 system,
 *    再念一遍就是这个仓库一直在裁的那种念经。
 *
 * 剩下的三条都是**跨场子恒真**的书写约定,与群版逐字相同,各自的机械防线见
 * 文件头那张表。
 */
export function buildCollabWorkRules(): string {
	return [
		"<workspace>",
		"<rules>",
		'- Two inline tags exist and no others: `<card id="…"/>` points at a board card, `<file path="…"/>` points at a file. Any other angle bracket is treated as ordinary text.',
		"- Both are verified when they render: a card that is not on the board, a file that is not on disk, becomes dead text nobody can click. Point only at things that exist.",
		"- Read a card's status live with `board` list. The status quoted in an older message is what it was then, not what it is now.",
		"</rules>",
		"</workspace>",
	].join("\n");
}
