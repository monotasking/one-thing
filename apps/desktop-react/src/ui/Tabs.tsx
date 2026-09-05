import { useEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { resolveIcon, X } from '../components/icons'
import { StatusDot } from './StatusDot'
import { Tooltip } from './Tooltip'
import { useRoving } from './a11y/roving'
import s from './Tabs.module.css'

/**
 * 规范画布「Tabs 族」的唯一实现:高 36、tab 左右内边距 10。
 * 活动态只换字色 + 底缘 2px accent 指示条(inset box-shadow,不占布局,
 * 所以切换 tab 一像素都不动);非活动 --text-3,hover --st-hover。
 *
 * 完全受控:它不存 activeId,也不认识 item 里装的是什么内容。
 * onClose 给了才画 ×,× 平时透明、hover 本 tab 时浮出(只动 opacity,位子一直占着)。
 *
 * ── 键盘表(A11y 线 · A2)───────────────────────────────────────────────
 *   ← / →             在 tab 之间移动焦点(循环),整条只占**一个** Tab 位;
 *                     **只移焦点不切页**(APG 的手动激活档)——「移到就切」会让
 *                     键盘用户路过一条 tab 就把它的内容装一遍,这台上每张页都要拉数据
 *   Home / End        到首 / 末
 *   Enter / Space     激活当前 tab
 *   Delete / Backspace 关掉当前 tab(给了 onClose 才有)—— 屏幕上那颗 × 是**鼠标**
 *                     的顺手路,它不进 Tab 序,理由写在下面那颗按钮上
 *   Tab               走出 tab 条(整条只占一个位子)
 * 语义:role=tablist / tab + aria-selected。**没有 aria-controls** —— 内容面板
 * 由宿主画在别处,Tabs 不认识它;指一个自己不知道在不在的 id 比不指更糟。
 * ──────────────────────────────────────────────────────────────────────
 */
export interface TabSpec {
  id: string
  label: string
  /** lucide 图标名,与 items 表同一套字符串 */
  icon?: string
  /**
   * **有没存的改动**(W1)。画一枚 `ui/StatusDot`(warn 档,`size="sm"`)——
   * 与查看器檐上从前那一颗**逐像素相同**(值就取自那一颗)。
   * 它**不是控件**:不进 Tab 序、没有 hover/active,只是一枚状态点,
   * 而且**不给 label** —— tab 自己的名字已经在旁边,再给一个无障碍名会念两遍。
   */
  dirty?: boolean
  /**
   * 悬停时说的**全名**。给了就把名字那一段包进 `ui/Tooltip`(截断的标题必须配
   * Tooltip 全名 —— 禁令区那条:`--tab-max-w` 是 160,`engine.ts` 与另一个目录里
   * 的 `engine.ts` 在屏幕上长得一模一样)。
   *
   * **缺席就一件都不挂**:没有 `tip` 的那些 tab(架子、别处的分段条)渲染出来
   * 的 DOM 与从前逐字相同 —— 这一格是加法,不是给所有消费方换一套行为。
   * 锚在名字那一段而不是整条 tab:说的是「这句被截断的话的全文」,
   * 而 ✕ 与未保存丸各有各的说法。
   */
  tip?: string
  /**
   * 关不关得掉。缺省 `true`(给了 `onClose` 就画 ✕)。
   *
   * **为什么 TabSpec 多这一格**(裁定原文只说加 `dirty` 一个布尔):
   * 「最后一片 chat 叶不可关」(T0 拍点 2)是**逐 tab** 的事实,而 `onClose`
   * 是整条 tab 条一个。判据若留在宿主里就得写成「点了才发现关不掉」——
   * 那时 ✕ 已经画出来了,而用户报的正是「按了没反应」这一族。所以它与
   * `dirty` 同族:**数据表驱动的一格事实**,不是混进来的 children。
   */
  closable?: boolean
  /**
   * **这一组的「家」**(W1-b,设计 §2.2:「会话标签的图标用主题色,它是这一组的家」)。
   * 只换**图标**的颜色 —— 底与字色是「活动 / 悬停」那两件事的语汇,与「谁是家」正交
   * (一条 tab 可以同时是家、是活动的、是被悬停的)。
   *
   * 它与 `dirty` / `closable` 同族:**数据表驱动的一格事实**。判据由宿主
   * 从内容种类的自述里取(`ContentKind.resident`),`ui/Tabs` 不认识任何一种内容。
   */
  home?: boolean
  /**
   * **这一格装了几份内容**(W6-b)。1 = 普通标签,2 = 两格并排的那一种。
   *
   * 它是**一个数**,不是「是不是 pair」—— `ui/Tabs` 认识的只有「这一格里有几份」,
   * 认不得任何一种内容(全目录 grep `pair` 在 `ui/` 下零命中)。落点判据要它:
   * 「两格的标签不能再并」(设计 v3 §6「不允许」)与「内容区左带仅 host 单格」
   * 两条各要读一次,而它们读的是 DOM 上这一格属性 —— 判据因此不必再开一份名册。
   * 缺省 1;与 `dirty` / `home` 同族:**数据表驱动的一格事实**。
   */
  slots?: number
}

/**
 * **这条 tab 条长什么样**(W3-b 裁定 1;09-05 用户看真机后选甲「浏览器式」)。
 *
 *   `line`    规范画布那一档:扁平,活动态只换字色 + 底缘 2px accent 指示条。
 *             **缺省** —— 别处的分段条(设置页、面板内的小 tab)一个像素都不变。
 *   `joined`  浏览器式:活动 tab 顶两角圆、无描边、底色 = 那片叶的脸,底部两侧
 *             各长一只反向圆角的「肩」把它和条底接成一整块;非活动透明底,
 *             相邻两条非活动之间一根细线。**拼贴台四个区域一律这一档**
 *             (顶栏组 / 架子叶 / 浮窗叶 / 分屏叶),用户报的「两套标签语言」
 *             就是这一句话治的。
 *
 * 它是**外观**,不是第二个组件:同一份数据表、同一套键盘行为、同一个 DOM 形状,
 * 换的只是一格 `data-look`。两个组件会在「预览斜体」「未保存丸」「✕ 什么时候浮出」
 * 这些地方各自漂一遍 —— 那正是这台壳里 tab 曾经有两套画法的病根。
 */
export type TabsLook = 'line' | 'joined'

interface TabsProps {
  items: TabSpec[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose?: (id: string) => void
  /** 外观档。缺省 `line`(见 `TabsLook`)。 */
  look?: TabsLook
  /**
   * 谁摆 Tabs 谁决定「按住一个 tab 意味着什么」。Tabs 自己不认识拖拽 ——
   * 它只把按下这件事连同 id 递出去,拖不拖得动、拖出去变成什么,是宿主的语法。
   * 不接就是不接:没给这个 prop 时 tab 的行为与从前逐字相同(按下 → 松开 → onSelect)。
   */
  onTabPointerDown?: (id: string, e: ReactPointerEvent<HTMLElement>) => void
  label?: string
}

export function Tabs({
  items,
  activeId,
  onSelect,
  onClose,
  onTabPointerDown,
  look = 'line',
  label,
}: TabsProps) {
  const bar = useRef<HTMLDivElement>(null)
  useRoving(bar, { axis: 'horizontal' })
  /*
   * **活动的那一格必须在视野里**(W3-b 真机读数:顶栏非焦点组被尾格夹到 216px,
   * 三格 tab 总宽 337,活动格排第三 —— `scrollLeft` 停在 0,活动格整颗裁在视野外,
   * 屏幕上那一组像「没有活动格」,连体当场失效)。条是横滚容器(超量纪律:永不换行、
   * 先收窄再横滚),所以活动格换人 / 条挂载时把它滚进来。`inline:'nearest'` 只在
   * 它真的在外面时才动,滚过的距离最短;`block:'nearest'` 不许它顺手把页面竖着滚。
   * 只滚不搬焦点(I3:`.focus()` 不在这里)。jsdom 没有 scrollIntoView,可选调用。
   */
  useEffect(() => {
    if (activeId === null) return
    const el = bar.current?.querySelector(`[data-tab-id="${activeId.replace(/["\\]/g, '\\$&')}"]`)
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [activeId])
  return (
    <div ref={bar} className={s.bar} data-look={look} role="tablist" aria-label={label}>
      {items.map((tab) => {
        const Icon = tab.icon ? resolveIcon(tab.icon) : null
        const on = tab.id === activeId
        // 关不掉的那一条**不画 ✕**(不是画出来再禁灰:一颗按不动的 ✕ 与
        // 「按了没反应」在屏幕上是同一件事)。
        const closable = onClose && tab.closable !== false
        return (
          /*
           * **tab 就是这一层**,不是里面那个按钮(A11y 线 · A2 的一处结构改动)。
           *
           * 理由是 ARIA 的一条硬约束:tablist 的合法子成员**只有** tab。从前的写法是
           * 「壳 div > [tab 按钮, × 按钮]」,那个 × 在无障碍树里是 tablist 的直接
           * 子成员(壳无论有没有 role,都会被穿过),于是 tablist 里坐着一个不是 tab
           * 的东西 —— axe 的 aria-required-children 判 critical,而它判得对:
           * 读屏软件按「第几个 tab」数下去会数错。
           *
           * 所以把 role="tab" 提到壳上,× 变成 tab **内部**的一个按钮。代价是这一层
           * 不再是原生 <button>,Enter / Space 要自己接一下 —— 这是**唯一**自造的
           * 一格键盘行为,写在下面那个 onKeyDown 里,别处一行都没有。
           */
          <div
            key={tab.id}
            className={[s.tab, on && s.tabOn, tab.home && s.tabHome]
              .filter(Boolean)
              .join(' ')}
            role="tab"
            aria-selected={on}
            /*
             * **取件口**(W3-b):条内换序那一件(`ui/tab-reorder.ts`)要按 id 认得出
             * 每一格,而 `role="tab"` 只说得出「第几个」。门与用例也读它。
             * 它是一格事实的投影,不是一件新功能 —— `id` 本来就在 props 里。
             */
            data-tab-id={tab.id}
            /*
             * **这一格装了几份**(W6-b,见 `TabSpec.slots`)。落点判据从 DOM 上读它,
             * 于是「两格的标签不能再并」这条规矩不必在判据那一头再开一份名册。
             * 只在 > 1 时写:一格标签的 DOM 与从前逐字相同。
             */
            data-tab-slots={tab.slots && tab.slots > 1 ? String(tab.slots) : undefined}
            // roving 入组标记 + 初值。选中的那一条由 useRoving 改回 0 ——
            // 不给初值的话,一条八页的 tab 条要按八下 Tab 才走得出去。
            data-roving-item
            tabIndex={on ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(e) => {
              // 原生按钮白送的那一格,这里补上。
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect(tab.id)
                return
              }
              // 关这条 tab 的**键盘路**(APG 可删除 tab 的做法)。× 是鼠标的顺手路,
              // 它不进 Tab 序(理由见下面那颗按钮上的注释),所以键盘要有自己这一下。
              if (closable && (e.key === 'Delete' || e.key === 'Backspace')) {
                e.preventDefault()
                onClose(tab.id)
              }
            }}
            onPointerDown={onTabPointerDown ? (e) => onTabPointerDown(tab.id, e) : undefined}
          >
            <span className={s.main}>
              {Icon && <Icon className={s.icon} strokeWidth={1.75} aria-hidden="true" />}
              {tab.tip ? (
                <Tooltip content={tab.tip}>
                  <span className={s.label}>{tab.label}</span>
                </Tooltip>
              ) : (
                <span className={s.label}>{tab.label}</span>
              )}
              {/*
               * 未保存丸**消费 `ui/StatusDot`**(与查看器檐上从前那一颗同一件、
               * 同一档)。不给 `label`:tab 的名字就在左边,读屏软件念两遍是噪音。
               */}
              {tab.dirty && (
                <span className={s.dirty} data-tab-dirty="" aria-hidden="true">
                  <StatusDot tone="warn" size="sm" />
                </span>
              )}
            </span>
            {closable && (
              /*
               * × 是**鼠标的顺手路**,不是键盘的路 —— 所以它 `aria-hidden` 且不进
               * Tab 序,键盘那一路是上面 onKeyDown 里的 Delete / Backspace。
               *
               * 这不是省事,是 ARIA 逼出来的唯一出口,两边都撞过墙才落到这里:
               *  · × 摆在 tab **外面**(从前的写法)→ tablist 里坐着一个不是 tab 的
               *    成员,aria-required-children 判 critical;
               *  · × 摆在 tab **里面**且可聚焦 → tab 是「子元素呈现性」的角色,
               *    nested-interactive 判 serious(两条都是真机 axe 实测出来的,
               *    不是纸上推的)。
               * 第三条路才两边都过:× 退成纯装饰,关闭这件事由 tab 自己用一个键表达。
               * 连 `<button>` 都不能留 —— axe 的原话是「元素上加负 tabindex(哪怕再
               * 加 aria-hidden)也挡不住辅助技术聚焦到它」,所以它必须**从一开始就不是
               * 一个控件**:一个 aria-hidden 的 <span>,只接鼠标。
               * 代价记档:读屏软件不再念得到那颗 ×(它本来也只念得出「关闭 files」
               * 这句我们编的话),键盘用户少按一下 Tab、多知道一个 Delete。
               */
              /* 刻意不给 role / tabIndex:一给就又变回「tab 里嵌了个控件」,也就是
               * 上面那两堵墙里的第二堵。键盘那一路在外层 tab 的 onKeyDown 上。
               * (jsx-a11y 的 click-events-have-key-events 不在这里报 —— 它认
               * aria-hidden:一个不在无障碍树里的节点,规则不要求它自带键盘路。) */
              <span
                className={s.close}
                aria-hidden="true"
                // 两处都要拦:click 不拦会顺手把这条 tab 选中(它现在在 tab 里面),
                // pointerdown 不拦会被宿主的拖拽处理器当成「按住这条 tab 要拖」。
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(tab.id)
                }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <X className={s.closeIcon} strokeWidth={2} aria-hidden="true" />
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
