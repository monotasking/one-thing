import { useEffect, useMemo, useState } from 'react'
import { AsyncButton } from '../../ui/AsyncButton'
import { Button } from '../../ui/Button'
import { Field } from '../../ui/Field'
import { Fold, FoldBody, FoldTrigger } from '../../ui/Fold'
import { IconButton } from '../../ui/IconButton'
import { Input } from '../../ui/Input'
import { PathText } from '../../ui/PathText'
import { Rail } from '../../ui/Rail'
import type { RailItem, RailSection } from '../../ui/Rail'
import { StatusDot } from '../../ui/StatusDot'
import type { StatusDotTone } from '../../ui/StatusDot'
import { Switch } from '../../ui/Switch'
import { Tooltip } from '../../ui/Tooltip'
import { useConfirm } from '../../ui/Dialog'
import { ChevronDown, ChevronRight, Lock, X } from '../../components/icons'
import { ProviderGlyph } from '../../providers/components/ProviderGlyph'
import { createMutation, useAsyncPending, useMutation, useQuery } from '../../data/kernel'
import { useHomeDir } from '../../data/home-dir'
import {
  acpAgentsQuery,
  addAgentMutation,
  agentIdFromName,
  argsFromLine,
  argsToLine,
  detectAgentsMutation,
  refreshRegistryMutation,
  removeAgentMutation,
  sourceOf,
  startAcpAgentsSource,
  updateAgentMutation,
  updatePendingKey,
} from '../../data/acp-agents-source'
import { runScriptInTerminal } from '../terminal/run-script'
import { getLogger } from '../../services/log'
import { useT } from '../../i18n'
import type { MessageKey, TFn } from '../../i18n'
import type { ACPAgentConfig, ACPAgentState } from '@shared/ipc/acp'
import shared from './Settings.module.css'
import s from './AgentsSettings.module.css'

const log = getLogger('settings.agents')

/**
 * 设置页「Agent」那一页(ACP A1-b,正本 `docs/design/acp-integration-2026-09.md` §3.8 / §3.9)。
 *
 * 形与模型服务那一页同一套:左栏名册(`ui/Rail`,从 `ProviderRail` 抽出来的那一件)
 * + 右栏选中那一台的详情。它是名册,不是凭证 —— 登录归各家 CLI 自己,这一页只说
 * 「装没装、开没开、怎么起它」。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三张状态表(状态先行,09-01 用户令)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ① **生命周期**
 *
 * | 时机 | 做什么 |
 * | --- | --- |
 * | 挂载 | `acpAgentsQuery.ensure()` + `startAcpAgentsSource()`(幂等订 `acp:agent-state`)+ **探测一次**(`acp.detect`;方案 §11.2「设置页打开时刷新,不轮询」)|
 * | 首载 | 整面一句「正在读取…」,两颗头部钮禁着(没有名册可探测)。**不画骨架**:库里没有骨架件,模型服务那一页同一处也是一句字(判例同源)|
 * | 重拉 | `acp:agent-state` 就地换一行;写完 `settle` 对账;探测 / 刷注册表的回答直接落格。**旧内容留在屏上**(律②)|
 * | 换宿主 | 不存在:只活在设置页的一页里 |
 * | 卸载 | 组件卸下,query 格留着 = 缓存;订阅全应用一条,退役只有 `resetAcpAgentsSource()` 与 HMR dispose 两口 |
 *
 * ② **UI 生命状态**
 *
 * | 态 | 判据 | 屏幕上 |
 * | --- | --- | --- |
 * | initial | 一份都还没有,也没出错 | 「正在读取…」;没有一个可点的控件 |
 * | error | 这一发红了且**一份都没有过** | 「读不到 Agent 列表。」+「重试」 |
 * | empty | 名册是空的(种子目录丢了、注册表关着) | 左栏只剩脚上的「添加自定义 Agent」;右栏一句「还没有找到任何 Agent」+ 一句怎么装 |
 * | ready | 有行 | 左栏三组(内置 / 注册表 / 自定义)+ 右栏选中那一台 |
 * | 探测失败 | `detect` / `refreshRegistry` 的快照 `error` | 头部那一行换成「没有完成:…」,名册照旧(**不弹通知**,派工单原话)|
 * | 超量 | 注册表 60 台 | 左栏自己滚(`ui/Rail` 的 `.body`),右栏只画一台;行只截断不换行 |
 *
 * ③ **UI 交互状态**:全部走库件(`Rail` / `Switch` / `Button` / `AsyncButton` / `Input` /
 *    `Fold` / `Tooltip` / `IconButton`),rest / hover / focus / active 随件走,这一页一行不自绘。
 *
 * | 件 | pending | disabled |
 * | --- | --- | --- |
 * | 「重新探测」/「刷新注册表」 | AsyncButton 读各自的 mutation | 首载 / 另一颗在飞(两颗都会重写整张名册,并发的两份回答谁后到谁赢)|
 * | 启用开关 | 乐观翻过去 + 自己禁着(`updatePendingKey(id,'enabled')`)| 同左 |
 * | 高级区「保存」 | AsyncButton(`updatePendingKey(id,'advanced')`)| 没改动 / 命令空着(自定义那一台) |
 * | 「装上」 | AsyncButton(`installAgentMutation`)| 没有 npm 包名时不画这颗钮,画装法那句话 |
 * | 「添加」/「复制」 | AsyncButton(`addAgentMutation`)| 命令空着(添加)/ 名字空着(复制)|
 * | 「删除」 | 乐观摘掉那一行 + 一次确认(本壳唯一允许的 confirm)| 只在自定义那一台上出现 |
 *
 * ── 焦点三件 ─────────────────────────────────────────────────────────────
 * 这一页**不新开作用域**:住在设置页那块面里,`settings` 那一格已经声明过。
 */

/** 右栏在画「新建一台」那张表时的选中值。不是任何 agent 的 id(id 只收 `[a-z0-9-]`)。 */
const NEW_AGENT = '\u0000new'

const SOURCE_ORDER = ['builtin', 'registry', 'user'] as const
const SOURCE_KEY: Record<(typeof SOURCE_ORDER)[number], MessageKey> = {
  builtin: 'agents.groupBuiltin',
  registry: 'agents.groupRegistry',
  user: 'agents.groupUser',
}

/** 键名像密钥就给一枚锁(本单只标记,值仍明文存 —— 凭证池归 A3)。 */
const SECRET_KEY_PATTERN = /KEY|TOKEN|SECRET|PASSWORD/i

/**
 * 「装上」:在终端瓦里跑 `npm i -g <pkg>`。借的是聊天里代码块「运行」那一条路
 * (`runScriptInTerminal`):开(或复用)一格运行终端、摆出来、写进去回车。
 * 这里没有新后端,也不等它装完 —— 装好之后人点「重新探测」。
 */
const installAgentMutation = createMutation<string, void>('agents.install', {
  run: async (pkg) => {
    await runScriptInTerminal({ shell: 'bash', script: `npm i -g ${pkg}` })
  },
  onError: (error) => log.warn('install in terminal failed', { err: error.message }),
})

function nameOf(state: ACPAgentState): string {
  return state.config.name || state.manifest?.name || state.config.id
}

/** 探测那一格说成一句话。 */
function installFactOf(t: TFn, state: ACPAgentState): string {
  const detect = state.detect
  if (!detect?.installed) return t('agents.notInstalled')
  if (detect.belowMin) return t('agents.belowMin', { version: detect.version ?? '' })
  return detect.version ? t('agents.installedVersion', { version: detect.version }) : t('agents.installed')
}

function installToneOf(state: ACPAgentState): StatusDotTone {
  if (!state.detect?.installed) return 'off'
  return state.detect.belowMin ? 'warn' : 'ok'
}

function processFactOf(t: TFn, state: ACPAgentState): string {
  switch (state.status) {
    case 'connected':
      return state.pid ? t('agents.processRunning', { pid: state.pid }) : t('agents.processRunningNoPid')
    case 'connecting':
      return t('agents.processConnecting')
    case 'error':
      return t('agents.processError', { error: state.error ?? '' })
    default:
      return t('agents.processIdle')
  }
}

function matches(state: ACPAgentState, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    nameOf(state).toLowerCase().includes(q) ||
    state.config.id.includes(q) ||
    (state.manifest?.vendor ?? '').toLowerCase().includes(q)
  )
}

export function AgentsSettings() {
  const t = useT()
  const { data, error } = useQuery(acpAgentsQuery)
  const detectSnap = useMutation(detectAgentsMutation)
  const registrySnap = useMutation(refreshRegistryMutation)
  const [picked, setPicked] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    void acpAgentsQuery.ensure()
    void startAcpAgentsSource()
    // 版本号只在「探测」时刷新,不轮询;打开这一页就是那个时机(方案 §11.2)。
    void detectAgentsMutation.run()
  }, [])

  const rows = useMemo(() => data ?? [], [data])
  const installedCount = rows.filter((row) => row.detect?.installed).length

  const sections = useMemo<RailSection[]>(
    () =>
      SOURCE_ORDER.map((source) => ({
        id: source,
        label: t(SOURCE_KEY[source]),
        items: rows
          .filter((row) => sourceOf(row) === source && matches(row, query))
          .map((row): RailItem => {
            const facts = [installFactOf(t, row)]
            if (!row.config.enabled) facts.push(t('agents.disabled'))
            const detail = facts.join(' · ')
            const label = nameOf(row)
            return {
              id: row.config.id,
              label,
              detail,
              detailBad: row.status === 'error',
              spoken: `${label} · ${detail}`,
              glyph: (className) => (
                <ProviderGlyph
                  className={className}
                  familyId={row.manifest?.icon ?? row.config.id}
                  label={label}
                  custom={sourceOf(row) === 'user'}
                />
              ),
              status: (
                <span className={s.dots}>
                  <StatusDot tone={installToneOf(row)} />
                  {/* 登录态归 A3-c(握手 `authMethods` + 上次 `auth_required`);今天一律「不知道」。 */}
                  <StatusDot tone="idle" />
                </span>
              ),
            }
          }),
      })),
    [rows, query, t],
  )

  // 选中:点过的那一台还在就是它;否则第一台(被删了 / 首次打开)。
  const selectedId =
    picked === NEW_AGENT || (picked !== null && rows.some((row) => row.config.id === picked))
      ? picked
      : (rows[0]?.config.id ?? null)
  const selected = rows.find((row) => row.config.id === selectedId)

  if (data === undefined) {
    return (
      <div className={s.panel} data-testid="agents-panel">
        {error === undefined ? (
          <p className={s.state}>{t('agents.loading')}</p>
        ) : (
          <div className={s.state}>
            <span>{t('agents.loadFailed')}</span>
            <Button onClick={() => void acpAgentsQuery.refetch()}>{t('agents.retry')}</Button>
          </div>
        )}
      </div>
    )
  }

  const actionError = detectSnap.error ?? registrySnap.error
  const checkedAt = Math.max(0, ...rows.map((row) => row.detect?.checkedAt ?? 0))

  return (
    <div className={s.panel} data-testid="agents-panel">
      <Rail
        title={t('agents.railTitle')}
        aside={t('agents.railCount', { count: installedCount })}
        sections={sections}
        emptyText={rows.length === 0 ? t('agents.emptyTitle') : t('agents.railEmpty')}
        selectedId={selectedId}
        onSelect={setPicked}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: t('agents.search'),
          expandLabel: t('agents.railExpand'),
          collapseLabel: t('agents.railCollapse'),
        }}
        add={{ label: t('agents.addCustom'), onClick: () => setPicked(NEW_AGENT) }}
        testIdPrefix="agent"
      />
      <div className={s.detail}>
        <div className={s.toolbar}>
          <span className={`${s.toolbarNote} ${actionError ? s.toolbarNoteBad : ''}`}>
            {actionError
              ? t('agents.actionFailed', { error: actionError })
              : checkedAt > 0
                ? t('agents.checkedAt', {
                    time: new Date(checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                  })
                : ''}
          </span>
          <AsyncButton
            size="sm"
            action={detectAgentsMutation}
            pendingLabel={t('agents.detecting')}
            disabled={registrySnap.pending}
            onClick={() => void detectAgentsMutation.run()}
            data-testid="agents-detect"
          >
            {t('agents.detect')}
          </AsyncButton>
          <AsyncButton
            size="sm"
            action={refreshRegistryMutation}
            pendingLabel={t('agents.refreshing')}
            disabled={detectSnap.pending}
            onClick={() => void refreshRegistryMutation.run()}
            data-testid="agents-refresh-registry"
          >
            {t('agents.refreshRegistry')}
          </AsyncButton>
        </div>
        {selectedId === NEW_AGENT ? (
          <AddAgentForm
            t={t}
            taken={rows.map((row) => row.config.id)}
            onDone={(id) => setPicked(id)}
            onCancel={() => setPicked(null)}
          />
        ) : selected ? (
          // key = agent id:换一台 = 高级区的草稿、复制那一格的名字一并归零,不串到下一台上。
          <AgentDetail key={selected.config.id} t={t} state={selected} rows={rows} onPick={setPicked} />
        ) : rows.length === 0 ? (
          <div className={s.empty}>
            <p className={s.emptyTitle}>{t('agents.emptyTitle')}</p>
            <p className={shared.sectionNote}>{t('agents.emptyHint')}</p>
          </div>
        ) : (
          <p className={s.state}>{t('agents.pickOne')}</p>
        )}
      </div>
    </div>
  )
}

function AgentDetail({
  t,
  state,
  rows,
  onPick,
}: {
  t: TFn
  state: ACPAgentState
  rows: readonly ACPAgentState[]
  onPick: (id: string | null) => void
}) {
  const id = state.config.id
  const source = sourceOf(state)
  const manifest = state.manifest
  const enabling = useAsyncPending(updateAgentMutation, updatePendingKey(id, 'enabled'))
  const confirm = useConfirm()
  const detect = state.detect

  const remove = async () => {
    const ok = await confirm({
      title: t('agents.removeConfirmTitle', { name: nameOf(state) }),
      description: t('agents.removeConfirmBody'),
      confirmLabel: t('agents.remove'),
    })
    if (!ok) return
    onPick(null)
    await removeAgentMutation.run(id)
  }

  return (
    <div className={shared.form} data-testid={`agent-detail-${id}`}>
      <div className={s.head}>
        <ProviderGlyph size="md" familyId={manifest?.icon ?? id} label={nameOf(state)} custom={source === 'user'} />
        <div className={s.headText}>
          <div className={s.headLine}>
            <h3 className={s.name}>{nameOf(state)}</h3>
            <span className={s.tag} data-testid="agent-source">
              {t(SOURCE_KEY[source])}
            </span>
            {manifest?.experimental && <span className={s.tag}>{t('agents.experimental')}</span>}
          </div>
          {manifest?.description && <p className={s.desc}>{manifest.description}</p>}
        </div>
      </div>

      <section className={shared.section}>
        <div className={shared.settingRow}>
          <span className={shared.settingRowLabel}>{t('agents.labelInstall')}</span>
          <span className={s.value} data-testid="agent-install-state" data-installed={detect?.installed ? 'true' : 'false'}>
            {detect?.installed && detect.path ? (
              <Tooltip content={t('agents.pathTip', { path: detect.path })}>
                <span className={s.valueText}>{installFactOf(t, state)}</span>
              </Tooltip>
            ) : (
              <span className={s.valueText}>{installFactOf(t, state)}</span>
            )}
            {!detect?.installed && manifest?.install?.npm && (
              <AsyncButton
                size="sm"
                action={installAgentMutation}
                pendingLabel={t('agents.installing')}
                onClick={() => void installAgentMutation.run(manifest.install!.npm!)}
                data-testid="agent-install"
              >
                {t('agents.install')}
              </AsyncButton>
            )}
          </span>
        </div>
        {!detect?.installed && manifest?.install?.npm && (
          <p className={shared.settingRowNote}>{t('agents.installNote', { command: `npm i -g ${manifest.install.npm}` })}</p>
        )}
        {!detect?.installed && !manifest?.install?.npm && manifest?.install?.hint && (
          <p className={shared.settingRowNote}>{t('agents.installHint', { hint: manifest.install.hint })}</p>
        )}
        <div className={shared.settingRow}>
          <span className={shared.settingRowLabel}>{t('agents.labelProcess')}</span>
          <span className={`${s.valueText} ${state.status === 'error' ? s.valueBad : ''}`}>
            {processFactOf(t, state)}
          </span>
        </div>
        <div className={shared.settingRow}>
          <span className={shared.settingRowLabel}>{t('agents.enable')}</span>
          <Switch
            checked={state.config.enabled}
            disabled={enabling}
            label={t('agents.enable')}
            onChange={(enabled) => void updateAgentMutation.run({ state, patch: { enabled } })}
          />
        </div>
        <p className={shared.settingRowNote}>{t('agents.enableHint')}</p>
      </section>

      {/* A3-d:「登录」一节落在这里(状态行「已登录 / 未登录」+「去登录」钮,§3.9 ②)。 */}
      {/* A2-c:「缺省选项」一节落在这里(`AgentOptionsCard` 同一个组件画 agent 自报的选项,§3.9 ③)。 */}
      {/* A3:「权限」一节落在这里(「无人值守时自动放行」开关 + 「查看已授权」链接,§3.9 ④)。 */}
      {/* A4:「工具」一节落在这里(宿主工具面 / 转发 MCP 两个开关,§3.9 ⑤)。 */}

      <AdvancedSection t={t} state={state} />

      <section className={shared.section}>
        {source === 'user' ? (
          <div className={s.actions}>
            <Button onClick={() => void remove()} data-testid="agent-remove">
              {t('agents.remove')}
            </Button>
          </div>
        ) : (
          <DuplicateRow t={t} state={state} rows={rows} onPick={onPick} />
        )}
      </section>
    </div>
  )
}

/** 高级区的草稿:改的时候只动本地这一份,「保存」才发出去。 */
interface AdvancedDraft {
  command: string
  args: string
  env: Array<{ key: string; value: string }>
  promptTimeout: string
  idleTimeout: string
  connectTimeout: string
}

function secondsOf(ms: number | undefined): string {
  return ms === undefined ? '' : String(Math.round(ms / 1000))
}

function msOf(seconds: string): number | undefined {
  const n = Number(seconds.trim())
  return seconds.trim() === '' || !Number.isFinite(n) || n <= 0 ? undefined : Math.round(n * 1000)
}

function draftOf(config: ACPAgentConfig): AdvancedDraft {
  return {
    command: config.command ?? '',
    args: argsToLine(config.args),
    env: Object.entries(config.env ?? {}).map(([key, value]) => ({ key, value })),
    promptTimeout: secondsOf(config.promptTimeoutMs),
    idleTimeout: secondsOf(config.idleTimeoutMs),
    connectTimeout: secondsOf(config.connectTimeoutMs),
  }
}

function patchOf(draft: AdvancedDraft): Partial<ACPAgentConfig> {
  const env: Record<string, string> = {}
  for (const row of draft.env) if (row.key.trim()) env[row.key.trim()] = row.value
  return {
    command: draft.command.trim(),
    args: argsFromLine(draft.args),
    env,
    promptTimeoutMs: msOf(draft.promptTimeout),
    idleTimeoutMs: msOf(draft.idleTimeout),
    connectTimeoutMs: msOf(draft.connectTimeout),
  }
}

function AdvancedSection({ t, state }: { t: TFn; state: ACPAgentState }) {
  const home = useHomeDir()
  const source = sourceOf(state)
  const pristine = useMemo(() => draftOf(state.config), [state.config])
  const [draft, setDraft] = useState<AdvancedDraft | null>(null)
  const [open, setOpen] = useState(false)
  const current = draft ?? pristine
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(pristine)
  // 种子 / 注册表那一台的命令可以留空(起法来自它的自述);自定义那一台没命令起不来。
  const commandMissing = source === 'user' && current.command.trim() === ''
  const edit = (patch: Partial<AdvancedDraft>) => setDraft({ ...current, ...patch })
  const setEnv = (index: number, patch: Partial<{ key: string; value: string }>) =>
    edit({ env: current.env.map((row, i) => (i === index ? { ...row, ...patch } : row)) })

  const save = async () => {
    await updateAgentMutation.run({ state, patch: patchOf(current) })
    if (!updateAgentMutation.get().error) setDraft(null)
  }

  return (
    <section className={shared.section}>
      {/* 缺省收着:绝大多数人一辈子不用碰这几格(§3.9 ①)。收起不卸载(`FoldBody` 只藏),
          草稿因此在开合之间留着。 */}
      <Fold open={open} onOpenChange={setOpen}>
        <FoldTrigger className={s.foldHead} data-testid="agent-advanced">
          {open ? <ChevronDown className={s.foldIcon} aria-hidden="true" /> : <ChevronRight className={s.foldIcon} aria-hidden="true" />}
          <span className={s.foldLabel}>{t('agents.advanced')}</span>
        </FoldTrigger>
        <FoldBody className={s.advanced}>
          <p className={shared.sectionNote}>{t('agents.advancedHint')}</p>
          <Field label={t('agents.command')} size="sm" error={commandMissing ? t('agents.commandRequired') : undefined}>
            <Input
              size="sm"
              value={current.command}
              onValueChange={(command) => edit({ command })}
              invalid={commandMissing}
              placeholder={state.manifest?.launch?.command}
            />
          </Field>
          <Field label={t('agents.args')} size="sm" hint={t('agents.argsHint')}>
            <Input size="sm" value={current.args} onValueChange={(args) => edit({ args })} />
          </Field>

          <div className={s.group}>
            <span className={shared.settingRowLabel}>{t('agents.env')}</span>
            {current.env.map((row, index) => (
              // 行没有稳定身份(键名本身就在被编辑),下标是这张小表唯一诚实的 key。
              <div key={index} className={s.envRow}>
                <Input
                  size="sm"
                  value={row.key}
                  onValueChange={(key) => setEnv(index, { key })}
                  placeholder={t('agents.envKey')}
                  aria-label={t('agents.envKey')}
                />
                <Input
                  size="sm"
                  value={row.value}
                  onValueChange={(value) => setEnv(index, { value })}
                  placeholder={t('agents.envValue')}
                  aria-label={t('agents.envValue')}
                />
                {/* 锁那一格永远占位(空着也占),四列对齐不随键名跳。 */}
                <span className={s.lockSlot}>
                  {SECRET_KEY_PATTERN.test(row.key) && (
                    <Tooltip content={t('agents.envSecret')}>
                      <span className={s.lock} role="img" aria-label={t('agents.envSecret')} data-testid="agent-env-secret">
                        <Lock className={s.lockIcon} aria-hidden="true" />
                      </span>
                    </Tooltip>
                  )}
                </span>
                <IconButton
                  icon={X}
                  label={t('agents.envRemove')}
                  onClick={() => edit({ env: current.env.filter((_, i) => i !== index) })}
                />
              </div>
            ))}
            <div className={s.actions}>
              <Button size="sm" onClick={() => edit({ env: [...current.env, { key: '', value: '' }] })}>
                {t('agents.envAdd')}
              </Button>
            </div>
          </div>

          <div className={s.group}>
            <span className={shared.settingRowLabel}>{t('agents.timeouts')}</span>
            <div className={s.timeouts}>
              <Field label={t('agents.promptTimeout')} size="sm">
                <Input
                  size="sm"
                  inputMode="numeric"
                  value={current.promptTimeout}
                  onValueChange={(promptTimeout) => edit({ promptTimeout })}
                  placeholder={t('agents.timeoutDefault')}
                />
              </Field>
              <Field label={t('agents.idleTimeout')} size="sm">
                <Input
                  size="sm"
                  inputMode="numeric"
                  value={current.idleTimeout}
                  onValueChange={(idleTimeout) => edit({ idleTimeout })}
                  placeholder={t('agents.timeoutDefault')}
                />
              </Field>
              <Field label={t('agents.connectTimeout')} size="sm">
                <Input
                  size="sm"
                  inputMode="numeric"
                  value={current.connectTimeout}
                  onValueChange={(connectTimeout) => edit({ connectTimeout })}
                  placeholder={t('agents.timeoutDefault')}
                />
              </Field>
            </div>
          </div>

          {/*
            它自己的配置目录(§3.9 ⑥)。**只画路径,不画「打开」钮**:这台壳里能定位一条路径的
            只有 `dir:` 的 `reveal`,它判的是读根(写根 ∪ 接入目录 ∪ 笔记根 ∪ 下载目录),
            `~/.claude` 这类目录在界外,按下去只会得到一句越界拒绝;`shell` 域没有定位那一口,
            React 壳的 `shell` 宿主口也是 null。与其给一颗注定失败的钮,不如把路径摆出来。
          */}
          {(state.manifest?.configPaths?.length ?? 0) > 0 && (
            <div className={s.group}>
              <span className={shared.settingRowLabel}>{t('agents.configPaths')}</span>
              {state.manifest!.configPaths!.map((path) => (
                <span key={path} className={s.path} data-testid="agent-config-path">
                  <PathText path={path} home={home} dir />
                </span>
              ))}
              <p className={shared.sectionNote}>{t('agents.configPathsHint')}</p>
            </div>
          )}

          <div className={s.actions}>
            <AsyncButton
              size="sm"
              variant="primary"
              action={updateAgentMutation}
              pendingKey={updatePendingKey(state.config.id, 'advanced')}
              pendingLabel={t('agents.saving')}
              disabled={!dirty || commandMissing}
              onClick={() => void save()}
              data-testid="agent-advanced-save"
            >
              {t('agents.save')}
            </AsyncButton>
            <Button size="sm" disabled={!dirty} onClick={() => setDraft(null)}>
              {t('agents.revert')}
            </Button>
          </div>
        </FoldBody>
      </Fold>
    </section>
  )
}

function DuplicateRow({
  t,
  state,
  rows,
  onPick,
}: {
  t: TFn
  state: ACPAgentState
  rows: readonly ACPAgentState[]
  onPick: (id: string | null) => void
}) {
  const [name, setName] = useState<string | null>(null)
  const adding = useAsyncPending(addAgentMutation)

  if (name === null) {
    return (
      <div className={s.actions}>
        <Button onClick={() => setName(t('agents.duplicateDefault', { name: nameOf(state) }))} data-testid="agent-duplicate">
          {t('agents.duplicate')}
        </Button>
      </div>
    )
  }

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    const id = agentIdFromName(
      trimmed,
      rows.map((row) => row.config.id),
    )
    await addAgentMutation.run({ id, name: trimmed, basedOn: state.config.id } as ACPAgentConfig)
    if (!addAgentMutation.get().error) onPick(id)
  }

  return (
    <div className={s.inlineForm}>
      <Field label={t('agents.duplicateName')} size="sm">
        <Input size="sm" value={name} onValueChange={setName} />
      </Field>
      <div className={s.actions}>
        <AsyncButton
          size="sm"
          variant="primary"
          action={addAgentMutation}
          pendingLabel={t('agents.adding')}
          disabled={adding || !name.trim()}
          onClick={() => void submit()}
        >
          {t('agents.duplicateConfirm')}
        </AsyncButton>
        <Button size="sm" onClick={() => setName(null)}>
          {t('agents.cancel')}
        </Button>
      </div>
    </div>
  )
}

function AddAgentForm({
  t,
  taken,
  onDone,
  onCancel,
}: {
  t: TFn
  taken: readonly string[]
  onDone: (id: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [tried, setTried] = useState(false)
  const missing = command.trim() === ''

  const submit = async () => {
    setTried(true)
    if (missing) return
    const label = name.trim() || command.trim()
    const id = agentIdFromName(label, taken)
    await addAgentMutation.run({
      id,
      name: label,
      enabled: true,
      command: command.trim(),
      args: argsFromLine(args),
    })
    if (!addAgentMutation.get().error) onDone(id)
  }

  return (
    <div className={shared.form} data-testid="agent-add-form">
      <section className={shared.section}>
        <h3 className={shared.sectionTitle}>{t('agents.addCustom')}</h3>
        <p className={shared.sectionNote}>{t('agents.addHint')}</p>
        <Field label={t('agents.name')} size="sm">
          <Input size="sm" value={name} onValueChange={setName} placeholder={t('agents.namePlaceholder')} />
        </Field>
        <Field label={t('agents.command')} size="sm" error={tried && missing ? t('agents.commandRequired') : undefined}>
          <Input size="sm" value={command} onValueChange={setCommand} invalid={tried && missing} placeholder="my-agent" />
        </Field>
        <Field label={t('agents.args')} size="sm" hint={t('agents.argsHint')}>
          <Input size="sm" value={args} onValueChange={setArgs} placeholder="--acp" />
        </Field>
        <div className={s.actions}>
          <AsyncButton
            size="sm"
            variant="primary"
            action={addAgentMutation}
            pendingLabel={t('agents.adding')}
            onClick={() => void submit()}
            data-testid="agent-add-submit"
          >
            {t('agents.add')}
          </AsyncButton>
          <Button size="sm" onClick={onCancel}>
            {t('agents.cancel')}
          </Button>
        </div>
      </section>
    </div>
  )
}

/*
 * 模块级副作用:`installAgentMutation` 那一格快照(忙态 / 错)。寿命是这个模块实例,
 * 退役复用它自己的 `reset()`。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    installAgentMutation.reset()
  })
}
