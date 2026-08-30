import type { BlockModel, DiffHunk } from '../../../model/blocks'
import s from './Diff.module.css'

type DiffModel = Extract<BlockModel, { kind: 'diff' }>

/**
 * diff 块的本体 —— 六轮定稿的**行底形**(不是左竖线形)。
 *
 * 檐(类型词 `diff` + 文件路径 + ±统计色字)由壳画,声明在 index.ts;这里只有三件:
 * hunk 头行、行号单列、逐行上底色。
 *
 * ── 为什么用行底而不是左竖线 ────────────────────────────────────────────
 * 左竖线是全域禁令(引用块那条同源)。diff 里它还额外坏:一段 diff 里增删相邻,
 * 两条颜色不同的竖线挨着会读成一个装订边,而不是「这一行是加的」。行底 12% 透明
 * 的色块盖住整行,增删的**范围**因此是自明的 —— 这也是为什么行必须能横向铺满
 * (`min-width: max-content`),否则横滚之后右半边的底色会断在容器边上。
 *
 * ── 行号是新文件的行号,一列 ────────────────────────────────────────────
 * 两列(旧/新)在聊天纸面这个宽度里是奢侈品,而人读 diff 时问的几乎总是「改完之后
 * 在第几行」。删除行没有新行号 —— 那一格就空着,不编一个。碎片 diff(没有 `@@`,
 * 因而没有起始行号)整块都没有行号,列仍在:它同时是 +/− 符号的靠山,撤掉会让
 * 有头和没头的两种 diff 缩排不一样。
 */
export function Diff({ model }: { model: DiffModel }) {
  return (
    <div className={s.diff}>
      {model.hunks.map((hunk, index) => (
        <Hunk key={index} hunk={hunk} />
      ))}
    </div>
  )
}

function Hunk({ hunk }: { hunk: DiffHunk }) {
  // 行号从 hunk 头给的新文件起始行往下走;删除行不占新文件的行,所以不递增。
  let line = hunk.newStart
  return (
    <>
      {hunk.header !== undefined && <div className={s.hunkHead}>{hunk.header}</div>}
      {hunk.lines.map((entry, index) => {
        const number = entry.kind === 'del' ? undefined : line
        if (entry.kind !== 'del' && line !== undefined) line += 1
        return (
          <div key={index} className={`${s.row} ${ROW_CLASS[entry.kind]}`}>
            {/* 行号不可选中:框选一段 diff 去贴到别处时,行号混进去就废了。 */}
            <span className={s.num}>{number ?? ''}</span>
            <span className={s.sign}>{SIGN[entry.kind]}</span>
            <span className={s.text}>{entry.text}</span>
          </div>
        )
      })}
    </>
  )
}

const ROW_CLASS = { add: s.add, del: s.del, ctx: s.ctx } as const
const SIGN = { add: '+', del: '−', ctx: ' ' } as const
