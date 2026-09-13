import type { ThemedToken } from 'shiki/types'
import type { HighlightedLines } from './highlight'
import s from './CodeLines.module.css'

/**
 * **「行」渲染基础件**(2026-09-13 批 ①;正本 `docs/changes-file-view-2026-09.md` §2)。
 *
 * 它画**一串行**,不知道自己装的是聊天里的代码块、文件查看器还是 diff ——
 * 这个文件里没有那三个名字中的任何一个。宿主给什么它画什么:
 *
 *  · 行从哪儿来、有没有 token、行号是几 —— 宿主在 `CodeLine` 里说;
 *  · 行号画几列、折不折行、当前行是哪一行、要不要跳过屏外行 —— 四个开关;
 *  · 每一行 / 根上要挂什么 `data-*` —— `rowAttrs` / `rootAttrs` / `testId` 三口。
 *    (查看器有一整套真机门按属性取件的 DOM 契约,那些名字是**它的**,
 *    不该长在这件基础件身上。)
 *
 * 三条硬规矩(横滚纪律 / 整数行高 / 逐行跳过)全部在 `CodeLines.module.css` 里,
 * 判词也写在那儿 —— 消费方一行样式都不写,这是这件东西存在的全部理由。
 *
 * ── 为什么正文外面还裹一层 span ────────────────────────────────────────────
 * 一行是 flex 行盒(行号列要粘在左缘,正文要在折行档里伸缩)。flex 容器会把
 * **每一段连续文本、每一个子元素**都变成独立的 flex 项 —— 而正文是一串
 * `<span style="color">` token,不裹起来就是几十个各自成盒的 token。
 */

/** 一行:文本是必需的,其余都是「有就画」。 */
export interface CodeLine {
  readonly text: string
  /** 缺席 = 纯文本(高亮器还没到,或这台不认识这门语言)。 */
  readonly tokens?: readonly ThemedToken[]
  /** 两列行号里的旧文件那一列。 */
  readonly oldNo?: number
  /** 新文件的行号;单列行号与 `currentLine` 都按它算。 */
  readonly newNo?: number
  /** 缺席 = 未改。 */
  readonly mark?: 'add' | 'del'
}

export interface CodeLinesProps {
  readonly lines: readonly CodeLine[]
  readonly numbers: 'none' | 'single' | 'both'
  readonly wrap?: boolean
  /** 1 基,按 `newNo` 认;落点由宿主给,这里只把它画出来。 */
  readonly currentLine?: number
  /**
   * 画不画加删符号列(`+` / `−`)。判据是宿主的:底色只有 12%,而符号是满饱和的,
   * 一行到底是加是删,色弱的人读的是这一格。有 `mark` 不等于要画它 —— 整文件那一路
   * 靠两列行号的空缺就说得清,聊天里的 diff 块沿用符号。
   */
  readonly signs?: boolean
  /** 屏外行 `content-visibility`。行数到了才值得 —— 判据在宿主那边。 */
  readonly skip?: boolean
  /** 根上的 `data-testid`。 */
  readonly testId?: string
  /** 根上的其它 `data-*`(宿主的契约,不是这件的)。 */
  readonly rootAttrs?: Record<string, string | undefined>
  /** 每一行上的 `data-*`。 */
  readonly rowAttrs?: (line: CodeLine, index: number) => Record<string, string | undefined>
}

const NUMBER_CLASS = { none: undefined, single: s.numSingle, both: s.numBoth } as const

export function CodeLines({
  lines,
  numbers,
  wrap,
  currentLine,
  signs,
  skip,
  testId,
  rootAttrs,
  rowAttrs,
}: CodeLinesProps) {
  const rootClass = [
    s.root,
    NUMBER_CLASS[numbers],
    wrap ? s.rootWrap : undefined,
    // 递了 `currentLine`(哪怕是 0)= 这个宿主认「当前行」,行左缘才留那一格标记位。
    currentLine === undefined ? undefined : s.marksCurrent,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <pre className={rootClass} data-testid={testId} {...rootAttrs}>
      {/*
        * 一行**不挂任何交互**:它不是控件,给它点击就得同时给键盘路径,而给每一行
        * 配一颗按钮会把整份文件在读屏里念成一列按钮。落到某一行的路由宿主自己开
        * (查看器是 ⌘L 跳转条:真控件、在 Tab 序里、有名字)。
        */}
      <code className={s.code}>
        {lines.map((line, index) => (
          <span
            key={index}
            className={lineClass(line, skip)}
            data-old-no={line.oldNo}
            data-new-no={line.newNo}
            data-current={
              currentLine !== undefined && line.newNo === currentLine ? 'true' : undefined
            }
            {...rowAttrs?.(line, index)}
          >
            {signs && <span className={s.sign}>{SIGN[line.mark ?? 'ctx']}</span>}
            <span className={s.text}>{line.tokens ? renderTokens(line.tokens) : line.text}</span>
          </span>
        ))}
      </code>
    </pre>
  )
}

/**
 * 三种标记的字形。未改那一格是**空格不是空串** —— 它撑住那一列的宽度,
 * 让加删行与未改行的正文起笔在同一条线上。真减号(U+2212)与工具行的读数同字形。
 */
const SIGN = { add: '+', del: '\u2212', ctx: ' ' } as const

function lineClass(line: CodeLine, skip: boolean | undefined): string {
  const mark = line.mark === 'add' ? s.lineAdd : line.mark === 'del' ? s.lineDel : undefined
  return [s.line, mark, skip ? s.lineSkip : undefined].filter(Boolean).join(' ')
}

/**
 * token → React 元素 + 行内色。**不用 `dangerouslySetInnerHTML`** —— 这里装的是
 * 模型吐出来的任意文本、磁盘上任意一份文件,交给 innerHTML 就是把一条注入路径
 * 接到正文上。颜色是 shiki 给的**数据**(每个 token 一个颜色),与「样式表里不许
 * 写字面色」是两件事。
 */
function renderTokens(tokens: readonly ThemedToken[]) {
  return tokens.map((token, index) => (
    <span key={index} style={{ color: token.color }}>
      {token.content}
    </span>
  ))
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
 * 一段源码 + 一份(可能还没到的)高亮 → `CodeLine[]`。
 *
 * **行永远是我们自己切的,不等高亮器**:行号、当前行、跳渲都挂在行上,而高亮器
 * 是懒加载的、还可能永远拉不到 —— 那时若没有行元素,这三件就一起没了。token 到了
 * 往里填,两条路上行元素一模一样。
 */
export function sourceCodeLines(source: string, highlighted?: HighlightedLines): CodeLine[] {
  return splitLines(source).map((text, index) => ({
    text,
    ...(highlighted?.[index] ? { tokens: highlighted[index] } : {}),
    newNo: index + 1,
  }))
}
