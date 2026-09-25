import { useEffect, useMemo, useRef, useState } from 'react'
import type { ACPAgentState } from '@shared/ipc/acp'
import { Button } from '../../ui/Button'
import { AsyncButton } from '../../ui/AsyncButton'
import { ButtonBase } from '../../ui/ButtonBase'
import { Dialog } from '../../ui/Dialog'
import { PathText } from '../../ui/PathText'
import { useRoving } from '../../ui/a11y/roving'
import { useT } from '../../i18n'
import type { TFn } from '../../i18n'
import { useAsyncPending, useQuery } from '../../data/kernel'
import { acpAgentsQuery } from '../../data/acp-agents-source'
import {
  adoptPendingKey,
  adoptSessionMutation,
  importCandidatesOf,
  remoteSessionsFamily,
  remoteSessionsKey,
  remoteUpdatedAtMs,
  type AcpLifeFailCode,
  type AcpRemoteSession,
} from '../../data/acp-sessions-source'
import { useSessionsSource } from '../../data/sessions-source'
import { notify } from '../../services/notify'
import { useSessionTime } from '../../expose/components/session-time'
import { useExposeStore } from '../../expose/store'
import { ProviderGlyph } from '../../providers/components/ProviderGlyph'
import { agentNameOf, pickDirectoryFor, useAcpImport } from './import-hub'
import s from './AcpImportDialog.module.css'

/**
 * **「从 Agent 导入…」**(A5-b,正本 `docs/design/acp-integration-2026-09.md` §3.7 / §11.6 A5)。
 *
 * agent 自己存着会话(协议 `session/list`),这扇窗把它们列出来、点一条认领成本地会话
 * (`acp.adoptSession`:建本地会话 + 链接 + `session/load`,回放折成 `message/imported`)。
 * 步骤与开关住在 `./import-hub.ts`。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * ① 生命周期
 * | 时机 | 做什么 |
 * | --- | --- |
 * | 挂载 | **常挂**在外壳上(与 `OpenDirDialog` 同一条);`open` 为假时 `ui/Dialog` 一个 DOM 都不画 |
 * | 打开(第二步) | 那一格名单 `ensure()`:第一次问就拉;问过的(同一 agent × 目录)旧答案先上屏、后台对账 |
 * | 挑目录 | 关窗 → `requestDirectory` → 挑完开在第二步;取消 = 取消(判词在 hub)|
 * | 认领成功 | 关窗 → 会话列表 `await refresh()` → `enterSession`(缺省顶替那一格,§会话打开缺省)→ 一条「已导入 N 条」|
 * | 换宿主 | 不存在:它是一扇模态窗,只挂在外壳上 |
 * | 卸载 | 关窗即卸;名单格留着 = 缓存(下一次打开同一处先见旧答案)|
 *
 * ② UI 生命状态(第二步)
 * | 态 | 判据 | 屏幕上 |
 * | --- | --- | --- |
 * | loading | 一份都还没有,也没出错 | 「正在读取…」一句字(列表里不画 spinner)|
 * | error | 传输层红了且一份都没有过 | 「没有读到会话列表。」+「重试」|
 * | unsupported / unavailable / failed | 回答 `ok: false` | 按机器码一句人话,原话在括号里 |
 * | empty | `sessions` 为空 | 「这个目录下没有 X 存着的会话。」|
 * | ready | 有行 | 行 = 标题 · 时间(· 与所挑目录不同时的目录);已认领的行尾「已导入」|
 * | 认领失败 | `adoptSession` 答 `ok: false` / 传输断 | 列表下一行字,列表不动 |
 * | 超量 | 500 条(后端上限) | 列表自己滚(`--acp-import-list-max-h`),行只截断不换行 |
 *
 * 第一步(挑 agent)只有 ready / empty 两态:名册那一格早被入口那一行拉过。
 *
 * ③ UI 交互状态
 * | 件 | rest / hover / focus / active | pending | disabled |
 * | --- | --- | --- | --- |
 * | 行 | `ButtonBase` + 本地皮:hover 只走 CSS `:hover`,键盘位 = 真焦点(`a11y/roving`,焦点就在行上,**没有第二个下标可被鼠标污染**)| 认领那一行 `aria-busy` + 行尾「正在导入…」,别的行照常可点(律③)| 另一条正在认领时这一行只是不响应,不禁灰 |
 * | 「重试」 | `AsyncButton`(读那一格 query)| 钮自己 | — |
 * | 「换一个目录…」/「返回」/「取消」 | `ui/Button` | — | — |
 *
 * ── 焦点 ───────────────────────────────────────────────────────────────
 * 不新开作用域:`ui/Dialog` 自己是 `dialog` 那一格,开出来焦点进面板,Tab 一下进列表,
 * 方向键在行之间走(`useRoving`),↵ / Space = 点那一行(`ButtonBase` 天生认)。Esc 归 `ui/Dialog`。
 */
export function AcpImportDialog() {
  const t = useT()
  const open = useAcpImport((st) => st.open)
  const step = useAcpImport((st) => st.step)
  const close = useAcpImport((st) => st.close)
  const roster = useQuery(acpAgentsQuery)
  const candidates = useMemo(() => importCandidatesOf(roster.data), [roster.data])
  const agent = step.kind === 'sessions' ? roster.data?.find((row) => row.config.id === step.agentId) : undefined
  const agentName = step.kind === 'sessions' ? (agent ? agentNameOf(agent) : step.agentId) : ''

  const title = step.kind === 'sessions' ? t('acpImport.titleAgent', { name: agentName }) : t('acpImport.title')

  const footer =
    step.kind === 'sessions' ? (
      <>
        {candidates.length > 1 && (
          <Button variant="ghost" onClick={() => useAcpImport.getState().showAgents()} data-testid="acp-import-back">
            {t('acpImport.back')}
          </Button>
        )}
        {agent && (
          <Button variant="ghost" onClick={() => pickDirectoryFor(agent)} data-testid="acp-import-change-dir">
            {t('acpImport.changeDir')}
          </Button>
        )}
        <Button onClick={close}>{t('common.cancel')}</Button>
      </>
    ) : (
      <Button onClick={close}>{t('common.cancel')}</Button>
    )

  return (
    <Dialog open={open} onClose={close} title={title} footer={footer}>
      {step.kind === 'agents' ? (
        <AgentStep t={t} candidates={candidates} />
      ) : (
        <SessionStep t={t} agentId={step.agentId} agentName={agentName} cwd={step.cwd} />
      )}
    </Dialog>
  )
}

function AgentStep({ t, candidates }: { t: TFn; candidates: readonly ACPAgentState[] }) {
  const listRef = useRef<HTMLUListElement>(null)
  useRoving(listRef, { active: candidates.length > 0 })
  if (candidates.length === 0) {
    return (
      <p className={s.note} data-testid="acp-import-no-agents">
        {t('acpImport.noAgents')}
      </p>
    )
  }
  return (
    <>
      <p className={s.lead}>{t('acpImport.pickAgent')}</p>
      <ul ref={listRef} className={s.list} aria-label={t('acpImport.pickAgent')} data-testid="acp-import-agents">
        {candidates.map((row) => (
          <li key={row.config.id} className={s.item}>
            <ButtonBase
              className={s.row}
              data-roving-item=""
              data-testid={`acp-import-agent-${row.config.id}`}
              onClick={() => pickDirectoryFor(row)}
            >
              <ProviderGlyph size="sm" familyId={row.manifest?.icon ?? row.config.id} label={agentNameOf(row)} />
              <span className={s.title}>{agentNameOf(row)}</span>
            </ButtonBase>
          </li>
        ))}
      </ul>
    </>
  )
}

const FAIL_KEY = {
  unsupported: 'acpImport.unsupported',
  unavailable: 'acpImport.unavailable',
  failed: 'acpImport.failed',
} as const satisfies Record<AcpLifeFailCode, string>

function failLine(t: TFn, code: AcpLifeFailCode, name: string, error: string): string {
  return t(FAIL_KEY[code] ?? 'acpImport.failed', { name, error })
}

function SessionStep({ t, agentId, agentName, cwd }: { t: TFn; agentId: string; agentName: string; cwd: string }) {
  const entry = remoteSessionsFamily.get(remoteSessionsKey(agentId, cwd))
  const snapshot = useQuery(entry)
  const [adoptError, setAdoptError] = useState<string | null>(null)
  const timeOf = useSessionTime()
  const listRef = useRef<HTMLUListElement>(null)
  const answer = snapshot.data
  const sessions = answer?.ok ? answer.sessions : []
  useRoving(listRef, { active: sessions.length > 0 })

  useEffect(() => {
    void entry.ensure()
    setAdoptError(null)
  }, [entry])

  const adopt = async (row: AcpRemoteSession) => {
    if (row.adoptedSessionId) {
      await openLocalSession(row.adoptedSessionId)
      return
    }
    // 另一条正在认领时不再发第二发(不禁灰:在飞不是不可用,判词在 NavRows 的「新会话」上)。
    if (adoptSessionMutation.get().pending) return
    setAdoptError(null)
    const result = await adoptSessionMutation.run({ agentId, acpSessionId: row.acpSessionId, cwd: row.cwd || cwd })
    if (!result) {
      setAdoptError(t('acpImport.adoptFailed', { error: adoptSessionMutation.get().error ?? '' }))
      return
    }
    if (!result.ok) {
      setAdoptError(failLine(t, result.code, agentName, result.error))
      return
    }
    const line = result.alreadyAdopted ? t('acpImport.alreadyDone') : t('acpImport.done', { n: result.imported })
    await openLocalSession(result.sessionId)
    notify({ level: 'success', source: 'acp.import', title: line })
  }

  let body
  if (answer === undefined) {
    body = snapshot.error ? (
      <div className={s.stateRow} data-testid="acp-import-error">
        <p className={s.note}>{t('acpImport.loadFailed')}</p>
        <AsyncButton size="sm" action={entry} pendingLabel={t('acpImport.loading')} onClick={() => void entry.refetch()}>
          {t('acpImport.retry')}
        </AsyncButton>
      </div>
    ) : (
      <p className={s.note} data-testid="acp-import-loading">
        {t('acpImport.loading')}
      </p>
    )
  } else if (!answer.ok) {
    body = (
      <p className={s.note} data-testid="acp-import-refused" data-code={answer.code}>
        {failLine(t, answer.code, agentName, answer.error)}
      </p>
    )
  } else if (sessions.length === 0) {
    body = (
      <p className={s.note} data-testid="acp-import-empty">
        {t('acpImport.empty', { name: agentName })}
      </p>
    )
  } else {
    body = (
      <ul ref={listRef} className={s.list} aria-label={t('acpImport.listLabel')} data-testid="acp-import-sessions">
        {sessions.map((row) => (
          <SessionRow
            key={row.acpSessionId}
            t={t}
            row={row}
            agentId={agentId}
            cwd={cwd}
            when={timeOf}
            onPick={() => void adopt(row)}
          />
        ))}
      </ul>
    )
  }

  return (
    <>
      <p className={s.lead} data-testid="acp-import-cwd">
        <PathText path={cwd} dir />
      </p>
      {body}
      {adoptError && (
        <p className={s.error} role="status" data-testid="acp-import-adopt-error">
          {adoptError}
        </p>
      )}
    </>
  )
}

function SessionRow({
  t,
  row,
  agentId,
  cwd,
  when,
  onPick,
}: {
  t: TFn
  row: AcpRemoteSession
  agentId: string
  cwd: string
  when: (ms: number) => string
  onPick: () => void
}) {
  const busy = useAsyncPending(adoptSessionMutation, adoptPendingKey(agentId, row.acpSessionId))
  const updated = remoteUpdatedAtMs(row.updatedAt)
  const adopted = Boolean(row.adoptedSessionId)
  return (
    <li className={s.item}>
      <ButtonBase
        className={s.row}
        data-roving-item=""
        data-testid={`acp-import-session-${row.acpSessionId}`}
        data-adopted={adopted ? 'true' : undefined}
        aria-busy={busy || undefined}
        onClick={onPick}
      >
        <span className={s.text}>
          <span className={s.title}>{row.title || t('acpImport.untitled')}</span>
          {row.cwd && row.cwd !== cwd && (
            <span className={s.meta}>
              <PathText path={row.cwd} dir />
            </span>
          )}
        </span>
        {updated !== undefined && <span className={s.time}>{when(updated)}</span>}
        {busy ? (
          <span className={s.tag}>{t('acpImport.adopting')}</span>
        ) : (
          adopted && <span className={s.tag}>{t('acpImport.adopted')}</span>
        )}
      </ButtonBase>
    </li>
  )
}

/**
 * 进那条本地会话:关窗 → 列表对账(`enterSession` 要拿它去夹焦点序列,列表里还没有它的话
 * 焦点会退到别处 —— 与新建会话同一条链)→ 进。缺省打开方式由 `enterSession` 那一口说了算。
 */
async function openLocalSession(sessionId: string): Promise<void> {
  useAcpImport.getState().close()
  await useSessionsSource.getState().refresh()
  useExposeStore.getState().enterSession(sessionId)
}
