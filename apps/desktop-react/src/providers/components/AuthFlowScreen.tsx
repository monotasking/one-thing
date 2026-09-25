import { useEffect, useRef, useState } from 'react'
import { Button } from '../../ui/Button'
import { ButtonBase } from '../../ui/ButtonBase'
import { Input } from '../../ui/Input'
import { Spinner } from '../../ui/Spinner'
import { Tooltip } from '../../ui/Tooltip'
import { announce } from '../../ui/a11y/live-region'
import { focusTree } from '../../focus/registry'
import { COPY_FEEDBACK_MS } from '../../components/motion'
import { copyText } from '../../services/clipboard'
import { useT } from '../../i18n'
import type { TFn } from '../../i18n'
import { authPageUrlOf, isAccessDenied } from '../auth'
import type { AuthFlowState } from '../auth'
import s from './OAuthCard.module.css'

/**
 * 一屏三流(批 1,`docs/design/provider-settings-rework-2026-09.md` §3.2)。
 *
 * 浏览器回调(codex)/ 贴码(claude-code)/ 设备码(grok / kimi-code / copilot)
 * 合成**一个**组件,行按事实显隐 —— 不按流名分三套屏:
 *
 * | 行 | 回调 | 贴码 | 设备码 |
 * | --- | --- | --- | --- |
 * | 授权页链接 + 打开 + 复制 | 显示 | 显示 | 显示 |
 * | 用户码 + 复制 | — | — | 显示 |
 * | 授权码输入 + 提交 | — | 显示 | — |
 * | 状态句 + 取消登录 | 显示 | 显示 | 显示 |
 *
 * 判据全是**这一次后端给了什么**:给了授权页网址就有链接行,给了用户码就有码行,
 * 是贴码流就有输入行。「加一家用短信验证码登录的服务商」不改这里(方案 §3.4)。
 *
 * 终局两档(`flow.ended`):失败 → 「登录失败」+ 原话 Tooltip + 重试;超时 → 「登录已超时」。
 * 那时码与链接都已作废,只留状态句与重试 / 取消。
 *
 * Esc = 取消登录,**只在焦点在这一屏里时**认领(瞬态口,同 `ui/inline-edit` 的判据) ——
 * 焦点在别处按 Esc 该退的是别的层,不该被一张开在设置页深处的登录卡截胡。
 */
export function AuthFlowScreen({
  flow,
  onOpen,
  onCode,
  onSubmitCode,
  onCancel,
  onRetry,
}: {
  flow: AuthFlowState
  /** 点链接或「打开」:把授权页交给系统浏览器(`platform/open-external`)。 */
  onOpen: () => void
  onCode: (code: string) => void
  onSubmitCode: () => void
  /** 取消登录 = `oauth.cancel`(流已终局时只收屏)。 */
  onCancel: () => void
  /** 终局之后再来一次(= 重新起流)。 */
  onRetry: () => void
}) {
  const t = useT()
  const url = authPageUrlOf(flow)
  const live = !flow.ended

  const focused = useRef(false)
  const cancelRef = useRef(onCancel)
  cancelRef.current = onCancel
  useEffect(
    () =>
      focusTree.registerTransient(() => {
        if (!focused.current) return false
        cancelRef.current()
        return true
      }),
    [],
  )

  return (
    <div
      className={s.flow}
      data-testid="auth-flow-screen"
      data-flow-kind={flow.kind ?? undefined}
      onFocus={() => {
        focused.current = true
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) focused.current = false
      }}
    >
      {live && url && <AuthPageRow t={t} url={url} onOpen={onOpen} />}

      {live && flow.kind === 'device' && flow.device?.userCode && (
        <UserCodeRow t={t} code={flow.device.userCode} />
      )}

      {live && flow.kind === 'paste' && (
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
            {/* ui-consume-allow: spinner-placement — 在这颗「提交授权码」钮的 children 里:
                忙时换成转圈 + disabled。允许位「按钮内」。 */}
            {flow.busy ? <Spinner label={t('providers.subCodeSubmit')} /> : t('providers.subCodeSubmit')}
          </Button>
        </div>
      )}

      {/* 贴码提交失败(不是终局,码可以再贴一次):服务商原话。 */}
      {live && flow.error && <p className={s.error}>{flow.error}</p>}

      <div className={s.statusRow}>
        <StatusLine t={t} flow={flow} />
        <div className={s.row}>
          {!live && (
            <Button size="sm" variant="primary" onClick={onRetry}>
              {t('providers.subRetry')}
            </Button>
          )}
          <Button size="sm" onClick={onCancel}>
            {t('providers.subCancel')}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** 状态句。按 §3.2 表:终局两档 > 贴码 > 设备码 > 回调(真打开了 / 没打开)。 */
function StatusLine({ t, flow }: { t: TFn; flow: AuthFlowState }) {
  if (flow.ended === 'expired') return <p className={s.error}>{t('providers.subTimedOut')}</p>
  if (flow.ended === 'failed') {
    if (isAccessDenied(flow.error)) return <p className={s.error}>{t('providers.subDenied')}</p>
    // 「登录失败」一句,服务商原话进 Tooltip(交接稿 §4b:原话要能看到,但不铺满一屏)。
    return (
      <p className={s.error}>
        {flow.error ? (
          <Tooltip content={flow.error}>
            <span data-testid="auth-flow-failed">{t('providers.subFailed')}</span>
          </Tooltip>
        ) : (
          t('providers.subFailed')
        )}
      </p>
    )
  }
  if (flow.kind === 'paste') {
    return <p className={s.note}>{flow.paste?.instructions || t('providers.subPasteHint')}</p>
  }
  if (flow.kind === 'device') return <p className={s.note}>{t('providers.subWaiting')}</p>
  // 回调流:**只有真打开了**才说「已打开授权页」(桌面自动开成功);网页壳或开不成说「点『打开』」。
  return <p className={s.note}>{flow.opened ? t('providers.subBrowserWaiting') : t('providers.subOpenHint')}</p>
}

/** 授权页一行:网址是链接(点 = 打开),右侧「打开」「复制」。 */
function AuthPageRow({ t, url, onOpen }: { t: TFn; url: string; onOpen: () => void }) {
  const [copied, copy] = useCopyFeedback(t)
  return (
    <div className={s.urlRow}>
      <span className={s.meta}>{t('providers.subDeviceUrl')}</span>
      <a
        className={s.url}
        href={url}
        data-testid="auth-flow-url"
        onClick={(event) => {
          // 链接的默认行为在桌面上会开出一扇壳自己的窗 —— 一律交给帮手。
          event.preventDefault()
          onOpen()
        }}
      >
        {url}
      </a>
      <div className={s.row}>
        <Button size="sm" onClick={onOpen} data-testid="auth-flow-open">
          {t('providers.subOpen')}
        </Button>
        <Button size="sm" onClick={() => copy(url)} data-testid="auth-flow-copy-url">
          {copied ? t('providers.subCopied') : t('providers.subCopy')}
        </Button>
      </div>
    </div>
  )
}

/** 设备码一行:大字码(点它本身也复制)+「复制」。 */
function UserCodeRow({ t, code }: { t: TFn; code: string }) {
  const [copied, copy] = useCopyFeedback(t)
  return (
    <>
      <p className={s.note}>{t('providers.subDeviceCode')}</p>
      <div className={s.row}>
        {/* 设备码是要**照着打**的,所以它是这一屏最大的那个东西;点它 = 复制。 */}
        <ButtonBase
          className={s.deviceCode}
          onClick={() => copy(code)}
          aria-label={`${code} · ${t('providers.subCopy')}`}
          data-testid="auth-flow-user-code"
        >
          {code}
        </ButtonBase>
        <Button size="sm" onClick={() => copy(code)} data-testid="auth-flow-copy-code">
          {copied ? t('providers.subCopied') : t('providers.subCopy')}
        </Button>
      </div>
    </>
  )
}

/** 复制 + 就地反馈:钮上的字换成「已复制」1.5 秒后复原(08-31 拍板:复制走就地反馈,不弹通知)。 */
function useCopyFeedback(t: TFn): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = (text: string) => {
    void copyText(text).then((ok) => {
      setCopied(ok)
      announce(t(ok ? 'providers.subCopied' : 'common.copyFailed'))
      clearTimeout(timer.current)
      if (ok) timer.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS)
    })
  }
  return [copied, copy]
}
