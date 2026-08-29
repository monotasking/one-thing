import type { ReactNode } from 'react'
import { useStageStore } from '../stage/store'
import { Segmented } from '../ui/Segmented'
import type { SegmentedOption } from '../ui/Segmented'
import { useT } from '../i18n'
import type { Locale, MessageKey } from '../i18n'
import type { DockAlign, DockDisplay, DockEdge, DockSize, ResolvedOpen } from '../stage/types'
import { KeymapSettings } from './KeymapSettings'
import s from './mocks.module.css'

/**
 * 选项表只存 key,渲染时才翻译 —— 表是常量,文案是当下的语言,两件事分开。
 * 唯一一个真接 store 的 mock:切换它,Dock 的形状 / 打开方式 / 界面语言当场生效。
 *
 * ── 版式:按**领域**分区(08-29 拍板)────────────────────────────────────────
 * 通用 / Dock / 打开方式 / 快捷键。一个控件属于哪个区,判据是「用户想改的是哪件事」,
 * 不是「它接的是哪个 store 字段」。所以 Dock 的显示方式 / 边 / 沿边位置 / 大小归一区,
 * 而「点图标落到哪」是另一件事,单独一区。
 * 分区不分页:左侧竖向锚点导航等设置真长到那个量级再说。
 * 这一页里**不许有游离在分区外的控件** —— 加一个控件就得先回答它属于哪个领域。
 * ──────────────────────────────────────────────────────────────────────────
 */
const DOCK_OPTIONS: Array<{ value: DockDisplay; labelKey: MessageKey }> = [
  { value: 'always', labelKey: 'settings.dockAlways' },
  { value: 'autohide', labelKey: 'settings.dockAutohide' },
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

const OPEN_OPTIONS: Array<{ value: ResolvedOpen; labelKey: MessageKey }> = [
  { value: 'stage', labelKey: 'dock.openStage' },
  { value: 'float', labelKey: 'dock.openFloat' },
  { value: 'pinned', labelKey: 'dock.openPinned' },
]

const LOCALE_OPTIONS: Array<{ value: Locale; labelKey: MessageKey }> = [
  { value: 'system', labelKey: 'settings.localeSystem' },
  { value: 'zh', labelKey: 'settings.localeZh' },
  { value: 'en', labelKey: 'settings.localeEn' },
]

/**
 * 一个领域一节:小节标题 + 若干行。标题走 <h3> 是为了让辅助技术读得出层级,
 * 视觉上它只是一行 11px 的小字 —— 层级由标签给,分量由 CSS 给,两件事不混。
 */
function Section({ titleKey, children }: { titleKey: MessageKey; children: ReactNode }) {
  const t = useT()
  return (
    <section className={s.section}>
      <h3 className={s.sectionTitle}>{t(titleKey)}</h3>
      {children}
    </section>
  )
}

export function SettingsMock() {
  const t = useT()
  const dockDisplay = useStageStore((st) => st.dockDisplay)
  const setDockDisplay = useStageStore((st) => st.setDockDisplay)
  const dockEdge = useStageStore((st) => st.dockEdge)
  const setDockEdge = useStageStore((st) => st.setDockEdge)
  const dockAlign = useStageStore((st) => st.dockAlign)
  const setDockAlign = useStageStore((st) => st.setDockAlign)
  const dockSize = useStageStore((st) => st.dockSize)
  const setDockSize = useStageStore((st) => st.setDockSize)
  const defaultOpen = useStageStore((st) => st.defaultOpen)
  const setDefaultOpen = useStageStore((st) => st.setDefaultOpen)
  const locale = useStageStore((st) => st.locale)
  const setLocale = useStageStore((st) => st.setLocale)

  const opts = <T extends string>(
    table: Array<{ value: T; labelKey: MessageKey }>,
  ): Array<SegmentedOption<T>> => table.map((o) => ({ value: o.value, label: t(o.labelKey) }))

  return (
    <div className={s.demo}>
      <div className={s.form}>
        <Section titleKey="settings.sectionGeneral">
          <div className={s.field}>
            <div className={s.fieldLabel}>{t('settings.language')}</div>
            <Segmented
              options={opts(LOCALE_OPTIONS)}
              value={locale}
              onChange={setLocale}
              label={t('settings.language')}
            />
          </div>

          <div className={s.field}>
            <div className={s.fieldLabel}>{t('settings.workdir')}</div>
            <div className={s.stub} />
          </div>
        </Section>

        <Section titleKey="settings.sectionDock">
          <div className={s.field}>
            <div>
              <div className={s.fieldLabel}>{t('settings.dockDisplay')}</div>
              <div className={s.fieldHint}>{t('settings.dockDisplayHint')}</div>
            </div>
            <Segmented
              options={opts(DOCK_OPTIONS)}
              value={dockDisplay}
              onChange={setDockDisplay}
              label={t('settings.dockDisplay')}
            />
          </div>

          <div className={s.field}>
            <div className={s.fieldLabel}>{t('dock.edge')}</div>
            <Segmented
              options={opts(EDGE_OPTIONS)}
              value={dockEdge}
              onChange={setDockEdge}
              label={t('dock.edge')}
            />
          </div>

          <div className={s.field}>
            <div className={s.fieldLabel}>{t('dock.align')}</div>
            <Segmented
              options={opts(ALIGN_OPTIONS)}
              value={dockAlign}
              onChange={setDockAlign}
              label={t('dock.align')}
            />
          </div>

          <div className={s.field}>
            <div className={s.fieldLabel}>{t('dock.size')}</div>
            <Segmented
              options={opts(SIZE_OPTIONS)}
              value={dockSize}
              onChange={setDockSize}
              label={t('dock.size')}
            />
          </div>
        </Section>

        <Section titleKey="dock.openWith">
          <div className={s.field}>
            <div>
              <div className={s.fieldLabel}>{t('settings.defaultOpen')}</div>
              <div className={s.fieldHint}>{t('settings.defaultOpenHint')}</div>
            </div>
            <Segmented
              options={opts(OPEN_OPTIONS)}
              value={defaultOpen}
              onChange={setDefaultOpen}
              label={t('settings.defaultOpen')}
            />
          </div>
          <div className={s.fieldNote}>{t('settings.defaultOpenNote')}</div>
        </Section>

        <Section titleKey="settings.sectionKeymap">
          <KeymapSettings />
        </Section>
      </div>
    </div>
  )
}
