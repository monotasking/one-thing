import { memo, useCallback, useRef } from 'react'
import { Button } from '../../ui/Button'
import { Tooltip } from '../../ui/Tooltip'
import { FocusScope } from '../../focus/FocusScope'
import { useT } from '../../i18n'
import type { WebPermissionAsk } from '../../data/browser-notices'
import { webPermissionLabel } from './web-permission-label'
/*
 * **复用隔壁那张卡的皮**,不另开一份(B3-a 派工令原话:「复用它的形,不另造一张
 * 卡」)。同一个模块 CSS 意味着两张卡永远长得一样 —— 一张问「这次工具调用准不准」,
 * 一张问「这个网页准不准」,而它们在人眼里本来就该是同一种东西。
 * 这也是为什么这只文件住在 `content/permission/` 而不是 `content/browser/`:
 * 「一次授权请求该怎么画」归这一族,浏览器只负责把那一问递过来。
 */
import s from './PermissionCard.module.css'

/**
 * **网页权限询问卡**(B3-a)。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ① 生命周期
 * ══════════════════════════════════════════════════════════════════════════
 * | 事件 | 这里发生什么 |
 * | --- | --- |
 * | 挂载 | 一条 `permissionRequested` 到了,而且它排在这一格 tab 的队头 |
 * | 换宿主 | 卡在叶檐下,拼贴树结构共享 → **不重挂**;真重挂了状态也不在这里 |
 * | 卸载 | 那一问结了(答了 / 超时 / tab 没了三条收场共用一条事实) |
 * | **不会** | 它没有「我自己把自己收起来」这条路 —— 见下 |
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ② UI 生命状态
 * ══════════════════════════════════════════════════════════════════════════
 * | 态 | 判据 | 屏幕上 |
 * | --- | --- | --- |
 * | 在问 | 队头这一问 | 标题 +「<来源> 想要 <能力>」+ 两颗键 |
 * | 来源说不出 | `origin` 空串 | 标题退成「这个网页想要…」—— **不编一个来源** |
 * | 认不出的能力 | 表里没有这个名字 | 念成「一格它没说清的能力」,两颗键照旧 |
 * | 排队 | 同一 tab 还有别的问 | **整张卡只画队头**;后面那几问一格都不画(叶那边判) |
 * | 已答 | — | 这张卡当场没了(由 `permissionResolved` 撤),**没有「已答」那一档** |
 *
 * 「已答」为什么没有那一档:隔壁那张工具权限卡有它,因为那头有一台引擎要等
 * 「核心确认」那一下;这里答完就是一句 `callback(allow)` 打回 Chromium,没有
 * 第二拍可等 —— 硬画一档「已允许,等确认」是编一个不存在的中间态。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ③ UI 交互状态
 * ══════════════════════════════════════════════════════════════════════════
 * | 交互 | 结果 |
 * | --- | --- |
 * | 允许一次 | `do respondPermission {allow: true}`。**没有「始终允许」** —— 那是按 profile 记的一格设定,归 B3 的多 profile 设置面 |
 * | 拒绝 | 同上,`allow: false` |
 * | rest / hover / focus / disabled | 全部由 `ui/Button` 带(配方随件走) |
 * | pending | **无**。发出去到卡消失之间是一发 RPC 往返(20–30ms),画一个「正在…」只会闪一下 |
 * | Esc | **穿过去**,不认领(见下) |
 *
 * ── 接响应链的三件声明 ────────────────────────────────────────────────────
 *  ① scope id `permission`(与隔壁那张卡同一格;一次询问一份实例,
 *     owner = `web:<requestId>` —— 加前缀是为了与工具调用那一族的 `toolCallId`
 *     永不相撞);
 *  ② 落点 `restingTarget` = 第一颗键;
 *  ③ **不声明 `onEscape`** —— 与隔壁那张卡逐字同一句判词:一张等着人答的卡关不掉
 *     (那头 Chromium 在等一个 `callback`),把它收起来只会让人以为这件事过去了。
 *     不传 = 根本不进 Esc 候选表,那一下照旧交给外面那一层。
 *
 * 除此之外这只文件里一行焦点代码都没有:零 `keydown`、零 `.focus()`。
 */
export const WebPermissionCard = memo(function WebPermissionCard({
  ask,
  onRespond,
}: {
  ask: WebPermissionAsk
  /** 答一下。产地只有一处 —— 叶上那一句 `browserOps.respondPermission.run`。 */
  onRespond: (requestId: string, allow: boolean) => void
}) {
  const t = useT()
  const firstKeyRef = useRef<HTMLButtonElement | null>(null)
  const allow = useCallback(() => onRespond(ask.requestId, true), [ask.requestId, onRespond])
  const refuse = useCallback(() => onRespond(ask.requestId, false), [ask.requestId, onRespond])

  const capability = webPermissionLabel(t, ask.permission)
  const title = ask.origin
    ? t('browser.perm.title', { origin: ask.origin, capability })
    : t('browser.perm.titleAnonymous', { capability })

  return (
    <FocusScope
      scope="permission"
      owner={`web:${ask.requestId}`}
      restingTarget={() => firstKeyRef.current}
    >
      {({ scopeProps }) => (
        <div
          {...scopeProps}
          className={s.permCard}
          role="group"
          aria-label={t('permission.waiting', { title })}
          data-web-permission={ask.requestId}
          data-testid="browser-permission-card"
        >
          {/* 标题单行截断,全称走 Tooltip(禁 native title=)。 */}
          <Tooltip content={title}>
            <div className={s.title}>{title}</div>
          </Tooltip>
          <div className={s.line}>
            <span className={s.effect}>{capability}</span>
            {/* 来源说不出就整格不画 —— 编一句「未知来源」是造事实。 */}
            {ask.origin ? <span className={s.resource}>{ask.origin}</span> : null}
          </div>
          <div className={s.actions}>
            <Button ref={firstKeyRef} variant="primary" onClick={allow} data-testid="browser-permission-allow">
              {t('permission.allowOnce')}
            </Button>
            <Button variant="danger" onClick={refuse} data-testid="browser-permission-reject">
              {t('permission.reject')}
            </Button>
          </div>
        </div>
      )}
    </FocusScope>
  )
})
