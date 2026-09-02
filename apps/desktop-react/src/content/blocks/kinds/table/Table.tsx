import { useMemo, useRef, useState } from 'react'
import { useT } from '../../../../i18n'
import { COPY_FEEDBACK_MS } from '../../../../components/motion'
import { announce } from '../../../../ui/a11y/live-region'
import { resolveIcon } from '../../../../components/icons'
import { IconButton } from '../../../../ui/IconButton'
import type { BlockModel } from '../../../model/blocks'
import { InlineRun } from '../../inline/InlineRun'
import { runBlockAction } from '../../shell/actions'
import { columnToText, numericColumns } from './serialize'
import s from './Table.module.css'

type TableModel = Extract<BlockModel, { kind: 'table' }>

/**
 * 一屏摆得下的列数上限(R4b 的超量削列)。
 *
 * 取 24:真机报障那张是 117 列,而聊天里的表**极少**过 24(素材里最宽的一张 13 列,
 * 削量对它是恒等)。这个数不是视觉量(不进 tokens.css),是一条**内容政策**——
 * 它回答的是「摆不下的时候摆几列」,与色值 / 间距不是一类东西。
 */
export const TABLE_MAX_COLS = 24

const CopyIcon = resolveIcon('Copy')
const CheckIcon = resolveIcon('Check')

/**
 * 表格本体 —— 六轮定稿的 **T0 基准**。
 *
 * 逐条落位:
 *  · **窄檐**(表题位 + 动作)由壳画,不在这个文件里 —— 见 index.ts 的 chrome/actions。
 *  · **无斑马**。隔行底色是给「一屏几十行、只需扫过去」的报表准备的;聊天里的表通常
 *    三五行,斑马纹在这个尺度上只是噪声。
 *  · **行 hover**:横向读一行时给一条淡底,这是读表真正需要的引导。
 *  · **列感应只归表头**:悬到**列头**,整列淡亮 + 该列头露出 ⧉ 复制列。身体格不感应
 *    (08-30 用户报障:td 上也挂了 onMouseEnter,读一行时行 hover 与整列淡亮叠成
 *    十字准星,一片糊)。表头是「这一列是什么」的把手,列操作就长在它上面。
 *  · **数字列右对齐 + mono**:判据是列里装的是什么(numericColumns),不是作者写没写
 *    冒号 —— 理由在 serialize.ts。
 *  · **超量削列**(R4b,用户 117 列截图):列数过了 `TABLE_MAX_COLS` 就只画前 N 列,
 *    末尾挂一格**文字读数**「还有 M 列」。与列表削量同一条超量纪律(计数禁令允许
 *    文字读数,不允许计数徽)。
 *
 * ── 削的只是**画面**,不是数据 ────────────────────────────────────────
 * 檐上那两个「复制 Markdown / 复制 CSV」取的是 `model` 本身(serialize.ts),
 * 一列都不少。削量是「这一屏摆不下」的答案,不是「这张表只有这么多」——
 * 把削量渗进序列化会让用户复制出一份**缺列的**表,而他根本不知道。
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
  /** 刚复制过的列(⧉ 换 ✓ 一拍,COPY_FEEDBACK_MS 后还原)。 */
  const [copiedCol, setCopiedCol] = useState<number | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const numeric = useMemo(() => numericColumns(model), [model])
  const hiddenCols = Math.max(0, model.head.length - TABLE_MAX_COLS)
  const shown = hiddenCols > 0 ? TABLE_MAX_COLS : model.head.length

  return (
    <table
      className={s.table}
      data-hover-col={hoverCol ?? undefined}
      onMouseLeave={() => setHoverCol(null)}
    >
      {/*
       * onMouseLeave 挂在 thead 上,不是只靠 table 那一层:从列头往下滑进表体时,
       * 整张表并没有被离开,少了这一下列光会滞留在原地(容器级 onMouseLeave 只管
       * 「离开整张表」这一件事)。
       */}
      <thead onMouseLeave={() => setHoverCol(null)}>
        <tr>
          {model.head.slice(0, shown).map((cell, col) => (
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
                <IconButton
                  icon={copiedCol === col ? CheckIcon : CopyIcon}
                  size="xs"
                  className={s.colCopy}
                  label={t(copiedCol === col ? 'common.copied' : 'block.action.copyColumn')}
                  onClick={() => {
                    // 块内热区,走的仍是**壳的那一个执行器** —— 复制在全系统是同一件事。
                    // 反馈也走同一条拍板(08-31):就地换形(⧉ → ✓)一拍 + 播报,不弹通知。
                    void runBlockAction(
                      { verb: 'copy', what: 'column', text: columnToText(model, col) },
                      // 壳的那两件能力(源码开关 / 放大浮层)在块内热区这条路上都用不上,
                      // 但接口是一份 —— 给两个空实现,而不是给执行器开一条「可以缺席」的口子。
                      { toggleSource: () => undefined, openZoom: () => undefined },
                    ).then((ok) => {
                      if (ok === undefined) return
                      announce(t(ok ? 'common.copied' : 'common.copyFailed'))
                      if (!ok) return
                      setCopiedCol(col)
                      clearTimeout(copiedTimer.current)
                      copiedTimer.current = setTimeout(() => setCopiedCol(null), COPY_FEEDBACK_MS)
                    })
                  }}
                />
              </span>
            </th>
          ))}
          {hiddenCols > 0 && (
            <th className={`${s.th} ${s.overflowCell}`} scope="col" data-col-overflow={hiddenCols}>
              {t('block.table.moreColumns', { n: hiddenCols })}
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {model.rows.map((row, index) => (
          <tr key={index} className={s.row}>
            {row.slice(0, shown).map((cell, col) => (
              <td key={col} className={numeric[col] ? `${s.td} ${s.numeric}` : s.td}>
                <InlineRun nodes={cell} />
              </td>
            ))}
            {hiddenCols > 0 && <td className={`${s.td} ${s.overflowCell}`} />}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
