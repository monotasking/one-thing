import type { TFn } from '../../i18n'
import { OTHER_GROUP } from '../types'
import type { CatalogGroup } from '../types'

/**
 * 模型目录的**纯判据**(09-02 批 9a 从 ModelCatalog.tsx 出文件,切线 E)。
 * 不认识 React、不碰 DOM、不读 store —— 进什么出什么,所以每一条都断言得动。
 *
 * ── 为什么不并进 `providers/projection.ts` ──────────────────────────────
 * 那份文件头上写着一条纪律:「纯函数,不认识 React、不认识 store,**也不翻译**
 * —— 交出去的是 `Fact`,组件用 useT 把它变成字」。而这里这三条**收 `t`、
 * 交字符串**(组名是 id 不翻译、读数是拼出来的一句话、空态那句是三层三元的
 * 结论),放进去当场破那条纪律。所以它们落在**这块组件旁边**:同一个文件夹、
 * 同一个消费者、一个 `.ts` 的名字说清它不画东西。
 */

/**
 * 超过这个行数的**展开**组,行上挂 `content-visibility: auto` 让浏览器跳过
 * 视口外的排版。只对长组挂:短组挂了只是多一层 containment,白付成本。
 */
export const SKIP_ROWS_FROM = 40

/**
 * 这一组的行要不要跳过视口外排版。**收起的组一行都不渲染**,所以「收起」
 * 那一档恒假 —— 不是省一次判断,是「没有行可跳」这件事本身。
 */
export function shouldSkipRows(open: boolean, rowCount: number): boolean {
  return open && rowCount > SKIP_ROWS_FROM
}

/** 「anthropic/」;杂项组说「其他」。前缀是数据,不翻译。 */
export function groupLabel(t: TFn, group: CatalogGroup): string {
  return group.prefix === OTHER_GROUP ? t('providers.groupOther') : group.prefix
}

/** 「18 型」/「125 型 · 45 个厂牌」。厂牌数只有杂项组说得出口。 */
export function groupNote(t: TFn, group: CatalogGroup): string {
  const count = t('providers.groupCount', { count: group.rows.length })
  if (group.prefix !== OTHER_GROUP || group.vendors === 0) return count
  return `${count} · ${t('providers.groupVendors', { count: group.vendors })}`
}

export interface CatalogEmptyInput {
  /** `phase === 'initial'` —— 这一坑从来没拿到过目录。 */
  firstLoad: boolean
  /** 后端那句原话。它在场时空态那句让位:错误行已经把话说完了。 */
  error?: string
  rowCount: number
  searching: boolean
}

/**
 * 屏幕上那句「非常态」的话 —— 没有就交 `undefined`(什么都不画)。
 *
 * ── 首载这一档里**不再分「在飞」与「还没开始」**────────────────────────
 * 取数是挂载后的一个副作用,中间隔着一帧,而那一帧按「没在飞」画就会闪一下
 * 「这一坑还没有模型」—— 一句当时并不成立的话。首载只有两种诚实答案:
 * 「在拿」或者「没拿到,原话是这句」(后者归错误行说,这里交 `undefined`)。
 *
 * 「空」是一个**只有拿到过才说得出口**的结论,所以它归 ready 那一档。
 * 而 ready 里还分两句:检索没命中(**目录里有,只是这几个字没找着**)与
 * 这一坑真的一个模型都没有 —— 两句话在事实上差得远。
 */
export function catalogEmptyLine(t: TFn, input: CatalogEmptyInput): string | undefined {
  const { firstLoad, error, rowCount, searching } = input
  if (firstLoad) return error ? undefined : t('providers.catalogLoading')
  if (rowCount > 0) return undefined
  return searching ? t('providers.catalogNoHit') : t('providers.catalogEmpty')
}
