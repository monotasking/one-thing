import { registerNavigator } from './registry'

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

/* ── 留表位:有名字、有前缀、画得出来,但还没接上 ───────────────────────── */

registerNavigator({ id: 'symbol', sigil: '#', labelKey: 'viewer.jumpSymbol' })
registerNavigator({ id: 'search', sigil: '/', labelKey: 'viewer.jumpSearch' })
registerNavigator({ id: 'diff', sigil: '@', labelKey: 'viewer.jumpDiff' })
