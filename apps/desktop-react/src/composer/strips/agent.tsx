import { useMemo } from 'react'
import { useT } from '../../i18n'
import type { MessageKey } from '../../i18n'
import type { AcpSessionNotice, AcpSessionState } from '@shared/contracts/acp'
import { useAcpSessionState } from '../../data/acp-session-state-source'
import type { ComposerStrip, StripBarModel } from '../strip'
import s from '../components/Composer.module.css'

/**
 * **agent 会话横条**(A2-c,正本 `docs/design/acp-integration-2026-09.md` §3.8「会话状态:
 * 一条会话级横条」)。它是输入框顶条登记表里的一条(`strips/index.ts` 一行),Composer 里
 * 不出现它的名字。
 *
 * 条上一次只说**一件**,按急迫程度挑(判据是 `agentBarFactOf`,纯函数):
 *  ① agent 正在整理上下文(`compaction.status === 'in_progress'`)—— 转圈,因为它会结束;
 *  ② agent 进程出错(`process.status === 'error'`)—— 错误记号 + 后端那句原话的一行;
 *  ③ 最近一条通知 —— 级别记号 + 标题,描述在 Tooltip 里(悬停 / 聚焦可见)。
 * 三样都没有 = 这条不出现。点它开的抽屉是全文:进程错误、整理状态、最近几条通知带描述。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * **① 生命周期**:随 Composer 每次渲染按登记表顺序问一遍(`useBar` 是 hook);订的是这条会话
 *   的状态格(`useAcpSessionState`:非 agent 会话 / 草稿零往返、恒为 null → 条不出现)。
 *   抽屉只在展开时挂载,收起即卸载,没有自己的订阅要退。
 * **② UI 生命状态**:没有 loading 态 —— 状态格还没答上来就是「没有可说的」,条不出现
 *   (一条「正在读 agent 状态」只会在每次开会话时闪一下);ready = 上面三选一;
 *   超量 = 通知最多 20 条(后端封顶),抽屉只列最近 `DRAWER_NOTICES` 条,新的在上。
 * **③ UI 交互状态**:条的 rest / hover / focus / expanded 全归 `StripBar`(`ui/ButtonBase` +
 *   `.statusbar`),这一条不另画;没有 pending / disabled —— 它只读不写。
 */

/** 抽屉里最多列几条通知。条上只说一条,抽屉给「刚才还发生了什么」,不是全量日志。 */
const DRAWER_NOTICES = 5

export type AgentBarFact =
  | { kind: 'compacting' }
  | { kind: 'process-error'; error: string | undefined }
  | { kind: 'notice'; notice: AcpSessionNotice }

/** 条上此刻说哪一件。判据在文件头;没有可说的 = null。 */
export function agentBarFactOf(state: AcpSessionState | null): AgentBarFact | null {
  if (!state) return null
  if (state.compaction?.status === 'in_progress') return { kind: 'compacting' }
  if (state.process.status === 'error') return { kind: 'process-error', error: state.process.error }
  const latest = state.notices[state.notices.length - 1]
  return latest ? { kind: 'notice', notice: latest } : null
}

/** 错误原话只念第一行:条是一眼,堆栈与后文进抽屉。 */
export function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim())?.trim() ?? text.trim()
}

const SEVERITY_KEY: Record<AcpSessionNotice['severity'], MessageKey> = {
  info: 'agentStrip.severityInfo',
  warning: 'agentStrip.severityWarning',
  error: 'agentStrip.severityError',
}

function useAgentBar(sessionId: string): StripBarModel | null {
  const t = useT()
  const state = useAcpSessionState(sessionId)
  return useMemo(() => {
    const fact = agentBarFactOf(state)
    if (!fact) return null
    const label = t('agentStrip.toggle')
    if (fact.kind === 'compacting') {
      return { indicator: { kind: 'spinner' }, text: t('agentStrip.compacting'), label }
    }
    if (fact.kind === 'process-error') {
      return {
        indicator: { kind: 'notice', severity: 'error' },
        text: fact.error ? firstLine(fact.error) : t('agentStrip.processError'),
        label,
        ...(fact.error ? { tip: fact.error } : {}),
      }
    }
    const { notice } = fact
    return {
      indicator: { kind: 'notice', severity: notice.severity },
      text: notice.title,
      label,
      ...(notice.description ? { tip: notice.description } : {}),
    }
  }, [state, t])
}

function AgentStatusDrawer({ sessionId }: { sessionId: string }) {
  const t = useT()
  const state = useAcpSessionState(sessionId)
  if (!state) return null
  const notices = state.notices.slice(-DRAWER_NOTICES).reverse()
  return (
    <div className={s.statusBody} data-testid="agent-status-drawer">
      {state.process.status === 'error' && (
        <div className={s.step}>
          <span className={s.stepLabel}>{t('agentStrip.processError')}</span>
          <span>{state.process.error ?? ''}</span>
        </div>
      )}
      {state.compaction?.status === 'in_progress' && (
        <div className={`${s.step} ${s.stepDoing}`}>
          <span className={s.stepLabel}>{t('agentStrip.compacting')}</span>
        </div>
      )}
      {notices.map((notice) => (
        <div key={`${notice.at}-${notice.title}`} className={s.step}>
          <span className={s.stepLabel}>{t(SEVERITY_KEY[notice.severity])}</span>
          <span>
            {notice.title}
            {notice.description ? ` — ${notice.description}` : ''}
          </span>
        </div>
      ))}
    </div>
  )
}

export const agentStrip: ComposerStrip = {
  id: 'agent',
  order: 1,
  useBar: useAgentBar,
  Drawer: AgentStatusDrawer,
}
