import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Input } from '../../ui/Input'
import { Spinner } from '../../ui/Spinner'
import { StatusDot } from '../../ui/StatusDot'
import { useT } from '../../i18n'
import type { TFn } from '../../i18n'
import { formatMoment, standingOf } from '../auth'
import type { AuthFlowState } from '../auth'
import type { OAuthStatusResponse } from '@shared/ipc/oauth'
import s from './OAuthCard.module.css'

/**
 * 订阅坑的登录卡。三屏,由**当下的事实**决定画哪一屏 —— 不是由一个 step 计数器:
 *
 *   没在登录 + 没登上   → 说明这是什么 + 一颗「登录」
 *   在登录              → 那一条流的现场(设备码 / 贴码 / 浏览器等待)+ 取消
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
  onSignOut,
}: {
  status: OAuthStatusResponse | undefined
  flow: AuthFlowState
  /** 这一坑现有几个订阅账号(凭证池里 oauth 型的条数)。 */
  accounts: number
  onSignIn: () => void
  onCode: (code: string) => void
  onSubmitCode: () => void
  onCancel: () => void
  onSignOut: () => void
}) {
  const t = useT()
  const standing = standingOf(status)

  if (flow.kind) {
    return (
      <Card>
        <FlowScreen t={t} flow={flow} onCode={onCode} onSubmitCode={onSubmitCode} />
        {/* 失败要显示**服务商原话**(交接稿 §4b)—— 不换成一句「登录失败」。 */}
        {flow.error && <p className={s.error}>{flow.error}</p>}
        <div className={s.row}>
          <Button size="sm" onClick={onCancel}>
            {t('providers.subCancel')}
          </Button>
        </div>
      </Card>
    )
  }

  if (standing === 'signedOut') {
    return (
      <Card>
        <div className={s.row}>
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

      {/* 多账号:说得出「支持几个、现在有几个」,加账号就是再走一次同一条登录流。 */}
      <div className={s.row}>
        <span className={s.meta}>{t('providers.subAccounts', { count: accounts })}</span>
        <Button size="sm" variant="ghost" disabled={flow.busy} onClick={onSignIn}>
          {t('providers.subAddAccount')}
        </Button>
      </div>
      <p className={s.note}>{t('providers.subIntro')}</p>
    </Card>
  )
}

/** 流程中的那一屏。三种流各画各的 —— 不合并成一句「正在登录」。 */
function FlowScreen({
  t,
  flow,
  onCode,
  onSubmitCode,
}: {
  t: TFn
  flow: AuthFlowState
  onCode: (code: string) => void
  onSubmitCode: () => void
}) {
  if (flow.kind === 'device' && flow.device) {
    return (
      <>
        <p className={s.note}>{t('providers.subDeviceCode')}</p>
        {/* 设备码是要**照着念、照着打**的,所以它是这一屏最大的那个东西。 */}
        <p className={s.deviceCode}>{flow.device.userCode}</p>
        <p className={s.meta}>
          {t('providers.subDeviceUrl')} <span className={s.mono}>{flow.device.verificationUri}</span>
        </p>
        <p className={s.meta}>{t('providers.subWaiting')}</p>
      </>
    )
  }

  if (flow.kind === 'paste' && flow.paste) {
    return (
      <>
        {/* 后端给的说明原样显示;它没给才退到我们自己那句。 */}
        <p className={s.note}>{flow.paste.instructions || t('providers.subPasteHint')}</p>
        <div className={s.row}>
          <div className={s.codeField}>
            <Input
              size="sm"
              value={flow.code}
              onValueChange={onCode}
              disabled={flow.busy}
              placeholder={t('providers.subCodeLabel')}
              aria-label={t('providers.subCodeLabel')}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  onSubmitCode()
                }
              }}
            />
          </div>
          <Button
            size="sm"
            variant="primary"
            disabled={flow.busy || !flow.code.trim()}
            onClick={onSubmitCode}
          >
            {flow.busy ? (
              <Spinner label={t('providers.subCodeSubmit')} />
            ) : (
              t('providers.subCodeSubmit')
            )}
          </Button>
        </div>
      </>
    )
  }

  return (
    <>
      <p className={s.note}>{t('providers.subBrowserWaiting')}</p>
      <p className={s.meta}>{t('providers.subWaiting')}</p>
    </>
  )
}
