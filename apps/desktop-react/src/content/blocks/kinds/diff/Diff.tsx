import { useMemo } from 'react'
import type { BlockModel, DiffHunk } from '../../../model/blocks'
import { CodeLines, type CodeLine } from '../../../code/CodeLines'
import { useHighlight } from '../../../code/useHighlight'
import type { HighlightedLines } from '../../../code/highlight'
import { langOfPath } from '../../../../data/languages'
import s from './Diff.module.css'

type DiffModel = Extract<BlockModel, { kind: 'diff' }>

/**
 * diff 块的本体 —— 六轮定稿的**行底形**(不是左竖线形)。
 *
 * 檐(类型词 `diff` + 文件路径 + ±统计色字)由壳画,声明在 index.ts;这里只剩两件:
 * **hunk 盒 + hunk 头原文那一行**。行怎么画归基础件 `content/code/CodeLines`
 * (2026-09-13 批 ②:聊天代码块、文件查看器、diff 三处画的是同一串行)。
 *
 * ── 为什么用行底而不是左竖线 ────────────────────────────────────────────
 * 左竖线是全域禁令(引用块那条同源)。diff 里它还额外坏:一段 diff 里增删相邻,
 * 两条颜色不同的竖线挨着会读成一个装订边,而不是「这一行是加的」。行底 12% 透明
 * 的色块盖住整行,增删的**范围**因此是自明的 —— 这也是为什么行必须能横向铺满
 * (基础件根上那句 `min-width: max-content`),否则横滚之后右半边的底色会断在
 * 容器边上。
 *
 * ── 行号从一列变两列(批 ②)──────────────────────────────────────────────
 * 从前只画新文件的行号,理由是「两列在聊天纸面这个宽度里是奢侈品」。批 ② 改判:
 * 改动面那条整文件路要两列,而**同一段 diff 在两处不该长成两种东西**——这正是
 * 这只块当初把 markdown 围栏与 edit 工具卡并成一个组件时立的那条。两列同时把
 * 「这一行是加是删」说了第二遍(加行没有旧号、删行没有新号),与满饱和的 +/−
 * 符号、12% 的行底一起,三条冗余里任意一条失效(色弱、截图转灰、行太长滚出屏)
 * 另外两条还在。
 *
 * 碎片 diff(没有 `@@`,因而 `oldStart` / `newStart` 都缺席)两列都空 —— **列仍在**:
 * 它同时是 +/− 符号的靠山,撤掉会让有头和没头的两种 diff 缩排不一样。
 *
 * ── `skip`:逐行不排版屏外的行 ───────────────────────────────────────────
 * 改动面那块两万行的 diff 要它,聊天正文里这块不要(它本来就在限高折叠里)。
 * 所以是**宿主说**的一格,不是这只块自己猜的。判词见 `CodeLines.module.css`
 * 规矩③:行高取整之后逐行 containment 才不留缝。
 */
export function Diff({ model, skip }: { model: DiffModel; skip?: boolean }) {
  /*
   * 高亮用哪门语言,由**文件名**说(`model.file`;markdown 的 ```diff 围栏没有
   * 文件名这回事,那时就是素文本)。表是 `data/languages.ts` 那一张,这里不抄
   * 第二份扩展名名单 —— 两处必然分叉。
   */
  const lang = model.file ? langOfPath(model.file) : null

  return (
    <div className={s.diff}>
      {model.hunks.map((hunk, index) => (
        <Hunk key={index} hunk={hunk} lang={lang} skip={skip} />
      ))}
    </div>
  )
}

/**
 * 一个 hunk 一个盒。
 *
 * 这层盒从前扛的是 `content-visibility` 的粒度(2026-09-13 改动面报障「同色相邻行
 * 之间每隔五六行一道白线」:逐行 containment + 分数行高,2 倍屏上相邻两块绘制盒在
 * 分数边界上各自吸附,留下一道没人画的缝)。**批 ② 起那条账结在行高上了** ——
 * `--code-line-h` 是整数,逐行 containment 不再留缝,所以 containment 回到行的粒度
 * (基础件的 `skip`),这层盒只剩它本来的意思:hunk 头与它管的那些行是一组。
 *
 * ── 高亮按 hunk 拼一次,不逐行调 ────────────────────────────────────────
 * `highlight()` 每调一次就是一趟 shiki 的分词;一个 hunk 几十行就是几十趟。把这个
 * hunk 的行文本按 `\n` 拼起来一次染色、再按下标取回每一行的 token,一个 hunk 只花
 * 一趟。**代价如实说**:①跨行语法状态在 hunk 边界会断(一个跨 hunk 的多行注释,
 * 第二个 hunk 从零开始算)—— 与 GitHub 同;②拼起来的那一段是「旧行与新行交错」的
 * 流,不是一份能编译的源码,所以极端情况下(删掉的那行有个没闭合的引号)染色会跑偏
 * 一小段。两者都是**只影响颜色**的偏差:字一个都不会变,行一条都不会少。
 */
function Hunk({ hunk, lang, skip }: { hunk: DiffHunk; lang: string | null; skip?: boolean }) {
  const source = useMemo(() => hunk.lines.map((entry) => entry.text).join('\n'), [hunk])
  const highlighted = useHighlight(source, lang)
  const lines = useMemo(() => hunkCodeLines(hunk, highlighted), [hunk, highlighted])

  return (
    <div className={s.hunk}>
      {hunk.header !== undefined && <div className={s.hunkHead}>{hunk.header}</div>}
      <CodeLines lines={lines} numbers="both" signs skip={skip} />
    </div>
  )
}

/**
 * 一个 hunk → 一串 `CodeLine`。**纯函数**,两个计数器各走各的:
 * 新增行不占旧文件的行号,删除行不占新文件的行号,未改行两边都占。
 * 起始号缺席(碎片 diff)时那一列整列空着 —— 不编一个。
 */
export function hunkCodeLines(hunk: DiffHunk, highlighted?: HighlightedLines): CodeLine[] {
  let oldNo = hunk.oldStart
  let newNo = hunk.newStart
  return hunk.lines.map((entry, index) => {
    const line: CodeLine = {
      text: entry.text,
      ...(highlighted?.[index] ? { tokens: highlighted[index] } : {}),
      ...(entry.kind !== 'add' && oldNo !== undefined ? { oldNo } : {}),
      ...(entry.kind !== 'del' && newNo !== undefined ? { newNo } : {}),
      ...(entry.kind === 'ctx' ? {} : { mark: entry.kind }),
    }
    if (entry.kind !== 'add' && oldNo !== undefined) oldNo += 1
    if (entry.kind !== 'del' && newNo !== undefined) newNo += 1
    return line
  })
}
