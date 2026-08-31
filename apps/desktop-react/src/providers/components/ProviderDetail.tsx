import { useEffect, useState } from 'react'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Input'
import { Segmented } from '../../ui/Segmented'
import { Spinner } from '../../ui/Spinner'
import { Switch } from '../../ui/Switch'
import { useT } from '../../i18n'
import type { TFn } from '../../i18n'
import { initialOf } from '../projection'
import type { CredentialFacts, ModeTab, ProviderFamilyView, ProviderMode } from '../types'
import type { KeySaveStatus } from '../store'
import s from './ProviderDetail.module.css'

/**
 * 右面 = 一家的详情:头(图标 / 名 / 副语 / 启用开关)+ 模式分段器 + 模式内容区。
 *
 * **一家的启用是一个开关,不是每坑一个**:家族一开全开(与 Vue 壳
 * `ConnectionsSection.toggleCardEnabled` 同一条语义)。所以开关画在头上,
 * 而不是画在每一坑里 —— 画在坑里就等于宣布它们可以各开各的。
 *
 * 模式分段器只在**真有两坑**时出现。一坑的家画一个只有一格的分段器是噪音:
 * 那一格点了也不会变。
 */

export function ProviderDetail({
  family,
  mode,
  tabs,
  enabled,
  saving,
  credentials,
  keyStatus,
  onToggleEnabled,
  onSelectMode,
  onSaveKey,
  children,
}: {
  family: ProviderFamilyView
  mode: ProviderMode
  tabs: readonly ModeTab[]
  enabled: boolean
  saving: boolean
  credentials: CredentialFacts
  keyStatus: KeySaveStatus
  onToggleEnabled: (next: boolean) => void
  onSelectMode: (providerId: string) => void
  onSaveKey: (apiKey: string) => void
  /** 模型目录。由上面递进来 —— 详情不该知道目录是怎么拉的。 */
  children?: React.ReactNode
}) {
  const t = useT()

  return (
    /*
     * 头这一行**不用 `<header>`**,这一格是真机门抓出来的:`<header>` 的隐含角色是
     * banner,而整页只该有一个 banner(那是顶栏的),axe 的
     * landmark-no-duplicate-banner 当场红。套一层无名 `<section>` 也救不回来 ——
     * 无名的 section 角色是 generic,axe 判祖先看的是**角色**不是标签名,
     * 所以那一层挡不住(真机上试过一轮,读数记在这里免得下一个人再试一遍)。
     * 层级由 `<h2>` 给,分量由 CSS 给 —— 这一行本来也不需要是个地标。
     */
    <div className={s.detail}>
      <div className={s.head}>
        <span className={`${s.icon} ${family.custom ? s.iconCustom : ''}`} aria-hidden="true">
          {initialOf(family.label)}
        </span>
        <div className={s.headText}>
          <h2 className={s.name}>{family.label}</h2>
          {family.description && <p className={s.desc}>{family.description}</p>}
        </div>
        <div className={s.enable}>
          <span className={s.enableLabel}>{t('providers.enable')}</span>
          <Switch
            checked={enabled}
            onChange={onToggleEnabled}
            disabled={saving}
            label={t('providers.enableFamily', { name: family.label })}
          />
        </div>
      </div>

      {tabs.length > 1 && (
        <div className={s.modes}>
          <Segmented
            options={tabs.map((tab) => ({
              value: tab.providerId,
              label: `${t(tab.label.key, tab.label.vars)} · ${t(tab.state.key, tab.state.vars)}`,
            }))}
            value={mode.providerId}
            onChange={onSelectMode}
            label={t('providers.modeLabel')}
          />
        </div>
      )}

      <div className={s.body}>
        <ModeCard
          t={t}
          mode={mode}
          credentials={credentials}
          keyStatus={keyStatus}
          onSaveKey={onSaveKey}
        />
        {children}
      </div>
    </div>
  )
}

/** 一坑一张卡。四种坑各说各的话 —— 不合并成一句「这里配一下」。 */
function ModeCard({
  t,
  mode,
  credentials,
  keyStatus,
  onSaveKey,
}: {
  t: TFn
  mode: ProviderMode
  credentials: CredentialFacts
  keyStatus: KeySaveStatus
  onSaveKey: (apiKey: string) => void
}) {
  if (mode.kind === 'api') {
    return (
      <ApiKeyCard
        t={t}
        mode={mode}
        credentials={credentials}
        keyStatus={keyStatus}
        onSaveKey={onSaveKey}
      />
    )
  }
  if (mode.kind === 'subscription') return <SubscriptionCard t={t} credentials={credentials} />
  return (
    <section className={s.card}>
      <p className={s.cardNote}>
        {mode.kind === 'custom' ? t('providers.customIntro') : t('providers.localIntro')}
      </p>
    </section>
  )
}

/**
 * API 密钥。批一只做**一条**:输入新的即替换。
 *
 * 原文永不回读 —— 输入框的初值永远是空的,占位符说的是「已经存着一把 ……8c1d」。
 * 那不是把旧值放进框里(放进去就等于把它交回渲染层),是把「有这么一把」说出来。
 */
function ApiKeyCard({
  t,
  mode,
  credentials,
  keyStatus,
  onSaveKey,
}: {
  t: TFn
  mode: ProviderMode
  credentials: CredentialFacts
  keyStatus: KeySaveStatus
  onSaveKey: (apiKey: string) => void
}) {
  const [draft, setDraft] = useState('')

  // 换一坑 = 换一把要填的钥匙。上一坑没提交的草稿不能跟过来 ——
  // 那会把 A 家的 key 存进 B 家。
  useEffect(() => {
    setDraft('')
  }, [mode.providerId])

  const saving = keyStatus === 'saving'
  const placeholder =
    credentials.known && credentials.hasApiKey
      ? t('providers.keyStored', { tail: credentials.apiKeyPreview ?? '' })
      : t('providers.keyEmpty')

  return (
    <section className={s.card}>
      <h3 className={s.cardTitle}>{t('providers.keySection')}</h3>
      <div className={s.keyRow}>
        <div className={s.keyField}>
          <Input
            size="sm"
            type="password"
            value={draft}
            onValueChange={setDraft}
            disabled={saving}
            placeholder={placeholder}
            aria-label={t('providers.keyLabel', { name: mode.name })}
          />
        </div>
        <Button
          size="sm"
          variant="primary"
          disabled={saving || draft.trim().length === 0}
          onClick={() => {
            onSaveKey(draft)
            setDraft('')
          }}
        >
          {saving ? <Spinner label={t('providers.keySave')} /> : t('providers.keySave')}
        </Button>
        {keyStatus === 'saved' && <span className={s.keySaved}>{t('providers.keySaved')}</span>}
      </div>
      <p className={s.cardNote}>{t('providers.keyNeverRead')}</p>
      {mode.defaultBaseUrl && (
        <p className={s.cardNote}>
          {t('providers.baseUrl')} <span className={s.mono}>{mode.defaultBaseUrl}</span>{' '}
          {t('providers.baseUrlDefault')}
        </p>
      )}
      <p className={s.cardNote}>{t('providers.keyMultiNext')}</p>
    </section>
  )
}

/** 订阅坑。批一只**读**登录态:登录流(设备码 / 授权码)在批二。 */
function SubscriptionCard({ t, credentials }: { t: TFn; credentials: CredentialFacts }) {
  return (
    <section className={s.card}>
      {credentials.known && credentials.hasOAuth ? (
        <div className={s.accountRow}>
          <span className={s.accountDot} aria-hidden="true" />
          <span>{t('providers.factSignedIn')}</span>
          {credentials.oauthAccount && <span className={s.mono}>{credentials.oauthAccount}</span>}
        </div>
      ) : (
        <div className={s.absent}>
          {/* 假流程不做:钮禁用着,旁边一句话说清它什么时候会活过来。 */}
          <Button size="sm" disabled>
            {t('providers.subSignIn')}
          </Button>
          <span className={s.absentNote}>{t('providers.subSignInNext')}</span>
        </div>
      )}
      <p className={s.cardNote}>{t('providers.subIntro')}</p>
    </section>
  )
}
