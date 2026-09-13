import { Section } from './Section'
import { Segmented } from '../../ui/Segmented'
import { Switch } from '../../ui/Switch'
import { useStageStore } from '../../stage/store'
import { useT } from '../../i18n'
import type { MessageKey } from '../../i18n'
import type {
  DockAlign,
  DockDisplay,
  DockEdge,
  DockMagnifyLevel,
  DockSize,
  ShelfRail,
} from '../../stage/types'
import s from './Settings.module.css'

/**
 * 设置 ·「Dock」页。从 `SettingsMock.tsx` 原样搬来的一节(2026-09-13 分页),
 * **逻辑一行没改**。
 *
 * 一个控件属于哪个领域,判据是「用户想改的是哪件事」,不是「它接的是哪个 store
 * 字段」。所以 Dock 的显示方式 / 边 / 沿边位置 / 大小归一区,而「点图标落到哪」
 * 是另一件事,在「打开方式」那一页。
 */
const DOCK_OPTIONS: Array<{ value: DockDisplay; labelKey: MessageKey }> = [
  { value: 'always', labelKey: 'settings.dockAlways' },
  { value: 'autohide', labelKey: 'settings.dockAutohide' },
]

/**
 * 收起后那条细梁把手画不画(2026-09-12 用户拍)。**第三处入口**,与细梁右键、
 * 架子 ⋯ 菜单写的是同一格 `shelfRail`;它长在 Dock 这一节里,因为这一节问的
 * 就是「外壳上那些常驻的把手长什么样」。
 */
const SHELF_RAIL_OPTIONS: Array<{ value: ShelfRail; labelKey: MessageKey }> = [
  { value: 'shown', labelKey: 'settings.shelfRailShown' },
  { value: 'hidden', labelKey: 'settings.shelfRailHidden' },
]

const EDGE_OPTIONS: Array<{ value: DockEdge; labelKey: MessageKey }> = [
  { value: 'bottom', labelKey: 'dock.edgeBottom' },
  { value: 'top', labelKey: 'dock.edgeTop' },
  { value: 'left', labelKey: 'dock.edgeLeft' },
  { value: 'right', labelKey: 'dock.edgeRight' },
]

const ALIGN_OPTIONS: Array<{ value: DockAlign; labelKey: MessageKey }> = [
  { value: 'start', labelKey: 'dock.alignStart' },
  { value: 'center', labelKey: 'dock.alignCenter' },
  { value: 'end', labelKey: 'dock.alignEnd' },
]

const SIZE_OPTIONS: Array<{ value: DockSize; labelKey: MessageKey }> = [
  { value: 'sm', labelKey: 'dock.sizeSm' },
  { value: 'md', labelKey: 'dock.sizeMd' },
  { value: 'lg', labelKey: 'dock.sizeLg' },
]

/*
 * 放大幅度三档(09-02 追补)。macOS 那里是一根连续滑杆,这里按「设置极简」收敛成
 * 三格 —— 三个真实的数住在 tokens.css 的 --dock-lens-max-*,这张表只认档名。
 */
const MAGNIFY_OPTIONS: Array<{ value: DockMagnifyLevel; labelKey: MessageKey }> = [
  { value: 'sm', labelKey: 'dock.magnifySm' },
  { value: 'md', labelKey: 'dock.magnifyMd' },
  { value: 'lg', labelKey: 'dock.magnifyLg' },
]

export function DockPage() {
  const t = useT()
  const dockDisplay = useStageStore((st) => st.dockDisplay)
  const setDockDisplay = useStageStore((st) => st.setDockDisplay)
  const shelfRail = useStageStore((st) => st.shelfRail)
  const setShelfRail = useStageStore((st) => st.setShelfRail)
  const dockEdge = useStageStore((st) => st.dockEdge)
  const setDockEdge = useStageStore((st) => st.setDockEdge)
  const dockAlign = useStageStore((st) => st.dockAlign)
  const setDockAlign = useStageStore((st) => st.setDockAlign)
  const dockSize = useStageStore((st) => st.dockSize)
  const setDockSize = useStageStore((st) => st.setDockSize)
  const dockMagnify = useStageStore((st) => st.dockMagnify)
  const setDockMagnify = useStageStore((st) => st.setDockMagnify)
  const dockMagnifyLevel = useStageStore((st) => st.dockMagnifyLevel)
  const setDockMagnifyLevel = useStageStore((st) => st.setDockMagnifyLevel)
  const dockRunningDot = useStageStore((st) => st.dockRunningDot)
  const setDockRunningDot = useStageStore((st) => st.setDockRunningDot)

  const opts = <T extends string>(table: Array<{ value: T; labelKey: MessageKey }>) =>
    table.map((o) => ({ value: o.value, label: t(o.labelKey) }))

  return (
    <Section titleKey="settings.sectionDock">
      <div className={s.settingRow}>
        <div>
          <div className={s.settingRowLabel}>{t('settings.dockDisplay')}</div>
          <div className={s.settingRowHint}>{t('settings.dockDisplayHint')}</div>
        </div>
        <Segmented
          options={opts(DOCK_OPTIONS)}
          value={dockDisplay}
          onChange={setDockDisplay}
          label={t('settings.dockDisplay')}
        />
      </div>

      <div className={s.settingRow}>
        <div>
          <div className={s.settingRowLabel}>{t('settings.shelfRail')}</div>
          <div className={s.settingRowHint}>{t('settings.shelfRailHint')}</div>
        </div>
        <Segmented
          options={opts(SHELF_RAIL_OPTIONS)}
          value={shelfRail}
          onChange={setShelfRail}
          label={t('settings.shelfRail')}
        />
      </div>

      <div className={s.settingRow}>
        <div className={s.settingRowLabel}>{t('dock.edge')}</div>
        <Segmented
          options={opts(EDGE_OPTIONS)}
          value={dockEdge}
          onChange={setDockEdge}
          label={t('dock.edge')}
        />
      </div>

      <div className={s.settingRow}>
        <div className={s.settingRowLabel}>{t('dock.align')}</div>
        <Segmented
          options={opts(ALIGN_OPTIONS)}
          value={dockAlign}
          onChange={setDockAlign}
          label={t('dock.align')}
        />
      </div>

      <div className={s.settingRow}>
        <div className={s.settingRowLabel}>{t('dock.size')}</div>
        <Segmented
          options={opts(SIZE_OPTIONS)}
          value={dockSize}
          onChange={setDockSize}
          label={t('dock.size')}
        />
      </div>

      {/*
        磁性放大那两行(09-02 追补,对齐 macOS 「Dock 与菜单栏」里那枚放大开关 +
        那根幅度滑杆)。**开关与幅度是两件事**:关掉是「这条链不跑」,幅度只是
        条上一个 CSS 变量。所以幅度那一行在关掉时**禁掉而不是藏掉** —— 藏掉会让
        人以为这个选项没了,禁掉才说得清「它还在,只是现在管不着」。
      */}
      <div className={s.settingRow}>
        <div>
          <div className={s.settingRowLabel}>{t('dock.magnify')}</div>
          <div className={s.settingRowHint}>{t('dock.magnifyHint')}</div>
        </div>
        <Switch checked={dockMagnify} onChange={setDockMagnify} label={t('dock.magnify')} />
      </div>

      <div className={s.settingRow}>
        <div className={s.settingRowLabel}>{t('dock.magnifyLevel')}</div>
        <Segmented
          options={opts(MAGNIFY_OPTIONS)}
          value={dockMagnifyLevel}
          onChange={setDockMagnifyLevel}
          label={t('dock.magnifyLevel')}
          disabled={!dockMagnify}
        />
      </div>

      <div className={s.settingRow}>
        <div>
          <div className={s.settingRowLabel}>{t('dock.runningDot')}</div>
          <div className={s.settingRowHint}>{t('dock.runningDotHint')}</div>
        </div>
        <Switch
          checked={dockRunningDot}
          onChange={setDockRunningDot}
          label={t('dock.runningDot')}
        />
      </div>
    </Section>
  )
}
