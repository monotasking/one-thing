/**
 * **正在出生的那张表**(09-01 用户复测报障:「表格问题没有修复」,附录屏)。
 *
 * ── 病历:两形,一条根 ────────────────────────────────────────────────
 * 录屏逐帧(10fps,`| 书名 | 作者 | 分类 | 出版社 | 出版年份 | 页数 | 评分 |` 七列):
 *
 * ```
 * Generating 1.6s  表头 + 半截分隔行,以**裸段落**挂在屏幕上(不是块,是散文)
 * Generating 2.3s  分隔行到齐 → 我们把它降级成**代码块**(Copy source 檐)
 * Generating 3.1s  还是代码块,已经五行数据
 * 收尾              才换成表
 * ```
 *
 * 两段难看各有各的原因,但根是同一条:**我们比解析器还晚**。
 *
 *  · **裸段落那一段**不是解析器的错 —— GFM 里表格**可以打断段落**(实测:正文紧跟
 *    表头、不空行,照样成表),它只是还没等到**完整的分隔行**。分隔行是表的身份证:
 *    列数由它定,没到齐之前那两行按定义就是段落。列越多这一段越长(13 列的那张
 *    真机截图挂了 3.5s+)。
 *  · **代码块那一段**是我们自己的判据:`toFrame` 从前有一条「贴着活尾巴的原子块按
 *    code 显示」,退出条件是 `text.endsWith('\n')`。那条件是**掷骰子** —— 一帧的文本
 *    结不结束在换行上,由 provider 的分片与 coalescer 的批次说了算。真机上八行表
 *    一次都没掷中,于是整条流全程是源码。(那条降级已在本批撤掉,见 `incremental.ts`。)
 *
 * ── 这个文件干的事:把分隔行**补齐**,让真解析器提前一步说话 ──────────────
 * 判据窄到只认一形:**活尾巴最后两行 = 像表头的一行 + 像分隔行的一行(还没写完)**。
 * 补齐 = 按表头的列数把分隔行凑够格数,补的是最保守的 `---`(不猜对齐;真的冒号
 * 到了下一帧自然生效)。补完之后**必须真的解析成表**,否则整段作废、一个字都不改 ——
 * 所以它不可能把不是表的东西画成表,最坏情况只是白算一次。
 *
 * ── 为什么补的是分隔行,而不是"给表前面加空行" ───────────────────────
 * 因为空行根本不缺(实测 A2/A3:GFM 允许表打断段落)。那条嫌疑在诊断里被排除了,
 * 照着它改会是治一个不存在的病。
 *
 * ── 三条不动 ──────────────────────────────────────────────────────────
 *  · **围栏里的表不动** —— 调用方只在「最后一块是段落」时才问它(围栏里是 code);
 *  · **缩进四格的表不动** —— 那在 CommonMark 里就是缩进代码块,剥缩进等于把真正的
 *    代码块也改了(那是可感知的行为裁定,不在本批);
 *  · **分隔行列数与表头对不上时不动** —— 那是模型写错了,GFM 判它不是表,我们照实。
 *    补齐只发生在「还没写完」,不发生在「写错了」:已经收尾的分隔行(带换行)不碰。
 */

/** 分隔行的样子:0–3 空格缩进,只由 `| : - 空白` 组成,而且至少有一个 `-`。 */
const SEPARATOR_ISH = /^ {0,3}\|?[-:|\t ]*-[-:|\t ]*$/

/**
 * 一行按 GFM 的规矩有几格:掐掉首尾各一根竖线,再按竖线切。
 *
 * 转义的 `\|` 不算分格 —— 与 GFM 同一条(表格里的竖线要转义才能当字符用)。
 */
function cellCount(line: string): number {
  let body = line.trim()
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1)
  let count = 1
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === '\\') { i += 1; continue }
    if (body[i] === '|') count += 1
  }
  return count
}

/**
 * 一段还在长的 markdown:**它的最后两行是不是一张正在出生的表**?是就返回补齐了
 * 分隔行的那一份,不是就返回 `undefined`。
 *
 * 只认**没写完的最后一行**(整段不以换行结束)—— 已经换行落定的分隔行说明模型写完了,
 * 它成不成表由 GFM 说了算,轮不到我们补。
 */
export function completeTableTail(source: string): string | undefined {
  if (!source || source.endsWith('\n')) return undefined
  const lastBreak = source.lastIndexOf('\n')
  if (lastBreak < 0) return undefined
  const separator = source.slice(lastBreak + 1)
  if (!SEPARATOR_ISH.test(separator)) return undefined

  const headStart = source.lastIndexOf('\n', lastBreak - 1) + 1
  const header = source.slice(headStart, lastBreak)
  if (!header.includes('|')) return undefined

  const columns = cellCount(header)
  if (columns < 1) return undefined

  /*
   * 半截的那一格要么**收口**,要么**丢掉** —— 判据是它自己够不够格。
   *
   * 一格分隔符至少要有一个 `-`(`:` 只说对齐,单独一个冒号不成格)。收到的最后那格
   * 常常只有 `| ` 或 `| :`,把它原样收口就造出一格**非法**的分隔符,整行当场不是表 ——
   * 屏幕上于是「表 → 段落 → 表 → 段落」来回翻。真机读数(2 字/帧喂十三列表):
   * 修前 `p@7356 → table@7398 → p@7538 → …` 十次翻面,指纹就是 `… | :` 那两个字符。
   *
   * 丢掉半格不会少画什么:那一格的横杠还没到,补出来的 `---` 与它长得一样;
   * 真的冒号到了下一帧自然生效。
   */
  let filled = separator.trimEnd()
  const lastPipe = filled.lastIndexOf('|')
  const partial = lastPipe >= 0 ? filled.slice(lastPipe + 1) : filled
  if (!partial.includes('-')) filled = lastPipe >= 0 ? filled.slice(0, lastPipe + 1) : ''
  else filled += ' |'
  // 掐掉半格之后连一个横杠都不剩 = 这一行还看不出是分隔行,不猜。
  if (!filled.includes('-')) return undefined

  const have = cellCount(filled)
  if (have >= columns) return undefined
  filled += ' --- |'.repeat(columns - have)
  return `${source.slice(0, lastBreak + 1)}${filled}`
}
