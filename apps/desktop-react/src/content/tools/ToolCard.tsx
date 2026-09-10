import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CARD_FLIP_MS, currentMotionTier } from '../../components/motion'
import { useLiveClock } from '../../components/useLiveClock'
import { resolveIcon } from '../../components/icons'
import { formatDuration } from '../../format/quantity'
import { useT, type TFn } from '../../i18n'
import { ButtonBase } from '../../ui/ButtonBase'
import { Tooltip } from '../../ui/Tooltip'
import type { BlockCtx } from '../blocks/registry'
import type {
  ToolCardEntry,
  ToolCardHead,
  ToolCardModel,
  ToolOutcomeModel,
  ToolRowModel,
  ToolStepModel,
} from '../model/segments'
import {
  cardProgressRatio,
  isBusyRevealed,
  isLiveStep,
  pickSlotStep,
  progressSummary,
  silentMsOf,
  stallLevel,
  stallSeconds,
  stepProgress,
  stepStartedAt,
  type StallLevel,
  type ToolProgress,
} from './card'
import { PermissionSlot } from '../permission/PermissionSlot'
import { ToolDrawer } from './ToolDrawer'
import { EXPANDABLE_STATUSES, toolStatusLabel, toolTone, type ToolTone } from './status'
import s from './ToolCard.module.css'

/**
 * 工具卡 —— **一张卡装一列步**(§6.1「一件事一张脸」)。
 *
 * 一次调用是一步的卡,连续多次调用是多步的卡:**同一个组件、同一张壳**,
 * 没有第二种画法。从前的 `ToolGroup`(收起时一句「执行了 7 步」的计数句)与
 * `ToolRow`(单发那张卡)合成了这一件;计数句退役 —— 头行画的是**这几步本身**。
 *
 * ── 流中态稳定性纪律(§6.5 九条)在这个文件里的落点 ─────────────────────
 *
 *  1. **行不重挂**:每一步的行 key = `callId`,而且**永远挂在树上** —— 收起态
 *     只画活槽位那一行,靠的是 `hidden` 属性,不是把别的行卸载。从第一个参数
 *     delta 到收场,那一行是同一个 DOM 节点;流中态的每一次变化只改文本与
 *     `data-*`。(唯一一次换元素在「参数收齐 → 开始执行」那一下:不能展开的行
 *     不画钮、能展开的画钮 —— 那是第 4 条明许的三处换挡之一。)
 *  2. **几何锁定**:行高有地板、摘要单行截断、耗时定宽 tabular-nums 右对齐 ——
 *     全在 `ToolCard.module.css`,这里一个像素都不写。
 *  3. **节拍**:一张卡**一只**时钟(`useLiveClock`),10Hz,只在有活步时起;
 *     收场了的行拿到的 `now` 恒为 0,于是它们的 `memo` 一次都不再算。
 *  4. **换挡只有三处**改结构(参数收齐 / 开始执行 / 收场)。
 *  6. **活槽位常驻**:`pickSlotStep` —— 卡不在步与步之间缩回只剩头行。
 *  7. **快步骤不闪**:`isBusyRevealed` —— 250ms 内收场的步不露 busy 形。
 *  8. **结构变化走 FLIP**:`useFlipHeight`,180ms,动效档 none 直切。
 *  9. **读数定宽**:同第 2 条;头行那一叠图标只在**工具种类**集合变化时才换
 *     (`head.icons` 由种类推导,种类没变它逐字相同,React 不动那几个节点)。
 *
 * ── 病历:切会话点击同步 908ms,715ms 全在这一只卡的 FLIP 里(2026-09-10)──
 *
 * 真会话(388 条消息、场上 916 张工具卡)在停靠池命中那条路上复现:切过去的
 * 那一下 click 同步 908ms,CPU 自调 715ms 落在 `useFlipHeight` 的 layout effect。
 * 病不在 FLIP 本身 —— 是**它无条件先读一次 `el.offsetHeight` 再判要不要做**。
 *
 * 切会话是整片叶卸载重挂,916 张卡在**同一次提交**里挂上来,每张都在 React 刚
 * 改完 DOM 之后逼浏览器把 27 万像素的文档全量排一次版:微基准 0.34–0.41ms/张
 * × 916 = 315–372ms 纯排版;而布局干净时同样这 916 次读只要 0.8–1.5ms。
 * 「读一个几何属性」这件事本身不要钱,**在脏布局上读**才要 ——
 * 一次读 + 一次改 + 再一次读,就是一次强制同步排版(layout thrashing)。
 *
 * 所以判据挪到读之前,而且**首帧一次都不许同步量**:首帧压根没有「改前」,
 * 那一次读量到的高只是**下一次**的起点,晚一帧拿到与当场拿到完全等价。
 * 把它排进 `requestAnimationFrame`:916 张卡的回调落在同一帧、布局已经算好,
 * 第一个读的把版排一次,其余 915 个白拿 —— 从 O(n) 次排版回到 O(1) 次。
 *
 * **为什么是 rAF 不是 ResizeObserver**:RO 报的是「这个盒子的尺寸变了」,
 * 而这里要的是「**这一次提交之后**它多高」——不变也得有个数(下一次 FLIP 的
 * 起点),RO 在没变时一声不吭。rAF 的语义正好是「这一帧的活干完了」,
 * 而且零新观察者、零常驻订阅,卸载时一句 `cancelAnimationFrame` 就干净。
 */
export const ToolCard = memo(function ToolCard({
  card,
  ctx,
}: {
  card: ToolCardModel
  ctx: BlockCtx
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(EMPTY_KEYS)
  const cardRef = useRef<HTMLDivElement | null>(null)

  const toggleOpen = useCallback(() => setOpen((value) => !value), [])
  const toggleKey = useCallback((key: string) => {
    setOpenKeys((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }, [])

  // 有活步才需要一只钟:一条会话里九成的工具卡是收场了的,它们不该有定时器。
  const live = card.steps.some(isLiveStep)
  const now = useLiveClock(READOUT_TICK_MS, live)

  const slot = live || card.steps.length > 1 ? pickSlotStep(card.steps, now) : card.steps[0]
  const multi = card.steps.length > 1

  /*
   * 谁看得见 —— **一次算清**,行自己不判。
   *
   * 收起:只有活槽位那一行;展开:全部,但被快步骤门挡住的那一步除外
   * (它还没够格露 busy 形);聚合行下的逐条要那一格开着才看得见。
   */
  const visible = useMemo(() => {
    const ids = new Set<string>()
    for (const entry of card.entries) {
      const aggregated = multi && open && entry.count > 1
      for (const step of entry.children) {
        const id = step.row.callId
        if (aggregated ? openKeys.has(aggregateKey(entry)) : open || !multi || step === slot) {
          ids.add(id)
        }
      }
    }
    // 快步骤门:还没够格露 busy 形的步不露面 —— 除非它就是活槽位
    // (那时卡上一行都没有,空着比闪更糟)。
    for (const step of card.steps) {
      if (!isBusyRevealed(step, now) && step !== slot) ids.delete(step.row.callId)
    }
    return ids
  }, [card.entries, card.steps, multi, open, openKeys, slot, now])

  /*
   * FLIP 的触发条件:**结构**变了才量高。
   *
   * 逐帧的文字补丁(耗时在走、命令逐字长)不改高度,量它只是每 100ms 强排一次版。
   * 所以这里把「谁在、谁看得见、谁开着」拼成一个字符串当依赖 —— 它变了才是第 8 条
   * 说的那种「结构变化」。
   */
  const structure = `${multi}|${open}|${card.steps.length}|${[...visible].join(',')}|${[...openKeys].sort().join(',')}`
  useFlipHeight(cardRef, structure)

  /*
   * 底缘那条进度条(§6.2「执行中」列,C2-b)。
   *
   * **只有工具真报了 `ratio` 才有** —— 一条恒为 0 的条是造事实。它绝对定位在卡
   * 的底缘,不占布局(§6.5 第 2 条几何锁:画不画都不动卡高,所以它也不进上面
   * 那个 `structure` —— 它不是「结构变化」,量高会白白多一次强排版)。
   */
  const ratio = cardProgressRatio(card.steps)
  const sessionId = ctx.sessionId

  return (
    /*
     * 段只渲染一个元素、不加包裹层(SegmentView 的纪律),所以这个 `div` **自己**
     * 就是那张卡。一步与多步在这里是同一个元素、同一批类名 —— 第二次调用到达时
     * React 在同一位置见到的还是它,打补丁不重挂(09-01 P2 那条真机判例)。
     *
     * `data-prose` 两支都有:工具那件东西按物件档留白(content/ChatStream.module.css)。
     * 色调**不在卡上** —— 一张卡里可以同时有 busy / ok / bad 三行,挂在卡上会让
     * 后代选择器把每一行都染成同一色。它在各行自己身上。
     */
    <div
      ref={cardRef}
      className={s.toolCard}
      data-tool-card="true"
      data-multi={multi || undefined}
      data-open={(multi && open) || undefined}
      data-prose="object"
    >
      {card.head && (
        <ToolCardHeadRow t={t} head={card.head} open={open} onToggle={toggleOpen} />
      )}
      <div className={s.list}>
        {card.entries.map((entry) => (
          <ToolCardEntryRows
            key={aggregateKey(entry)}
            t={t}
            entry={entry}
            ctx={ctx}
            aggregated={multi && open && entry.count > 1}
            aggregateOpen={openKeys.has(aggregateKey(entry))}
            onToggleAggregate={toggleKey}
            visible={visible}
            openKeys={openKeys}
            onToggleDrawer={toggleKey}
            now={now}
          />
        ))}
      </div>
      {/*
        * 进度条:`role="progressbar"` + 三个 aria 值,读屏因此读得出「几成」。
        * 只改 `width`(合成器上的一格),不改任何参与布局的属性 —— §6.5 第 1 条
        * 「零重挂」在这一格上的落点是:同一个节点从 12% 走到 87%,不换元素。
        */}
      {/*
        * **审批槽**(应用级许可 · 壳半边,2026-09-10)。
        *
        * 落点在行列之外、进度条之前:一张等着人答的卡在**收起态也必须看得见**,
        * 而行在收起态是 `hidden` 的(§6.5 第 1 条)。一步一格槽,理由(订阅粒度)
        * 写在 `PermissionSlot` 头上;没有审批时它画 `null`,一个 DOM 节点都不多。
        *
        * `ctx.sessionId` 缺席 = **这里没有会话**(查看器里回放一份 markdown 也会
        * 长出工具卡)。那时整格不画 —— 画一颗按下去不知道打给谁的键,比不画糟。
        */}
      {sessionId !== undefined &&
        card.steps.map((step) => (
          <PermissionSlot
            key={step.row.callId}
            sessionId={sessionId}
            toolCallId={step.row.callId}
          />
        ))}
      {ratio !== undefined && (
        <div
          className={s.tbar}
          data-tool-progress="true"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={ratio}
        >
          <div className={s.tbarFill} style={{ width: `${(ratio * 100).toFixed(1)}%` }} />
        </div>
      )}
    </div>
  )
})

/**
 * 读数的刷新节拍。
 *
 * 100ms 是「读数」该有的节拍:比它慢,秒的小数位会一顿一顿;比它快,除了多烧几次
 * 渲染什么都不多。它**不是动效时长** —— 动效档一格都不动它,所以它没有 CSS token
 * (与 `StreamReadout.READOUT_TICK_MS` 同一条判;两处归并等 C1 的消息尾读数落地)。
 */
const READOUT_TICK_MS = 100

const EMPTY_KEYS: ReadonlySet<string> = new Set<string>()

/** 一格的稳定身份:工具名 + 这一格第一步的 callId —— 前后两帧同一格就是同一个串。 */
function aggregateKey(entry: ToolCardEntry): string {
  return `${entry.tool}:${entry.children[0]?.row.callId ?? ''}`
}

/**
 * 一格:聚合行(可有可无)+ 它的逐条。
 *
 * 逐条**永远渲染**,看不看得见由 `hidden` 说 —— 这是第 1 条「行不重挂」的落点:
 * 一行从第一个参数 delta 到收场是同一个 DOM 节点,收起 / 展开 / 换活槽位都只是
 * 改那个属性。
 */
function ToolCardEntryRows({
  t,
  entry,
  ctx,
  aggregated,
  aggregateOpen,
  onToggleAggregate,
  visible,
  openKeys,
  onToggleDrawer,
  now,
}: {
  t: TFn
  entry: ToolCardEntry
  ctx: BlockCtx
  aggregated: boolean
  aggregateOpen: boolean
  onToggleAggregate: (key: string) => void
  visible: ReadonlySet<string>
  openKeys: ReadonlySet<string>
  onToggleDrawer: (key: string) => void
  now: number
}) {
  const key = aggregateKey(entry)
  return (
    <>
      {entry.count > 1 && (
        <AggregateRow
          t={t}
          entry={entry}
          open={aggregateOpen}
          hidden={!aggregated}
          onToggle={() => onToggleAggregate(key)}
        />
      )}
      {entry.children.map((step) => (
        <ToolStepRow
          key={step.row.callId}
          step={step}
          ctx={ctx}
          hidden={!visible.has(step.row.callId)}
          child={aggregated}
          drawerOpen={openKeys.has(drawerKey(step))}
          onToggleDrawer={onToggleDrawer}
          // 收场了的行拿到的「此刻」恒为 0:它的 memo 因此在 10Hz 的时钟下一次都不算。
          now={isLiveStep(step) ? now : 0}
        />
      ))}
    </>
  )
}

function drawerKey(step: ToolStepModel): string {
  return `drawer:${step.row.callId}`
}

const CaretIcon = resolveIcon('ChevronRight')

/**
 * 头行 —— 与步行**同一套栅格**:图标位画一叠最多三枚工具图标、名位画摘要句、
 * 右端画总耗时与失败点。
 *
 * 它是**结构件**(视觉本该定制),三类判的第三类:皮肤留本地、清 UA 归 ButtonBase。
 */
function ToolCardHeadRow({
  t,
  head,
  open,
  onToggle,
}: {
  t: TFn
  head: ToolCardHead
  open: boolean
  onToggle: () => void
}) {
  return (
    <ButtonBase
      className={`${s.row} ${s.head}`}
      data-tool-head="true"
      data-tool-tone={head.live ? 'busy' : head.failed > 0 ? 'bad' : 'ok'}
      aria-expanded={open}
      onClick={onToggle}
    >
      <CaretIcon className={s.caret} strokeWidth={2} aria-hidden="true" />
      <span className={s.stack}>
        {head.icons.map((icon) => {
          const Icon = resolveIcon(icon)
          return <Icon key={icon} className={s.toolIcon} strokeWidth={1.75} aria-hidden="true" />
        })}
      </span>
      <span className={s.headText}>{head.text}</span>
      <span className={s.toolRight}>
        {head.failed > 0 && (
          <span className={s.failed}>{t('chat.toolGroup.failed', { n: head.failed })}</span>
        )}
        {head.durationMs !== undefined && (
          <span className={s.toolDuration}>{formatDuration(head.durationMs)}</span>
        )}
      </span>
    </ButtonBase>
  )
}

/** 聚合行「read ×3」—— 同判,结构件。 */
function AggregateRow({
  t,
  entry,
  open,
  hidden,
  onToggle,
}: {
  t: TFn
  entry: ToolCardEntry
  open: boolean
  hidden: boolean
  onToggle: () => void
}) {
  const Icon = resolveIcon(entry.row.icon)
  return (
    <ButtonBase
      className={s.row}
      data-tool-aggregate="true"
      data-tool-tone={entry.failed > 0 ? 'bad' : 'ok'}
      aria-expanded={open}
      hidden={hidden}
      onClick={onToggle}
    >
      <Icon className={s.toolIcon} strokeWidth={1.75} aria-hidden="true" />
      <span className={s.toolName}>{entry.tool}</span>
      <span className={s.times}>{t('chat.toolGroup.times', { n: entry.count })}</span>
      <span className={s.toolRight}>
        {entry.failed > 0 && (
          <span className={s.failed}>{t('chat.toolGroup.failed', { n: entry.failed })}</span>
        )}
      </span>
    </ButtonBase>
  )
}

/**
 * 一步的一行(+ 拉开的抽屉)。
 *
 * `memo` 挡的是 10Hz 那只钟:收场了的行 `now` 恒为 0,props 逐帧全等,一次都不重算。
 */
const ToolStepRow = memo(function ToolStepRow({
  step,
  ctx,
  hidden,
  child,
  drawerOpen,
  onToggleDrawer,
  now,
}: {
  step: ToolStepModel
  ctx: BlockCtx
  hidden: boolean
  child: boolean
  drawerOpen: boolean
  onToggleDrawer: (key: string) => void
  now: number
}) {
  const t = useT()
  const { row, call } = step
  const live = isLiveStep(step)

  /*
   * 活性读数(§6.6)。判据是**静默时长**,不是猜测 —— 壳只会说「多久没收到数据」,
   * 「它卡住了」永远不是壳的判断(真正的收场是引擎那侧的超时与重试)。
   *
   * 收场了的行不算:`now` 是 0,而它本来也没有「还在等」这回事。
   */
  // 「这台从什么时候开始等它」—— 冷开会话时账本里那次没有结局的老调用靠它,
  // 静默从**打开会话**算起而不是从对端两年前的钟算起(见 `silentMsOf`)。
  const watchedSince = useRef(0)
  if (live && now > 0 && watchedSince.current === 0) watchedSince.current = now
  const silentMs = live && now > 0 ? silentMsOf(call, watchedSince.current, now) : 0
  const stall: StallLevel = live ? stallLevel(silentMs) : 'none'
  const tone: ToolTone = stall === 'none' ? toolTone(row.status) : 'warn'

  // 抽屉状态住组件本地,**不进模型**:「这一行现在是开着的」是这台屏幕此刻的事,
  // 不是这次调用的事实。进了模型,同一条消息在两个窗口里就得共享展开态。
  //
  // 能不能展开由 `EXPANDABLE_STATUSES` 说:收场了的三档 + 执行中(拍点 ⑩)。
  // 参数生成中仍然不能 —— 那一刻连一份参数都摆不出来。
  const expandable = EXPANDABLE_STATUSES.has(row.status)
  const toggle = useCallback(() => onToggleDrawer(drawerKey(step)), [onToggleDrawer, step])

  // 露出 busy 形的行淡入进场(§6.5 第 7 条);快步骤根本走不到这里。
  const reveal = live && isBusyRevealed(step, now) ? 'busy' : undefined

  // 执行中的过程读数(C2-b)。收场了的步没有 —— `stepProgress` 自己判。
  const progress = stepProgress(step)

  const face = (
    <ToolRowFace
      t={t}
      row={row}
      tone={tone}
      stall={stall}
      silentMs={silentMs}
      now={now}
      // 活耗时的起点是**调用**的事实(引擎记的执行起点),不是那一行的 ——
      // 所以它从这里传下去,不往 `ToolRowModel` 里塞一个只有渲染用得着的字段。
      startedAt={stepStartedAt(call)}
      // 进度同理:它是**这次调用此刻**的读数,不是那一行的静态属性。
      progress={progress}
    />
  )

  return (
    <>
      {expandable ? (
        /* 一行工具是**结构件**(图标 · 名 · 摘要 · 右端读数,视觉本该定制)——
         * 三类判的第三类,皮肤留本地、清 UA 归 `ui/ButtonBase`。 */
        <ButtonBase
          className={s.row}
          data-call-id={row.callId}
          data-tool-status={row.status}
          data-tool-tone={tone}
          data-child={child || undefined}
          data-reveal={reveal}
          hidden={hidden}
          aria-expanded={drawerOpen}
          onClick={toggle}
        >
          {face}
        </ButtonBase>
      ) : (
        // 不能展开时**不画按钮**:一个按得动却什么也不发生的钮是「假按钮」,
        // 它比没有钮更费人 —— 焦点会停在它上面,读屏会念它可点。
        <div
          className={s.row}
          data-call-id={row.callId}
          data-tool-status={row.status}
          data-tool-tone={tone}
          data-child={child || undefined}
          data-reveal={reveal}
          hidden={hidden}
        >
          {face}
        </div>
      )}
      {drawerOpen && !hidden && (
        <ToolDrawer call={call} ctx={ctx} live={live} progress={progress} />
      )}
    </>
  )
})

/** 一行的四格:图标 · 名 · 摘要 · 右端。三种形态共用。 */
function ToolRowFace({
  t,
  row,
  tone,
  stall,
  silentMs,
  now,
  startedAt,
  progress,
}: {
  t: TFn
  row: ToolRowModel
  tone: ToolTone
  stall: StallLevel
  silentMs: number
  now: number
  startedAt?: number
  progress?: ToolProgress
}) {
  const Icon = resolveIcon(row.icon)
  const streaming = row.status === 'input-streaming'
  /*
   * 摘要三级(§6.2「执行中」列,C2-b):
   *
   *  · **静默**了就换成读数 —— 「命令逐字长」这句话在数据停了之后就是假的
   *    (这一级最先判,进度也压不过它:有进度就不会静默);
   *  · 有**进度**就说进度(输出尾行 → 工具那一句),那是它此刻真的在干的事;
   *  · 都没有就是今天那一份(presenter 算出来的参数摘要)。
   */
  const summary =
    stall !== 'none'
      ? t(streaming ? 'chat.tool.stallArgs' : 'chat.tool.stallData', {
          n: stallSeconds(silentMs),
        })
      : progressSummary(progress) ?? row.summary

  return (
    <>
      <Icon className={s.toolIcon} strokeWidth={1.75} aria-hidden="true" />
      {/* 全名走 `ui/Tooltip`(禁 native `title=`):行上画的是短名,长的那一句
        * (带参数的标题)在悬停时说。cloneElement 注入,不多包一层 DOM。 */}
      <Tooltip content={row.title}>
        <span className={s.toolName}>{row.name}</span>
      </Tooltip>
      {(summary || streaming) && (
        <span className={s.toolSummary}>
          {summary}
          {/* 参数还在长:一枚打字光标。右端因此**不写字** —— 光标已经说了。 */}
          {streaming && <span className={s.cursor} aria-hidden="true" />}
        </span>
      )}
      <span className={s.toolRight}>
        {stall === 'hard' && <span className={s.stallHard}>{t('chat.tool.stallStuck')}</span>}
        {/*
          * **这里不转圈**(09-02 批 6 兑现禁令)。判的是这一格算不算「状态栏」:
          * 不算 —— 它是一行工具自己的右端读数,长在聊天正文流里,不是壳的状态栏。
          */}
        <ToolRightText t={t} row={row} tone={tone} now={now} startedAt={startedAt} />
      </span>
    </>
  )
}

/**
 * 右端那一格。
 *
 * 三段各说各的(§6.2):
 *  · **参数生成中**:什么都不写 —— 光标已经说了「还在长」,再补一句「参数生成中」
 *    就是同一件事说两遍(而它还会在收齐那一帧消失,平添一次跳)。
 *  · **执行中**:活的耗时,10Hz 走。从前那句「执行中」退役 —— 一个不变的词
 *    在数据停了之后一个字都不变,正是用户报的「不知道它是不是卡住了」。
 *  · **收场**:成果词 + 耗时。成功那一支**允许什么都不显示**:没有成果词、也没算出
 *    耗时时右端就是空的。这正是「无打卡词」的意思 —— 宁可空着,不拿一句「已完成」去填。
 */
function ToolRightText({
  t,
  row,
  tone,
  now,
  startedAt,
}: {
  t: TFn
  row: ToolRowModel
  tone: ToolTone
  now: number
  startedAt?: number
}) {
  if (row.status === 'input-streaming') return null

  if (row.status === 'executing') {
    // 算不出起点就不画:一个从 0 开始重新跑的读数比没有读数更误导人。
    const elapsed = startedAt !== undefined && now > 0 ? now - startedAt : undefined
    return elapsed === undefined ? null : (
      <span className={s.toolDuration}>{formatDuration(elapsed)}</span>
    )
  }

  if (tone === 'ok') {
    return (
      <>
        {row.outcome && <span className={s.toolOutcome}>{outcomeText(t, row.outcome)}</span>}
        {row.durationMs !== undefined && (
          <span className={s.toolDuration}>{formatDuration(row.durationMs)}</span>
        )}
      </>
    )
  }
  // 失败 / 取消 / 认不出:成果词缺席时退到那一档状态的说法(认不出就是英文枚举)。
  const text = row.outcome ? outcomeText(t, row.outcome) : toolStatusLabel(t, row.status)
  return <span className={s.toolOutcome}>{text}</span>
}

/** 模型说的是「哪一句 + 变量」;翻译发生在这里,所以切语言当场生效。 */
export function outcomeText(t: TFn, outcome: ToolOutcomeModel): string {
  return 'text' in outcome ? outcome.text : t(outcome.key, outcome.vars)
}

/**
 * 卡高从「改前」到「改后」做过渡(§6.5 第 8 条 FLIP)。
 *
 * 量两次(上一次提交后的高、这一次提交后的高),把内联 height 先钉回旧值、
 * 强制一次排版、再钉到新值让它自己走过去 —— 不突变。
 *
 * 只在 `structure` 变了时跑:逐帧的文字补丁不改高度,量它只是每 100ms 白白强排一次版。
 * 动效档 `none` 直切(不是「快一点」,是压根不做)。
 *
 * **三条次序纪律**(病历在文件头,读数 715ms/916 张卡):
 *  ① 判据排在读之前 —— `none` 档整段不做,那就一个几何属性都不该碰;
 *  ② 首帧(`before` 为 0)没有「改前」,基线读排进 `requestAnimationFrame`
 *     ——晚一帧拿到与当场拿到等价,而当场拿到是一次强制同步排版;
 *  ③ 只有真有「改前」的那一次照旧**同步**量并当场 FLIP —— 那一次非同步不可
 *     (要在浏览器绘制之前把起点钉住),而它一次只发生在一张卡上。
 */
function useFlipHeight(ref: React.RefObject<HTMLDivElement | null>, structure: string): void {
  const lastHeight = useRef(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // ① none 档压根不做这件事 —— 连基线都不必量(读在前判在后,就是 916 次白排版)。
    if (currentMotionTier() === 'none') return

    const before = lastHeight.current
    if (!before) {
      /*
       * ② 首帧:只取下一次的起点。没有 rAF 的宿主(jsdom 非 visual / SSR)
       * 也就没有帧可动,基线索性不取 —— 下一次结构变化照旧当首帧处理,
       * 结果是「不做 FLIP」,而不是「在脏布局上补一次同步读」。
       */
      if (typeof requestAnimationFrame !== 'function') return
      const frame = requestAnimationFrame(() => {
        const node = ref.current
        if (node) lastHeight.current = node.offsetHeight
      })
      return () => cancelAnimationFrame(frame)
    }

    // ③ 真有「改前」:同步量「改后」,当场把两头钉住。
    const after = el.offsetHeight
    lastHeight.current = after
    if (before === after) return

    el.style.transition = 'none'
    el.style.height = `${before}px`
    // 强制一次排版,让上面那一句成为动画的起点(不读它的话浏览器会把两次写合并)。
    void el.offsetHeight
    el.style.transition = `height var(--dur-card-flip) var(--ease)`
    el.style.height = `${after}px`

    const clear = () => {
      el.style.height = ''
      el.style.transition = ''
    }
    const timer = window.setTimeout(clear, CARD_FLIP_MS + FLIP_SETTLE_MS)
    return () => {
      window.clearTimeout(timer)
      clear()
    }
  }, [ref, structure])
}

/** 过渡跑完到摘掉内联 height 之间留的一点余量 —— 定时器与合成器不是同一个时钟。 */
const FLIP_SETTLE_MS = 40
