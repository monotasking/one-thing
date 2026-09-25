import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { Button } from '../../ui/Button'
import { Fold, FoldBody, FoldTrigger } from '../../ui/Fold'
import { Tooltip } from '../../ui/Tooltip'
import { ChevronDown, ChevronRight } from '../../components/icons'
import { FocusScope } from '../../focus/FocusScope'
import { useT, type TFn } from '../../i18n'
import { isGrantablePermissionType, type PermissionAsk } from '../../data/permission-ask'
import type { PermissionChoice } from '@shared/events/session-events'
import type { PermissionResponse } from '@shared/ipc/permissions'
import { BlockView } from '../blocks/BlockView'
import type { BlockCtx } from '../blocks/registry'
import { diffBlockOf } from '../tools/presenters/edit'
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
 * ── 发问方自带选项时(A3-d,`ask.choices` 在场;ACP agent 的审批)───────────
 * 「后端说有几个画几个」:agent 给了哪几种 kind 就画哪几颗,字用 agent 的原话
 * (它说「Always Allow」就是「Always Allow」—— 那是它对自己那一档的描述,我们
 * 翻译它等于替它改口);**颜色与位置由 kind 定**,不由字定:
 *  · `once`          → primary,排第一(与五钮里「允许一次」同位,落点也是它);
 *  · `session` / `workdir` → **照画**(可授权时)—— 它们是 onething 自己的记忆,
 *    不是 agent 的选项,后端答 agent 的 `allow_once`;
 *  · `always`        → ghost;
 *  · `reject`        → ghost(库里没有更安静的一档:primary 之外全是 ghost);
 *  · `reject-always` → danger(危险色只上字),排最后。
 * 应答的 `decision` 就是 kind 那个词(`reject-always` 也在内),**不带 optionId**——
 * 选哪一个 optionId 是后端按 kind 查 agent 那张表的事,壳回传等于让页面指定答案。
 * `choices` 缺席 = 上面那五个键,逐字不变(零回归,原有用例一条没改)。
 *
 * ── 改动预览(A3-d,`ask.diff` 在场)──────────────────────────────────────
 * 写文件的审批带着「准了就会写下去的那段 diff」。它画成**与工具卡抽屉同一个
 * diff 块**(`diffBlockOf`,唯一产地在 edit presenter 上),缺省收着,一行摘要
 * 「改动 · 路径 · +a −d」;点开才挂块(首次展开之后常驻,开合不重挂)——
 * 一张等人答的卡不该在收着的时候先去跑一趟高亮。
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
          {ask.diff ? <PermissionDiff t={t} ask={ask} diff={ask.diff} /> : null}
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
    const rejected = ask.answered === 'reject' || ask.answered === 'reject-always'
    return (
      <div className={s.state}>
        {t(rejected ? 'permission.answeredReject' : 'permission.answeredAllow')}
      </div>
    )
  }

  const grantable = isGrantablePermissionType(ask.type)
  if (ask.choices) {
    return (
      <ChoiceKeys
        t={t}
        choices={ask.choices}
        grantable={grantable}
        firstKeyRef={firstKeyRef}
        onRespond={onRespond}
      />
    )
  }
  const scheme = ask.alwaysScope?.scheme

  return (
    <div className={s.actions}>
      <Button ref={firstKeyRef} variant="primary" data-permission-decision="once" onClick={() => onRespond('once')}>
        {t('permission.allowOnce')}
      </Button>
      {grantable && (
        <Button data-permission-decision="session" onClick={() => onRespond('session')}>
          {t('permission.allowSession')}
        </Button>
      )}
      {grantable && (
        <Button data-permission-decision="workdir" onClick={() => onRespond('workdir')}>
          {t('permission.allowWorkdir')}
        </Button>
      )}
      {/* 第四键**只在 `alwaysScope` 在场时**画,文案带 scheme(a50d4f99 留账)。 */}
      {scheme && (
        <Button data-permission-always={scheme} data-permission-decision="always" onClick={() => onRespond('always')}>
          {t('permission.allowAlways', { app: scheme })}
        </Button>
      )}
      <Button variant="danger" data-permission-decision="reject" onClick={() => onRespond('reject')}>
        {t('permission.reject')}
      </Button>
    </div>
  )
}

/** kind 决定颜色与次序(判词在文件头「发问方自带选项时」)。 */
const CHOICE_ORDER: Record<PermissionChoice['kind'], number> = { once: 0, always: 1, reject: 2, 'reject-always': 3 }
const CHOICE_VARIANT: Record<PermissionChoice['kind'], 'primary' | 'ghost' | 'danger'> = {
  once: 'primary',
  always: 'ghost',
  reject: 'ghost',
  'reject-always': 'danger',
}

/**
 * 发问方自带选项的那一排键。`session` / `workdir` 插在 `once` 之后、`always` 之前 ——
 * 与五钮那一排的相对位置一样(「允许」一族从窄到宽,「拒绝」一族收尾)。
 * 同一种 kind 给了两格(协议没禁)就都画,次序按 agent 给的;落点(`firstKeyRef`)
 * 永远是这一排的第一颗。
 */
function ChoiceKeys({
  t,
  choices,
  grantable,
  firstKeyRef,
  onRespond,
}: {
  t: TFn
  choices: readonly PermissionChoice[]
  grantable: boolean
  firstKeyRef: { current: HTMLButtonElement | null }
  onRespond: (decision: PermissionResponse) => void
}) {
  const sorted = [...choices].sort((a, b) => CHOICE_ORDER[a.kind] - CHOICE_ORDER[b.kind])
  const allow = sorted.filter((choice) => choice.kind === 'once')
  const rest = sorted.filter((choice) => choice.kind !== 'once')
  let first = true
  const takeRef = () => {
    if (!first) return undefined
    first = false
    return firstKeyRef
  }
  const choiceKey = (choice: PermissionChoice) => (
    <Button
      key={choice.id}
      ref={takeRef()}
      variant={CHOICE_VARIANT[choice.kind]}
      data-permission-choice={choice.kind}
      data-permission-decision={choice.kind}
      onClick={() => onRespond(choice.kind)}
    >
      {choice.label}
    </Button>
  )
  return (
    <div className={s.actions}>
      {allow.map(choiceKey)}
      {grantable && (
        <Button ref={takeRef()} data-permission-decision="session" onClick={() => onRespond('session')}>
          {t('permission.allowSession')}
        </Button>
      )}
      {grantable && (
        <Button ref={takeRef()} data-permission-decision="workdir" onClick={() => onRespond('workdir')}>
          {t('permission.allowWorkdir')}
        </Button>
      )}
      {rest.map(choiceKey)}
    </div>
  )
}

/**
 * **改动预览**:一行摘要 + 收着的 diff 块(判词在文件头「改动预览」)。
 *
 * 块只在**第一次展开之后**才挂(`seen`),之后常驻 —— 开合走 `FoldBody` 的
 * `hidden`,不卸载(树/面常驻铁律)。块的上下文没有会话、没有文档目录:它长在
 * 一张卡里,按会话动手的钮本来就不该画(`BlockCtx.sessionId` 缺席的语义)。
 */
function PermissionDiff({ t, ask, diff }: { t: TFn; ask: PermissionAsk; diff: string }) {
  const [open, setOpen] = useState(false)
  const [seen, setSeen] = useState(false)
  const block = useMemo(
    () => diffBlockOf({ diff, path: ask.path, additions: ask.additions, deletions: ask.deletions }),
    [diff, ask.path, ask.additions, ask.deletions],
  )
  const ctx = useMemo<BlockCtx>(() => ({ messageId: `permission:${ask.permissionId}`, streaming: false }), [ask.permissionId])
  const stat =
    ask.additions !== undefined && ask.deletions !== undefined
      ? t('chat.tool.diffStat', { add: ask.additions, del: ask.deletions })
      : undefined
  return (
    <Fold
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setSeen(true)
      }}
    >
      <FoldTrigger className={s.diffHead} data-permission-diff={open ? 'open' : 'closed'}>
        {open ? (
          <ChevronDown className={s.diffIcon} aria-hidden="true" />
        ) : (
          <ChevronRight className={s.diffIcon} aria-hidden="true" />
        )}
        <span className={s.diffLabel}>{t('permission.diffLabel')}</span>
        {ask.path ? <span className={s.resource}>{ask.path}</span> : null}
        {stat ? <span className={s.diffStat}>{stat}</span> : null}
      </FoldTrigger>
      <FoldBody className={s.diffBody}>{seen ? <BlockView block={block} ctx={ctx} /> : null}</FoldBody>
    </Fold>
  )
}
