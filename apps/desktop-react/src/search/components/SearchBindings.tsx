import { useEffect, useRef } from 'react'
import { usePanelVisibility } from '../../content/visibility'
import { useFocusScope } from '../../focus/useFocusScope'
import { useStageStore } from '../../stage/store'
import { formOf } from '../../stage/transitions'
import { ensureSearchCatalog } from '../../data/search-catalog-source'
import { ensureSearchListing } from '../../data/search-listing-source'
import { useSearchStore } from '../store'

/**
 * **这块面的三条副作用**,渲染 `null` 的一片叶(检索面终稿 附录 B §1 /
 * §2 生命周期表)。
 *
 * 装在叶子里而不是长在 `SearchPanel` 身上,理由与 `expose/components/Overview.tsx`
 * 的 `AutoFocusSearch` 逐字相同:这三件各自订着会频繁翻转的事实(摆没摆出来 /
 * 看不看得见 / 主语换没换),谁的渲染输出消费它,谁就跟着整棵重渲。
 *
 * 三条:
 *
 * ① **摆出来的那一刻,键盘归这块面**(`placed` 由假翻真且此刻算数 →
 *    `activate('placement')`)。逐字照 `AutoFocusSearch`:判据是「**它自己**被摆
 *    出来了」,不是挂载(会被出场动画与搬家骗到)、也不是 live 升起(会因为隔壁
 *    的事翻真)。它接的是从前那句 `activateOnMount` 的班 —— 行为不变:指针点
 *    Dock 瓦开出来也送焦点,落点由 `restingTarget` 答(那格输入框)。
 *
 * ② **取数**。合并窗口只挡**打字的余波**:主语的「问谁 + 哪些片」那一半变了
 *    ——「确定的一步」(换档 / 拨片 / 续搜)—— 就当场换键,不等 220ms。
 *    换键走 `resetForListing`(活动项归零 + 清多选),它与 `ensure` 是同一件事的
 *    两半,所以在同一处发生。
 *
 *    看不见的那一份**不发**(`visible` 翻假时 cleanup 清计时器、`committedKey`
 *    一个字不换);重新看得见时若主语已经不是订着的那一把,当场补一发。
 *
 * ③ **收回 Dock = 回出厂**(`placed` 由真翻假 → `store.reset()`;拍点 G 默认保旧,
 *    与从前「卸载本地状态全没了」逐字相同)。store 的寿命比组件长,所以这一句
 *    必须显式写出来 —— 从前它是「组件没了,useState 跟着没」的副产品。
 */

/** 检索这块瓦的 id。它是**瓦**的名字,不是一个能力 id。 */
const SEARCH_ITEM_ID = 'search'

/**
 * 合并窗口。每敲一个字母发一次请求是不合适的 —— 窗口按「打完一个词的停顿」取,
 * 不按「最快能有多快」取。
 */
export const SEARCH_DEBOUNCE_MS = 220

export interface SearchBindingsProps {
  /** 此刻的主语那把键(问谁 + 词 + 片)。 */
  subjectKey: string
  /**
   * 主语里**除词以外**那一半的指纹(问谁 + 片)。它变了 = 一次「确定的一步」,
   * 不等合并窗口;只有词变才等。
   */
  subjectShape: string
}

export function SearchBindings({ subjectKey, subjectShape }: SearchBindingsProps) {
  const { activate } = useFocusScope()
  const { visible, interactive } = usePanelVisibility()
  const placed = useStageStore(st => formOf(st, SEARCH_ITEM_ID) !== 'dock')
  const committedKey = useSearchStore(st => st.committedKey)
  const resetForListing = useSearchStore(st => st.resetForListing)
  const reset = useSearchStore(st => st.reset)

  /*
   * ⓪ 自述与索引状态:挂上来问一次(幂等,`ensure` 的语义)。**只此一次** ——
   * 它们不是跟着词走的东西,进不了下面那条带去抖的副作用。
   */
  useEffect(() => {
    void ensureSearchCatalog()
  }, [])

  /* ① 摆出来 → 焦点进来。 */
  const wasPlaced = useRef(false)
  useEffect(() => {
    const justPlaced = placed && !wasPlaced.current
    wasPlaced.current = placed
    if (justPlaced && interactive) activate('placement')
  }, [placed, interactive, activate])

  /*
   * ③ **收回 Dock = 回出厂**(拍点 G 保旧:词 / 档 / 片 / 历史 / 选中全没了)。
   *
   * 判据挂在**卸载**上,不是 `placed` 的下降沿 —— 那条下降沿在组件里**等不到**:
   * 这块面与它那一格形态是同生共死的,收回 Dock 那一刻它当场从树上摘掉,
   * 下一次渲染根本不会发生(第 ⑦ 步真机门抓到的:`gate:search` 第 5 步进会话之后
   * 再开面板,屏幕上还是上一次那个词的结果)。
   *
   * 卸载的**另外**几种理由不该清:换宿主(舞台 → 浮窗 / 钉边)是真重挂,而词与
   * 滚动位不该因为把面板拖到别处就归零。两者的分界只有一句话 —— **此刻它还在不在
   * 某棵树里**,所以在拆卸那一刻现问一次形态,而不是靠上一次渲染留下的记号。
   */
  useEffect(() => () => {
    if (formOf(useStageStore.getState(), SEARCH_ITEM_ID) === 'dock') reset()
  }, [reset])

  /* ② 取数(去抖只挡打字的余波)。 */
  const shapeRef = useRef(subjectShape)
  useEffect(() => {
    const shapeChanged = shapeRef.current !== subjectShape
    shapeRef.current = subjectShape
    if (!visible) return
    if (committedKey === subjectKey) {
      // 订着的就是此刻的主语 —— `ensure` 幂等,重看得见 / 重挂都靠它补那一发。
      void ensureSearchListing(subjectKey)
      return
    }
    const commit = (): void => {
      resetForListing(subjectKey)
      void ensureSearchListing(subjectKey)
    }
    if (shapeChanged) {
      commit()
      return
    }
    const timer = setTimeout(commit, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [subjectKey, subjectShape, committedKey, visible, resetForListing])

  return null
}
