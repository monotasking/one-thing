import { ChevronDown, ChevronRight } from '../../components/icons'
import { MONTH_KEYS, type SectionLabel } from '../sections'
import { useT } from '../../i18n'
import s from './SectionHead.module.css'

/**
 * 分节头 —— **一行字,而且是树的一项**(设计 §1.2 + 09-04 用户报「分组没法收」)。
 *
 * 三条禁令仍在,它们互相支撑:
 *  · **不带计数**(08-30 计数禁令:tab / 列表 / 组头不挂计数徽);
 *  · **底色不自己猜**:09-04 用户令「让它不透明」翻掉了「组头不画背景」那半条
 *    (6378233d)—— 粘顶的头要是透明的,行从它底下滚过就会透出来。底读的是宿主
 *    那一层 `--surface-host`,四个 Placement 宿主各自声明,这一行只读不猜。
 *    悬停在它之上再叠一层标准薄膜 `--st-hover`(09-04 用户报「group 的 hover
 *    看不到几乎」:那时只提墨色,弱到读不出来),配方与行 / 侧栏项同一张表;
 *  · **粘顶**(`position: sticky`,粘在它自己那一节的范围内)。
 *
 * 第四条 09-04 **翻面**:从「不可折叠」变成 **恒可折叠**。用户 09-04 真机报
 * 「分组没法收」——一张 469 条会话的列表里,「八月」那一节占掉整屏而没有任何
 * 收起它的办法。
 *
 * ── 为什么它是 `<div role="treeitem">` 而不是 `ui/GroupHead`(基础件先行的答卷)──
 * `ui/GroupHead` 正是这套壳的「列表分组头」库件,它的可折叠形也确实带 caret 与
 * `aria-expanded`;但那一形的根是 `ui/ButtonBase` —— 一个 `<button>`。而这一行
 * 长在 `role="tree"` 里:**树的项是 treeitem,不是按钮**(APG:项由容器接键,
 * 不各占一个 Tab 位;469 条会话 + 6 个节头不该是 475 个 Tab 位)。
 * 一个 `role="treeitem"` 的 `<button>` 会同时说两句相反的话(可聚焦 vs 由
 * activedescendant 指着),axe 的 `aria-required-children` 与 Tab 序走查各红一遍。
 * 它的**静态形**是 `<div>`,但静态形按定义不画 caret(判据就是「给不给 onToggle」)。
 * 皮肤也没有 `composes`:`GroupHead.module.css` 的 `.head` 带着自己的 padding 与
 * `--fs-micro`,而这一行的高必须**恰好是它这一档的行高**(侧栏形
 * `--expose-sec-h`、总览形 `--list-row-h`;粘顶的高度与滚动容器的
 * `scroll-padding-top` 是同一个数);两个单类选择器特异性相同,谁赢由样式表
 * 先后决定 —— 那是一条会随 import 次序漂的规则,不值得为省几行 CSS 去冒。
 * 所以这里保留自己的皮肤,并把这条出入记在这儿(施工纪律:出入记档回报)。
 *
 * 文案由 `SectionLabel` 这只**数据**说了算 —— 纯函数层(sections.ts)只产标识,
 * 界面字符串在这里拼(与 session-time 的 `formatRelativeTime` 同一条规矩)。
 * 本年的月份**就是** `time.month<N>` 自己,跨年才包一层 `expose.sectionMonthYear`。
 */
export function SectionHead({
  id,
  label,
  expanded,
  active,
  onToggle,
}: {
  /** 分节 id(`pinned` / `today` / `month:2026-08` …)。DOM id 与 testid 都由它拼。 */
  id: string
  label: SectionLabel
  expanded: boolean
  /** 键盘活动项(`aria-activedescendant` 指着的那一个,柔光环)。 */
  active: boolean
  onToggle: (sectionId: string) => void
}) {
  const t = useT()
  const text =
    label.kind === 'key'
      ? t(label.key)
      : t('expose.sectionMonthYear', {
          year: label.year,
          month: t(MONTH_KEYS[label.month - 1] ?? MONTH_KEYS[0]),
        })
  const Caret = expanded ? ChevronDown : ChevronRight
  return (
    /*
     * ── 从前这里是一个 `aria-hidden` 的 `<h3>`,那一手 09-04 上午还是对的 ──────
     * 那时它不是树的项,而一个裸的 `<h3>` 在 `role="tree"` 里是「不允许的孩子」
     * (axe `aria-required-children` critical,真跑红过),于是把它从无障碍树里
     * 摘掉、名字仍由 `aria-labelledby` 引用(accname 允许引用隐藏内容)。
     * 现在它**是**树的项了,`aria-hidden` 必须去掉 —— 藏起来的项走不到、
     * 也读不出 `aria-expanded`。`<h3>` 这个标签跟着退役:一个 `role="treeitem"`
     * 的 h3 只是把「标题」这层语义换成了别的,留着标签徒增误解。
     * 名字仍从这里取(下面那只 `role="group"` 的 `aria-labelledby` 指着这个 id)。
     */
    /* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/interactive-supports-focus --
     * 两条都为 **APG 的 activedescendant 形**让路,与 SessionRow 上那两条逐字同因:
     * 键盘等价物(→ / ← / ↵)由树容器接(事件委托,见 ExposeView),项本身
     * 故意不可聚焦 —— 焦点停在 `role="tree"` 那**一个** Tab 位上。 */
    <div
      role="treeitem"
      id={`expose-section-${id}`}
      className={s.head}
      data-testid={`expose-section-${id}`}
      data-section-id={id}
      data-active={active ? 'true' : undefined}
      aria-level={1}
      /*
       * 这棵树是**单选**的(选中 = 当前会话,行上由 `aria-selected` 报),而一个
       * 分组永远不会是当前会话 —— 所以这里恒 `false`,不是省略。ARIA 1.1 把
       * `aria-selected` 列为 treeitem 的必备格(jsx-a11y 的
       * `role-has-required-aria-props` 照它判),而「省略」在读屏那头读作
       * 「这一项不可选」;同一棵树里一半项可选一半项不可选,是比「没被选中」
       * 更难解释的一句话。
       */
      aria-selected={false}
      aria-expanded={expanded}
      onClick={() => onToggle(id)}
    >
      {/*
       * ── 09-12:节名在前,caret 挪到**行尾**(正本 §3.1)──────────────────
       * 从前 caret 占的是 `--expose-glyph-w`、与行首那一列同宽同位,为的是
       * 「节名与行标题从同一条竖线起笔」。方向 A 把行首那一列去掉了
       * (形态字形只在有字形的行上画),于是那条对齐的对象不存在了 ——
       * 留着一列常显的 ▾ 只会让节名比行的文字多缩进 22px。
       * 今天节名直接从盒子的左内缘起笔(x = 22,红灯中心),与行的文字同一条线,
       * caret 退到行尾并且**悬停或已折叠才显**(判词在 .caret 上)。
       *
       * caret 不带名字:开合态由 `aria-expanded` 说,读屏念两遍是噪音。
       */}
      <span className={s.label}>{text}</span>
      <Caret className={s.caret} strokeWidth={2} aria-hidden="true" />
    </div>
  )
}
