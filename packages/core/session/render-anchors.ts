/**
 * 工具渲染锚点的**唯一**合成器(F4-c c4-b,§16.25 钥匙①)。
 *
 * `data-steps` / `tool-call` 是**渲染坐标**,不是正文:canonical G4 明文把它们
 * 丢掉,事件账本里从来没有它们,投影的 `materializeContentParts` 也不产出。
 * 从前它们只有一个产地 —— 活 run 窗口内那个**引擎写手对象**(内存 store 上的
 * 那一条),于是"写手对象"成了锚点的必经保管人:settle 快照必须读它,
 * 18 个热写端口因此一个都空转不得(§16.24 第五节证据一)。
 *
 * 这个文件把那条依赖掐断:**锚点由折叠产物现算**。同一份纯逻辑今天有两个消费者
 * —— renderer 的加载路径(S3w-0 的补水)与主进程的 settle 推送 —— 而它们必须
 * 逐字同算,否则"流式看到的分界"与"刷新后看到的分界"会分叉(§15.16 那一课的
 * 反面)。单实现纪律因此把它放在 core:renderer 与 backend 各 import 一次,
 * 谁都不许再抄第二份。
 *
 * 纯函数、零依赖、浏览器安全 —— 与 `packages/core/logging` 同款约束。
 */

/** 锚点合成只关心 part 的这两格(`type` 认锚点,`turnIndex` 定位置)。 */
export interface CoreRenderAnchorPart {
	type: string
	turnIndex?: number
}

/** 锚点合成只关心 step 的这三格。 */
export interface CoreRenderAnchorStep {
	turnIndex?: number
	toolCall?: unknown
	toolCallId?: string
}

export interface CoreRenderAnchorMessage<TStep extends CoreRenderAnchorStep = CoreRenderAnchorStep> {
	steps?: readonly TStep[]
	toolCalls?: readonly unknown[]
}

/** 一条 contentParts 是否已带工具渲染锚点(`data-steps` 或 `tool-call`)。 */
export function hasCoreRenderToolAnchor(parts: readonly CoreRenderAnchorPart[]): boolean {
	return parts.some((part) => part.type === "data-steps" || part.type === "tool-call")
}

/** 消息里有没有真的工具活儿:含 toolCall 的 step,或非空 toolCalls。 */
export function coreRenderMessageHasToolWork(message: CoreRenderAnchorMessage): boolean {
	const steps = message.steps ?? []
	if (steps.some((step) => step.toolCall !== undefined || step.toolCallId !== undefined)) {
		return true
	}
	return (message.toolCalls?.length ?? 0) > 0
}

/** part 的所属轮次;缺省视为第 0 轮(单轮老消息 / content-only 那一格)。 */
function partTurn(part: CoreRenderAnchorPart): number {
	return part.turnIndex ?? 0
}

/**
 * 把 `data-steps` 锚点插进**已有的** parts:每一轮内容 part 之后、下一轮之前各插一个,
 * 让 `buildWorkRender` 的 Working/Worked 切分落在最后一轮工具处(而不是把最终回答也
 * 卷进 work group)。
 *
 * **空轮必须按轮次序就位,不能挂尾**(§15.16 修 A,2026-08-26)。一轮有工具却没有
 * 任何内容 part 是常态而非例外:第 1 轮的 reasoning 在 `turnIndex === 1` 且尚无正文
 * 时走 'top' 落 `message.reasoning`,根本不进 `contentParts`;中间轮也可能只有工具
 * 没有叙述。旧实现把这些"找不到落点"的轮次一律挂到 parts **末尾**,于是孤儿锚点排在
 * 最终正文之后,`buildWorkRender` 的 `lastProcessIndex` 被推到末位 —— 整条正文被卷进
 * 折叠区,历史消息默认收起就等于正文不可见(真机 e0267646 seq2–18 九条中招)。
 *
 * 正确落点:轮次 `t` 的锚点插在**第一个轮次大于 t 的 part 之前**;只有 `t` 确实大于
 * 所有 part 的轮次(末轮工具之后再无内容)时才允许挂尾。
 */
function insertDataStepsByTurn<TPart extends CoreRenderAnchorPart>(
	parts: readonly TPart[],
	turns: number[],
): TPart[] {
	const ordered = [...turns].sort((a, b) => a - b)
	const remaining = new Set(ordered)
	const out: TPart[] = []
	// 锚点是这个函数**造出来**的那一格,不是入参里的 part —— 它在每个宿主那边都是
	// `ContentPart` 联合的合法成员(`{type:'data-steps', turnIndex}`),但 core 不认识
	// 那个联合。两处 cast 是这条边界的全部代价,故意写在同一个文件里好数。
	const anchor = (turnIndex: number): TPart => ({ type: "data-steps", turnIndex }) as unknown as TPart
	parts.forEach((part, index) => {
		const turnIndex = partTurn(part)
		// 空轮就位:所有还没落地、且轮次小于本 part 的锚点,插在本 part **之前**。
		for (const pending of ordered) {
			if (pending >= turnIndex) break
			if (remaining.has(pending)) {
				out.push(anchor(pending))
				remaining.delete(pending)
			}
		}
		out.push(part)
		const next = parts[index + 1]
		const nextTurn = next ? partTurn(next) : undefined
		if (remaining.has(turnIndex) && nextTurn !== turnIndex) {
			out.push(anchor(turnIndex))
			remaining.delete(turnIndex)
		}
	})
	// 真正大于所有 part 轮次的锚点才挂尾。
	for (const turnIndex of ordered) {
		if (remaining.has(turnIndex)) {
			out.push(anchor(turnIndex))
			remaining.delete(turnIndex)
		}
	}
	return out
}

/**
 * **锚点自合成**(S3w-0 立法,c4-b 上收为共享纯件)。
 *
 * 投影**故意不产出**渲染锚点,于是折叠出来的 contentParts 只有 `text`/`reasoning`,
 * 没有 `data-steps`/`tool-call`。这里按消息**自己**的 steps/toolCalls 现合成锚点,
 * 让工具行与 work-group 不再依赖任何地方持久化(或任何写手对象持有)的锚点。
 *
 * 三条纪律:
 *   · **只在缺锚点且有工具时动手** —— 已带锚点的消息返回 `null`(no-op),绝不重复插。
 *     流式期间 contentParts 早就有 `tool-call`/`data-steps`,这里一律不碰,不会把
 *     live 的 `tool-call` 冲成 `data-steps` 导致行 remount。
 *   · **turnIndex 全覆盖** —— steps 里出现的每个 turnIndex 都得到一个 `data-steps`,
 *     否则那一轮的 step 折不出、工具行不显示。
 *   · **幂等** —— 同一条已合成过(或本就带锚点)的消息再过一遍不变。
 *
 * 返回补好锚点的新 parts;无需改动时返回 `null`。
 */
export function synthesizeCoreToolAnchors<TPart extends CoreRenderAnchorPart>(
	parts: readonly TPart[],
	message: CoreRenderAnchorMessage,
): TPart[] | null {
	if (hasCoreRenderToolAnchor(parts)) return null
	if (!coreRenderMessageHasToolWork(message)) return null

	const steps = message.steps ?? []
	if (steps.length > 0) {
		const turns = [...new Set(steps.map((step) => step.turnIndex ?? 0))].sort((a, b) => a - b)
		return insertDataStepsByTurn(parts, turns)
	}

	// 更老的、只存了 toolCalls 的消息:一个 tool-call 兜底块挂末尾(与
	// `rebuildLoadedContentParts` 的空路径同款)。
	const toolCalls = message.toolCalls ?? []
	return [
		...parts,
		{ type: "tool-call", toolCalls: [...toolCalls] } as unknown as TPart,
	]
}
