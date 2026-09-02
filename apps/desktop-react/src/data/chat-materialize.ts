import {
  materializeNode,
  type ProjectionMaterializeOptions,
  type ProjectionNode,
  type SessionProjectionState,
} from '@onething/core/session'
import type { ProjectedMessage } from './chat-fold'
import type { StreamWater, WaterPartView } from './stream-water'

/**
 * **增量物化**(09-01 P0,用户真机日志:60 万 token 长会话流式期间 chat-source 的
 * rAF 回调连续十几帧 250–335ms、最重 1153ms,流式实际 3–4fps,打字悬停全卡)。
 *
 * ── 病在哪儿 ──────────────────────────────────────────────────────────
 * `compose()` 每帧调一次 `materializeChatMessages(fold.state, …)`,而那一口是
 * **全量**的:整篇抄本每条节点都重新物化一遍。流式期间真正在变的只有一条消息,
 * 其余几百条每帧陪跑一次,代价 ∝ 抄本长度 —— 长会话每帧付全款。
 *
 * 连带还有一条更贵的:`assembleMessage` 的 memo 按**消息对象引用**做键
 * (assemble/index.ts)。全量物化每帧造出全新对象,那张表于是每帧全军 miss ——
 * 整篇抄本每帧重装配一次(日志里那条 `perf.span assemble 206ms`)。它一直是对的,
 * 只是上游每帧把键换掉了;这里把引用稳住,它不用改一个字就跟着好了。
 *
 * ── 钥匙:`(投影节点对象, node.rev)` ──────────────────────────────────
 * 不是新发明。`BaseNode.rev` 与 `forWrite` 早在 core 的归约器里(§17.7.1 批 1):
 * 要往节点上写的分支一律经 `forWrite` 取节点,号顺手前进 —— 于是「这条节点的
 * 物化产物还作数吗」由节点自己回答。`packages/backend/session/materialized-messages.ts`
 * 已按同一把钥匙做过一次(258 条 / 50MB 的会话 46ms → 0.026ms)。
 *
 * **为什么壳要自己存一份,而不是把 memo 塞进 core 的 `materializeNode`**:
 * 与那个文件头第 30 行同一条理由 —— 成品取决于**这条读路自己的物化选项**
 * (壳这边是 `resolveBlob`,读的是壳的 blob 缓存),而 refold 那道门、模型历史、
 * 后端读路各自带着自己的选项走同一口。缓存归读路,节点只负责回答「我变过没有」。
 *
 * ── 失效条件,只有三条 ────────────────────────────────────────────────
 *  ① **节点 rev 前进** —— 唯一产地是归约器的 `forWrite`;
 *  ② **blobEpoch 前进** —— 见下,这是壳比后端多出来的一格;
 *  ③ **节点对象没了** —— 重折换整份 state、换会话丢掉 fold,`WeakMap` 自动清。
 *
 * 没有第四条,也没有「谁去清」这个问题 —— 也就没有清漏的可能。
 * `hidden` **不进** rev(core 的既有裁定:它是列表成员判据不是产物判据),
 * 所以每次现问,与后端那份逐字同一手。
 *
 * ── 内存上界 ──────────────────────────────────────────────────────────
 * 两张表都是 `WeakMap`,键是投影节点 / 投影 state 对象本身,**没有按 id 的强引用
 * 表**。上界 = 当前这一份投影自己的大小(每条节点最多挂一份成品,rev 变了是覆盖
 * 不是追加),不随会话数、不随时间增长。
 */

interface MessageMemo {
  /** 算这一份时那条节点的 `rev`(见 core 的 `BaseNode.rev`)。 */
  rev: number
  /** 算这一份时的 blob 世代(见 `materializeChatMessagesCached` 的 `blobEpoch`)。 */
  epoch: number
  message: ProjectedMessage
}

/** 节点 → 它此刻的成品。键是节点对象本身,节点没了成品跟着没。 */
const memos = new WeakMap<ProjectionNode, MessageMemo>()

/**
 * 投影 state → 上一次交出去的那个**数组实例**。
 *
 * 它不是缓存(正确性全在上面那张 memo 表里),是**实例稳定器**:逐条同一时交回
 * 上一次那个数组,于是「这一帧账本真的没变」在下游是一次引用相等,而不是一个
 * 长得一样的新数组。键是 state 对象:整份重折换新 state,旧数组随它一起消失。
 */
const lists = new WeakMap<SessionProjectionState, ProjectedMessage[]>()

export interface MaterializedChat {
  messages: ProjectedMessage[]
  activeRun?: SessionProjectionState['activeRun']
}

/**
 * 折叠状态 → 屏幕要的那一份消息,**按节点缓存**。
 *
 * 与 core 的 `materializeChatMessages` 逐条同义(同一个 `materializeNode`、同一条
 * `hidden` 过滤、同一份 `activeRun`),差别只在「不变的节点直接取上一份成品」。
 *
 * @param blobEpoch 壳的 blob 缓存世代。`resolveBlob` 读的是模块级那张表,一条 blob
 *   落盘之后成品会变,而账本没变、`node.rev` 因此不动 —— 少了这一格,附件正文
 *   会永远停在「还没读回来」的那一版。这是壳比后端多出来的一格:后端那侧的物化
 *   选项是每会话固定的,没有这个世代问题。
 */
export function materializeChatMessagesCached(
  state: SessionProjectionState,
  options: ProjectionMaterializeOptions,
  blobEpoch: number,
  /** R2:活水位。不传 = 纯账本投影,与 R2 之前逐字相同。 */
  water?: StreamWater,
): MaterializedChat {
  const next: ProjectedMessage[] = []
  for (const node of state.nodes) {
    // `hidden` 是列表成员判据,不进 `rev` —— 每次现问(见文件头)。
    if (node.hidden) continue
    next.push(mergeWater(cachedNode(node, options, blobEpoch), water))
  }
  const previous = lists.get(state)
  const messages = previous && sameList(previous, next) ? previous : next
  lists.set(state, messages)
  return { messages, ...(state.activeRun ? { activeRun: state.activeRun } : {}) }
}

function cachedNode(
  node: ProjectionNode,
  options: ProjectionMaterializeOptions,
  epoch: number,
): ProjectedMessage {
  const hit = memos.get(node)
  if (hit && hit.rev === node.rev && hit.epoch === epoch) return hit.message
  const message = materializeNode(node, options) as ProjectedMessage
  memos.set(node, { rev: node.rev, epoch, message })
  return message
}

/** 逐条**引用**相同才算同一份 —— 值相等不算数,下游短路靠的就是引用。 */
function sameList(a: readonly ProjectedMessage[], b: readonly ProjectedMessage[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

/** 只给测试用:量「这一帧真的物化了几条」。 */
export function __countMemoMisses(
  state: SessionProjectionState,
  options: ProjectionMaterializeOptions,
  blobEpoch: number,
): number {
  let misses = 0
  for (const node of state.nodes) {
    if (node.hidden) continue
    const hit = memos.get(node)
    if (!hit || hit.rev !== node.rev || hit.epoch !== blobEpoch) misses += 1
  }
  return misses
}

/* ── R2:水位合并 ───────────────────────────────────────────────────────── */

/**
 * **一条消息 = 账本投影 ∪ 活水位**(R 线 R2,`docs/stream-render-2026-09.md` L2)。
 *
 * 合并式只有一条:**每 part 取 `max(账本可画长, 活水位)`** —— 两者是同一个字符串的
 * 两个前缀(前缀定律),取长的那个。于是:
 *
 *  · **同一截只画一次**:根本没有第二份内容存在,不必对账;
 *  · **只长不缩**:两个前缀取 max,结构上不可能变短;
 *  · **打包行到达零像素变化**(第六不变式):它只让账本那一侧变长,`max` 不变。
 *
 * ── 「账本可画长」不是「账本装了多长」(cc560612 的学费)────────────────
 * 基准取的是 `contentParts` 里那一格的长度 —— 也就是**投影真画得出来的那一截**,
 * 不是 `message.content`(它把还没结算的轮次也折进去了,画的时候根本不在场)。
 * 那次事故(思考块消失 2166ms)的病根正是拿「装了」当「画得出」。
 *
 * ── 段号从哪来 ────────────────────────────────────────────────────────
 * 账本那侧由 `includePartIndex` 现给(唯一产地是投影的 `requestSettled` 那道闸,
 * 壳不判第二遍);水位那侧由 R1 的身份章带着。两边说的是同一个号。
 *
 * ── 顶部推理走另一格 ──────────────────────────────────────────────────
 * `placement:'top'` 的推理段落在 `message.reasoning`(思考块的产地),不进 parts。
 * 落点由**流自己说**(reasoning-delta 自带 placement),与从前逐字同判。
 */
function mergeWater(message: ProjectedMessage, water?: StreamWater): ProjectedMessage {
  if (!water) return message
  /*
   * **水位空着也要往下走**(09-02):中途入场那一形的定义就是「水位一格都没有」
   * —— 在这里早退等于把补账那一段(见下面「账本比 parts 长的那截」)直接关掉。
   * 水位空时下面两个循环各自空转,代价是零。
   */
  const live = water.parts(message.id)

  const ledger = (message.contentParts ?? []) as Array<{
    type?: string
    content?: string
    partIndex?: number
    turnIndex?: number
  }>
  const byIndex = new Map<number, { type?: string; content?: string; partIndex?: number; turnIndex?: number }>()
  for (const part of ledger) {
    if (part.partIndex !== undefined) byIndex.set(part.partIndex, part)
  }

  const top: WaterPartView[] = []
  const inline: WaterPartView[] = []
  for (const part of live) {
    if (part.kind === 'tool-input') continue // 参数流不进 contentParts(投影同款判据)
    if (part.kind === 'reasoning' && part.placement === 'top') top.push(part)
    else inline.push(part)
  }

  let parts = ledger
  let changed = false
  for (const part of inline) {
    const seat = byIndex.get(part.partIndex)
    const ledgerLength = seat?.content?.length ?? 0
    if (ledgerLength >= part.length) continue // 账本已经追平:水位这一格无话可说
    /*
     * **回合号:座位优先,座位缺席时用章上那一格**(09-02 真机回归的修法)。
     *
     * 账本已经有座位时以座位为准(账本是事实);而**流式期这一段还没有座位** ——
     * 从前那一句于是把回合号整个丢掉,`partTurn` 按 `?? 0` 兜底,
     * `insertDataStepsByTurn` 判定「所有工具锚点的回合都大于这一段」,把整批已经
     * 做完的工具挂到了这段新推理**后面**。屏幕上就是用户报的那一形:思考块在流,
     * 而它下面立着刚做完的工具调用。
     *
     * 一整条正文都没有的消息(推理 → 直接调工具)最容易踩到:账本那时连一个
     * content part 都没有,没有任何一格能替它说出回合。
     */
    const turnIndex = seat?.turnIndex ?? part.turnIndex
    const cell = {
      type: part.kind === 'reasoning' ? 'reasoning' : 'text',
      content: trimToGraphemeBoundary(part.text()),
      ...(turnIndex !== undefined ? { turnIndex } : {}),
      partIndex: part.partIndex,
    }
    if (!changed) { parts = [...ledger]; changed = true }
    if (seat) parts[parts.indexOf(seat)] = cell
    else insertByPartIndex(parts, cell)
  }

  // 顶部推理:`message.reasoning` 与水位取长的那个(同一个字符串的两个前缀)。
  let reasoning = message.reasoning
  for (const part of top) {
    const text = trimToGraphemeBoundary(part.text())
    if (text.length > (reasoning?.length ?? 0)) { reasoning = text; changed = true }
  }

  /*
   * ── 参数还在流的那几次调用 ──────────────────────────────────────────
   *
   * 挂在 `toolCalls` 上而不是自己造一个锚点 part:锚点是账本的坐标系
   * (`synthesizeCoreToolAnchors` 见了锚点就整条不动手),往 parts 里塞一个假锚点
   * 会把**真**锚点的合成一起关掉。挂在 `toolCalls` 上,`anchorMessage` 末尾那句
   * 「锚点没认领到的调用摆出来」自然把它排在最后 —— 而「刚刚开始的这一次」
   * 本来就该在最后。账本已经有的 id 一律不画(少一张是说谎,多一张是重影)。
   */
  /*
   * ── **中途入场 / 重连:账本已经收到、但 parts 还画不出来的那一截**(09-02 修)──
   *
   * 病历(编排者读源码审出来的真回归,链是三段合起来才成立的):
   *  ① `contentParts` 只在 `requestSettled` 之后物化(投影的那道闸);
   *  ② `anchorMessage` 只在 parts **整个为空**时才回落 `message.content`;
   *  ③ 水位表按连续前缀律收 delta —— 中途入场那一刻收到的第一条偏移不为 0,
   *     按律丢掉(**这是对的**:带洞的字符串比没有更坏)。
   * 三条各自都对,合起来就是:当前这一个请求已经流出来的正文,**既不在水位、
   * 也不在 parts**,屏幕上一个字都没有,一直等到 `run/end`。而「账本 ≤2s 自愈」
   * 在这里不成立 —— 打包行只让 `message.content` 变长,不物化 parts。
   *
   * 旧路本来有这条(6ce26668 的第 ② 条「账本正文比 parts 长的那截照样画」),
   * R2 把拼装机器整条退役时一并带走了。这里把它按新坐标系接回来。
   *
   * ── 三条判据,一条都不能少 ────────────────────────────────────────────
   *  · **只在账本比画得出来的长时补**,补的是那一截差额;
   *  · **必须是前缀关系**(`startsWith`)。不是前缀 = 两边说的不是同一个字符串
   *    (水位领先、或者段序错开),那时**一个字都不补** —— 宁可少画一截,
   *    不肯画错位置(这条不对称决定了所有取舍,与增量解析器那条同源);
   *  · **不引回尾巴**:补出来的是一格 `contentParts`,走的还是 parts 那套坐标系,
   *    没有第二条内容车道。
   *
   * ── 记档:两处已知的照不到 ────────────────────────────────────────────
   *  · 未结算请求里的**行内推理**补不出来 —— `message.content` 是正文,推理不在
   *    里面,账本侧没有第二个产地可比(顶部推理有 `message.reasoning`,不受影响);
   *  · 「水位领先某一段 + 另一段中途入场」混在一起时前缀关系不成立,按上面第二条
   *    整段作废。两条都不静默:它们各是一次 `stream.water.divergence` 之外的
   *    「照不到」,写在这里而不是假装已经盖住。
   */
  const drawnText = parts
    .filter(part => part.type === 'text')
    .map(part => part.content ?? '')
    .join('')
  const ledgerContent = message.content ?? ''
  if (ledgerContent.length > drawnText.length && ledgerContent.startsWith(drawnText)) {
    /*
     * 回合号取「这条消息此刻**最佳可知**的那个」:水位章上的(最准)、账本 parts 上的、
     * steps 上的,三者取大。这一截按定义属于**当前**这个请求,而当前请求排在所有
     * 已经落地的工具之后 —— 取大正好让 `insertDataStepsByTurn` 把那些锚点排在它前面。
     *
     * 它是**推断**不是事实:真正权威的号在身份章上,而中途入场这一形按定义没有章
     * (第一条 delta 就被连续前缀律丢了)。所以这里写明是最佳可知值,不假装是事实。
     */
    const currentTurn = Math.max(
      0,
      ...live.map(part => part.turnIndex ?? 0),
      ...ledger.map(part => part.turnIndex ?? 0),
      ...((message.steps ?? []) as Array<{ turnIndex?: number }>).map(step => step.turnIndex ?? 0),
    )
    if (!changed) { parts = [...ledger]; changed = true }
    parts.push({
      type: 'text',
      content: ledgerContent.slice(drawnText.length),
      turnIndex: currentTurn,
    })
  }

  const ledgerCallIds = new Set((message.toolCalls ?? []).map(call => call.id))
  const liveTools = water.tools(message.id).filter(tool => !ledgerCallIds.has(tool.id))
  if (liveTools.length > 0) changed = true

  if (!changed) return message
  return {
    ...message,
    ...(liveTools.length > 0
      ? {
          toolCalls: [
            ...(message.toolCalls ?? []),
            ...liveTools.map(tool => ({
              id: tool.id,
              toolId: tool.toolName,
              toolName: tool.toolName,
              arguments: {},
              // 后端自己那份占位调用写的正是这一档(`createCoreToolInputStartArtifacts`)。
              status: 'input-streaming',
              timestamp: tool.timestamp,
              streamingArgs: tool.argsText(),
            })),
          ] as ProjectedMessage['toolCalls'],
        }
      : {}),
    ...(reasoning !== message.reasoning ? { reasoning } : {}),
    contentParts: parts,
    // `content` 是正文那几格拼起来的 —— 单一产地,不另存一份。
    content: parts.filter(part => part.type === 'text').map(part => part.content ?? '').join(''),
  } as ProjectedMessage
}

/**
 * 按段号插进去(账本还没结算出这一格时)。
 *
 * 没有段号的老格(`includePartIndex` 关着,或 image/provider-data 这类)一律当**更早**
 * 处理 —— 它们是已经落定的东西,活水位那几格永远在它们之后。
 */
function insertByPartIndex(
  parts: Array<{ partIndex?: number }>,
  cell: { partIndex: number },
): void {
  const at = parts.findIndex(part => part.partIndex !== undefined && part.partIndex > cell.partIndex)
  if (at < 0) parts.push(cell)
  else parts.splice(at, 0, cell)
}

/**
 * **渲染边界向字素边界收一格**(审查条 6)。
 *
 * 偏移按 UTF-16 码元数(与 `String.length`、与打包行的 `len` 同一把尺 —— 那一层不能
 * 改,不然两边对不上)。但分片是按码元切的,一条 delta 完全可能停在一个**代理对的
 * 中间**:半个 emoji 在屏幕上是一格 `�`,下一帧才补全 —— 一帧乱码,肉眼看得见。
 *
 * 所以收格只发生在**画**的这一刻,不动存的那一份:末尾是落单的高位代理(还等着
 * 它的低位)、或是零宽连接符 / 变体选择符(它们后面必然还有字,单独结尾就是半个
 * 字素),就先不画那一小截。下一片一到自然补上。
 *
 * 只看结尾那两三个码元,不做整段字素切分 —— 这条路每帧都走,`Intl.Segmenter`
 * 扫全段是十万字级的浪费,而**只有结尾**可能半截。
 */
const ZERO_WIDTH_JOINER = 0x200d
const VARIATION_SELECTOR_START = 0xfe00
const VARIATION_SELECTOR_END = 0xfe0f

export function trimToGraphemeBoundary(text: string): string {
  const last = text.charCodeAt(text.length - 1)
  if (Number.isNaN(last)) return text
  // 落单的高位代理:它的低位还没到,单独画出来就是一格乱码。
  if (last >= 0xd800 && last <= 0xdbff) return text.slice(0, -1)
  // 连接符 / 变体选择符结尾:后面一定还有字,现在画就是半个字素。
  if (last === ZERO_WIDTH_JOINER) return text.slice(0, -1)
  if (last >= VARIATION_SELECTOR_START && last <= VARIATION_SELECTOR_END) return text.slice(0, -1)
  return text
}
