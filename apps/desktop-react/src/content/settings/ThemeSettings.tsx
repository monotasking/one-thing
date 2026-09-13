import { useEffect } from 'react'
import { Segmented } from '../../ui/Segmented'
import { Select } from '../../ui/Select'
import { useQuery } from '../../data/kernel'
import {
  setDarkThemeMutation,
  setLightThemeMutation,
  setThemeModeMutation,
  startThemeSettingsSource,
  themeSettingsQuery,
} from '../../data/theme-settings-source'
import { themesFor, type ThemeMode } from '../../data/theme-settings-model'
import { useT } from '../../i18n'
import type { MessageKey } from '../../i18n'
import s from './Settings.module.css'

/**
 * 设置 · 外观 ·「主题」这一节(2026-09-13,用户原话「设置增加 theme 选择」)。
 *
 * ── 它属于哪个领域 ────────────────────────────────────────────────────────
 * 分区判据照旧是「**用户想改的是哪件事**」:这一件是「这台壳长什么颜色」,与
 * 底下那一节「这段字读起来怎么样」(阅读四轴)是同一类**外观**,所以同一页、
 * 两节。
 *
 * ── 三行都即点即生效,没有保存钮 ──────────────────────────────────────────
 * 与阅读四轴同一条纪律:没有一次改动是需要确认的 —— 改错了再点回来就是,而
 * 颜色的对错只有看着才知道。
 *
 * ── **不做** accent ───────────────────────────────────────────────────────
 * `general.colorTheme` 那七档没有出现在这一节里:用户没要。加它要先回答「它与
 * 主题自带的 accent 谁赢」,那是一次拍板不是一格控件。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三张状态表(施工前先按它自审整面)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ① **生命周期**:随外观页挂载 → `ensure()` 问一次(设置 + 名册一趟并发)→
 *    `startThemeSettingsSource()` 订一次设置推送(幂等,订阅不随组件走)→
 *    卸载什么都不清(query 与订阅都不是这份实例的)。**没有第二种宿主形态** ——
 *    它只活在设置页的一节里,跟着整页滚。
 *
 * ② **UI 生命状态**
 *
 * | 态 | 判据 | 屏幕上 |
 * | --- | --- | --- |
 * | 还没问到 | `!data` | 三行都画着、都**禁着**。一行禁着的控件说的是「还不知道」,而一格空的选择器说的是「你没选过主题」,后者是假话 |
 * | 读到了 | `data` | 三行可用;两格选择器各列该档的主题 |
 * | 读失败 | `error` | 错话与**旧值并陈**(律②):拉不到不把三行抹掉 |
 * | 名册为空 | `themes.length === 0` | 明暗那一行照常;两格选择器各只剩「当前那一套」(`themesFor` 的补位那一支)—— 一趟取数的坏不该让明暗也改不了 |
 * | 当前 id 不在过滤表里 | 主题卸载了 / 指着只有另一档的主题 | 那一项补在列表末尾,名字就是 id 本身(判词在 `themesFor` 上) |
 * | 超量 | 主题很多 | 面板自己滚(`ui/Select` 的 `--select-menu-max-h`),不撑页 |
 *
 * ③ **UI 交互状态**:明暗随 `ui/Segmented` 全套(rest/hover/选中/禁用);两格
 *    选择器随 `ui/Select` 全套;三条写路都是乐观更新,所以没有单独的 pending 皮肤
 *    —— 屏上那一格**当场**就变了,后台对账回来若被拒,`notify` 说话并翻回去。
 */
const MODE_OPTIONS: Array<{ value: ThemeMode; labelKey: MessageKey }> = [
  { value: 'system', labelKey: 'settings.themeModeSystem' },
  { value: 'light', labelKey: 'settings.themeModeLight' },
  { value: 'dark', labelKey: 'settings.themeModeDark' },
]

export function ThemeSettings() {
  const t = useT()
  const { data, error } = useQuery(themeSettingsQuery)

  useEffect(() => {
    void themeSettingsQuery.ensure()
    void startThemeSettingsSource()
  }, [])

  const themes = data?.themes ?? []
  const lightOptions = themesFor(themes, 'light', data?.lightThemeId)
  const darkOptions = themesFor(themes, 'dark', data?.darkThemeId)

  return (
    <>
      <div className={s.settingRow} data-testid="theme-mode-row">
        <div>
          <div className={s.settingRowLabel}>{t('settings.themeMode')}</div>
          <div className={s.settingRowHint}>{t('settings.themeModeHint')}</div>
        </div>
        <Segmented
          options={MODE_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
          value={data?.mode ?? 'system'}
          // 还没问到就不许动:此刻屏上那一格是「不知道」,翻它等于拿一个猜测
          // 当底本去写设置(判据与 `BrowserSettings` 那枚开关逐字相同)。
          disabled={!data}
          onChange={(next) => void setThemeModeMutation.run(next)}
          label={t('settings.themeMode')}
        />
      </div>

      <div className={s.settingRow} data-testid="theme-light-row">
        <div className={s.settingRowLabel}>{t('settings.themeLight')}</div>
        <Select
          size="sm"
          label={t('settings.themeLight')}
          value={data?.lightThemeId ?? ''}
          disabled={!data}
          options={lightOptions.map((row) => ({ value: row.id, label: row.name }))}
          onChange={(next) => void setLightThemeMutation.run(next)}
        />
      </div>

      <div className={s.settingRow} data-testid="theme-dark-row">
        <div className={s.settingRowLabel}>{t('settings.themeDark')}</div>
        <Select
          size="sm"
          label={t('settings.themeDark')}
          value={data?.darkThemeId ?? ''}
          disabled={!data}
          options={darkOptions.map((row) => ({ value: row.id, label: row.name }))}
          onChange={(next) => void setDarkThemeMutation.run(next)}
        />
      </div>

      {/* 错误与旧值**并陈**(律②):拉不到不把那三行抹掉。 */}
      {error ? (
        <div className={s.settingRowNote}>{`${t('settings.themeLoadFailed')} · ${error}`}</div>
      ) : null}
    </>
  )
}
