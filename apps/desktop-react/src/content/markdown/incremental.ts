import { perfSpan } from '../../services/perf'
// 注册 barrel:早成形政策(`stream.earlyForm`)住在各型自己的注册契约里,查表发生在
// 这里,所以这里负责保证表是装好的(与 BlockView 同款)。
import '../blocks'
import { blockEarlyForms } from '../blocks/registry'
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
 *  ② **正在出生的那一型提前认**:活尾巴那一块的源码递给注册表里声明了 `earlyForm`
 *     的几型,补一刀重解析,**真是那一型才认**(`applyEarlyForm`)。R4a 之前这一条
 *     写死认识表(`upgradeTableTail`),现在政策住在型自己的注册契约里。
 *     09-01 撤掉了它的前身「未闭合的原子块按 code 显示」——病历在 `toFrame` 的注里。
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
  /** 与 blocks 一一对应的源偏移 —— 旧路 key 的产地。 */
  offsets: number[]
  /**
   * 与 blocks 一一对应的**块流身份号**(R4a)。旧路(`onething.blockStream=off`)
   * 缺席 —— 那条路上身份仍由渲染侧按源偏移现算。
   */
  ids?: readonly string[]
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

/**
 * 「这中间没画过」的门槛(审查条 8)。
 *
 * 正常直播两次真解析之间是 16ms 量级;隔了 2 秒还没画过,只可能是窗口不可见 /
 * 主线程被别的事占死。那一刻回来别追帧,当第一次解析。
 */
export const STALE_PARSE_MS = 2000

export class MarkdownStream {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * @param id    这段文本的身份(消息 id + 段序号)。缓存按它分。
   * @param live  这条消息此刻是不是还在生成 —— 决定「贴着结尾的原子块要不要按 code 画」。
   */
  parse(id: string, text: string, live: boolean): MarkdownFrame {
    return toFrame(this.parseBlocks(id, text, live).parsed, text, live)
  }

  /**
   * 与 `parse` 同一条路,但把**解析事实**原样交出去:块序列 + 这一份文本上的安全切点。
   *
   * 块流生产者(block-stream.ts)要的正是这两样 —— `end` 判「这一块贴不贴着活尾巴」,
   * `cut` 判「这一块能不能提交(从此不再变)」。`parse` 是它的投影(丢掉 `end`/`cut`),
   * 两条路**同一个函数体**,不会分叉。
   */
  parseBlocks(id: string, text: string, live: boolean): { parsed: readonly ParsedBlock[]; cut: number } {
    const prev = this.entries.get(id)

    // 同一份文本再问一次:上一帧的答案逐字有效(React 重渲染很常见,别重解析)。
    if (prev && prev.text === text) return { parsed: prev.parsed, cut: prev.cut }

    /*
     * **停摆太久 = 不追帧,直接全量**(R2 审查条 8)。
     *
     * 窗口最小化 / 切到别的应用时 rAF 停摆,而 delta 照灌。恢复可见那一刻,增量那条路
     * 要拿「上一份解析」去接一大段积压的文本 —— 切点越旧、要重解析的尾巴越长,
     * 堆出来的就是 1153ms 级的长帧(P0 那次性能事故的形)。
     *
     * 判据不看 `document.visibilityState`:那要挂一个 DOM 监听(模块级副作用,还要配
     * dispose),而**要防的事**用一个数就说得清 —— 距上一次真解析超过 `STALE_PARSE_MS`,
     * 说明这中间根本没画过,那就当第一次解析(等价落定路)。
     */
    const appended =
      prev !== undefined
      && text.startsWith(prev.text)
      && this.now() - prev.at <= STALE_PARSE_MS

    if (appended && this.now() - prev.at < PARSE_INTERVAL_MS) {
      const spliced = spliceTail(prev.parsed, prev.text, text)
      // 贴上了就用贴的:**不写回缓存** —— 下一帧仍以上次真解析的那份为基准,
      // 于是「一直有帧来」不会让真解析被无限推迟(窗口一过必解析)。
      // 切点照旧用上一份自己的(它对更长的前缀一样安全,理由见 `reparseTail`)。
      if (spliced) return { parsed: spliced, cut: prev.cut }
    }

    // 打点埋在**真解析**那一格,不埋整个 parse:上面两条早退(同一份文本 / 贴尾巴)
    // 本来就是为了不解析而存在的,把它们也算进来会让读数被一堆 0 稀释。
    const parsed = perfSpan('markdown.reparse', () => {
      const base = appended ? this.reparseTail(prev, text) : parseMarkdown(text)
      // 还在长的那条路上才补分隔行:落定的文本是什么就是什么,补一刀就是两条路分叉
      // (`gate:stream-structure` 的「流式末帧 == 冷加载」盯的正是这件事)。
      return live ? applyEarlyForm(base, text) : base
    })
    const cut = stableCut(text)
    this.entries.set(id, { text, parsed, cut, at: this.now() })
    return { parsed, cut }
  }

  /** 这条消息不流了(或被换掉了):把它的帧缓存丢掉。 */
  forget(id: string): void {
    this.entries.delete(id)
  }

  /** 整份丢掉 —— 唯一的一口拆卸(HMR 退役复用它,不写第二套)。 */
  reset(): void {
    this.entries.clear()
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
 * 最后一步:**块序列 → 帧**。
 *
 * ── 从前这里有一条「未闭合的原子块按 code 显示」,09-01 撤掉 ──────────────
 * 原话是「一张正在长的表此刻画成半张表是噪声,按代码原样长出来才诚实」,退出条件
 * 是 `text.endsWith('\n')`(行末落定就换装),外加一道单向闸防它来回翻。
 *
 * **退出条件是掷骰子**:一帧的文本结不结束在换行上,由 provider 的分片与 coalescer
 * 的批次说了算,与"这张表长完了没有"无关。用户 09-01 的录屏逐帧:七列八行的一张表
 * 从 2.3s 到收尾**全程是代码块**(Copy source 檐),一次都没掷中,直到 run 收尾
 * `live` 变假才换成表。屏幕上就是「一大坨源码摆了三秒」—— 比它要防的「半张表」难看
 * 得多,而且那半张表本来也不存在:GFM 只在**完整的分隔行**之后才判它是表,判成表的
 * 那一刻列结构已经定了,后面只会一行行追加。
 *
 * 所以撤掉:**表一被解析成表,屏幕上就是表**,行随流长。单向闸(`formed`)是那条
 * 降级的配套护栏,一并退役 —— 没有降级就没有来回翻。`gate:stream-structure` 的 C 条
 * 从「成形后不再降级」加严成「一张表从头到尾不许以源码示人」(I 条)。
 *
 * `figure` 从来不走这条:围栏路由(fence.ts)只在围栏**闭合**时产出 figure,
 * 没闭合的那段图源码本来就是 `code(closed:false)`。
 */
function toFrame(parsed: readonly ParsedBlock[], _text: string, _live: boolean): MarkdownFrame {
  const blocks: BlockModel[] = []
  const offsets: number[] = []
  for (const entry of parsed) {
    blocks.push(entry.block)
    offsets.push(entry.offset)
  }
  return { blocks, offsets }
}

/**
 * **正在出生的那一型,提前一步认出来 —— 由型自己认领**(R4a 把政策从这里收走)。
 *
 * ── 从前 ──────────────────────────────────────────────────────────────
 * 这个函数从前叫 `upgradeTableTail`,它认识**表**:认识分隔行长什么样、认识 GFM 的
 * 列数规矩、认识「补出来的字不许上屏」。也就是说增量层认识一种块 —— 而六轮事故的
 * 元凶正是这种「政策渗进机制」:机制每认识一型就多长一根倒刺。
 *
 * ── 现在 ──────────────────────────────────────────────────────────────
 * 它只剩三步,一步都不认识表:
 *  ① 问注册表:哪几型声明了 `stream.earlyForm`(表是今天唯一的一行);
 *  ② 把活尾巴那一块的源文本递过去,拿回「补齐后的源文本」;
 *  ③ 重解析一次 —— **末块真的是声明者那一型才认**,否则整段作废、一个字不改。
 *
 * 三条纪律原样保留(它们是机制的纪律,不是表的):
 *  · 只碰**最后一块**,而且必须贴着活尾巴 —— 围栏里的表(末块是 code)与已经落定
 *    的段落都不在射程内;
 *  · 补出来的字**一个都不上屏**:末块的 `end` 夹回真实文本长度,补的那几格只是给
 *    解析器看的脚手架;
 *  · 认不出就整段作废 —— 最坏情况是白算一次(一小段文本的解析)。
 *
 * 判据里那句「必须是 paragraph」也一并退役:它当初是「表从段落里长出来」这条**表的**
 * 事实的化身。现在的判据是型无关的 —— 末块贴着活尾巴、而且补齐后解析出来换了型。
 */
function applyEarlyForm(parsed: ParsedBlock[], text: string): ParsedBlock[] {
  const last = parsed[parsed.length - 1]
  if (!last || last.end < text.length) return parsed
  const source = text.slice(last.offset)

  for (const { kind, earlyForm } of blockEarlyForms()) {
    // 已经是这一型了就没什么可提前的 —— 提前成形说的是「还没被认出来」。
    if (last.block.kind === kind) continue
    const completed = earlyForm(source)
    if (completed === undefined) continue
    const sub = parseMarkdown(completed)
    if (sub.length === 0 || sub[sub.length - 1].block.kind !== kind) continue
    return [
      ...parsed.slice(0, -1),
      ...sub.map((entry, index) => ({
        block: entry.block,
        offset: entry.offset + last.offset,
        end: index === sub.length - 1 ? text.length : entry.end + last.offset,
      })),
    ]
  }
  return parsed
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
