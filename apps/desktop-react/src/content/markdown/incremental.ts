import { perfSpan } from '../../services/perf'
import type { BlockModel } from '../model/blocks'
import { parseMarkdown } from './parse'
import { stableCut } from './stable-cut'
import type { ParsedBlock } from './to-blocks'

/**
 * **流式的那一半**(§6)。
 *
 * 活跃消息每来一帧就换一次引用,装配管线跟着重跑一次 ④。这个类接住那件事,做三件:
 *
 *  ① **稳定前缀沿用**:切点之前的块整块复用,只重解析活动尾(切点判据见 stable-cut.ts)。
 *  ② **未闭合的原子块按 code 显示**:贴着活尾巴的 table / figure 还没成形,先按代码
 *     逐行长出来,闭合那一刻原位换装。
 *  ③ **每帧至多解析一次**:16ms 节拍(与 SessionStreamCoalescer 同一个批)。窗口里
 *     又来一帧时不重解析,把新来的字符**贴到最后一块的尾巴上** —— 这不是近似:
 *     活尾巴纪律(D3)保证流式期间的变化只有「文本追加」,而纯文本追加落在段落或
 *     未闭合围栏上就是这个动作。贴不安全时(追加里含空行或围栏起手式)当场退回解析。
 *
 * ── 为什么它是一个类,而不是几个模块级函数 ────────────────────────────
 * 它有状态(每条活跃消息一份上一帧的解析)。状态藏在模块里,用例之间就会互相污染,
 * 而这里要测的恰恰是**跨帧行为**(key 稳不稳、切点对不对)。生产侧只有下面那一个单例。
 */

export interface MarkdownFrame {
  blocks: BlockModel[]
  /** 与 blocks 一一对应的源偏移 —— key 的产地。 */
  offsets: number[]
}

interface Entry {
  text: string
  parsed: ParsedBlock[]
  /**
   * 这一份解析**自己**的安全切点(`stableCut(text)`)。
   *
   * 记下来而不是下一帧现算,是因为下一帧要的恰恰是「在**旧文本**上成立的切点」——
   * 见 `reparseTail` 的病历。安全切点的性质是「前 N 个字符的解析不会被后面追加的
   * 字符改掉」,而旧文本是新文本的前缀,所以旧文本上的安全切点对新文本一样安全。
   */
  cut: number
  /** 上一次**真的解析**的时刻,节流窗按它算。 */
  at: number
}

/** 与 SessionStreamCoalescer 同一个节拍:16ms 一批。 */
export const PARSE_INTERVAL_MS = 16

export class MarkdownStream {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * @param id    这段文本的身份(消息 id + 段序号)。缓存按它分。
   * @param live  这条消息此刻是不是还在生成 —— 决定「贴着结尾的原子块要不要按 code 画」。
   */
  parse(id: string, text: string, live: boolean): MarkdownFrame {
    const prev = this.entries.get(id)

    // 同一份文本再问一次:上一帧的答案逐字有效(React 重渲染很常见,别重解析)。
    if (prev && prev.text === text) return toFrame(prev.parsed, text, live)

    const appended = prev !== undefined && text.startsWith(prev.text)

    if (appended && this.now() - prev.at < PARSE_INTERVAL_MS) {
      const spliced = spliceTail(prev.parsed, prev.text, text)
      // 贴上了就用贴的:**不写回缓存** —— 下一帧仍以上次真解析的那份为基准,
      // 于是「一直有帧来」不会让真解析被无限推迟(窗口一过必解析)。
      if (spliced) return toFrame(spliced, text, live)
    }

    // 打点埋在**真解析**那一格,不埋整个 parse:上面两条早退(同一份文本 / 贴尾巴)
    // 本来就是为了不解析而存在的,把它们也算进来会让读数被一堆 0 稀释。
    const parsed = perfSpan('markdown.reparse', () =>
      appended ? this.reparseTail(prev, text) : parseMarkdown(text),
    )
    this.entries.set(id, { text, parsed, cut: stableCut(text), at: this.now() })
    return toFrame(parsed, text, live)
  }

  /** 这条消息不流了(或被换掉了):把它的帧缓存丢掉。 */
  forget(id: string): void {
    this.entries.delete(id)
  }

  private reparseTail(prev: Entry, text: string): ParsedBlock[] {
    /*
     * 切点用**上一份解析自己的**安全切点,不在新文本上现算再夹长度。
     *
     * ── 病历:`---` 被夹成 `-` + `--`,分隔线整条消失(08-31 真机报障)──────
     * 从前这里是 `Math.min(stableCut(text), prev.text.length)`。`stableCut` 返回的
     * 一定是**行首**,但 `prev.text.length` 是「上一帧收到的字符数」—— 它落在哪儿
     * 由网络分片说了算,压根不是行首。两者一取 min,夹出来的切点就可能停在一行**中间**,
     * 而这整个函数的前提是「前缀里最后一块的结尾之后到切点之间只可能是空行」。
     *
     * 真机上它是这样炸的(素材 `一段话\n\n---\n\n## 标题`,8 字一帧):
     *   帧 A 收到 `一段话\n\n-`      → 解析成 [段落, 列表](孤零零一个 `-` 是列表起手式)
     *   帧 B 收到 `…\n\n---\n\n## 分` → stableCut=`##` 行首(20),夹到 16 = 那个 `-` 之后
     *                                  → 沿用了帧 A 那个**列表**,尾巴从 `--` 起解析
     *                                  → [段落, 列表, 段落("--"), 标题],divider 没了
     * 屏幕上于是只剩一段空白:空列表画不出东西,`--` 是两个字符宽的一小段。全量解析
     * 同一段文本给的是 [段落, divider, 标题] —— 流式与最终结果不一致,正是 §6 顶在
     * 最前面那条不对称(宁可多解析一次)要挡住的事。这条不只坑 `---`:任何块的**起手行**
     * 被帧边界切开都会中招(`## 标题` 切成 `#` + `# 标题` 同理)。
     *
     * 修法不是把 min 改精确,是**别再算第二个切点**:`prev.cut` 是上一份解析在
     * 它自己的文本上算出的安全切点,天然 ≤ `prev.text.length` 且一定在行首;
     * 而「安全」的定义就是「后面再追加字符也不会改前面的解析」,旧文本是新文本的
     * 前缀,所以它对新文本一样安全。切点因此比从前晚一帧前进 —— 这是对的方向:
     * 早一帧前进换来的是可能切错,而切错的代价是屏幕说谎。
     */
    const cut = prev.cut
    if (cut <= 0) return parseMarkdown(text)

    const head = prev.parsed.filter((entry) => entry.end <= cut)
    if (head.length === 0) return parseMarkdown(text)
    // 前缀里最后一块的结尾之后到切点之间只可能是空行 —— 从切点起解析,偏移整体平移。
    const tail = parseMarkdown(text.slice(cut)).map((entry) => ({
      block: entry.block,
      offset: entry.offset + cut,
      end: entry.end + cut,
    }))
    return [...head, ...tail]
  }
}

/**
 * 节流窗里的「贴尾巴」。
 *
 * 只贴两种落点:未闭合围栏(逐行 append,正是它的常态)、末尾段落的末尾文字节点。
 * 追加里一旦含空行(会开新块)或围栏起手式(会换块型),就不贴 —— 返回 undefined,
 * 上面当场退回真解析。**宁可多解析一次,不可显示一份和最终结果不同的东西。**
 */
function spliceTail(parsed: ParsedBlock[], oldText: string, text: string): ParsedBlock[] | undefined {
  const delta = text.slice(oldText.length)
  if (delta === '') return parsed
  if (delta.includes('\n\n') || delta.includes('```') || delta.includes('~~~')) return undefined

  const last = parsed[parsed.length - 1]
  if (!last || last.end !== oldText.length) return undefined

  const grown = growBlock(last.block, delta)
  if (!grown) return undefined
  return [...parsed.slice(0, -1), { block: grown, offset: last.offset, end: text.length }]
}

function growBlock(block: BlockModel, delta: string): BlockModel | undefined {
  if (block.kind === 'code' && !block.closed) {
    return { ...block, source: block.source + delta }
  }
  if (block.kind === 'paragraph') {
    const last = block.inline[block.inline.length - 1]
    // 只往「末尾就是一段纯文字」上贴:末尾是行内码 / 链接 / 强调时,追加的字符
    // 属于它还是属于它后面,只有解析器说了算。
    if (!last || last.type !== 'text') return undefined
    if (delta.includes('\n')) return undefined
    return {
      kind: 'paragraph',
      inline: [...block.inline.slice(0, -1), { type: 'text', text: last.text + delta }],
    }
  }
  return undefined
}

/**
 * 最后一步:**未闭合的原子块按 code 显示**。
 *
 * 判据是「这一块贴着活尾巴,而文本还没换行落定」—— 一张正在长的表此刻画成半张表
 * 是噪声,按代码原样长出来才诚实。闭合(有了换行,或这条消息不流了)那一刻,它按
 * 自己真正的 kind 换装 —— key 由源偏移派生,所以换装是**原位**的,前后的块一个都不重挂。
 *
 * 这里只管 `table`。`figure` 不需要:围栏路由(fence.ts)本来就只在围栏**闭合**时
 * 才产出 figure,没闭合的那段图源码从头到尾就是一个 `code(closed:false)` ——
 * 一个判据在一处成立就够了,不必在这儿再判一遍(判两遍迟早会分叉)。
 */
function toFrame(parsed: readonly ParsedBlock[], text: string, live: boolean): MarkdownFrame {
  const blocks: BlockModel[] = []
  const offsets: number[] = []
  const tailOpen = live && !text.endsWith('\n')

  for (let i = 0; i < parsed.length; i += 1) {
    const entry = parsed[i]
    const atTail = tailOpen && i === parsed.length - 1 && entry.end >= text.length
    blocks.push(atTail ? asOpenCode(entry.block, text.slice(entry.offset, entry.end)) : entry.block)
    offsets.push(entry.offset)
  }
  return { blocks, offsets }
}

function asOpenCode(block: BlockModel, source: string): BlockModel {
  if (block.kind !== 'table') return block
  return { kind: 'code', lang: null, source, closed: false }
}

/**
 * 不流的那一份:一次全量解析,不进任何缓存。
 *
 * 历史消息走这条 —— 它们由装配管线按消息引用 memo(assemble/index.ts),再在这里
 * 存一份就是两套失效逻辑。流式缓存只服务活跃消息,活跃消息永远只有一条。
 */
export function parseFrame(text: string): MarkdownFrame {
  return toFrame(parseMarkdown(text), text, false)
}

/** 生产侧那一个。测试各起各的(节拍要能拨)。 */
export const markdownStream = new MarkdownStream()
