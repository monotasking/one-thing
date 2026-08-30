import { useMemo, useState } from 'react'
import { useT } from '../../../../i18n'
import { resolveIcon } from '../../../../components/icons'
import type { BlockModel } from '../../../model/blocks'
import { InlineRun } from '../../inline/InlineRun'
import { runBlockAction } from '../../shell/actions'
import { columnToText, numericColumns } from './serialize'
import s from './Table.module.css'

type TableModel = Extract<BlockModel, { kind: 'table' }>

const CopyIcon = resolveIcon('Copy')

/**
 * 表格本体 —— 六轮定稿的 **T0 基准**。
 *
 * 逐条落位:
 *  · **窄檐**(表题位 + 动作)由壳画,不在这个文件里 —— 见 index.ts 的 chrome/actions。
 *  · **无斑马**。隔行底色是给「一屏几十行、只需扫过去」的报表准备的;聊天里的表通常
 *    三五行,斑马纹在这个尺度上只是噪声。
 *  · **行 hover**:横向读一行时给一条淡底,这是读表真正需要的引导。
 *  · **列感应**:悬到任意单元格,**整列**淡亮;列头同时露出 ⧉ 复制列。
 *  · **数字列右对齐 + mono**:判据是列里装的是什么(numericColumns),不是作者写没写
 *    冒号 —— 理由在 serialize.ts。
 *
 * ── 列感应怎么做到不重渲染 ────────────────────────────────────────────
 * 悬停的列号写在**容器的一个 data 属性**上(`data-hover-col`),整列淡亮由 CSS 的
 * `nth-child` 完成。不给每个单元格算 className:那样每移一列就要重画整张表,
 * 而表格是流式期间会长的东西,那份重画会直接压在长表上。
 * 代价是 CSS 里要为前 N 列各写一条规则(N 见 Table.module.css 的说明),
 * 超出 N 列不淡亮 —— 一个诚实的降级,而不是一段会卡的通用实现。
 */
export function Table({ model }: { model: TableModel }) {
  const t = useT()
  const [hoverCol, setHoverCol] = useState<number | null>(null)
  const numeric = useMemo(() => numericColumns(model), [model])

  return (
    <table
      className={s.table}
      data-hover-col={hoverCol ?? undefined}
      onMouseLeave={() => setHoverCol(null)}
    >
      <thead>
        <tr>
          {model.head.map((cell, col) => (
            <th
              key={col}
              className={numeric[col] ? `${s.th} ${s.numeric}` : s.th}
              scope="col"
              onMouseEnter={() => setHoverCol(col)}
            >
              <span className={s.headInner}>
                <span className={s.headText}>
                  <InlineRun nodes={cell} />
                </span>
                <button
                  type="button"
                  className={s.colCopy}
                  aria-label={t('block.action.copyColumn')}
                  title={t('block.action.copyColumn')}
                  onClick={() => {
                    // 块内热区,走的仍是**壳的那一个执行器** —— 复制在全系统是同一件事。
                    void runBlockAction(
                      { verb: 'copy', what: 'column', text: columnToText(model, col) },
                      { toggleSource: () => undefined },
                    )
                  }}
                >
                  <CopyIcon className={s.colCopyIcon} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {model.rows.map((row, index) => (
          <tr key={index} className={s.row}>
            {row.map((cell, col) => (
              <td
                key={col}
                className={numeric[col] ? `${s.td} ${s.numeric}` : s.td}
                onMouseEnter={() => setHoverCol(col)}
              >
                <InlineRun nodes={cell} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
