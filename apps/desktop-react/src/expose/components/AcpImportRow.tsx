import { useEffect, useMemo } from 'react'
import { Import } from '../../components/icons'
import { ButtonBase } from '../../ui/ButtonBase'
import { useT } from '../../i18n'
import { useQuery } from '../../data/kernel'
import { acpAgentsQuery, startAcpAgentsSource } from '../../data/acp-agents-source'
import { importCandidatesOf } from '../../data/acp-sessions-source'
import { agentNameOf, startAcpImport } from '../../content/acp-import/import-hub'
import s from './NavRows.module.css'

/**
 * 会话侧栏导航里的「从 Agent 导入…」(A5-b,正本 `docs/design/acp-integration-2026-09.md` §3.7:
 * 入口与「打开目录…」同一个 hub —— 窗在 `content/acp-import/`,这一行只按开关)。
 *
 * **只在有东西可导时在场**:启用、装着、没明说「不会列会话」的 agent 至少一台
 * (`importCandidatesOf`;握手之前能力位不知道,那一台照样算 —— 让 RPC 的 `unsupported` 当场说)。
 * 一台都没有就整行不在:一行点开只会说「没有」的入口比没有入口更糟(与会话菜单「关闭」那一行
 * 「没有对象就不在场」同一条判词)。只有一台时这一行直接写它的名字,点下去跳过挑 agent 那一步。
 *
 * 与上面三行同形(`NavRows.module.css` 的 `.row` / `.glyph` / `.label`,侧栏对齐律一格不差),
 * 走 `ButtonBase`(裸钮三类判第③类)。名册那一格与设置页 / 模型选择器共用,挂载时 `ensure()`
 * 一次并订上 `acp:agent-state`(握手之后能力位变了,这一行跟着变)。
 */
export function AcpImportRow() {
  const t = useT()
  const roster = useQuery(acpAgentsQuery)
  useEffect(() => {
    void acpAgentsQuery.ensure()
    void startAcpAgentsSource()
  }, [])
  const candidates = useMemo(() => importCandidatesOf(roster.data), [roster.data])
  if (candidates.length === 0) return null
  const label =
    candidates.length === 1
      ? t('acpImport.fromAgent', { name: agentNameOf(candidates[0]!) })
      : t('acpImport.fromAny')
  return (
    <ButtonBase className={s.row} data-testid="expose-acp-import" onClick={() => startAcpImport(candidates)}>
      <Import className={s.glyph} strokeWidth={1.75} aria-hidden="true" />
      <span className={s.label}>{label}</span>
    </ButtonBase>
  )
}
