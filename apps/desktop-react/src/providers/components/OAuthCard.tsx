import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Spinner } from '../../ui/Spinner'
import { StatusDot } from '../../ui/StatusDot'
import { useT } from '../../i18n'
import { formatMoment, standingOf } from '../auth'
import type { AuthFlowState } from '../auth'
import type { OAuthStatusResponse } from '@shared/ipc/oauth'
import { AuthFlowScreen } from './AuthFlowScreen'
import s from './OAuthCard.module.css'

/**
 * 订阅模式的登录卡。三屏,由**当下的事实**决定画哪一屏 —— 不是由一个 step 计数器:
 *
 *   没在登录 + 没登上   → 说明这是什么 + 一颗「登录」(那句说明**只在这一屏**)
 *   在登录              → 那一条流的现场(`AuthFlowScreen`:一屏三流,行按事实显隐)
 *   已登上              → 账号 / 套餐 / 令牌状态 / 有效期 + 重新授权 + 退出
 *
 * 「登过但过期了」是**第三屏的一种**,不是第一屏:说「未登录」会让人以为要
 * 从头再走一遍,而实际上重新授权就够了(判据 `standingOf` 在 auth.ts)。
 */

export function OAuthCard({
  status,
  flow,
  accounts,
  onSignIn,
  onCode,
  onSubmitCode,
  onCancel,
  onOpenAuthPage,
  onSignOut,
}: {
  status: OAuthStatusResponse | undefined
  flow: AuthFlowState
  /** 这个模式现有几个订阅账号(凭证池里 oauth 型的条数)。 */
  accounts: number
  onSignIn: () => void
  onCode: (code: string) => void
  onSubmitCode: () => void
  onCancel: () => void
  /** 把这条流的授权页交给系统浏览器(`platform/open-external`)。 */
  onOpenAuthPage: () => void
  onSignOut: () => void
}) {
  const t = useT()
  const standing = standingOf(status)

  if (flow.kind) {
    return (
      <Card>
        <AuthFlowScreen
          flow={flow}
          onOpen={onOpenAuthPage}
          onCode={onCode}
          onSubmitCode={onSubmitCode}
          onCancel={onCancel}
          onRetry={onSignIn}
        />
      </Card>
    )
  }

  if (standing === 'signedOut') {
    return (
      <Card>
        <div className={s.row}>
          {/* ui-consume-allow: spinner-placement — 它就在这颗「登录」钮的 children 里:
              忙时整颗钮换成转圈 + disabled(律③:异步动作必有进行中反馈)。
              这是禁令原文的第一个允许位「按钮内」。 */}
          <Button size="sm" variant="primary" disabled={flow.busy} onClick={onSignIn}>
            {flow.busy ? <Spinner label={t('providers.subSignIn')} /> : t('providers.subSignIn')}
          </Button>
        </div>
        {flow.error && <p className={s.error}>{flow.error}</p>}
        <p className={s.note}>{t('providers.subIntro')}</p>
      </Card>
    )
  }

  const expiresAt = formatMoment(status?.expiresAt)
  const account = status?.account?.email || status?.account?.id || ''
  const plan = status?.account?.planType

  return (
    <Card>
      <div className={s.account}>
        {/* 不给 label:紧挨着就是账号名与「令牌有效 / 已过期」那句话。 */}
        <StatusDot tone={standing === 'expired' ? 'warn' : 'ok'} />
        {account && <span className={s.accountName}>{account}</span>}
        {plan && <span className={s.meta}>{t('providers.subPlan', { plan })}</span>}
      </div>
      <p className={s.meta}>
        {standing === 'expired' ? t('providers.subTokenExpired') : t('providers.subTokenValid')}
        {expiresAt ? ` · ${t('providers.subExpires', { time: expiresAt })}` : ''}
      </p>
      {/* 后端记下的上一次错误。它是「登着但上次出过事」,值得说,不值得报警。 */}
      {status?.lastError && <p className={s.meta}>{status.lastError}</p>}

      <div className={s.row}>
        <Button
          size="sm"
          variant={standing === 'expired' ? 'primary' : 'ghost'}
          disabled={flow.busy}
          onClick={onSignIn}
        >
          {t('providers.subReauth')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={flow.busy}
          onClick={onSignOut}
          aria-label={account ? t('providers.subSignOutFor', { account }) : t('providers.subSignOut')}
        >
          {t('providers.subSignOut')}
        </Button>
      </div>

      {/* 多账号:现在有几个,加账号就是再走一次同一条登录流。 */}
      <div className={s.row}>
        <span className={s.meta}>{t('providers.subAccounts', { count: accounts })}</span>
        <Button size="sm" variant="ghost" disabled={flow.busy} onClick={onSignIn}>
          {t('providers.subAddAccount')}
        </Button>
      </div>
    </Card>
  )
}
