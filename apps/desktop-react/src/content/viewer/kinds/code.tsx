import { CodeLines, sourceCodeLines, splitLines } from '../../code/CodeLines'
import { useHighlight } from '../../code/useHighlight'
import { VIEWER_SKIP_LINES } from '../../../data/viewer-kinds'
import { registerViewer, disposeRegistrations } from '../registry'
import type { ViewerBodyProps } from '../registry'

/**
 * **code 型** —— 聊天代码块那条查看形的整份复用,外加查看器才需要的四件。
 *
 * ── 复用的是什么、不复用的是什么(记档)─────────────────────────────────
 * **复用**:`content/code/` 那一整套 —— 同一台 shiki(同一个主题、同一份缓存、
 * 同一条「素文本先行 / 拉不到就一直素文本」的降级路径),以及 2026-09-13 批 ①
 * 立的「行」渲染基础件 `CodeLines`。行高、行号列、当前行、跳渲、横滚纪律都长在
 * 那件基础件上,所以同一段代码在聊天里和在查看器里**逐像素**一样。
 *
 * **不复用** `BlockShell`:壳给的是「一件嵌在纸上的物件」—— 有檐、限高折叠、
 * 块内横滚。查看器整块面**就是**这个文件,限高折叠在这里是错的(把一份正在看的
 * 文件切掉四分之三,还给一颗「展开」),檐也已经由查看器自己那一条占着。
 *
 * ── 查看器才有的四件,今天全是**递给基础件的参数** ─────────────────────
 * ① **行号**:`numbers: 'single'`(新文件那一列)。它是生成内容,不进选区 ——
 *    框选一段代码复制出来只有代码,没有一列数字。
 * ② **当前行**:`currentLine`。它由**壳**落点(⌘L 跳转 / 点一行),这里只把那个
 *    数递下去 —— 「跳到哪儿」是壳的事。
 * ③ **折行开关**:`wrap`。默认不折(代码里的缩进有含义,自动断行会改变它的读法)。
 * ④ **行跳渲**:行数超过 `VIEWER_SKIP_LINES` 时 `skip`。判据是行数不是字节数:
 *    排版的代价按行算。**判据留在这里**,因为「多少行算多」是查看器的事;
 *    基础件只认那个布尔。
 *
 * ── 那一套 `data-*` 是**查看器的契约**,不是基础件的 ────────────────────
 * `viewer-code` / `data-viewer-lines` / `data-viewer-skip` / 每行 `data-line`
 * —— 真机门(`gate:files` / `gate:focus` / `gate:a11y` 第 9 屏)与单测按它们取件,
 * 还有 `useViewerScroll` 的 `[data-line="n"]` 落点。所以它们经 `testId` /
 * `rootAttrs` / `rowAttrs` 三口递进去,基础件里不出现「viewer」这个词。
 * (`data-current` 不在此列:它是「当前那一行」这件事本身,基础件自己画。)
 */
export function CodeCanvas({
  source,
  lang,
  wrap,
  currentLine,
}: {
  source: string
  lang: string | null
  wrap: boolean
  /** 1 基;0 = 还没落过点。落点由 ⌘L 跳转条给(这里只负责画出来)。 */
  currentLine?: number
}) {
  const highlighted = useHighlight(source, lang)
  const lines = sourceCodeLines(source, highlighted)
  const skip = lines.length > VIEWER_SKIP_LINES

  return (
    <CodeLines
      lines={lines}
      numbers="single"
      wrap={wrap}
      currentLine={currentLine}
      skip={skip}
      testId="viewer-code"
      rootAttrs={{
        'data-viewer-lines': String(lines.length),
        'data-viewer-skip': skip ? 'true' : undefined,
      }}
      rowAttrs={(_line, index) => ({ 'data-line': String(index + 1) })}
    />
  )
}

/** 切行是基础件那一条(尾随换行切出来的空段丢掉);这里只是把它转出去。 */
export { splitLines }

/* ── 注册 ──────────────────────────────────────────────────────────────── */

function CodeBody({ file, view }: ViewerBodyProps) {
  if (file.kind !== 'code') return null
  return (
    <CodeCanvas
      source={file.content}
      lang={file.lang}
      wrap={view.wrap}
      currentLine={view.currentLine}
    />
  )
}

registerViewer({
  id: 'code',
  /*
   * 判据来自分型表那张纯表(viewer-source 已经按它定过型),这里只是一行委托。
   * **不在这里再抄一份扩展名名单** —— 两处必然分叉。
   *
   * 注意 `code` 同时是「认得出语言的源码」和「认不出但读得动的纯文本」:
   * `lang === null` 就是后者,画法完全一样,只是没有颜色。定稿说的
   * 「未注册后缀先嗅探可读文本 → 纯文本体」正是这一格,不需要第二个处理器。
   */
  match: (file) => file.kind === 'code',
  Body: CodeBody,
  editable: true,
  lineCount: ({ file }) => (file.kind === 'code' ? splitLines(file.content).length : undefined),
  statusItems: ({ view, onView }) => [
    { id: 'wrap', labelKey: 'viewer.wrap', on: view.wrap, onToggle: () => onView({ wrap: !view.wrap }) },
  ],
  status: ({ file }) =>
    // 语言 · 编码 · 换行符。编码这一格后端只回过 utf-8(readContent 的 encoding),
    // 换行符按内容现看 —— 两件都是**事实**,不是文案,所以不进字典。
    file.kind === 'code'
      ? [file.lang ?? 'text', 'UTF-8', file.content.includes('\r\n') ? 'CRLF' : 'LF'].join(' · ')
      : undefined,
})

/*
 * HMR 退役(09-01 立法:模块级副作用必须配 dispose)。这个文件在被 import 时
 * 往注册表里塞东西,而那张表**重复注册即抛** —— 不退役,热更后新模块进来当场
 * 白屏。复用 registry 那一口唯一的拆卸,不写第二套。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => disposeRegistrations({ viewers: ['code'] }))
}
