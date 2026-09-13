import { Section } from './Section'
import { ThemeSettings } from './ThemeSettings'
import { Segmented } from '../../ui/Segmented'
import { useReadingStore, effectiveMotionTier } from '../../reading/store'
import { useSystemReducedMotion } from '../../reading/useSystemReducedMotion'
import { useT } from '../../i18n'
import type { MessageKey } from '../../i18n'
import type { MotionTier, ReadingColumn, ReadingDensity, ReadingFontSize } from '../../reading/types'
import s from './Settings.module.css'

/**
 * 设置 ·「外观」页。两节:**主题**(2026-09-13 新)+ **阅读**(08-31 的四根轴,
 * 从 `SettingsMock.tsx` 原样搬来,逻辑一行没改)。
 *
 * 阅读那一节的节名从「外观 · 阅读」改成「阅读」:它已经住在外观页里,
 * 「外观 · 外观 · 阅读」是重复。改的只有字典里那一格值,键没动。
 *
 * ── 阅读四根**正交**的轴 ─────────────────────────────────────────────────
 * 档值即写进 DOM 的属性值(`src/reading/types.ts` 是那张表的另一半),这里只配
 * 文案。四枚分段器都是**即点即生效**:没有「保存」按钮,因为没有一次改动是需要
 * 确认的 —— 改错了再点回来就是,而版式的对错只有看着才知道。
 * 它们**只管聊天正文列**,不动外壳与面板(那是「界面」不是「读物」,判据写在
 * `styles/tokens.css` 的阅读轴一节)。
 */
const READING_FS_OPTIONS: Array<{ value: ReadingFontSize; labelKey: MessageKey }> = [
  { value: '13', labelKey: 'settings.readingFsSm' },
  { value: '14', labelKey: 'settings.readingFsMd' },
  { value: '15', labelKey: 'settings.readingFsLg' },
  { value: '16', labelKey: 'settings.readingFsXl' },
]

const READING_DENSITY_OPTIONS: Array<{ value: ReadingDensity; labelKey: MessageKey }> = [
  { value: 'compact', labelKey: 'settings.readingDensityCompact' },
  { value: 'comfortable', labelKey: 'settings.readingDensityComfortable' },
  { value: 'relaxed', labelKey: 'settings.readingDensityRelaxed' },
]

const READING_COL_OPTIONS: Array<{ value: ReadingColumn; labelKey: MessageKey }> = [
  { value: 'standard', labelKey: 'settings.readingColStandard' },
  { value: 'wide', labelKey: 'settings.readingColWide' },
  { value: 'full', labelKey: 'settings.readingColFull' },
]

const MOTION_OPTIONS: Array<{ value: MotionTier; labelKey: MessageKey }> = [
  { value: 'standard', labelKey: 'settings.motionStandard' },
  { value: 'calm', labelKey: 'settings.motionCalm' },
  { value: 'none', labelKey: 'settings.motionNone' },
]

export function AppearancePage() {
  const t = useT()
  const readingFs = useReadingStore((st) => st.fontSize)
  const setReadingFs = useReadingStore((st) => st.setFontSize)
  const readingDensity = useReadingStore((st) => st.density)
  const setReadingDensity = useReadingStore((st) => st.setDensity)
  const readingCol = useReadingStore((st) => st.column)
  const setReadingCol = useReadingStore((st) => st.setColumn)
  const setMotion = useReadingStore((st) => st.setMotion)
  // 动效那一枚高亮的是**生效档**,不是存着的那个:系统开着「减弱动态效果」而用户
  // 还没表过态时,面上就该显示「无」—— 显示「标准」而屏幕上不动是在骗人。
  const systemReduced = useSystemReducedMotion()
  const motion = useReadingStore((st) => effectiveMotionTier(st, systemReduced))

  const opts = <T extends string>(table: Array<{ value: T; labelKey: MessageKey }>) =>
    table.map((o) => ({ value: o.value, label: t(o.labelKey) }))

  return (
    <>
      <Section titleKey="settings.sectionTheme">
        <ThemeSettings />
      </Section>

      <Section titleKey="settings.sectionReading">
        <div className={s.settingRow}>
          <div className={s.settingRowLabel}>{t('settings.readingFs')}</div>
          <Segmented
            options={opts(READING_FS_OPTIONS)}
            value={readingFs}
            onChange={setReadingFs}
            label={t('settings.readingFs')}
          />
        </div>

        <div className={s.settingRow}>
          <div>
            <div className={s.settingRowLabel}>{t('settings.readingDensity')}</div>
            <div className={s.settingRowHint}>{t('settings.readingDensityHint')}</div>
          </div>
          <Segmented
            options={opts(READING_DENSITY_OPTIONS)}
            value={readingDensity}
            onChange={setReadingDensity}
            label={t('settings.readingDensity')}
          />
        </div>

        <div className={s.settingRow}>
          <div className={s.settingRowLabel}>{t('settings.readingCol')}</div>
          <Segmented
            options={opts(READING_COL_OPTIONS)}
            value={readingCol}
            onChange={setReadingCol}
            label={t('settings.readingCol')}
          />
        </div>

        <div className={s.settingRow}>
          <div>
            <div className={s.settingRowLabel}>{t('settings.motion')}</div>
            <div className={s.settingRowHint}>{t('settings.motionHint')}</div>
          </div>
          <Segmented
            options={opts(MOTION_OPTIONS)}
            value={motion}
            onChange={setMotion}
            label={t('settings.motion')}
          />
        </div>
      </Section>
    </>
  )
}
