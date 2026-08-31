import { useEffect, useMemo, useState } from 'react'
import {
  highlight,
  loadHighlighter,
  type HighlightedLines,
} from '../../blocks/kinds/code/highlight'
import { VIEWER_SKIP_LINES } from '../../../data/viewer-kinds'
import { registerViewer } from '../registry'
import type { ViewerBodyProps } from '../registry'
import s from '../FileViewer.module.css'

/**
 * **code 型** —— 聊天代码块那条查看形的整份复用,外加查看器才需要的四件。
 *
 * ── 复用的是什么、不复用的是什么(记档)─────────────────────────────────
 * **复用**:`blocks/kinds/code/highlight.ts` 那一整套 —— 同一台 shiki、同一个
 * 主题、同一份缓存、同一条「素文本先行 / 拉不到就一直素文本」的降级路径。
 * 字体与字号也跟着代码块走(mono、比正文小一档),所以同一段代码在聊天里和在
 * 查看器里长得一样。
 *
 * **不复用** `BlockShell`:壳给的是「一件嵌在纸上的物件」—— 有檐、限高折叠、
 * 块内横滚。查看器整块面**就是**这个文件,限高折叠在这里是错的(把一份正在看的
 * 文件切掉四分之三,还给一颗「展开」),檐也已经由查看器自己那一条占着。
 *
 * ── 查看器才有的四件 ───────────────────────────────────────────────────
 * ① **行号**:CSS counter + `::before`,不是一列真的 DOM 文本 —— 生成内容不进
 *    选区,所以框选一段代码复制出来只有代码,没有一列数字。
 * ② **当前行**:淡 accent 底 + 左缘 2px accent 竖条(定稿画法)。它由**壳**落点
 *    (⌘L 跳转 / 点一行),这里只把那个数画出来 —— 「跳到哪儿」是壳的事。
 * ③ **折行开关**:默认不折(代码里的缩进有含义,自动断行会改变它的读法)。
 * ④ **行跳渲**:超过 `VIEWER_SKIP_LINES` 行时给每一行 `content-visibility:auto`
 *    —— 视口外的行不排版、不上色。判据是行数不是字节数:排版的代价按行算。
 *
 * ── 为什么行永远是我们自己切的,不等高亮器 ───────────────────────────────
 * 上面四件都挂在**行元素**上。高亮器是懒加载的,而且可能永远拉不到 —— 那时若没有
 * 行元素,行号、当前行、跳渲就一起没了。所以行由 `split('\n')` 切,token 到了往里
 * 填:两条路上行元素一模一样。
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
  const lines = useHighlight(source, lang)
  const shown = useMemo(() => splitLines(source), [source])
  const skip = shown.length > VIEWER_SKIP_LINES

  return (
    <pre
      className={wrap ? `${s.pre} ${s.preWrap}` : s.pre}
      data-testid="viewer-code"
      data-viewer-lines={shown.length}
      data-viewer-skip={skip ? 'true' : undefined}
    >
      <code className={s.code}>
        {/*
          * 一行**不挂任何交互**:它不是控件,给它点击就得同时给键盘路径,而给
          * 每一行配一颗按钮会把整份文件在读屏里念成一列按钮。落到某一行的路
          * 只有一条 —— ⌘L 跳转条(它是真控件、在 Tab 序里、有名字)。
          */}
        {shown.map((text, row) => (
          <span
            key={row}
            className={skip ? `${s.line} ${s.lineSkip}` : s.line}
            data-line={row + 1}
            data-current={row + 1 === currentLine ? 'true' : undefined}
          >
            {lines?.[row] ? renderTokens(lines[row]) : text}
          </span>
        ))}
      </code>
    </pre>
  )
}

/**
 * 切行。**尾随换行切出来的那个空段丢掉** —— 文件以 `\n` 结尾是常态,把它画成
 * 一行空行等于凭空多一个行号。只在它确实是空的时候丢(`a\n\n` 中间那一空行要留)。
 */
export function splitLines(source: string): string[] {
  const raw = source.split('\n')
  return raw.length > 1 && raw[raw.length - 1] === '' ? raw.slice(0, -1) : raw
}

/**
 * 高亮的懒加载闸 —— 与 `blocks/kinds/code/Code.tsx` 逐字同一条:`ready` 只是
 * 「重画一次」的信号,结果每次渲染现算(highlight 自带缓存)。
 */
function useHighlight(source: string, lang: string | null): HighlightedLines | undefined {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!lang) return
    let alive = true
    void loadHighlighter().then(() => {
      if (alive) setReady(true)
    })
    return () => {
      alive = false
    }
  }, [lang])

  return ready ? highlight(source, lang) : undefined
}

/**
 * token → React 元素 + 行内色。**不用 `dangerouslySetInnerHTML`** —— 这里装的是
 * 磁盘上任意一份文件的内容,交给 innerHTML 就是把一条注入路径接到查看器上。
 * 颜色是 shiki 给的**数据**,与「样式表里不许写字面色」是两件事(同 Code.tsx)。
 */
function renderTokens(tokens: HighlightedLines[number]) {
  return tokens.map((token, index) => (
    <span key={index} style={{ color: token.color }}>
      {token.content}
    </span>
  ))
}

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
