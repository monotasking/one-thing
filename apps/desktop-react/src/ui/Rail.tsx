import { useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { Button } from './Button'
import { Input } from './Input'
import { ButtonBase } from './ButtonBase'
import { GroupHead } from './GroupHead'
import { IconButton } from './IconButton'
import { Tooltip } from './Tooltip'
import { ChevronsLeft, Plus, Search } from '../components/icons'
import s from './Rail.module.css'

/**
 * **名册左栏**:一块「左边一列条目、右边是选中那一条的详情」的面,左边那一列。
 *
 * ── 为什么它在 `src/ui` ────────────────────────────────────────────────────
 * 09-26(ACP A1-b)之前它叫 `ProviderRail`,只画模型服务的「家」。设置页新长出的
 * 「Agent」一页要的是同一条栏 —— 一样的头(标题 + 读数 + 搜索)、一样的分组、
 * 一样的行(方图标 / 名 + 副行 / 行尾状态)、一样的脚(新建钮)、一样的窄档收成
 * 44px 图标条。复制一份就是两个会漂的产地(基础件先行,09-01 立法),所以把
 * **形**抽到这里,`ProviderRail` 退成一层把「家」翻译成条目的适配。
 *
 * 它**不认识任何领域** —— 条目是算好的 `RailItem[]`(名、副行、提示句、图标、
 * 行尾状态都由调用方给),选中与检索由上面递进来。于是这块组件只做一件事:
 * 把事实排出来;事实那一半在各自的投影里可断言。
 *
 * ── 两种形:268 的名册 / 44 的图标条 ──────────────────────────────────────
 * 「此刻是哪一种」**这块组件不知道,也不该知道** —— 判据是摆它的那块面板的
 * 容器宽,写在 `Rail.module.css` 末尾那段 `@container rail-host` 里。摆它的面板
 * 在自己的根上声明 `container-name: rail-host`,这里既没有 ResizeObserver
 * 也没有窗口监听。
 *
 * 它唯一持有的一格状态是 `railExpanded` ——「用户在窄面板里临时把名册撑开了」。
 * 这一格**不上报**:面板不需要知道,它只影响左栏自己那点宽。收回的两条路
 * (再点一次那颗钮 / 选中一条)都在这个文件里,所以「展开了就一定收得回」
 * 是看得见的,不靠调用方记得。宽档里那颗钮 `display: none`,于是这一格在宽档里
 * 既点不出来也不生效 —— CSS 那段规则只在窄容器里认它。
 */

export interface RailItem {
  id: string
  /** 名。 */
  label: string
  /** 副行(已经串好的一句)。空串 = 没有可说的。 */
  detail: string
  /** 副行要不要跟着变红(出错那句话本身要被看见;其余状态色只上点)。 */
  detailBad?: boolean
  /**
   * 收起档里屏幕上只剩一枚图标,这一句同时是**读屏念的名字**与**悬停出的提示**。
   * 宽档里它与屏幕上那两行逐字相同(「可见标签含于可达名」,WCAG 2.5.3)。
   */
  spoken: string
  /**
   * 方图标。`className` 是**名册自己**的落点把手(收起档的 pointer-events / ::after),
   * 必须原样交到那枚图标的根上;图标件还要转发剩下的 props —— Tooltip 用
   * cloneElement 往它身上接 ref 与四个指针手,不转发就等于把提示悄悄掐掉。
   */
  glyph: (className: string) => ReactElement<Record<string, unknown>>
  /** 行尾状态(一颗或几颗 `ui/StatusDot`)。收起档里它竖着排在图标下面。 */
  status: ReactNode
}

export interface RailSection {
  id: string
  /** 组名。组里一条都没有时整组不画(空组头等于让人点了个寂寞)。 */
  label: string
  items: readonly RailItem[]
}

export interface RailProps {
  /** 标题,同时是这条 `<nav>` 的无障碍名。 */
  title: string
  /** 标题右边那一格文字读数(「3 家已接入」)。文字读数可以,计数徽不行。 */
  aside?: ReactNode
  sections: readonly RailSection[]
  /** 一条都没有(含检索后)时说的那句话。 */
  emptyText: string
  selectedId: string | null
  onSelect: (id: string) => void
  /** 右键一行 —— 行级动作的唯一入口(09-01「动作单产地」)。不给 = 这张名册没有行菜单。 */
  onItemMenu?: (id: string, x: number, y: number) => void
  search: {
    value: string
    onChange: (value: string) => void
    placeholder: string
    /** 窄档里那颗撑开 / 收回钮的两句名字。 */
    expandLabel: string
    collapseLabel: string
  }
  /** 脚上那颗新建钮(宽档画字、收起档画图标,两颗读同一句)。 */
  add: { label: string; onClick: () => void }
  /**
   * 给真机门的**稳定选择器**(CSS Modules 的类名构建后是哈希)。行上挂
   * `${testIdPrefix}-row-<id>`,容器挂 `${testIdPrefix}-rail`,另外三颗钮各一格。
   */
  testIdPrefix: string
}

export function Rail({
  title,
  aside,
  sections,
  emptyText,
  selectedId,
  onSelect,
  onItemMenu,
  search,
  add,
  testIdPrefix,
}: RailProps) {
  const [railExpanded, setRailExpanded] = useState(false)
  const empty = sections.every((section) => section.items.length === 0)

  return (
    // 容器挂 testid:删一条之后要问的是「这棵树有没有被整个掀了」——
    // 行会少一条,而容器必须是同一个节点(四律第 4 条)。
    <nav
      className={s.rail}
      aria-label={title}
      data-testid={`${testIdPrefix}-rail`}
      data-expanded={railExpanded ? 'true' : undefined}
    >
      <div className={s.head}>
        <div className={s.headLine}>
          <h2 className={s.title}>{title}</h2>
          {aside !== undefined && <span className={s.count}>{aside}</span>}
        </div>
        <div className={s.searchRow}>
          <div className={s.searchBox}>
            <Input
              size="sm"
              value={search.value}
              onValueChange={search.onChange}
              placeholder={search.placeholder}
              aria-label={search.placeholder}
            />
          </div>
          {/*
            图标条里的搜索口。点下去把名册撑回 268(**不开浮层** —— 一块盖在右面上的
            临时名册要自带定位、点外关、焦点归还三件事,而这里要的只是「宽一点」)。
            焦点不由这里搬:`.focus()` 只许出现在 src/focus/(响应链 I3)。
          */}
          <IconButton
            className={s.railToggle}
            icon={railExpanded ? ChevronsLeft : Search}
            label={railExpanded ? search.collapseLabel : search.expandLabel}
            aria-expanded={railExpanded}
            onClick={() => setRailExpanded((open) => !open)}
            testId={`${testIdPrefix}-rail-toggle`}
          />
        </div>
      </div>

      <div className={s.body}>
        {empty && <p className={s.none}>{emptyText}</p>}
        {sections.map((section) => {
          if (section.items.length === 0) return null
          return (
            <div key={section.id} className={s.group}>
              {/* 组名包一层 `.groupLabel`:全大写与 --text-2 是这块面的落点事实,
                  由内容自己带,不去覆盖 GroupHead 的规则(理由见 module.css)。 */}
              <GroupHead className={s.groupHead} label={<span className={s.groupLabel}>{section.label}</span>} />
              <ul className={s.list}>
                {section.items.map((item) => (
                  <li key={item.id}>
                    <ButtonBase
                      className={`${s.row} ${item.id === selectedId ? s.rowSelected : ''}`}
                      // 「这一行是当下选中的那一行」对读屏软件也要说得出来。
                      aria-current={item.id === selectedId ? 'true' : undefined}
                      // 收起档里 `.text` 不在场(display:none = 不进无障碍树),
                      // 没有这一句这颗钮就会被念成「按钮」。
                      aria-label={item.spoken}
                      onClick={() => {
                        onSelect(item.id)
                        // 选中一条 = 名册的活干完了,撑开的条子自己收回去。
                        setRailExpanded(false)
                      }}
                      onContextMenu={
                        onItemMenu === undefined
                          ? undefined
                          : (e) => {
                              e.preventDefault()
                              // 右键顺手把这一行选中:菜单说的是「这一行」,右面得跟着它。
                              onSelect(item.id)
                              onItemMenu(item.id, e.clientX, e.clientY)
                            }
                      }
                      data-testid={`${testIdPrefix}-row-${item.id}`}
                    >
                      {/* 提示挂在**图标**上而不是整行上:宽档里名字就写在旁边,
                          那时图标 `pointer-events: none`,这只 Tooltip 永远触发不了;
                          收起档里 CSS 把它打开并用一层透明伪元素摊满全行。 */}
                      <Tooltip content={item.spoken}>{item.glyph(s.icon)}</Tooltip>
                      <span className={s.text}>
                        <span className={s.name}>{item.label}</span>
                        <span className={`${s.detail} ${item.detailBad ? s.detailBad : ''}`}>{item.detail}</span>
                      </span>
                      {item.status}
                    </ButtonBase>
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
      </div>

      {/* 脚:两种形同一件事。宽档画带字的钮,收起档画一颗图标钮 —— 两颗读**同一句**,
          **永不同屏**(另一颗在它那一档里 display:none,不进无障碍树)。
          jsdom 里两颗都在(那边没有 CSS),所以单测按 testid 取件,不按名字取。 */}
      <div className={s.foot}>
        <Button className={s.addCustomText} size="sm" onClick={add.onClick} data-testid={`${testIdPrefix}-add-custom`}>
          {add.label}
        </Button>
        <IconButton
          className={s.addCustomIcon}
          icon={Plus}
          label={add.label}
          onClick={add.onClick}
          testId={`${testIdPrefix}-add-custom-icon`}
        />
      </div>
    </nav>
  )
}
