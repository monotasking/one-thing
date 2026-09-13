import { Section } from './Section'
import { Segmented } from '../../ui/Segmented'
import { useStageStore } from '../../stage/store'
import {
  SESSION_OPEN_MODE_LABELS,
  SESSION_OPEN_MODES,
  useSessionOpenMode,
} from '../../data/session-open-mode'
import { useT } from '../../i18n'
import type { MessageKey } from '../../i18n'
import type { ResolvedOpen } from '../../stage/types'
import s from './Settings.module.css'

/**
 * 设置 ·「打开方式」页。从 `SettingsMock.tsx` 原样搬来的一节(2026-09-13 分页),
 * **逻辑一行没改**。
 */
// 舞台不在此列(08-30 拍板:点开统一浮窗,舞台只是浮窗的放大目标 —— 见 stage/types.ts)。
const OPEN_OPTIONS: Array<{ value: ResolvedOpen; labelKey: MessageKey }> = [
  { value: 'float', labelKey: 'dock.openFloat' },
  { value: 'pinned', labelKey: 'dock.openPinned' },
]

/*
 * 「点会话列表一行是什么意思」三档(C2)。
 *
 * **表在 `data/session-open-mode.ts`,这里只取次序与文案键** —— 与上面那张
 * 就地写死的表不同,这一张有第二个消费方(标签的右键菜单),而「三档是哪三档、
 * 按什么次序排」只该有一个产地(判例:`FILE_OPEN_MODES` 与 `FileActionsMenu`)。
 */
const SESSION_OPEN_OPTIONS = SESSION_OPEN_MODES.map((value) => ({
  value,
  labelKey: SESSION_OPEN_MODE_LABELS[value],
}))

export function OpenPage() {
  const t = useT()
  const defaultOpen = useStageStore((st) => st.defaultOpen)
  const setDefaultOpen = useStageStore((st) => st.setDefaultOpen)
  const sessionOpenMode = useSessionOpenMode((st) => st.mode)
  const setSessionOpenMode = useSessionOpenMode((st) => st.setMode)

  const opts = <T extends string>(table: Array<{ value: T; labelKey: MessageKey }>) =>
    table.map((o) => ({ value: o.value, label: t(o.labelKey) }))

  return (
    <Section titleKey="dock.openWith">
      <div className={s.settingRow}>
        <div>
          <div className={s.settingRowLabel}>{t('settings.defaultOpen')}</div>
          <div className={s.settingRowHint}>{t('settings.defaultOpenHint')}</div>
        </div>
        <Segmented
          options={opts(OPEN_OPTIONS)}
          value={defaultOpen}
          onChange={setDefaultOpen}
          label={t('settings.defaultOpen')}
        />
      </div>
      <div className={s.settingRowNote}>{t('settings.defaultOpenNote')}</div>

      {/*
        「点会话列表一行」那三档(C2,设计 §4.2)。
        **它归「打开方式」这一页**:分区判据是「用户想改的是哪件事」,而这一件
        想改的正是**打开方式** —— 只不过宾语从「Dock 上那块瓦」换成了「会话列表
        里那一行」。为它单开一页会让设置多一个只有一行的领域,而那一行说的还是
        同一件事。与标签右键菜单里那一节读写**同一格 store**,不是两份状态。
      */}
      <div className={s.settingRow}>
        <div>
          <div className={s.settingRowLabel}>{t('sessions.openMode')}</div>
          <div className={s.settingRowHint}>{t('sessions.openModeHint')}</div>
        </div>
        <Segmented
          options={opts(SESSION_OPEN_OPTIONS)}
          value={sessionOpenMode}
          onChange={setSessionOpenMode}
          label={t('sessions.openMode')}
        />
      </div>
    </Section>
  )
}
