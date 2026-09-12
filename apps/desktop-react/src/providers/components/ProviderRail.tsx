import { useState } from 'react'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Input'
import { ButtonBase } from '../../ui/ButtonBase'
import { GroupHead } from '../../ui/GroupHead'
import { IconButton } from '../../ui/IconButton'
import { StatusDot } from '../../ui/StatusDot'
import { Tooltip } from '../../ui/Tooltip'
import { ChevronsLeft, Plus, Search } from '../../components/icons'
import { useT } from '../../i18n'
import type { MessageKey, TFn } from '../../i18n'
import type { Fact, RailGroup, RailRow } from '../types'
import s from './ProviderRail.module.css'

/**
 * 左栏 = 家名册。268px 定宽,三组(云服务 / 本地 / 自定义),
 * 一行三件:22px 方图标 / 名 + 副行 / 行尾 6px 状态点。
 *
 * 它**不认识 store** —— 行是算好的 `RailRow[]`,选中与检索由上面递进来。
 * 这样这块组件只做一件事(把事实画出来),而事实那一半在 projection 里可断言。
 *
 * ── 两种形:268 的名册 / 44 的图标条(09-11 报障「模型配置页面没有响应式布局」)──
 * 「此刻是哪一种」**这块组件不知道,也不该知道** —— 判据是面板的容器宽,写在
 * ProviderRail.module.css 末尾那段 `@container providers-panel` 里。它既没有
 * ResizeObserver 也没有窗口监听:这一批一行新的 JS 生命周期都没有加。
 *
 * 它唯一持有的一格状态是 `railExpanded` ——「用户在窄面板里临时把名册撑开了」。
 * 这一格**不上报**:面板不需要知道,它只影响左栏自己那点宽。收回的两条路
 * (再点一次那颗钮 / 选中一家)都在这个文件里,所以「展开了就一定收得回」
 * 是看得见的,不靠调用方记得。
 * 宽档里那颗钮 `display: none`,于是这一格在宽档里既点不出来也不生效 ——
 * CSS 那段规则只在窄容器里认它。
 */

const GROUP_LABELS: Record<RailGroup, MessageKey> = {
  cloud: 'providers.groupCloud',
  local: 'providers.groupLocal',
  custom: 'providers.groupCustom',
}

const GROUP_ORDER: RailGroup[] = ['cloud', 'local', 'custom']

/*
 * 状态点的那张 tone 表已经不在这里了(09-01 批 2b 收编):`RailRow.tone` 的五档
 * (ok / bad / warn / idle / off)与 `ui/StatusDot` 的 tone 逐字同名同义,
 * 所以这一面**没有映射表**——直接把事实递过去。一张只做恒等变换的表就是
 * 一处会漂的产地。
 */

/** 一串事实 → 一行字。分隔符是排版记号,不是文案,所以它不进字典。 */
export function renderFacts(t: TFn, facts: readonly Fact[]): string {
  return facts.map((fact) => t(fact.key, fact.vars)).join(' · ')
}

export function ProviderRail({
  rows,
  connectedCount,
  selectedId,
  query,
  onQuery,
  onSelect,
  onAddCustom,
  onRowMenu,
}: {
  rows: readonly RailRow[]
  /** 「N 家已接入」的 N —— 已接入 ≠ 名册长度,判据在 projection 里。 */
  connectedCount: number
  selectedId: string | null
  query: string
  onQuery: (value: string) => void
  onSelect: (familyId: string) => void
  onAddCustom: () => void
  /**
   * 右键这一行 —— 行级动作的**唯一入口**(09-01「动作单产地」)。
   * 这块组件**照旧不认识 store**:它只把「谁、在哪儿」交上去,菜单由面板来开。
   */
  onRowMenu: (familyId: string, x: number, y: number) => void
}) {
  const t = useT()
  const [railExpanded, setRailExpanded] = useState(false)

  return (
    // data-testid 是给真机门的**稳定选择器**(CSS Modules 的类名构建后是哈希)。
    // 挂在名册容器上:删一家之后要问的是「这棵树有没有被整个掀了」——
    // 行会少一条,而容器必须是同一个节点(四律第 4 条)。
    <nav
      className={s.rail}
      aria-label={t('providers.railTitle')}
      data-testid="provider-rail"
      data-expanded={railExpanded ? 'true' : undefined}
    >
      <div className={s.head}>
        <div className={s.headLine}>
          <h2 className={s.title}>{t('providers.railTitle')}</h2>
          <span className={s.count}>{t('providers.railCount', { count: connectedCount })}</span>
        </div>
        <div className={s.searchRow}>
          <div className={s.searchBox}>
            <Input
              size="sm"
              value={query}
              onValueChange={onQuery}
              placeholder={t('providers.searchPlaceholder')}
              aria-label={t('providers.searchPlaceholder')}
            />
          </div>
          {/*
            图标条里的搜索口。点下去把名册撑回 268(**不开浮层** —— 一块盖在右面上的
            临时名册要自带定位、点外关、焦点归还三件事,而这里要的只是「宽一点」)。
            焦点不由这里搬:`.focus()` 只许出现在 src/focus/(响应链 I3),
            所以撑开之后用户自己 Tab 进输入框 —— 少一步顺手,换的是焦点只有一个产地。
          */}
          <IconButton
            className={s.railToggle}
            icon={railExpanded ? ChevronsLeft : Search}
            label={railExpanded ? t('providers.railCollapse') : t('providers.railExpand')}
            aria-expanded={railExpanded}
            onClick={() => setRailExpanded((open) => !open)}
            testId="provider-rail-toggle"
          />
        </div>
      </div>

      <div className={s.body}>
        {rows.length === 0 && <p className={s.none}>{t('providers.railEmpty')}</p>}
        {GROUP_ORDER.map((group) => {
          const inGroup = rows.filter((row) => row.group === group)
          if (inGroup.length === 0) return null
          return (
            <div key={group} className={s.group}>
              {/* 组名包一层 `.groupLabel`:全大写与 --text-2 是这块面的落点事实,
                  由内容自己带,不去覆盖 GroupHead 的规则(理由见 module.css)。
                  `.groupHead` 只是**给收起档一个把手**(那时组与组之间改画一条发丝线),
                  与 `.out / .colOut` 那对同款:一个零外观的类名,不是第二套皮肤。 */}
              <GroupHead
                className={s.groupHead}
                label={<span className={s.groupLabel}>{t(GROUP_LABELS[group])}</span>}
              />
              <ul className={s.list}>
                {inGroup.map((row) => {
                  const facts = renderFacts(t, row.facts)
                  // 名 + 副行那串事实合成一句。收起档里屏幕上只剩一枚图标,
                  // 这一句同时是**读屏念的名字**与**悬停出的提示**——说给眼睛的
                  // 和说给读屏的是同一句(IconButton 的 label 同一条规矩)。
                  const spoken = facts ? `${row.label} · ${facts}` : row.label
                  return (
                    <li key={row.familyId}>
                      <ButtonBase
                        className={`${s.row} ${row.familyId === selectedId ? s.rowSelected : ''}`}
                        // 「这一行是当下选中的那一行」对读屏软件也要说得出来 ——
                        // 光靠底色是只给看得见的人的信息。
                        aria-current={row.familyId === selectedId ? 'true' : undefined}
                        // 收起档里 `.text` 不在场(display:none = 不进无障碍树),
                        // 没有这一句这颗钮就会被念成「按钮」。宽档里它与屏幕上那两行
                        // 逐字相同,所以「可见标签含于可达名」(WCAG 2.5.3)照旧成立。
                        aria-label={spoken}
                        onClick={() => {
                          onSelect(row.familyId)
                          // 选中一家 = 名册的活干完了,撑开的条子自己收回去。
                          setRailExpanded(false)
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          // 右键顺手把这一行选中:菜单说的是「这一行」,而右面得跟着它,
                          // 否则「编辑」开出来的是另一家(文件树行菜单同一手)。
                          onSelect(row.familyId)
                          onRowMenu(row.familyId, e.clientX, e.clientY)
                        }}
                        data-testid={`provider-row-${row.familyId}`}
                      >
                        {/* 提示挂在**图标**上而不是整行上:宽档里名字就写在旁边,
                            那时图标 `pointer-events: none`,这只 Tooltip 永远触发不了;
                            收起档里 CSS 把它打开并用一层透明伪元素摊满全行(见 module.css)。
                            这样「宽档不出提示」是排版决定的,不需要 JS 知道容器多宽。 */}
                        <Tooltip content={spoken}>
                          <span
                            className={`${s.icon} ${row.custom ? s.iconCustom : ''}`}
                            aria-hidden="true"
                          >
                            {row.initial}
                          </span>
                        </Tooltip>
                        <span className={s.text}>
                          <span className={s.name}>{row.label}</span>
                          <span className={`${s.detail} ${row.tone === 'bad' ? s.detailBad : ''}`}>
                            {facts}
                          </span>
                        </span>
                        {/* 不给 label:同一行里名字与副行已经把状态说成了字
                            (「已接入 · 3 把钥匙」),再给点一个名就是念两遍。 */}
                        <StatusDot tone={row.tone} />
                      </ButtonBase>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </div>

      {/* 脚:两种形同一件事。宽档画带字的钮,收起档画一颗图标钮 ——
          两颗读**同一句** `providers.addCustom`(图标钮的 label 同时是它的提示与
          可达名),所以没有第二处文案产地,字典也不必为这一格多开一行。
          两颗**永不同屏**:另一颗在它那一档里是 `display: none`,而
          display:none 的元素不进无障碍树 —— 真机上任何一刻只有一个「＋ 自定义服务商」。
          jsdom 里两颗都在(那边没有 CSS),所以单测按 testid 取件,不按名字取。 */}
      <div className={s.foot}>
        <Button
          className={s.addCustomText}
          size="sm"
          onClick={onAddCustom}
          data-testid="provider-add-custom"
        >
          {t('providers.addCustom')}
        </Button>
        <IconButton
          className={s.addCustomIcon}
          icon={Plus}
          label={t('providers.addCustom')}
          onClick={onAddCustom}
          testId="provider-add-custom-icon"
        />
      </div>
    </nav>
  )
}
