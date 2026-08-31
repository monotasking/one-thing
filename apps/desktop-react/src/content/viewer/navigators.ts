import { registerNavigator } from './registry'
import type { ViewerJumpCandidate } from './registry'
import type { ViewerFile } from '../../data/viewer-source'

/**
 * **⌘L 跳转条的提供者表**(定稿:跳转只有这一个入口)。
 *
 * 壳负责的是「输入 → 候选 → 落点 → 滚进视野 → 高亮当前行」这条**公共**的路;
 * 提供者只回答一件事:**这一串字对应哪几行**。所以「跳到第 42 行」「跳到某个
 * 符号」「跳到下一个检索命中」在屏幕上是同一件事、同一条路、同一套键 ——
 * 而不是三个各自长在别处的小功能。
 *
 * ── 今天接上的只有行号档 ──────────────────────────────────────────────────
 * 其余三格(符号 `#` / 检索 `/` / diff `@`)以**留表位**的形式注册:它们有名字、
 * 有前缀、在跳转条里画得出来,但 `list` 缺席 —— 于是那一行是灰的,并写着
 * 「还没接上」。这与「打开方式」那六档是同一条诚实降级:藏起来的能力,接上那天
 * 没有人会去找它。
 *
 * 书签那一格连表位都没有:它需要一处**存**(每个文件的书签存哪儿、跟不跟着
 * 工作区走),那是一次拍板,不是一行注册。记在这里免得被当成漏了。
 */

/** 行号档:输入纯数字,或 `:42`(Vim 的写法,同一个落点)。 */
registerNavigator({
  id: 'line',
  sigil: '',
  labelKey: 'viewer.jumpLine',
  list: (query, ctx) => {
    // `:42` 与 `42` 是同一件事 —— Vim 档的命令行与跳转条共用这一个提供者,
    // 所以那个冒号在这里被吃掉,而不是在两个地方各判一次。
    const raw = query.startsWith(':') ? query.slice(1) : query
    const digits = raw.trim()
    if (!/^\d+$/.test(digits)) return []
    const asked = Number.parseInt(digits, 10)
    if (asked <= 0) return []
    // 超出这份内容的行数就夹到最后一行 —— 说出来(hint),不静默改数。
    const line = Math.min(asked, Math.max(1, ctx.lineCount))
    return [
      {
        id: `line:${line}`,
        label: `${line}`,
        line,
        hint: line === asked ? undefined : `${ctx.lineCount}`,
      },
    ]
  },
})

/**
 * **检索档(`/`)—— F2 从留表位接真**。⌘F 就是「开这条跳转条,并把 `/` 先打上」。
 *
 * ── 它为什么能只写十几行 ────────────────────────────────────────────────
 * 因为「检索」在这条路上**不是一个功能**,是一个提供者:命中列表、落点、滚进视野、
 * 当前行高亮、↵ 循环全都是跳转条那套公共骨架的既有能力。这里只回答一句
 * 「这串字对应哪几行」——那正是 registerNavigator 存在的全部理由。
 *
 * 三条判据写死在这里,不留配置:
 *  · **大小写不敏感**:一份源码里搜 `usestate` 该找得到 `useState`,这是检索框的
 *    通行手感;要区分大小写是另一档(将来给个 `/`+修饰,或者一个开关),不是默认;
 *  · **一行一条命中**:同一行里出现两次只算一条 —— 落点的粒度是行(当前行高亮
 *    画在行上),给同一行发两条候选,↵ 走过去屏幕一动不动,那是假的「下一个」;
 *  · **上限 `SEARCH_HIT_CAP`**:在一份两万行的文件里搜一个 `e`,候选表本身会变成
 *    卡顿源。截断了就在 hint 里说出来(`…`),不静默少给。
 *
 * 只对**有正文**的那几型成立(code / markdown / svg 源码)。图、播放条、二进制
 * 手上根本没有字符串 —— 那时回空表,跳转条画的是「没有命中」,不是一句谎。
 */
const SEARCH_HIT_CAP = 200

/**
 * 检索档的前缀。**⌘F 要把它替用户打上,所以它有第二个消费方** ——
 * 一个符号两处写死必然分叉(改成 `?` 的那天 ⌘F 会开出一个行号档)。
 */
export const SEARCH_SIGIL = '/'

registerNavigator({
  id: 'search',
  sigil: SEARCH_SIGIL,
  labelKey: 'viewer.jumpSearch',
  cycle: true,
  list: (query, ctx) => {
    const needle = query.slice(1).toLowerCase()
    if (!needle) return []
    const source = searchableSourceOf(ctx.file)
    if (source === null) return []
    const lines = source.split('\n')
    const hits: ViewerJumpCandidate[] = []
    for (let row = 0; row < lines.length; row += 1) {
      const at = lines[row].toLowerCase().indexOf(needle)
      if (at < 0) continue
      hits.push({
        id: `hit:${row + 1}`,
        // 屏幕上这一行的**原样片段**(不是加工过的摘要):命中在哪儿要看得出来。
        label: lines[row].trim().slice(0, 80) || ' ',
        line: row + 1,
        hint: `${row + 1}`,
      })
      if (hits.length >= SEARCH_HIT_CAP) break
    }
    return hits
  },
})

/**
 * 这一份文件手上有没有一段能搜的字符串。**判别联合当场分岔**,不写
 * `'content' in file` 那种结构探测 —— svg 的源码挂在另一个字段上,探测会漏掉它。
 */
export function searchableSourceOf(file: ViewerFile): string | null {
  switch (file.kind) {
    case 'code':
    case 'markdown':
      return file.content
    case 'image':
      return file.svgSource ?? null
    default:
      return null
  }
}

/* ── 留表位:有名字、有前缀、画得出来,但还没接上 ───────────────────────── */

registerNavigator({ id: 'symbol', sigil: '#', labelKey: 'viewer.jumpSymbol' })
registerNavigator({ id: 'diff', sigil: '@', labelKey: 'viewer.jumpDiff' })
