import { Section } from './Section'
import { Segmented } from '../../ui/Segmented'
import { useStageStore } from '../../stage/store'
import { useT } from '../../i18n'
import type { Locale, MessageKey } from '../../i18n'
import s from './Settings.module.css'

/**
 * 设置 ·「通用」页。语言 + 工作目录占位。
 *
 * 从 `SettingsMock.tsx` 原样搬来的一节(2026-09-13 分页),**逻辑一行没改**。
 * 选项表只存 key,渲染时才翻译 —— 表是常量,文案是当下的语言,两件事分开。
 */
const LOCALE_OPTIONS: Array<{ value: Locale; labelKey: MessageKey }> = [
  { value: 'system', labelKey: 'settings.localeSystem' },
  { value: 'zh', labelKey: 'settings.localeZh' },
  { value: 'en', labelKey: 'settings.localeEn' },
]

export function GeneralPage() {
  const t = useT()
  const locale = useStageStore((st) => st.locale)
  const setLocale = useStageStore((st) => st.setLocale)

  return (
    <Section titleKey="settings.sectionGeneral">
      <div className={s.settingRow}>
        <div className={s.settingRowLabel}>{t('settings.language')}</div>
        <Segmented
          options={LOCALE_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
          value={locale}
          onChange={setLocale}
          label={t('settings.language')}
        />
      </div>

      <div className={s.settingRow}>
        <div className={s.settingRowLabel}>{t('settings.workdir')}</div>
        <div className={s.stub} />
      </div>
    </Section>
  )
}
