import { useMemo } from 'react'
import { Rail } from '../../ui/Rail'
import type { RailSection } from '../../ui/Rail'
import { StatusDot } from '../../ui/StatusDot'
import { useT } from '../../i18n'
import type { MessageKey, TFn } from '../../i18n'
import type { Fact, RailGroup, RailRow } from '../types'
import { ProviderGlyph } from './ProviderGlyph'

/**
 * 左栏 = 家名册。268px 定宽,三组(云服务 / 本地 / 自定义),
 * 一行三件:22px 方图标 / 名 + 副行 / 行尾 6px 状态点。
 *
 * **形住在 `ui/Rail`**(09-26,ACP A1-b 抽出去的:设置页「Agent」一页要同一条栏)。
 * 这只文件退成一层适配:把「家」(`RailRow`)翻译成名册条目(`RailItem`),
 * 组名 / 读数 / 检索 / 新建那几句文案从这里递进去。下面几段判词说的是
 * 这条栏的行为,今天由 `ui/Rail` 执行,原样留着是因为「为什么模型服务的左栏
 * 长这样」这个问题仍然该在这里答得出。
 *
 * 它**不认识 store** —— 行是算好的 `RailRow[]`,选中与检索由上面递进来。
 * 这样这块组件只做一件事(把事实画出来),而事实那一半在 projection 里可断言。
 *
 * ── 两种形:268 的名册 / 44 的图标条(09-11 报障「模型配置页面没有响应式布局」)──
 * 「此刻是哪一种」**这块组件不知道,也不该知道** —— 判据是面板的容器宽,写在
 * `ui/Rail.module.css` 末尾那段 `@container rail-host` 里。它既没有
 * ResizeObserver 也没有窗口监听:这一批一行新的 JS 生命周期都没有加。
 *
 * 它唯一持有的一格状态是 `railExpanded` ——「用户在窄面板里临时把名册撑开了」。
 * 这一格**不上报**:面板不需要知道,它只影响左栏自己那点宽。收回的两条路
 * (再点一次那颗钮 / 选中一家)都在这个文件里,所以「展开了就一定收得回」
 * 是看得见的,不靠调用方记得(那一格今天住在 `ui/Rail` 里)。
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
  const sections = useMemo<RailSection[]>(
    () =>
      GROUP_ORDER.map((group) => ({
        id: group,
        label: t(GROUP_LABELS[group]),
        items: rows
          .filter((row) => row.group === group)
          .map((row) => {
            const facts = renderFacts(t, row.facts)
            return {
              id: row.familyId,
              label: row.label,
              detail: facts,
              detailBad: row.tone === 'bad',
              // 名 + 副行那串事实合成一句:收起档里它是读屏念的名字,也是悬停出的提示。
              spoken: facts ? `${row.label} · ${facts}` : row.label,
              // 方框的形与「画图标还是画首字母」都由 ProviderGlyph 说了算;
              // `className` 是名册自己的落点把手(收起档的 pointer-events / ::after)。
              glyph: (className: string) => (
                <ProviderGlyph className={className} familyId={row.familyId} label={row.label} custom={row.custom} />
              ),
              // 不给 label:同一行里名字与副行已经把状态说成了字,再给点一个名就是念两遍。
              status: <StatusDot tone={row.tone} />,
            }
          }),
      })),
    [rows, t],
  )

  return (
    <Rail
      title={t('providers.railTitle')}
      aside={t('providers.railCount', { count: connectedCount })}
      sections={sections}
      emptyText={t('providers.railEmpty')}
      selectedId={selectedId}
      onSelect={onSelect}
      onItemMenu={onRowMenu}
      search={{
        value: query,
        onChange: onQuery,
        placeholder: t('providers.searchPlaceholder'),
        expandLabel: t('providers.railExpand'),
        collapseLabel: t('providers.railCollapse'),
      }}
      add={{ label: t('providers.addCustom'), onClick: onAddCustom }}
      testIdPrefix="provider"
    />
  )
}
