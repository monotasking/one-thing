import { perfCount } from '../../services/perf'
import type { BlockEvent, BlockId } from '../blocks/stream/events'
import { BlockStreamMachine, type BlockNode } from '../blocks/stream/machine'
import type { BlockModel } from '../model/blocks'
import { MarkdownStream } from './incremental'
import { parseMarkdown } from './parse'
import type { ParsedBlock } from './to-blocks'

/**
 * **markdown = 块流的第一个生产者**(R4a,设计 §R4「IR 反转」条)。
 *
 * 从前 markdown 是脊柱:块层的供货合同就是「解析器每帧交一份新的块列表」,块因此
 * 是一次性对象,身份靠渲染侧按源偏移现算。现在它降级成一个**生产者** —— 内部照旧
 * micromark/mdast(一个字没改),对外只发块流那七个词。
 *
 * ── 这一层干的唯一一件事:把「一份重新算出来的块列表」翻成「单调的提交流」──────
 *
 * 每帧拿到解析结果之后,与上一帧的账逐格对:
 *
 *  · 同位、同号、model 逐字相同 → **不发事件**,块实例连同它的 model 原样留着
 *    (`BlockView` 的 memo 是浅比 —— 这一格就是「块树操作代价 O(变化行数)」的兑现处);
 *  · 同位、同号、model 变了 → `append`(整行落定)或 `tail`(半截活行);
 *  · 号对不上 → 从尾巴往回 `retract`,再 `open` 新的。**只在尾巴上收**,前面提交过的
 *    一格都不动 —— 机器的 L3 盯着这一条;
 *  · 结尾贴着安全切点之前的块 → `close`,从此它的 model 永不再变(机器的 L2)。
 *
 * ── `append` 与 `tail` 的分家 = 「结构只在行界变」───────────────────────
 * 判据是**这一块是不是贴着流的末尾、而流又不以换行结束**:是就是活尾槽(`tail`),
 * 只换画面;否则是提交(`append`)。于是一帧里结构动没动 =「有没有 append/open/
 * close/retract」,是一个可以逐帧数出来的数(`machine.lastStructuralOps`)。
 *
 * **一个例外,而且是声明出来的例外**:早成形认领(`stream.earlyForm`)可以在行中间
 * 换型 —— 表的分隔行最后一个 `|` 一到,段落当场变表,那一帧没有换行却动了结构。
 * 它是政策,不是机制的漏洞:注册契约里写着,断言里也照它分格(见测试)。
 *
 * ── 身份号 ────────────────────────────────────────────────────────────
 * `${源偏移}:${kind}` —— 产地派生(契约里的 `identity: 'origin'`)。为什么不是一个
 * 不透明计数器,理由写在 events.ts 的 `BlockId` 注里(一句话:直播 / 收尾 / 重折 /
 * 冷加载四条路必须给出同一个号,而计数器活在一台机器实例里)。
 *
 * ── 一条消息一台机器 ──────────────────────────────────────────────────
 * 按 `(messageId, 段序号)` 各持有一台,不做模块级单例(R2 审查条 4 的同一条法)。
 */

export interface BlockStreamFrame {
  blocks: BlockModel[]
  ids: BlockId[]
  offsets: number[]
}

interface Rec {
  id: BlockId
  kind: string
  offset: number
  end: number
  model: BlockModel
  closed: boolean
}

interface Lane {
  machine: BlockStreamMachine
  recs: Rec[]
  /** 上一帧看到的那两个计数器 —— 只在**涨了**的那一帧记账,见 `frame` 里的注。 */
  telemetry: { violations: number; revivals: number }
}

export class MarkdownBlockStream {
  private readonly md: MarkdownStream
  private readonly lanes = new Map<string, Lane>()

  constructor(now: () => number = () => Date.now()) {
    this.md = new MarkdownStream(now)
  }

  /**
   * 喂一帧。返回**此刻那棵树**的投影(块 + 身份号 + 源偏移)。
   *
   * @param live 还在生成吗 —— 决定早成形要不要试、活尾槽存不存在、要不要收尾关块。
   */
  frame(id: string, text: string, live: boolean): BlockStreamFrame {
    const lane = this.lane(id)
    const { parsed, cut } = this.md.parseBlocks(id, text, live)
    const events = reconcile(lane.recs, parsed, text, live ? cut : text.length, live)
    lane.machine.applyAll(events)
    /*
     * **「理论不可能」的两个计数器接可见面**(设计审查条 13)。
     *
     * 机器生产态永不抛(dev 也在这一侧),于是违法与复生这两件事从前只活在一个
     * 内存里的数上 —— 没人看得见就等于没记。这里在**它们真的涨了**的那一帧记一笔
     * 进性能环(HUD 与通知中心的诊断区读同一份),节流去重在 `perfCount` 里。
     *
     * 比的是「涨了没有」不是「大于零」:大于零会每帧记一笔,把 200 格的环冲干净。
     */
    const seen = lane.telemetry
    const now = { violations: lane.machine.violations, revivals: lane.machine.revivals }
    if (now.violations > seen.violations) {
      perfCount('stream.block.violation', { lane: id, total: now.violations })
    }
    if (now.revivals > seen.revivals) {
      perfCount('stream.block.revival', { lane: id, total: now.revivals })
    }
    lane.telemetry = now
    return project(lane.machine.snapshot())
  }

  /** 这一帧动了几处结构 —— 行界断言与读数量它(测试与门用)。 */
  structuralOps(id: string): number {
    return this.lanes.get(id)?.machine.lastStructuralOps ?? 0
  }

  /** 「理论不可能」的两个计数器(违法 / 复生)。 */
  telemetry(id: string): { violations: number; revivals: number } {
    const machine = this.lanes.get(id)?.machine
    return { violations: machine?.violations ?? 0, revivals: machine?.revivals ?? 0 }
  }

  /** 这条消息不流了(或被换掉了):整条车道丢掉。 */
  forget(id: string): void {
    this.lanes.delete(id)
    this.md.forget(id)
  }

  /** 整份丢掉 —— 唯一的一口拆卸(HMR 退役复用它,不写第二套)。 */
  reset(): void {
    this.lanes.clear()
    this.md.reset()
  }

  private lane(id: string): Lane {
    let lane = this.lanes.get(id)
    if (!lane) {
      lane = { machine: new BlockStreamMachine(), recs: [], telemetry: { violations: 0, revivals: 0 } }
      this.lanes.set(id, lane)
    }
    return lane
  }
}

/** 身份号的产地(契约 `identity: 'origin'`)。 */
function originId(entry: ParsedBlock): BlockId {
  return `${entry.offset}:${entry.block.kind}`
}

/** 号的第一格就是源偏移 —— 与 `originId` 是一对,改一处必须改两处。 */
function originOffset(id: BlockId): number {
  return Number.parseInt(id, 10)
}

/**
 * **不流的那一份**:一次全量解析,不起机器、不留车道。
 *
 * 历史消息 / 冷加载 / 收尾后的那一帧走这条。它给出的号与直播那条路**逐字相同** ——
 * 号是产地派生的,而两条路对同一段文本给出同一份解析(这正是
 * `gate:stream-structure` 那条「流式末帧 == 冷加载」在钉的事)。所以收尾那一刻
 * React 看到的 key 一个都没变,不重挂;重折之后同理。
 *
 * 这也是为什么号不能是计数器:计数器活在一台机器实例里,这条无状态的路给不出它。
 */
export function parseBlockFrame(text: string): BlockStreamFrame {
  const parsed = parseMarkdown(text)
  return {
    blocks: parsed.map((entry) => entry.block),
    ids: parsed.map(originId),
    offsets: parsed.map((entry) => entry.offset),
  }
}

/**
 * 一份新解析 → 一串事件。**这里是 markdown 的政策**(机制在 machine.ts)。
 *
 * `recs` 就地更新成新的账 —— 它是生产者自己的账本,与机器里那棵树一一对应。
 */
function reconcile(
  recs: Rec[],
  parsed: readonly ParsedBlock[],
  text: string,
  cut: number,
  live: boolean,
): BlockEvent[] {
  const events: BlockEvent[] = []
  // 活尾槽住在哪一格:贴着流末尾、而流不以换行结束的那一块。收尾之后没有活尾槽。
  const tailIndex = live && !text.endsWith('\n') ? parsed.length - 1 : -1

  let i = 0
  for (; i < parsed.length && i < recs.length; i += 1) {
    const rec = recs[i]
    const entry = parsed[i]
    if (rec.id !== originId(entry)) break
    rec.end = entry.end
    // 引用相等是快路:增量解析对稳定前缀**沿用同一批对象**,所以头部一路命中。
    if (rec.model === entry.block || sameModel(rec.model, entry.block)) continue
    rec.model = entry.block
    events.push(
      i === tailIndex
        ? { op: 'tail', id: rec.id, model: entry.block }
        : { op: 'append', id: rec.id, model: entry.block },
    )
  }

  // 对不上的那一段:**从尾巴往回撤**(机器只收末块的 retract)。
  for (let k = recs.length - 1; k >= i; k -= 1) {
    events.push({ op: 'retract', id: recs[k].id })
  }
  recs.length = i

  for (let k = i; k < parsed.length; k += 1) {
    const entry = parsed[k]
    const rec: Rec = {
      id: originId(entry),
      kind: entry.block.kind,
      offset: entry.offset,
      end: entry.end,
      model: entry.block,
      closed: false,
    }
    recs.push(rec)
    events.push({ op: 'open', id: rec.id, kind: rec.kind, model: rec.model })
  }

  /*
   * **关块 = 提交到此为止**。
   *
   * 判据是增量层那个安全切点:「前 N 个字符的解析不会被后面追加的字符改掉」。结尾
   * 落在它之前的块,后面再来多少字都改不动它 —— 那正是 `close` 那句「从此不再变」的
   * 定义,一个字都不用另编。收尾(`live===false`)时切点取整段长度,全体关闭。
   *
   * 切点保守(见 stable-cut.ts:见过一次列表 / 引用 / 表的起手式之后整篇不再前进),
   * 所以很多真实文档里能关的块不多。这不是本期要治的事:关不了的块照样有稳定身份号
   * 与 model 复用,只是少了那句「机器替你担保它不会再变」。
   */
  for (const rec of recs) {
    if (!rec.closed && rec.end <= cut) {
      rec.closed = true
      events.push({ op: 'close', id: rec.id })
    }
  }

  return events
}

/** 机器那棵树 → 渲染要的三列。容器今天不产(留账见 kinds/quote/index.ts)。 */
function project(nodes: readonly BlockNode[]): BlockStreamFrame {
  const blocks: BlockModel[] = []
  const ids: BlockId[] = []
  const offsets: number[] = []
  for (const node of nodes) {
    // 容器(`model` 缺席)今天没有生产者 —— 真出现了跳过它比画一个空壳诚实。
    if (!node.model) continue
    blocks.push(node.model)
    ids.push(node.id)
    // 号里就带着产地(`identity: 'origin'`),所以偏移是从号上**读**回来的,不是
    // 另存一份 —— 两份会分叉。`offsets` 这一列还留着是因为旧路与工具产地的块序列
    // 都还按它发 key(段模型那一格的注里写了为什么两列并存不算重复)。
    offsets.push(originOffset(node.id))
  }
  return { blocks, ids, offsets }
}

/**
 * 两份块模型逐字相同吗。
 *
 * 只在**重解析过的那一段尾巴**上跑(头部走引用相等的快路),所以它的代价与那一段的
 * 解析代价同阶 —— 不会引入新的 O(文档)。写死循环而不是 `JSON.stringify` 比较:
 * 后者对一份长代码块要造两个大字符串,而这里十次有九次在第一个不同的字段上就返回。
 */
function sameModel(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) if (!sameModel(a[i], b[i])) return false
    return true
  }
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  for (const key of ka) {
    if (!(key in (b as object))) return false
    if (!sameModel((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false
  }
  return true
}
