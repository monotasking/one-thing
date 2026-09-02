import { useEffect, useState } from 'react'
import { AsyncButton } from '../../ui/AsyncButton'
import { Card } from '../../ui/Card'
import { Field, useFieldControlProps } from '../../ui/Field'
import { Input } from '../../ui/Input'
import { Select } from '../../ui/Select'
import { useInlineEdit } from '../../ui/inline-edit'
import { useT } from '../../i18n'
import { providerDialsOf, regionRowApplies, storedDialsOf } from '../dials'
import type { ProviderDialField } from '../dials'
import { settingsKey, settingsMutation } from '../store'
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
  /**
   * **计费档位**此刻在写吗(`dials:` 那一格)。档位是这张卡上唯一走设置写路的东西,
   * 所以它只收这一格 —— 从前收的是整面共享的 `saving`,勾一个模型也会把档位禁灰。
   */
  dialsPending: boolean

  pool: PoolView
  poolBusy: boolean
  poolError?: string
  onAddKey: (apiKey: string, label: string) => void
  onReplaceKey: (entryId: string, apiKey: string) => void
  /** 只改这一条的备注名(原地,与密钥那一格互斥)。 */
  onRelabelKey: (entryId: string, label: string) => void
  onRemoveKey: (entryId: string) => void
  onMoveKey: (entryId: string, delta: -1 | 1) => void
  onRotation: (policy: string) => void
  onDials: (apiMode: string, region: string) => void
  /** 手改端点。空串 = 回落缺省(自定义家由这一格自己挡住空值)。 */
  onBaseUrl: (baseUrl: string) => void

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
          onRelabel={props.onRelabelKey}
          onRemove={props.onRemoveKey}
          onMove={props.onMoveKey}
          onRotation={props.onRotation}
        />
        <DialsCard
          providerId={mode.providerId}
          config={props.config}
          pending={props.dialsPending}
          onDials={props.onDials}
        />
        <Card>
          <BaseUrlRow
            providerId={mode.providerId}
            custom={mode.kind === 'custom'}
            stored={props.config?.baseUrl ?? ''}
            fallback={mode.defaultBaseUrl}
            onSave={props.onBaseUrl}
          />
          {mode.kind === 'custom' && <p className={s.note}>{t('providers.customIntro')}</p>}
        </Card>
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
    <Card>
      <p className={s.note}>{t('providers.localIntro')}</p>
    </Card>
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
  pending,
  onDials,
}: {
  providerId: string
  config: ProviderConfig | undefined
  /** 这一坑的档位此刻在写吗。 */
  pending: boolean
  onDials: (apiMode: string, region: string) => void
}) {
  const spec = providerDialsOf(providerId)
  if (!spec) return null
  const stored = storedDialsOf(spec, config as unknown as Record<string, unknown> | undefined)
  const regionApplies = regionRowApplies(spec, stored.apiMode)

  return (
    <Card>
      <DialRow
        field={spec.apiMode}
        value={stored.apiMode}
        disabled={pending}
        onChange={(next) => onDials(next, stored.region)}
      />
      {spec.region && regionApplies && (
        <DialRow
          field={spec.region}
          value={stored.region}
          disabled={pending}
          onChange={(next) => onDials(stored.apiMode, next)}
        />
      )}
      {/* 风险说明。说的是**选错的代价**,不是功能介绍。 */}
      {spec.note && <p className={s.risk}>{spec.note}</p>}
    </Card>
  )
}

/**
 * **Base URL 那一格**(09-02 批 11,用户报障「baseurl 无法修改或者说很难找到改的地方」)。
 *
 * 从前这里是一行只读小字,理由写的是「技术参数,弱化处理」。弱化没错,**只读**错了 ——
 * 本机 Ollama / 代理 / 私有网关都要改它,而全壳唯一能改的地方只有自定义家的那个对话框。
 * 现在它是一格真字段:有标签、有缺省、有一颗保存钮 —— 仍然弱化(inline 档 + micro 附注),
 * 但一眼找得到。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * ① 生命周期:草稿由 `stored` **播种一次**,`providerId` / `stored` 一变就重播
 *    (换坑不能把 A 家的地址带到 B 家;后端认下新值之后草稿也要跟上,否则
 *    「改了没有」的读数会一直亮着)。无订阅、无计时器 → 不需要 dispose。
 *    落点只有一种:详情列里的一张 `ui/Card`。
 * ② UI 生命状态:empty = 没存过(占位符显示缺省地址,附注写着「(默认)」);
 *    ready = 存过;error = 自定义家清空了这一格(那一形没有缺省可回);
 *    loading / 超量对一格 URL 不存在。
 * ③ UI 交互状态:输入框 rest/hover/focus 归 `ui/Input`;保存钮**没改过就禁**
 *    (不是「点了没反应」),忙态由 `ui/AsyncButton` 读 `settingsMutation`
 *    的 `baseUrl:<id>` 那一格 —— 与档位那颗是两格,互不禁(律③的粒度)。
 *
 * ── 手改与计费档位的关系:**档位永远赢**,并且当面说清 ────────────────────
 * 千问 / Kimi / 智谱三家的地址是**档位算出来的**(`dials.ts` 的 `baseUrlOf`),
 * 拨一次档位就连地址一起写。这一批**没有**改成「手改过就不覆盖」,理由是钱:
 * `dials.ts` 文件头那句原话 —— 只写档位不写地址,请求还是发去旧地址,
 * 那正是「以为选对了、其实还在扣钱」。让一个手打的旧地址在切档之后活下来,
 * 等于把那颗雷原样装回去。所以行为不变,改的是**知情**:这三家的附注里
 * 明写「再拨一次档位会覆盖它」。
 */
function BaseUrlRow({
  providerId,
  custom,
  stored,
  fallback,
  onSave,
}: {
  providerId: string
  custom: boolean
  /** 这个空间此刻存着的那个(空串 = 没存过 = 用缺省)。 */
  stored: string
  /** 名册给的缺省。自定义家没有缺省 —— 那一格就是它自己。 */
  fallback: string
  onSave: (baseUrl: string) => void
}) {
  const t = useT()
  const [draft, setDraft] = useState(stored)
  // 播种:换坑、或后端认下新值,草稿都要跟着走(理由见文件头 ①)。
  useEffect(() => {
    setDraft(stored)
  }, [providerId, stored])

  const trimmed = draft.trim()
  const empty = custom && !trimmed
  const dirty = trimmed !== stored.trim()

  const parts: string[] = []
  if (custom) {
    parts.push(t('providers.customBaseUrlHint'))
  } else {
    if (!stored) parts.push(t('providers.baseUrlDefault'))
    if (fallback) parts.push(t('providers.baseUrlDefaultIs', { url: fallback }))
    if (providerDialsOf(providerId)) parts.push(t('providers.baseUrlDialOwned'))
  }

  return (
    <Field
      layout="inline"
      label={t('providers.baseUrl')}
      hint={parts.length ? parts.join(' ') : undefined}
      error={empty ? t('providers.customBaseUrlRequired') : undefined}
    >
      <BaseUrlInput
        value={draft}
        placeholder={fallback}
        invalid={empty}
        onChange={setDraft}
        onCommit={() => {
          if (dirty && !empty) onSave(trimmed)
        }}
        onCancel={() => setDraft(stored)}
      />
      {/* 钮上写「保存」,**读屏软件听到的是「保存 Base URL」** —— 同一块面上
          还有密钥池那颗「保存」,只念两个字的话它们在读屏里是同一颗钮。
          可见文字仍是那句话的一部分(WCAG「名字里要含可见文字」)。 */}
      <AsyncButton
        size="sm"
        action={settingsMutation}
        pendingKey={settingsKey.baseUrl(providerId)}
        pendingLabel={t('common.saving')}
        aria-label={t('providers.baseUrlSave')}
        disabled={!dirty || empty}
        onClick={() => onSave(trimmed)}
      >
        {t('providers.keySave')}
      </AsyncButton>
    </Field>
  )
}

/**
 * 输入框那一件。**单独一件是因为 hook 只能在组件里调**:`useFieldControlProps()`
 * 要在 `<Field>` 的 context 之内才拿得到 id 与 aria 关联(与 `CredentialPool.KeyInput`
 * / `WorkspaceOverview.RenameInput` 同一条理由)。
 *
 * ↵ / Esc 走 `ui/inline-edit` —— 同一组手势只许有一个产地。**两格与密钥行不同**,
 * 各有理由:
 *  · **不给 `controlId`** = 不自动聚焦。那件的自动聚焦是给「刚长出来的那一格」的;
 *    这一格是常驻的,开个面就把焦点抢到一个 URL 框上是骚扰。
 *  · **不开 `cancelOnBlur`**。这一格旁边站着一颗保存钮,而 `blur` 在 `click`
 *    之前到 —— 打开它等于让那颗钮永远点不到(判据全文在 inline-edit 文件头)。
 * 留下的正是这一格要的两条:↵ 存下、Esc 打回原样。
 */
function BaseUrlInput({
  value,
  placeholder,
  invalid,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string
  placeholder: string
  invalid: boolean
  onChange: (v: string) => void
  onCommit: () => void
  onCancel: () => void
}) {
  const field = useFieldControlProps()
  const edit = useInlineEdit({ onCommit, onCancel })
  return (
    <Input
      {...field}
      {...edit}
      size="sm"
      className={s.baseUrlInput}
      value={value}
      invalid={invalid}
      placeholder={placeholder}
      onValueChange={onChange}
      spellCheck={false}
      autoComplete="off"
    />
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
