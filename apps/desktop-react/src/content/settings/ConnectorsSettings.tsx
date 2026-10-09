import { useEffect, useState, type ComponentProps } from 'react'
import { Pencil, Trash2 } from '../../components/icons'
import { AsyncButton } from '../../ui/AsyncButton'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { Field, useFieldControlProps } from '../../ui/Field'
import { IconButton } from '../../ui/IconButton'
import { Input } from '../../ui/Input'
import { Segmented } from '../../ui/Segmented'
import { StatusDot, type StatusDotTone } from '../../ui/StatusDot'
import { Switch } from '../../ui/Switch'
import { useAsyncPending, useMutation, useQuery } from '../../data/kernel'
import {
  connectorDraftValidation,
  connectorsQuery,
  connectorsStillSettling,
  draftFromRow,
  emptyConnectorDraft,
  logoutConnectorMutation,
  reconnectConnectorMutation,
  removeConnectorMutation,
  saveConnectorMutation,
  setConnectorEnabledMutation,
  type ConnectorDraft,
  type ConnectorRow,
} from '../../data/mcp-connectors-source'
import { canRunClientActions, openExternalViaHost } from '../../platform/host'
import { useT, type MessageKey, type TFn } from '../../i18n'
import { Section } from './Section'
import shared from './Settings.module.css'
import s from './ConnectorsSettings.module.css'
import type { MCPTransportType } from '@shared/mcp/types'

/**
 * 设置页「连接器」(MCP 服务器)(2026-10-09,用户令「设置也增加 mcp(连接器)配置」)。
 *
 * 一页三件:一列连接器(每行:状态点 + 名字 + 一句摘要 + 开关 + 编辑 / 删除)、一颗「添加」、
 * 新建 / 编辑共用的一张表单对话框。装在本机的已知服务(Codex 电脑操控)由后端自动填进来,
 * 这一页不认识它 —— 它长得与别的行一样。
 *
 * ── 生命周期 ──────────────────────────────────────────────────────────────
 * 挂载 → `connectorsQuery.ensure()`(缓存有就不重拉);有一行还在「连接中」就每 2 秒补拉一次,
 * 全部落定即停;卸载清掉计时器,缓存留着(回来不闪)。对话框打开时起草稿、关闭即丢。
 * 换宿主(设置页只有 form 一种落点)不另算。
 *
 * ── UI 生命状态 ───────────────────────────────────────────────────────────
 * initial(没数据):只画说明与「正在读取」,「添加」禁灰;ready-empty:一句「还没有连接器」+ 添加;
 * ready:列表;error:列表留着(律②)+ 一行 alert + 重试;超量(几十行):纵向长表,不折叠,
 * 添加钮在表尾随表走。
 *
 * ── 交互状态(每行) ───────────────────────────────────────────────────────
 * 开关:乐观翻、按行 pending(`useAsyncPending` 逐格,律③);重连 / 登录 / 登出:AsyncButton 自带
 * pending;删除:确认对话框 → 乐观摘行;编辑:对话框带着原行,私密格留空 = 保持原样。
 * 失败:行底下一行 alert 带后端原话;保存失败留在对话框里不关。
 */
export function ConnectorsSettings() {
  const t = useT()
  const { data: rows, phase, error, inflight } = useQuery(connectorsQuery)
  const [editing, setEditing] = useState<ConnectorDraft | null>(null)
  const [doomed, setDoomed] = useState<ConnectorRow | null>(null)
  const settling = connectorsStillSettling(rows)

  useEffect(() => { void connectorsQuery.ensure() }, [])
  useEffect(() => {
    if (!settling) return
    const timer = setInterval(() => { void connectorsQuery.refetch() }, SETTLE_POLL_MS)
    return () => clearInterval(timer)
  }, [settling])

  return (
    <Section titleKey="settings.sectionConnectors">
      <div className={shared.sectionNote}>{t('connectors.intro')}</div>

      {phase === 'initial' && !error ? (
        <div className={s.feedback} role="status">{t('connectors.loading')}</div>
      ) : null}
      {error ? (
        <div className={s.feedback} role="alert">
          {t('connectors.loadFailed')} · {error}
          <Button disabled={inflight} onClick={() => { void connectorsQuery.refetch() }}>{t('connectors.retry')}</Button>
        </div>
      ) : null}

      {rows ? (
        <div className={s.list} data-testid="connectors-list">
          {rows.length === 0 ? <div className={shared.sectionNote}>{t('connectors.empty')}</div> : null}
          {rows.map((row) => (
            <ConnectorRowView
              key={row.id}
              row={row}
              onEdit={() => setEditing(draftFromRow(row))}
              onRemove={() => setDoomed(row)}
            />
          ))}
        </div>
      ) : null}

      <div className={s.actions}>
        <Button disabled={!rows} onClick={() => setEditing(emptyConnectorDraft())} data-testid="connectors-add">
          {t('connectors.add')}
        </Button>
      </div>

      <ConnectorDialog draft={editing} onClose={() => setEditing(null)} />

      <Dialog
        open={doomed !== null}
        onClose={() => setDoomed(null)}
        title={t('connectors.removeConfirmTitle', { name: doomed?.name ?? '' })}
        footer={
          <>
            <Button onClick={() => setDoomed(null)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              data-testid="connectors-remove-confirm"
              onClick={() => {
                if (doomed) void removeConnectorMutation.run(doomed.id)
                setDoomed(null)
              }}
            >
              {t('connectors.remove')}
            </Button>
          </>
        }
      >
        {t('connectors.removeConfirmBody')}
      </Dialog>
    </Section>
  )
}

const SETTLE_POLL_MS = 2000

function toneOf(row: ConnectorRow): StatusDotTone {
  if (!row.enabled) return 'off'
  switch (row.status) {
    case 'connected': return 'ok'
    case 'connecting': return 'info'
    case 'error': return 'bad'
    default: return 'idle'
  }
}

function statusKeyOf(row: ConnectorRow): MessageKey {
  if (!row.enabled) return 'connectors.statusDisabled'
  switch (row.status) {
    case 'connected': return 'connectors.statusConnected'
    case 'connecting': return 'connectors.statusConnecting'
    case 'error': return 'connectors.statusError'
    default: return 'connectors.statusDisconnected'
  }
}

const TRANSPORT_KEYS: Record<MCPTransportType, MessageKey> = {
  stdio: 'connectors.transportStdio',
  http: 'connectors.transportHttp',
  sse: 'connectors.transportSse',
}

function summaryOf(row: ConnectorRow, t: TFn): string {
  const parts = [row.url ?? t(TRANSPORT_KEYS[row.transport])]
  if (row.status === 'connected') parts.push(t('connectors.tools', { count: row.toolCount }))
  parts.push(t(statusKeyOf(row)))
  return parts.join(' · ')
}

/**
 * 一行连接器。左边是它是什么(状态点 + 名字 + 摘要),右边是关于它的那几个决定
 * (开关、编辑、删除)—— 与设置页别处 `.settingRow` 同一个形。
 */
function ConnectorRowView({ row, onEdit, onRemove }: { row: ConnectorRow; onEdit: () => void; onRemove: () => void }) {
  const t = useT()
  const toggling = useAsyncPending(setConnectorEnabledMutation, row.id)
  const removing = useAsyncPending(removeConnectorMutation, row.id)
  const needsLogin = row.enabled && row.oauth?.status === 'required'

  return (
    <div className={s.row} data-testid="connector-row" data-connector-id={row.id} data-connector-status={row.status}>
      <div className={shared.settingRow}>
        <div className={s.identity}>
          <StatusDot tone={toneOf(row)} size="sm" label={t(statusKeyOf(row))} />
          <div className={s.text}>
            <div className={shared.settingRowLabel}>{row.name}</div>
            <div className={shared.settingRowHint}>{summaryOf(row, t)}</div>
          </div>
        </div>
        <div className={s.controls}>
          <Switch
            label={t('connectors.enable', { name: row.name })}
            checked={row.enabled}
            disabled={toggling || removing}
            onChange={(enabled) => { void setConnectorEnabledMutation.run({ id: row.id, enabled }) }}
          />
          <IconButton icon={Pencil} size="xs" label={t('connectors.edit')} disabled={removing} onClick={onEdit} testId="connector-edit" />
          <IconButton icon={Trash2} size="xs" tone="danger" label={t('connectors.remove')} disabled={removing} onClick={onRemove} testId="connector-remove" />
        </div>
      </div>

      {row.error && row.enabled ? (
        <div className={s.feedback} role="alert">
          {row.error}
          <AsyncButton
            action={reconnectConnectorMutation}
            pendingLabel={t('connectors.statusConnecting')}
            onClick={() => { void reconnectConnectorMutation.run(row.id) }}
          >
            {t('connectors.reconnect')}
          </AsyncButton>
        </div>
      ) : null}

      {needsLogin ? (
        <div className={s.feedback} role="status">
          {t('connectors.loginHint')}
          {row.oauth?.authorizationUrl ? (
            canRunClientActions() ? (
              <Button onClick={() => { void openExternalViaHost(row.oauth!.authorizationUrl!) }}>{t('connectors.login')}</Button>
            ) : (
              <span className={s.url}>{t('connectors.loginUrlNote', { url: row.oauth.authorizationUrl })}</span>
            )
          ) : null}
        </div>
      ) : null}

      {row.oauth?.status === 'authorized' ? (
        <div className={s.feedback}>
          <AsyncButton
            action={logoutConnectorMutation}
            pendingLabel={t('connectors.logout')}
            onClick={() => { void logoutConnectorMutation.run(row.id) }}
          >
            {t('connectors.logout')}
          </AsyncButton>
        </div>
      ) : null}
    </div>
  )
}

function FieldInput(props: ComponentProps<typeof Input>) {
  const field = useFieldControlProps()
  return <Input {...field} {...props} />
}

/**
 * 新建 / 编辑共用的表单。草稿是**本地**的:对话框开着就是一份正在写的东西,关掉即丢,
 * 保存成功才落到后端(与浏览器身份那一格「失焦才存」同一个判据:打字中不是决定)。
 */
function ConnectorDialog({ draft, onClose }: { draft: ConnectorDraft | null; onClose: () => void }) {
  const t = useT()
  const [form, setForm] = useState<ConnectorDraft | null>(draft)
  const saving = useMutation(saveConnectorMutation)
  // 每次打开都从传进来的那份起草;同一份引用打开两次不会重置正在写的内容。
  useEffect(() => { setForm(draft) }, [draft])

  const open = draft !== null
  const current = form ?? draft
  const invalid = current ? connectorDraftValidation(current) : undefined
  const editingExisting = Boolean(current?.id)
  const patch = (next: Partial<ConnectorDraft>) => setForm((prev) => ({ ...(prev ?? emptyConnectorDraft()), ...next }))

  const submit = async () => {
    if (!current || invalid) return
    const ok = await saveConnectorMutation.run(current)
    // `run` 不抛:失败时 `undefined`;成功时 `void` 也是 undefined —— 以 error 判。
    if (ok === undefined && saveConnectorMutation.get().error) return
    onClose()
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t(editingExisting ? 'connectors.dialogEditTitle' : 'connectors.dialogAddTitle')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <AsyncButton
            action={saveConnectorMutation}
            pendingLabel={t('connectors.saving')}
            disabled={!current || !!invalid}
            onClick={() => { void submit() }}
            data-testid="connectors-save"
          >
            {t('connectors.save')}
          </AsyncButton>
        </>
      }
    >
      {current ? (
        <div className={s.form} data-testid="connectors-form">
          <Field label={t('connectors.name')}>
            <FieldInput value={current.name} autoComplete="off" spellCheck={false} onValueChange={(name) => patch({ name })} />
          </Field>
          <Field label={t('connectors.transport')}>
            <Segmented<MCPTransportType>
              label={t('connectors.transport')}
              value={current.transport}
              options={(['stdio', 'http', 'sse'] as const).map((value) => ({ value, label: t(TRANSPORT_KEYS[value]) }))}
              onChange={(transport) => patch({ transport })}
            />
          </Field>
          {current.transport === 'stdio' ? (
            <>
              <Field
                label={t('connectors.commandLine')}
                hint={editingExisting && !current.commandLine ? t('connectors.keepHint') : t('connectors.commandLineHint')}
              >
                <FieldInput
                  value={current.commandLine}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="npx -y some-mcp@latest"
                  onValueChange={(commandLine) => patch({ commandLine })}
                />
              </Field>
              <Field label={t('connectors.cwd')} hint={editingExisting ? t('connectors.keepHint') : t('connectors.cwdHint')}>
                <FieldInput value={current.cwd} autoComplete="off" spellCheck={false} onValueChange={(cwd) => patch({ cwd })} />
              </Field>
              <Field label={t('connectors.env')} hint={editingExisting ? t('connectors.keepHint') : t('connectors.envHint')}>
                <FieldInput value={current.env} autoComplete="off" spellCheck={false} placeholder="API_KEY=…; OTHER=…" onValueChange={(env) => patch({ env })} />
              </Field>
            </>
          ) : (
            <Field label={t('connectors.url')}>
              <FieldInput value={current.url} autoComplete="off" spellCheck={false} placeholder="https://" onValueChange={(url) => patch({ url })} />
            </Field>
          )}
          <div className={s.feedback} role={saving.error ? 'alert' : 'status'} aria-live="polite">
            {saving.error ? `${t('connectors.saveFailed')} · ${saving.error}` : invalid ? t(invalid) : ''}
          </div>
        </div>
      ) : null}
    </Dialog>
  )
}
