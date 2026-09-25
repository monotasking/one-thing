import { memo } from 'react'
import { resolveIcon } from '../../components/icons'
import { useT } from '../../i18n'
import { useQuery } from '../../data/kernel'
import { acpAgentsQuery } from '../../data/acp-agents-source'
import type { AgentNotice } from '../../data/agent-notices-source'
import s from './AgentNoticeRow.module.css'

const BellIcon = resolveIcon('Bell')

/**
 * **agent 发来的一句提醒**,作为会话里的一行系统行(ACP A2-c;数据与判词在
 * `data/agent-notices-source.ts`)。外面那一层(`ChatStream`)按 `at` 把它插在消息之间,
 * 给它行的壳(`.row .rowLate`:事后出现的行软着陆);这里只画那一句话。
 *
 * 一行三格:图标(级别色只上它)· 「<agent> 的通知」· 标题 + 原话。它**不带
 * `data-message-id`**(不是消息,不进 TOC / 定位),报的是 `data-agent-notice`。
 *
 * ── ① 生命周期 ── 挂载 = 这一条提醒到了(或打开会话时它已在表里);不随消息流重挂
 * (key 是本机铸的 id);卸载 = 会话关掉 / 壳重开(表跟壳同寿,见数据层文件头)。
 * ── ② UI 生命状态 ── 只有 ready 一态:到了才有这一行。名册没拉过时 agent 名退成 id。
 * 超量:原话很长时换行铺开不截;一条会话最多 50 条(数据层削量)。
 * ── ③ UI 交互状态 ── 纯陈述,无可点件:没有 hover / focus / pending。
 */
export const AgentNoticeLine = memo(function AgentNoticeLine({ notice }: { notice: AgentNotice }) {
  const t = useT()
  // 名册是一格共享读数(模型抽屉 / 设置页也读它);这里只读不拉 —— 一行提醒不值得为
  // 一个名字发一次往返,没拉过就念 id。
  const roster = useQuery(acpAgentsQuery)
  const row = roster.data?.find((state) => state.config.id === notice.agentId)
  const agent = row?.config.name || row?.agentInfo?.name || notice.agentId
  return (
    <p className={s.line} data-level={notice.level} role="note">
      <BellIcon className={s.icon} strokeWidth={1.75} aria-hidden="true" />
      <span className={s.who}>{t('chat.agentNotice.label', { agent })}</span>
      {notice.title && <span className={s.who}>{notice.title}</span>}
      <span className={s.message}>{notice.message}</span>
    </p>
  )
})
