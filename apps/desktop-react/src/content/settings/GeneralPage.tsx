import { useEffect, useState } from 'react'
import { Section } from './Section'
import { Segmented } from '../../ui/Segmented'
import { Switch } from '../../ui/Switch'
import { AsyncButton } from '../../ui/AsyncButton'
import { useMutation, useQuery } from '../../data/kernel'
import {
  BACKEND_UPTIME_TICK_MS,
  backendKeepRunningQuery,
  backendStatusLine,
  canRestartBackend,
  restartBackendMutation,
  saveKeepRunningMutation,
  useBackendHostState,
} from '../../data/backend-host-source'
import { canSeeBackendProcess } from '../../platform/host'
import { useStageStore } from '../../stage/store'
import { useT } from '../../i18n'
import type { Locale, MessageKey } from '../../i18n'
import s from './Settings.module.css'

/**
 * 设置 ·「通用」页。语言 + 工作目录占位 + 后端那几行(第④步批 2b:「退出后继续运行」开关、后端状态行与
 * 「重启后端」;只在看得见后端进程的客户端上画,判据 `canSeeBackendProcess()` 一处 —— 浏览器壳不画)。
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

      {canSeeBackendProcess() ? <BackendRows /> : null}
    </Section>
  )
}

/**
 * 后端那两行。状态全在 `data/backend-host-source.ts`(三张状态表见那只文件头指的施工记录),这里只读、只画。
 * 「已运行」那一格每 `BACKEND_UPTIME_TICK_MS` 重算一次,只在这两行挂着时走。
 */
function BackendRows() {
  const t = useT()
  const state = useBackendHostState()
  const keepRunning = useQuery(backendKeepRunningQuery)
  const saving = useMutation(saveKeepRunningMutation)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => { void backendKeepRunningQuery.ensure() }, [])
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), BACKEND_UPTIME_TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const line = backendStatusLine(state, now)
  const notOwned = state?.ownedByDesktop === false
  const keepRunningHint = saving.error
    ? t('backend.keepRunningSaveFailed')
    : keepRunning.error && keepRunning.data === undefined ? t('backend.keepRunningLoadFailed') : t('backend.keepRunningHint')

  return (
    <>
      <div className={s.settingRow} data-testid="backend-keep-running">
        <div>
          <div className={s.settingRowLabel}>{t('backend.keepRunning')}</div>
          <div className={s.settingRowHint}>{keepRunningHint}</div>
        </div>
        <Switch
          label={t('backend.keepRunning')}
          checked={keepRunning.data ?? false}
          disabled={keepRunning.data === undefined || saving.pending}
          onChange={(on) => { void saveKeepRunningMutation.run(on) }}
        />
      </div>

      {line ? (
        <div className={s.settingRow} data-testid="backend-status">
          <div>
            <div className={s.settingRowLabel}>{line}</div>
            {notOwned ? <div className={s.settingRowHint}>{t('backend.notOwnedHint')}</div> : null}
          </div>
          <AsyncButton
            action={restartBackendMutation}
            pendingLabel={t('backend.restarting')}
            disabled={!canRestartBackend(state)}
            size="sm"
            onClick={() => { void restartBackendMutation.run() }}
          >
            {t('backend.restart')}
          </AsyncButton>
        </div>
      ) : null}
    </>
  )
}
