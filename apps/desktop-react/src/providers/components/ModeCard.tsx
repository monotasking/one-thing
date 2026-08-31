import { Select } from '../../ui/Select'
import { useT } from '../../i18n'
import { providerDialsOf, regionRowApplies, storedDialsOf } from '../dials'
import type { ProviderDialField } from '../dials'
import { CredentialPool } from './CredentialPool'
import { OAuthCard } from './OAuthCard'
import { UsageCard } from './UsageCard'
import type { PoolView } from '../projection'
import type { AuthFlowState } from '../auth'
import type { ProviderMode } from '../types'
import type { OAuthStatusResponse } from '@shared/ipc/oauth'
import type { ProviderConfig, ProviderUsageResponse } from '@shared/ipc/providers'
import type { SourceStatus } from '../store'
import s from './ModeCard.module.css'

/**
 * 一坑一张卡。**四种坑各说各的话** —— 不合并成一句「这里配一下」。
 *
 *   api          密钥池(多钥 / 顺序 / 轮换)+ 计费档位 + Base URL
 *   subscription 登录卡(三种流)+ 订阅用量(只有后端真给数的那家才画)
 *   localCli/acp 本机进程,零凭证
 *   custom       用户自建端点(改它走头上那颗「编辑」)
 *
 * 计费档位只有三家有(千问 / Kimi / 智谱),判据是 `providerDialsOf` 返回不返回
 * null —— **不是**在这里写一串 `providerId === 'qwen' || …`。
 */

export function ModeCard(props: {
  mode: ProviderMode
  config: ProviderConfig | undefined
  saving: boolean

  pool: PoolView
  poolBusy: boolean
  poolError?: string
  onAddKey: (apiKey: string, label: string) => void
  onReplaceKey: (entryId: string, apiKey: string) => void
  onRemoveKey: (entryId: string) => void
  onMoveKey: (entryId: string, delta: -1 | 1) => void
  onRotation: (policy: string) => void
  onDials: (apiMode: string, region: string) => void

  authStatus: OAuthStatusResponse | undefined
  authFlow: AuthFlowState
  onSignIn: () => void
  onAuthCode: (code: string) => void
  onSubmitAuthCode: () => void
  onCancelAuth: () => void
  onSignOut: () => void

  usage: ProviderUsageResponse | null | undefined
  usageStatus: SourceStatus
  usageError?: string
  onRefreshUsage: () => void
}) {
  const t = useT()
  const { mode } = props

  if (mode.kind === 'api' || mode.kind === 'custom') {
    return (
      <>
        <CredentialPool
          providerId={mode.providerId}
          pool={props.pool}
          busy={props.poolBusy}
          error={props.poolError}
          onAdd={props.onAddKey}
          onReplace={props.onReplaceKey}
          onRemove={props.onRemoveKey}
          onMove={props.onMoveKey}
          onRotation={props.onRotation}
        />
        <DialsCard
          providerId={mode.providerId}
          config={props.config}
          saving={props.saving}
          onDials={props.onDials}
        />
        <section className={s.card}>
          {/* Base URL 是技术参数,弱化处理 —— 一行小字,不是一个大输入框。 */}
          <p className={s.note}>
            {t('providers.baseUrl')}{' '}
            <span className={s.mono}>{props.config?.baseUrl || mode.defaultBaseUrl}</span>
            {props.config?.baseUrl ? '' : ` ${t('providers.baseUrlDefault')}`}
          </p>
          {mode.kind === 'custom' && <p className={s.note}>{t('providers.customIntro')}</p>}
        </section>
      </>
    )
  }

  if (mode.kind === 'subscription') {
    return (
      <>
        <OAuthCard
          status={props.authStatus}
          flow={props.authFlow}
          accounts={props.pool.rows.filter((row) => row.authType === 'oauth').length}
          onSignIn={props.onSignIn}
          onCode={props.onAuthCode}
          onSubmitCode={props.onSubmitAuthCode}
          onCancel={props.onCancelAuth}
          onSignOut={props.onSignOut}
        />
        {/*
          用量卡:`usage === null` = **后端说这家没有用量**(unsupported),
          那时整块不画。`undefined` = 还没问过。两者都不画一张空卡。
        */}
        {props.usage && (
          <UsageCard
            usage={props.usage}
            status={props.usageStatus}
            error={props.usageError}
            onRefresh={props.onRefreshUsage}
          />
        )}
      </>
    )
  }

  return (
    <section className={s.card}>
      <p className={s.note}>{t('providers.localIntro')}</p>
    </section>
  )
}

/**
 * 计费档位。**选错会真扣钱**,所以这张卡上的每一句话都是从生产那张表逐字搬来的
 * (理由与表本身写在 `providers/dials.ts` 文件头)。
 *
 * 地区那一行会**整行收起**(Kimi 的编程套餐只有一个全球地址)——
 * 留一个拨了不动的选择器,比不画更让人怀疑自己是不是拨错了。
 */
function DialsCard({
  providerId,
  config,
  saving,
  onDials,
}: {
  providerId: string
  config: ProviderConfig | undefined
  saving: boolean
  onDials: (apiMode: string, region: string) => void
}) {
  const spec = providerDialsOf(providerId)
  if (!spec) return null
  const stored = storedDialsOf(spec, config as unknown as Record<string, unknown> | undefined)
  const regionApplies = regionRowApplies(spec, stored.apiMode)

  return (
    <section className={s.card}>
      <DialRow
        field={spec.apiMode}
        value={stored.apiMode}
        disabled={saving}
        onChange={(next) => onDials(next, stored.region)}
      />
      {spec.region && regionApplies && (
        <DialRow
          field={spec.region}
          value={stored.region}
          disabled={saving}
          onChange={(next) => onDials(stored.apiMode, next)}
        />
      )}
      {/* 风险说明。说的是**选错的代价**,不是功能介绍。 */}
      {spec.note && <p className={s.risk}>{spec.note}</p>}
    </section>
  )
}

function DialRow({
  field,
  value,
  disabled,
  onChange,
}: {
  field: ProviderDialField
  value: string
  disabled: boolean
  onChange: (next: string) => void
}) {
  return (
    <div className={s.dialRow}>
      <span className={s.dialLabel}>{field.label}</span>
      <Select
        size="sm"
        value={value}
        onChange={onChange}
        disabled={disabled}
        label={field.ariaLabel}
        options={field.options}
      />
    </div>
  )
}
