import type { MouseEvent as ReactMouseEvent } from 'react'
import { ButtonBase } from '../../ui/ButtonBase'
import { Highlight } from '../../expose/components/Highlight'
import type { MessageKey, TFn } from '../../i18n'
import { isOtherSpace } from '../filters'
import { originText } from '../transitions'
import { resolveTargetRenderer } from '../targets'
import type { SearchRow as SearchRowModel } from '../types'
import s from './SearchPanel.module.css'

/**
 * **一条命中** = 结构件(`role="option"`)→ `ui/ButtonBase` 只清 UA(裸 button 三类
 * 判的第③类:视觉本该定制的结构性交互件)。
 *
 * 第 ⑥ 步从 `SearchPanel.tsx:841-904` 原样搬出来 —— props 原样、DOM 原样、CSS 类
 * 原样。子节点次序也是契约:`SearchPanel.test.tsx:320-321` 按 `children[0]`(徽)/
 * `children[1]`(正文)取件,`gate-search-messages.mjs:345` 按 `data-row` 取行。
 *
 * ── 它不认识任何一个能力的名字 ──────────────────────────────────────────
 * 徽上写什么由**这一行的目标渲染器**答(`targets/registry.ts` 的 `badge(row)`),
 * 缺渲染器就是**空徽 + 照样画出正文**(§4.3:绝不因为壳没跟上而把结果吞掉)。
 *
 * ── 附录 B §1 里它叫 `items/row.tsx` 的 `Render` ────────────────────────
 * 那要等第 ⑦ 步:`items/row.tsx` 的 `Render` 吃的是新数据路的形
 * (`SearchListing` + `SearchResult`),而这一步面板**仍吃旧数据路**(壳自己的
 * `SearchRow` 模型)。两边合一是换心那一批的事,合在今天等于提前改行为。
 */
export interface SearchRowProps {
  row: SearchRowModel
  /** 这一行在**整张扁平列表**里的下标(`data-row`;门与用例按它点行)。 */
  index: number
  /** 这一项在序列里的身份(`data-item-id`;滚入视野与 `reconcile` 按它认)。 */
  itemId: string
  /** 这一块的**第一行**吗 —— 块之间那一格空 + 一条发线(R1)由它画。 */
  first: boolean
  /** 键盘位落在它身上吗(`aria-selected` 与 `--st-sel` 读它)。 */
  selected: boolean
  /** 明确挑出来的那几条之一吗(多选,`data-picked`)。 */
  picked: boolean
  /** 此刻是不是「全部空间」那一档 —— 跨空间徽只在那一档画(§9 原话)。 */
  allSpaces: boolean
  /** 当前空间 id(判「这一行是不是别的空间的」)。 */
  spaceId: string
  /** 缺省空间 id。 */
  defaultSpaceId: string
  /**
   * 高亮用的词。行自带 `highlight`(后端判的)时不看它 —— 判据写在 `Highlight` 上。
   * 空串 = 不按词切(浏览态)。
   */
  query: string
  t: TFn
  onClick(event: ReactMouseEvent): void
  onContextMenu(event: ReactMouseEvent): void
}

/**
 * 徽上的字 —— **由这一行的目标渲染器答**,不是面板自己 `switch` 一遍。
 *
 * 两种产地照旧分得清清楚楚:`labelKey` 那种是界面文案(走字典),`text` 那种是
 * 从数据推出来的(扩展名之类,换语言不该变)。缺渲染器时是空徽 —— 那一行仍然
 * 画出来(标题行),只是没有徽可写。
 */
function badgeText(row: SearchRowModel, t: TFn): string {
  const renderer = resolveTargetRenderer(row.target.kind)
  if (renderer === undefined) return ''
  const badge = renderer.badge(row)
  return 'labelKey' in badge ? t(badge.labelKey as MessageKey) : badge.text
}

export function SearchRow({
  row,
  index,
  itemId,
  first,
  selected,
  picked,
  allSpaces,
  spaceId,
  defaultSpaceId,
  query,
  t,
  onClick,
  onContextMenu,
}: SearchRowProps) {
  return (
    <ButtonBase
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      data-row={index}
      data-item-id={itemId}
      data-target-kind={row.target.kind}
      data-capability={row.capability}
      data-picked={picked ? 'true' : undefined}
      className={[
        s.row,
        first ? s.blockStart : '',
        selected ? s.rowOn : '',
        picked ? s.rowPicked : '',
      ].filter(Boolean).join(' ')}
      /* 焦点恒在输入框:按下去那一刻不许把它抢走(判例与 items/more 同一条)。 */
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {/*
        * 徽是**两层**:外层那颗胶囊 hug 内容(宽度由内容定,不写死),
        * 内层负责弯腰 —— text-overflow 只在块容器上生效,而胶囊为了居中
        * 是 inline-flex,直接挂在它身上的省略号永远不会出现。
        */}
      <span className={s.chip}>
        <span className={s.chipText}>{badgeText(row, t)}</span>
      </span>
      <span className={s.text}>
        {/*
          * 没有标题的那一行(后端把占位名归了空)画一句**壳自己的**「未命名会话」,
          * 降一档、斜体 —— 它是一个状态,不是一个名字(检索面终稿 §6)。
          */}
        {row.untitled === true ? (
          <span className={s.untitled}>{t('search.untitledSession')}</span>
        ) : (
          /* 高亮两条产地一条渲染:行自带 `highlight`(后端判的)就用那一份,
            * 没有就照当前的词自己切 —— 判据写在 Highlight 上。 */
          <Highlight
            text={row.text}
            query={query}
            {...(row.highlight ? { ranges: row.highlight } : {})}
          />
        )}
      </span>
      <span className={s.origin}>{originText(row.origin)}</span>
      {/*
        * 徽(§9「徽」那一条)。两颗,都只在**事实成立**时画:
        *  · 归档 —— `facets.archived` 为真。索引照建归档会话的文档,
        *    所以它们**搜得到**,但得让人一眼看出来。
        *  · 跨空间 —— `facets.spaceId` 与当前空间不同,**且此刻是
        *    「全部空间」那一档**(§9 原话):默认那一档里根本不会出现
        *    别的空间的行,画一颗恒不出现的徽等于骗自己。
        */}
      {row.facets?.archived === true && (
        <span className={s.tag} data-tag="archived">{t('search.badgeArchived')}</span>
      )}
      {allSpaces && isOtherSpace(row.facets?.spaceId, spaceId, defaultSpaceId) && (
        <span className={s.tag} data-tag="space">{t('search.badgeOtherSpace')}</span>
      )}
      {/*
        * 语义徽(检索面终稿 §6 最后一行)。**不是计数徽** —— 它说的是「这一条是
        * 向量路召回的」,一句实话:它未必逐字含那个词。判据是候选自己带的 `source`,
        * 壳不猜。
        */}
      {row.source === 'vector' && (
        <span className={s.tag} data-tag="semantic">{t('search.badgeSemantic')}</span>
      )}
    </ButtonBase>
  )
}
