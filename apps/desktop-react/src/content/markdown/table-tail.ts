import type { BlockCommitResult } from '../blocks/stream/contract'

/**
 * **正在出生的那张表**(09-01 用户复测报障;R4b 把「补半截分隔行」升级成「行首承诺」)。
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
 *    列数由它定,没到齐之前那两行按定义就是段落。列越多这一段越长。
 *  · **代码块那一段**是我们自己的判据,09-01 已撤(病历在 `incremental.ts`)。
 *
 * ── R4a:补半截分隔行 ──────────────────────────────────────────────────
 * 判据窄到只认一形:活尾巴末两行 = 表头 + **半截**分隔行。真机读数:13 列表头裸挂
 * 556ms(修前 1243ms)。
 *
 * ── R4b:承诺往前推到**行首第一根竖线**(用户 117 列截图为素材)────────────
 * 修前基线(R4a 的门,117 列):**表头裸挂 850ms**,而且成表那一刻裸文本段落从
 * 179px 塌到 22px —— 下面的内容整体上跳 157px。这就是用户报的「表头期裸文本数秒 +
 * 上下抖」的机器读数。
 *
 * 所以判据从「末两行像表头 + 半截分隔行」放宽到:**活尾巴里有一行以 `|` 开头(缩进
 * ≤3)、而且那一行至少有两根竖线**,就按它的格数**补一整行分隔行**,让解析器提前
 * 一步说话。补出来的字一个都不上屏。
 *
 * ── 单调性是**构造出来的**,不是记出来的 ──────────────────────────────
 * 「承诺不可逆」这条法不需要一本承诺账:上面每一条判据在文本只增不减时都只会从
 * 假变真,不会反向。唯一一处**故意**的反向是下面那条「分隔行写错」——
 * 它不是反悔,是事实变得可知了(见 `SEPARATOR_MISMATCH` 那一段)。
 *
 * ── 三条不动 ──────────────────────────────────────────────────────────
 *  · **围栏里的表不动** —— 补完之后重解析,末块仍在围栏里就不是表,整段作废;
 *  · **缩进四格的表不动** —— `^ {0,3}\|` 把它挡在门外(那在 CommonMark 里就是缩进
 *    代码块,剥缩进等于把真正的代码块也改了);
 *  · **分隔行写错时不猜** —— 见下。
 */

/** 分隔行的样子:0–3 空格缩进,只由 `| : - 空白` 组成,而且至少有一个 `-`。 */
const SEPARATOR_ISH = /^ {0,3}\|?[-:|\t ]*-[-:|\t ]*$/

/**
 * **正在写的分隔行**:同上,但**不要求已经有横杠**(`|` / `| ` / `| :` 都算)。
 *
 * 它比 `SEPARATOR_ISH` 松一格,松的正是分隔行刚开头那两三帧 —— 那几帧要是落到
 * 「分隔行没来」那条路上,`|` 会被当成一行数据画出来,下一帧又消失,屏幕上就是抖。
 */
const SEPARATOR_CHARS = /^ {0,3}[-:|\t ]*$/

/** 表行的起手式:缩进 ≤3 + 一根竖线。缩进四格的表被它挡在门外(那是缩进代码块)。 */
const TABLE_LINE = /^ {0,3}\|/

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

function pipeCount(line: string): number {
  let n = 0
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '\\') { i += 1; continue }
    if (line[i] === '|') n += 1
  }
  return n
}

/** 按格数造一行最保守的分隔行(不猜对齐;真的冒号到了下一帧自然生效)。 */
function synthSeparator(columns: number): string {
  return `|${' --- |'.repeat(columns)}`
}

/**
 * **表的 commit 政策** —— 注册契约 `stream.commit` 的那一格(`kinds/table/index.ts`)。
 *
 * @param source 活尾巴那一块的源文本(贴着流末尾的那一段)
 * @returns 补齐后的源文本 + 补在哪儿补了多少(偏移要按它映射回真实文本);认不出就 undefined
 */
export function commitTable(source: string): BlockCommitResult | undefined {
  if (!source) return undefined

  // 手动切行并记下每行的起点 —— 补出来的那一段要能映射回真实文本的下标。
  const starts: number[] = []
  const lines: string[] = []
  let pos = 0
  for (;;) {
    const nl = source.indexOf('\n', pos)
    starts.push(pos)
    lines.push(source.slice(pos, nl === -1 ? source.length : nl))
    if (nl === -1) break
    pos = nl + 1
  }
  // `a\n` 切出来末尾是一个空串行,它代表「下一行还没开始」——不是一行内容。
  const endsWithNewline = source.endsWith('\n')

  const head = lines.findIndex((line, i) => TABLE_LINE.test(line) && !(endsWithNewline && i === lines.length - 1))
  if (head < 0) return undefined
  const header = lines[head]
  // 一根竖线不算表(`| 见下文` 是散文的常见起手)。两根起认。
  if (pipeCount(header) < 2) return undefined
  const columns = cellCount(header)
  if (columns < 1) return undefined

  const nextIndex = head + 1
  const isLastRealLine = (i: number) => i === lines.length - 1 && !endsWithNewline
  /** 表头后面还没有第二行(表头自己就是活尾巴的末行,或它刚换完行)。 */
  const noSecondLine = nextIndex >= lines.length || (endsWithNewline && nextIndex === lines.length - 1)

  // ── 情形 ①:分隔行还没开始写 —— 在表头后面补一整行 ──────────────────────
  if (noSecondLine) {
    // 表头还没换行就先补一个换行;已经换过行了就直接接上(再补一个会造出空行,
    // 而空行会把表头收成段落 —— 那一刀补下去反而让表长不出来)。
    const addition = endsWithNewline ? synthSeparator(columns) : `\n${synthSeparator(columns)}`
    return { text: source + addition, insertAt: source.length, insertLen: addition.length }
  }

  const next = lines[nextIndex]

  /*
   * ── 情形 ②:下一行**正在写分隔行** —— 把它补够格 ────────────────────────
   *
   * 判据是「这一行到此为止只由分隔行的字符组成」(`| : - 空白`),**不要求已经有横杠**。
   * R4a 时这里要求至少一个 `-`,于是 `|` / `| ` / `| :` 这几帧落到别的分支去;
   * R4b 把它们收进来是有原因的:那几帧正是分隔行刚开头的样子,让它们走「分隔行没来」
   * 那条路会把 `|` 当成一行**数据**画出来,屏幕上多一行空行、下一帧又消失 —— 那就是
   * 竖向抖动的制造机。
   */
  if (isLastRealLine(nextIndex) && SEPARATOR_CHARS.test(next)) {
    /*
     * 半截的那一格要么**收口**,要么**丢掉** —— 判据是它自己够不够格。
     *
     * 一格分隔符至少要有一个 `-`(`:` 只说对齐,单独一个冒号不成格)。收到的最后那格
     * 常常只有 `| ` 或 `| :`,把它原样收口就造出一格**非法**的分隔符,整行当场不是表 ——
     * 屏幕上于是「表 → 段落 → 表 → 段落」来回翻。真机读数(2 字/帧喂十三列表):
     * 修前 `p@7356 → table@7398 → p@7538 → …` 十次翻面,指纹就是 `… | :` 那两个字符。
     */
    let filled = next.trimEnd()
    const lastPipe = filled.lastIndexOf('|')
    const partial = lastPipe >= 0 ? filled.slice(lastPipe + 1) : filled
    if (!partial.includes('-')) filled = lastPipe >= 0 ? filled.slice(0, lastPipe + 1) : ''
    else filled += ' |'
    // 连一根竖线都没剩(整行还只是 `:` 或空白):从一根竖线起造。
    if (!filled.includes('|')) filled = '|'
    const have = filled.includes('-') ? cellCount(filled) : 0
    // 格数已经够了 = 解析器自己就认得,一个字都不必动。
    if (have >= columns) return undefined
    filled += ' --- |'.repeat(columns - have)
    return {
      text: source.slice(0, starts[nextIndex]) + filled,
      insertAt: starts[nextIndex],
      insertLen: filled.length - next.length,
    }
  }

  /*
   * ── SEPARATOR_MISMATCH:分隔行**写完了**而格数对不上 = 确定不是表 ─────────
   *
   * 这是唯一一处「承诺可以收回」的地方,而它不是反悔:在这一行写完之前,「分隔行会
   * 补齐成几格」还没有答案,承诺是对未来的一个赌;这一行一写完,GFM 的判决就出来了,
   * 事实变得可知。**知道了还继续画成表,才是撒谎**——照既有拍板「模型写错照实画」,
   * 当场退回段落,而且从此稳定(下一帧这条判据照样成立,不会来回翻)。
   *
   * 与拍板的出入记档:派工令写的是「settle 时一次性降回」,这里降在**事实可知的那一刻**
   * ——比 settle 早。理由是那之后整条流都稳定,而且收尾那一刻零变化(流式末帧 == 冷加载
   * 自动成立);拖到 settle 反而要先把 `| --- | --- |` 当数据行画出来,再在收尾整段塌一次。
   */
  if (SEPARATOR_ISH.test(next) && cellCount(next) !== columns) return undefined

  // ── 情形 ③:分隔行压根没来(漏写)—— 在表头后面插一整行 ──────────────────
  if (!SEPARATOR_ISH.test(next)) {
    const addition = `${synthSeparator(columns)}\n`
    const at = starts[nextIndex]
    return {
      text: source.slice(0, at) + addition + source.slice(at),
      insertAt: at,
      insertLen: addition.length,
    }
  }

  // 剩下的一种:下一行是**格数正好**的完整分隔行 —— 解析器自己就认得,不用我们补。
  return undefined
}
