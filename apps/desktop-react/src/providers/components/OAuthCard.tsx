import { useEffect, useRef, useState } from 'react'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { IconButton } from '../../ui/IconButton'
import { InlineEditStrip } from '../../ui/InlineEditStrip'
import { Menu, MenuItem, MenuSeparator } from '../../ui/Menu'
import { Spinner } from '../../ui/Spinner'
import { StatusDot } from '../../ui/StatusDot'
import { Ellipsis } from '../../components/icons'
import { useT } from '../../i18n'
import type { TFn } from '../../i18n'
import type { AuthFlowState } from '../auth'
import type { OAuthAccountStatus, OAuthStatusResponse } from '@shared/ipc/oauth'
import { AuthFlowScreen } from './AuthFlowScreen'
import { RotationPolicyPicker } from './RotationPolicyPicker'
import s from './OAuthCard.module.css'

/**
 * 订阅模式的登录卡。三屏,由**当下的事实**决定画哪一屏 —— 不是由一个 step 计数器:
 *
 *   没在登录 + 这个空间一个账号都没有 → 说明这是什么 + 一颗「登录」(那句说明**只在这一屏**)
 *   在登录                            → 那一条流的现场(`AuthFlowScreen`:一屏三流,行按事实显隐)
 *   有账号                            → **每账号一行**(批 8)+「N 个账号 · 添加账号」
 *
 * ── 批 8:账号是这个空间池里的一条条(`docs/design/subscription-accounts-2026-09.md` §8)──
 * 行读的是后端 `oauth.status` 答的 `accounts[]`(池序 = 「用完换下一个」下的优先级),不是凭证摘要:
 * 「过没过期」只有后端说得出。一行 = 邮箱 · 套餐 · 过期标;动作四个(重新授权 / 上移 / 下移 /
 * 退出),照 `CredentialPool` 那条「动作多则收进 ⋯」收进菜单;**过期的那一行把「重新授权」
 * 常驻画出来** —— 那是它此刻唯一该做的事。退出走与删密钥同一形的行内确认条(不弹窗)。
 * 窗口条(批 5)仍是每账号一张的 `UsageCard`,排在这张卡下面(ModeCard 画)。
 *
 * ── 批 9:订阅也能轮转(同正本 §10)────────────────────────────────────────
 * 账号列表上方放与密钥池**同一颗**轮换选择器(`RotationPolicyPicker`,订阅池那套说法:
 * 只用第一个 / 用完换下一个 / 轮流使用 / 余量多的优先)。**≥2 个账号才画** —— 一个账号
 * 没什么可轮,画出来只是一颗改了也不会有任何区别的钮。0 / 1 个账号时策略照样存着、照样生效。
 *
 * 「登过但过期了」是**有账号那一屏的一行**,不是第一屏:说「未登录」会让人以为要
 * 从头再走一遍,而实际上重新授权那一条就够了。
 *
 * ── 三张状态表(施工纪律「状态先行」)──────────────────────────────────────
 * ① 生命周期:随 ModeCard 在订阅坑上画出;自己不取数(`status` / `flow` 由面板 store 给);
 *    换坑 = 换一家的账号,那一格确认条当场收掉;无订阅、无计时器 → 不需要 HMR dispose。
 * ② UI 生命状态:empty(一个账号都没有 → 第一屏,无选择器)/ 一个账号(行,无选择器)/
 *    ≥2 个账号(选择器 + 行)/ loading(没有这一档:登录态在飞时上一份
 *    仍在屏,律②)/ ready(账号行)/ error(`flow.error` 服务商原话;`lastError` 登录流的错)/
 *    超量(一个空间十几个账号已是极端,列表不设最大高度,行名省略号截断)。
 * ③ UI 交互状态:⋯ 常驻,`aria-haspopup` / `aria-expanded`;到顶的「上移」/ 到底的「下移」
 *    禁灰不消失;确认条 ↵ 退出 / Esc 收回;`busy`(池在写)时整张卡的钮禁掉,重新授权另看
 *    `flow.busy`。
 */

export function OAuthCard({
  status,
  flow,
  busy = false,
  onSignIn,
  onReauth,
  onCode,
  onSubmitCode,
  onCancel,
  onOpenAuthPage,
  onSignOut,
  onMove,
  policy,
  policyUnavailable = false,
  onRotation,
}: {
  status: OAuthStatusResponse | undefined
  flow: AuthFlowState
  /** 这一家的池此刻在写(退出 / 排序)。 */
  busy?: boolean
  /** 添加账号(新登录,追加一条)。 */
  onSignIn: () => void
  /** 重新授权**那一条**(原地换令牌)。 */
  onReauth: (entryId: string) => void
  onCode: (code: string) => void
  onSubmitCode: () => void
  onCancel: () => void
  /** 把这条流的授权页交给系统浏览器(`platform/open-external`)。 */
  onOpenAuthPage: () => void
  /** 退出**那一个账号**(删本空间那一条)。 */
  onSignOut: (entryId: string) => void
  /** 调序:池序 = 「用完换下一个」下的优先级。 */
  onMove: (entryId: string, delta: -1 | 1) => void
  /** 这一池的轮换策略(`poolViewOf` 已补缺省)。 */
  policy: string
  /** 策略是插件给的、而此刻那个插件不在。 */
  policyUnavailable?: boolean
  /** 写池策略(store 的 `setRotation`,与密钥池同一口)。 */
  onRotation: (policy: string) => void
}) {
  const t = useT()
  const accounts = status?.accounts ?? []
  /** 此刻开着退出确认条的那一行。一次只有一条。 */
  const [confirming, setConfirming] = useState<string | null>(null)
  const providerId = status?.providerId
  useEffect(() => setConfirming(null), [providerId])
  // 那一行没了(退出成功 / 别处删掉)= 确认条跟着收。
  useEffect(() => {
    if (confirming && !accounts.some((account) => account.entryId === confirming)) setConfirming(null)
  }, [accounts, confirming])

  if (flow.kind) {
    return (
      <Card>
        <AuthFlowScreen
          flow={flow}
          onOpen={onOpenAuthPage}
          onCode={onCode}
          onSubmitCode={onSubmitCode}
          onCancel={onCancel}
          onRetry={flow.target?.entryId ? () => onReauth(flow.target!.entryId!) : onSignIn}
        />
      </Card>
    )
  }

  if (accounts.length === 0) {
    return (
      <Card>
        <div className={s.row}>
          {/* ui-consume-allow: spinner-placement — 它就在这颗「登录」钮的 children 里:
              忙时整颗钮换成转圈 + disabled(律③:异步动作必有进行中反馈)。
              这是禁令原文的第一个允许位「按钮内」。 */}
          <Button size="sm" variant="primary" disabled={flow.busy} onClick={() => onSignIn()}>
            {flow.busy ? <Spinner label={t('providers.subSignIn')} /> : t('providers.subSignIn')}
          </Button>
        </div>
        {flow.error && <p className={s.error}>{flow.error}</p>}
        <p className={s.note}>{t('providers.subIntro')}</p>
      </Card>
    )
  }

  return (
    <Card>
      {accounts.length >= 2 && (
        <RotationPolicyPicker
          kind="subscription"
          policy={policy}
          disabled={busy}
          unavailable={policyUnavailable}
          onChange={onRotation}
        />
      )}
      <ul className={s.accountList}>
        {accounts.map((account, index) => (
          <AccountRow
            key={account.entryId}
            t={t}
            account={account}
            ordinal={index + 1}
            first={index === 0}
            last={index === accounts.length - 1}
            busy={busy}
            flowBusy={flow.busy}
            confirming={confirming === account.entryId}
            onReauth={() => onReauth(account.entryId)}
            onAskSignOut={() => setConfirming(account.entryId)}
            onConfirmSignOut={() => onSignOut(account.entryId)}
            onCancelSignOut={() => setConfirming(null)}
            onMove={(delta) => onMove(account.entryId, delta)}
          />
        ))}
      </ul>

      {/* 后端记下的上一次登录流的错。它是「登着但上次出过事」,值得说,不值得报警。 */}
      {status?.lastError && <p className={s.meta}>{status.lastError}</p>}
      {flow.error && <p className={s.error}>{flow.error}</p>}

      {/* 多账号:现在有几个,加账号就是再走一次同一条登录流(追加,不盖掉谁)。 */}
      <div className={s.row}>
        <span className={s.meta}>{t('providers.subAccounts', { count: accounts.length })}</span>
        <Button size="sm" variant="ghost" disabled={flow.busy || busy} onClick={() => onSignIn()}>
          {t('providers.subAddAccount')}
        </Button>
      </div>
    </Card>
  )
}

/** 行名:「邮箱 · 套餐」/ 邮箱原文 /「账号 N」(没有邮箱时;套餐照挂)。 */
export function accountRowName(t: TFn, account: OAuthAccountStatus, ordinal: number): string {
  const name = account.email?.trim() || t('providers.subAccountNumbered', { n: ordinal })
  const plan = account.planType?.trim()
  return plan ? t('providers.subAccountRow', { email: name, plan }) : name
}

function AccountRow({
  t,
  account,
  ordinal,
  first,
  last,
  busy,
  flowBusy,
  confirming,
  onReauth,
  onAskSignOut,
  onConfirmSignOut,
  onCancelSignOut,
  onMove,
}: {
  t: TFn
  account: OAuthAccountStatus
  ordinal: number
  first: boolean
  last: boolean
  busy: boolean
  flowBusy: boolean
  confirming: boolean
  onReauth: () => void
  onAskSignOut: () => void
  onConfirmSignOut: () => void
  onCancelSignOut: () => void
  onMove: (delta: -1 | 1) => void
}) {
  const [menu, setMenu] = useState(false)
  const moreRef = useRef<HTMLButtonElement>(null)
  const name = accountRowName(t, account, ordinal)
  const menuLabel = t('providers.subAccountMenuFor', { account: name })

  return (
    <li className={s.accountRow}>
      {/* 不给 label:紧挨着就是账号名与「登录已过期」那句话。 */}
      <StatusDot tone={account.isExpired ? 'warn' : 'ok'} />
      <span className={s.accountIdentity}>
        <span className={s.accountName}>{name}</span>
        {account.isExpired && <span className={s.meta}>{t('providers.subAccountExpired')}</span>}
        {confirming && (
          /* 退出确认与删密钥同一形:一句后果 + 危险色主钮,落在这一行里,不弹窗。 */
          <InlineEditStrip
            className={s.stripBelow}
            prefix={<span className={s.meta}>{t('providers.subAccountSignOutAsk')}</span>}
            tone="danger"
            saveLabel={t('providers.subAccountSignOut')}
            savingLabel={t('common.saving')}
            cancelLabel={t('common.cancel')}
            busy={busy}
            onCommit={onConfirmSignOut}
            onCancel={onCancelSignOut}
          />
        )}
      </span>

      {!confirming && (
        <span className={s.trail}>
          {account.isExpired && (
            <Button size="sm" variant="primary" disabled={flowBusy || busy} onClick={onReauth}>
              {t('providers.subAccountReauth')}
            </Button>
          )}
          <IconButton
            ref={moreRef}
            size="sm"
            icon={Ellipsis}
            label={menuLabel}
            disabled={busy}
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((open) => !open)}
          />
        </span>
      )}

      {menu && (
        <Menu
          x={moreRef.current?.getBoundingClientRect().left ?? 0}
          y={moreRef.current?.getBoundingClientRect().bottom ?? 0}
          anchor={() => moreRef.current?.getBoundingClientRect() ?? null}
          anchorPlace="below-end"
          label={menuLabel}
          onClose={() => setMenu(false)}
        >
          <MenuItem
            disabled={flowBusy}
            onClick={() => {
              setMenu(false)
              onReauth()
            }}
          >
            {t('providers.subAccountReauth')}
          </MenuItem>
          <MenuSeparator />
          {/* 到顶 / 到底那一项**禁灰不消失**(与密钥行同一条:菜单形状不随上下文变)。 */}
          <MenuItem
            disabled={first}
            onClick={() => {
              setMenu(false)
              onMove(-1)
            }}
          >
            {t('providers.subAccountMoveUp')}
          </MenuItem>
          <MenuItem
            disabled={last}
            onClick={() => {
              setMenu(false)
              onMove(1)
            }}
          >
            {t('providers.subAccountMoveDown')}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            danger
            onClick={() => {
              setMenu(false)
              onAskSignOut()
            }}
          >
            {t('providers.subAccountSignOut')}
          </MenuItem>
        </Menu>
      )}
    </li>
  )
}
