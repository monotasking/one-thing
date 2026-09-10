import { memo, useCallback, useRef } from 'react'
import { Button } from '../../ui/Button'
import { Tooltip } from '../../ui/Tooltip'
import { FocusScope } from '../../focus/FocusScope'
import { useT, type TFn } from '../../i18n'
import { isGrantablePermissionType, type PermissionAsk } from '../../data/permission-ask'
import type { PermissionResponse } from '@shared/ipc/permissions'
import { effectLabel, resourceLine } from './effect-label'
import s from './PermissionCard.module.css'

/**
 * **权限卡** —— 「引擎停在这里,等一个人回答」的那一格(应用级许可 · 壳半边,
 * 2026-09-10;后端半边 a50d4f99,正本 `docs/design/atom-2026-09.md` §7 盲点 3)。
 *
 * 在这一批之前 React 壳**根本没有这件东西**:全仓零处渲染 `permission:request`、
 * 零处发 `command:permission-respond`。用户桌面一直开着 `dangerously-allow-all`,
 * 于是这个洞两个月没露头 —— 换成缺省档,任何一次要审批的工具调用都会让工具卡
 * 永远停在「执行中」,而引擎在那头一直等。
 *
 * ── 它长在哪儿:**工具卡里**,不是消息尾 ──────────────────────────────────
 * 一次审批问的是「**这一次调用**能不能做」,而屏幕上说得出「这一次调用」的地方
 * 只有那张工具卡。挂在消息尾会让「哪一步在等」变成读者自己去配对的活儿 ——
 * 一条助手消息里可以有七八步,其中两步同时挂着审批。
 *
 * 具体落点是**卡的末尾、行列之外**(`ToolCard` 的 `list` 之后):行是收起态会
 * `hidden` 的东西,而一张等着人答的卡在收起态也必须看得见。
 *
 * ── 五个键,各自的出现条件 ────────────────────────────────────────────────
 *  · 允许一次 / 拒绝    —— **恒在**。任何一次 ask 都答得出这两句;
 *  · 本会话 / 本工作目录 —— 这一类效果的答案**记得住**才画
 *    (`isGrantablePermissionType` 读的是核那张策略表;`capability_change`
 *    这一族是 `never-grantable`,而 `Permission.respond('session')` 那一支直接
 *    落到会抛的 `addGrant` 上 —— 画一个按下去会炸的键比不画糟得多);
 *  · 始终允许「<scheme>」 —— **只在 `alwaysScope` 在场时画**(a50d4f99 留账原话)。
 *    出现条件由后端在 ask 那一刻算好随事件交过来,壳只读这一格、不自己解析
 *    `pattern` 猜命名空间 —— 自己解析就会记出 `/Users:*` 这种荒唐 grant。
 *
 * 载荷五支**逐字相同**:`{ toolCallId, decision }`,没有第五个字段。scheme 由
 * 后端从那次 ask 上取;壳回传等于让发送方指定许可范围。
 *
 * ── 接响应链的三件声明(壳规范 · 无障碍轴)────────────────────────────────
 *  ① scope id `permission`(`focus/scopes.ts` 已加一行,行为档 `region`);
 *  ② 落点 `restingTarget` = 第一颗键;
 *  ③ **不声明 `onEscape`** —— 一张权限卡关不掉(那头有引擎在等),所以它不进
 *     Esc 候选表,那一下照旧穿过去交给外面那一层。
 * 除此之外这只文件里一行焦点代码都没有:零 `keydown`、零 `.focus()`。
 *
 * ── 无障碍 ────────────────────────────────────────────────────────────────
 * `role="group"` + 一个说得出**在等什么**的可访问名(「等待授权:<title>」)。
 * 组而不是 `alertdialog`:它不圈禁焦点、不盖住别的东西,人可以先把上下文读完
 * 再回来答 —— 那正是审批该有的样子。
 */
export const PermissionCard = memo(function PermissionCard({
  ask,
  onRespond,
}: {
  ask: PermissionAsk
  /** 答一下。产地只有一处 —— `ChatSourceState.respondPermission`。 */
  onRespond: (toolCallId: string, decision: PermissionResponse) => void
}) {
  const t = useT()
  const firstKeyRef = useRef<HTMLButtonElement | null>(null)
  const respond = useCallback(
    (decision: PermissionResponse) => onRespond(ask.toolCallId, decision),
    [ask.toolCallId, onRespond],
  )

  const queued = ask.permissionQueued
  const answered = ask.answered
  const effect = effectLabel(t, ask.type)
  const resource = resourceLine(ask.pattern)
  const label = t(queued ? 'permission.queuedLabel' : 'permission.waiting', {
    title: ask.title || effect,
  })

  return (
    <FocusScope
      scope="permission"
      owner={ask.toolCallId}
      restingTarget={() => firstKeyRef.current}
    >
      {({ scopeProps }) => (
        <div
          {...scopeProps}
          className={s.permCard}
          role="group"
          aria-label={label}
          data-permission-card={ask.toolCallId}
          data-queued={queued || undefined}
          data-answered={answered ? 'true' : undefined}
        >
          {/* 标题单行截断,全称走 Tooltip(禁 native title=)。 */}
          <Tooltip content={ask.title || effect}>
            <div className={s.title}>{ask.title || effect}</div>
          </Tooltip>
          <div className={s.line}>
            <span className={s.effect}>{effect}</span>
            {/* 资源缺席就整格不画 —— 编一句「未知资源」是造事实。 */}
            {resource ? <span className={s.resource}>{resource}</span> : null}
          </div>
          <PermissionCardFoot
            t={t}
            ask={ask}
            firstKeyRef={firstKeyRef}
            onRespond={respond}
          />
        </div>
      )}
    </FocusScope>
  )
})

/**
 * 卡的下半截 —— **三选一**,而且三者互斥:
 *  · 排队中  → 一句实话,**不给键**(内核那份序列化队列一次只交出一张能答的卡);
 *  · 已答    → 一句「已允许 / 已拒绝,等核心确认」。它由 `permission:settled`
 *              收尾,不由发出去那一下的应答收尾 —— 远端答掉、超时自结算这两条路上
 *              壳一下都没点过,而卡照样得消失;
 *  · 能答    → 那一排键。
 *
 * 三档写成一处而不是在卡里洒三个 `&&`:它们说的是**同一格**的三种样子,分开写
 * 迟早出现「排队中还画着键」这种两档同屏。
 */
function PermissionCardFoot({
  t,
  ask,
  firstKeyRef,
  onRespond,
}: {
  t: TFn
  ask: PermissionAsk
  firstKeyRef: { current: HTMLButtonElement | null }
  onRespond: (decision: PermissionResponse) => void
}) {
  if (ask.permissionQueued) return <div className={s.state}>{t('permission.queued')}</div>
  if (ask.answered) {
    return (
      <div className={s.state}>
        {t(ask.answered === 'reject' ? 'permission.answeredReject' : 'permission.answeredAllow')}
      </div>
    )
  }

  const grantable = isGrantablePermissionType(ask.type)
  const scheme = ask.alwaysScope?.scheme

  return (
    <div className={s.actions}>
      <Button ref={firstKeyRef} variant="primary" onClick={() => onRespond('once')}>
        {t('permission.allowOnce')}
      </Button>
      {grantable && (
        <Button onClick={() => onRespond('session')}>{t('permission.allowSession')}</Button>
      )}
      {grantable && (
        <Button onClick={() => onRespond('workdir')}>{t('permission.allowWorkdir')}</Button>
      )}
      {/* 第四键**只在 `alwaysScope` 在场时**画,文案带 scheme(a50d4f99 留账)。 */}
      {scheme && (
        <Button data-permission-always={scheme} onClick={() => onRespond('always')}>
          {t('permission.allowAlways', { app: scheme })}
        </Button>
      )}
      <Button variant="danger" onClick={() => onRespond('reject')}>
        {t('permission.reject')}
      </Button>
    </div>
  )
}
