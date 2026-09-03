import { MONTH_KEYS, type SectionLabel } from '../sections'
import { useT } from '../../i18n'
import s from './SectionHead.module.css'

/**
 * 分节头 —— **一行字**,不是一条带(设计 §1.2 / 08-30 当晚二裁)。
 *
 * 三条禁令一起写在这里,因为它们互相支撑:
 *  · **不带计数**(08-30 计数禁令:tab / 列表 / 组头不挂计数徽);
 *  · **不画背景**(任何状态都不画 —— 粘附态也不画。代价明知并接受:行从头底下
 *    滚过时字会短暂同框,换来的是列表里永远不出现一条颜色不同的横带);
 *  · **不可折叠**(一次分组,顺序即阅读顺序,没有第二层可以钻)。
 *
 * 文案由 `SectionLabel` 这只**数据**说了算 —— 纯函数层(sections.ts)只产标识,
 * 界面字符串在这里拼(与 session-time 的 `formatRelativeTime` 同一条规矩:
 * 纯函数不产界面字符串)。本年的月份**就是** `time.month<N>` 自己,跨年才包一层
 * `expose.sectionMonthYear`。
 */
export function SectionHead({ id, label }: { id: string; label: SectionLabel }) {
  const t = useT()
  const text =
    label.kind === 'key'
      ? t(label.key)
      : t('expose.sectionMonthYear', {
          year: label.year,
          month: t(MONTH_KEYS[label.month - 1] ?? MONTH_KEYS[0]),
        })
  /*
   * ── `aria-hidden` 不是「藏起来」,是「别在树里出现两遍」(09-04 gate:a11y 判例)──
   * 这块字是**分节的名字**:它已经由 `role="group"` 的 `aria-labelledby` 指着,
   * 读屏进这一节时会念一遍。而它同时是那只 `role="tree"` 的**后代** ——
   * ARIA 说 tree 里的 group 只许拥有 treeitem,于是一个裸的 `<h3>` 是「不允许的孩子」
   * (axe `aria-required-children` critical,真跑红过)。
   * 两件事一个修法:把它从无障碍树里摘掉。名字一点没丢 —— accname 允许引用
   * 隐藏内容,`aria-labelledby` 照样从这里取字;丢掉的只是「按标题跳转」那一层,
   * 而列表本来就靠 tree 自己的结构导航,不靠标题。
   * `<h3>` 这个标签留着:它是**视觉与文档结构**的实话(节头就是一行标题)。
   */
  return (
    <h3
      id={`expose-section-${id}`}
      className={s.head}
      data-testid={`expose-section-${id}`}
      aria-hidden="true"
    >
      {text}
    </h3>
  )
}
