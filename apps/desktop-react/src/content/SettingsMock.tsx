import { useStageStore } from '../stage/store'
import { Segmented } from '../ui/Segmented'
import type { SegmentedOption } from '../ui/Segmented'
import { useT } from '../i18n'
import type { Locale, MessageKey } from '../i18n'
import type { DockDisplay, ResolvedOpen } from '../stage/types'
import s from './mocks.module.css'

/**
 * 选项表只存 key,渲染时才翻译 —— 表是常量,文案是当下的语言,两件事分开。
 * 唯一一个真接 store 的 mock:切换它,Dock 保留带律 / 打开方式 / 界面语言当场生效。
 */
const DOCK_OPTIONS: Array<{ value: DockDisplay; labelKey: MessageKey }> = [
  { value: 'always', labelKey: 'settings.dockAlways' },
  { value: 'autohide', labelKey: 'settings.dockAutohide' },
]

const OPEN_OPTIONS: Array<{ value: ResolvedOpen; labelKey: MessageKey }> = [
  { value: 'stage', labelKey: 'dock.openStage' },
  { value: 'pinned', labelKey: 'dock.openPinned' },
]

const LOCALE_OPTIONS: Array<{ value: Locale; labelKey: MessageKey }> = [
  { value: 'system', labelKey: 'settings.localeSystem' },
  { value: 'zh', labelKey: 'settings.localeZh' },
  { value: 'en', labelKey: 'settings.localeEn' },
]

export function SettingsMock() {
  const t = useT()
  const dockDisplay = useStageStore((st) => st.dockDisplay)
  const setDockDisplay = useStageStore((st) => st.setDockDisplay)
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
        <div className={s.fieldNote}>{t('settings.overrideNote')}</div>

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
      </div>
    </div>
  )
}
