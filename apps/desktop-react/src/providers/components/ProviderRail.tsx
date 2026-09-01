import { Button } from '../../ui/Button'
import { Input } from '../../ui/Input'
import { ButtonBase } from '../../ui/ButtonBase'
import { GroupHead } from '../../ui/GroupHead'
import { StatusDot } from '../../ui/StatusDot'
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

  return (
    // data-testid 是给真机门的**稳定选择器**(CSS Modules 的类名构建后是哈希)。
    // 挂在名册容器上:删一家之后要问的是「这棵树有没有被整个掀了」——
    // 行会少一条,而容器必须是同一个节点(四律第 4 条)。
    <nav className={s.rail} aria-label={t('providers.railTitle')} data-testid="provider-rail">
      <div className={s.head}>
        <div className={s.headLine}>
          <h2 className={s.title}>{t('providers.railTitle')}</h2>
          <span className={s.count}>{t('providers.railCount', { count: connectedCount })}</span>
        </div>
        <Input
          size="sm"
          value={query}
          onValueChange={onQuery}
          placeholder={t('providers.searchPlaceholder')}
          aria-label={t('providers.searchPlaceholder')}
        />
      </div>

      <div className={s.body}>
        {rows.length === 0 && <p className={s.none}>{t('providers.railEmpty')}</p>}
        {GROUP_ORDER.map((group) => {
          const inGroup = rows.filter((row) => row.group === group)
          if (inGroup.length === 0) return null
          return (
            <div key={group} className={s.group}>
              {/* 组名包一层 `.groupLabel`:全大写与 --text-2 是这块面的落点事实,
                  由内容自己带,不去覆盖 GroupHead 的规则(理由见 module.css)。 */}
              <GroupHead label={<span className={s.groupLabel}>{t(GROUP_LABELS[group])}</span>} />
              <ul className={s.list}>
                {inGroup.map((row) => (
                  <li key={row.familyId}>
                    <ButtonBase
                      className={`${s.row} ${row.familyId === selectedId ? s.rowSelected : ''}`}
                      // 「这一行是当下选中的那一行」对读屏软件也要说得出来 ——
                      // 光靠底色是只给看得见的人的信息。
                      aria-current={row.familyId === selectedId ? 'true' : undefined}
                      onClick={() => onSelect(row.familyId)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        // 右键顺手把这一行选中:菜单说的是「这一行」,而右面得跟着它,
                        // 否则「编辑」开出来的是另一家(文件树行菜单同一手)。
                        onSelect(row.familyId)
                        onRowMenu(row.familyId, e.clientX, e.clientY)
                      }}
                      data-testid={`provider-row-${row.familyId}`}
                    >
                      <span className={`${s.icon} ${row.custom ? s.iconCustom : ''}`} aria-hidden="true">
                        {row.initial}
                      </span>
                      <span className={s.text}>
                        <span className={s.name}>{row.label}</span>
                        <span className={`${s.detail} ${row.tone === 'bad' ? s.detailBad : ''}`}>
                          {renderFacts(t, row.facts)}
                        </span>
                      </span>
                      {/* 不给 label:同一行里名字与副行已经把状态说成了字
                          (「已接入 · 3 把钥匙」),再给点一个名就是念两遍。 */}
                      <StatusDot tone={row.tone} />
                    </ButtonBase>
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
      </div>

      <div className={s.foot}>
        <Button size="sm" onClick={onAddCustom}>
          {t('providers.addCustom')}
        </Button>
      </div>
    </nav>
  )
}
