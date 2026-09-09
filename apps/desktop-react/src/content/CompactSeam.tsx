import { useMemo, type CSSProperties } from 'react'
import { ChevronDown } from '../components/icons'
import { selectEngineBusy, useChatSourceOf } from '../data/chat-source'
import { commandsPort } from '../data/commands-port'
import { formatQuantity } from '../format/quantity'
import { useT, type TFn } from '../i18n'
import { getLogger } from '../services/log'
import { ButtonBase } from '../ui/ButtonBase'
import { Fold, FoldBody, FoldFoot, FoldTrigger } from '../ui/Fold'
import { blockKey } from './assemble'
import { markdownToFrame } from './assemble/markdown'
import { BlockView } from './blocks/BlockView'
import type { BlockCtx } from './blocks/registry'
import type { CompactMarker } from './compact/marker'
import s from './SegmentView.module.css'

/**
 * **压缩折痕**(U2,设计正本 `docs/compact-seam-2026-09.md` §3.1;样例页
 * `docs/compact-seam-proposal-2026-09-08.html` ①–④ 节)。
 *
 * ── 一句话:压缩不是一件物件,是流里的一道折痕 ────────────────────────────
 * 它说的是「这条线以上已经折进摘要」,所以画成**一条贯穿整行的细线 + 一枚居中的
 * 标签**,不画成一张卡:卡是「一件东西」,而这里发生的事是「上面那些不见了」。
 * 起因是 09-08 那次事故 —— 压缩失败落进会话里的是一条 system 消息的原始 JSON,
 * 而压缩进行中、压完之后屏幕上一个像素都没有。
 *
 * ── 动效只在线上走,不转圈 ──────────────────────────────────────────────
 * 进行中是一束光沿折痕来回扫(`--kf-seam-sweep`),多块时线本身按 k/N 从左填色。
 * 壳的禁令「Spinner 只许出现在按钮内或状态栏」在这里成立,`--kf-dots`(三点跳)
 * 也不用 —— 那是**文字**的动作,会把标签变成一个在说话的东西;光扫是**这条线自己**
 * 的动作(设计正本 §4 第二条)。
 *
 * ── 事实从哪来 ──────────────────────────────────────────────────────────
 * 三态、k/N、前后读数全在 marker 里,而 marker 的唯一解析产地是
 * `content/compact/marker.ts` —— **折痕不自己解析 JSON**。后端每压完一块就刷一次
 * 那条 system 消息的正文,装配管线按消息引用 memo、marker 随 content 换引用,
 * 所以进度是自然刷新的:这只组件没有任何订阅、没有计时器、不订
 * `context:compact-*` 事件(壳里那条事件今天仍无消费者,留账)。
 *
 * ── 三张状态表(施工纪律「状态先行」)──────────────────────────────────
 * ① 生命周期:纯展示件 + 一格按会话的读数(失败态那颗钮才订阅)。无模块级副作用、
 *    无计时器、无监听 → **不需要 HMR dispose**。唯一的宿主是消息那一行的 flex 列;
 *    换会话 / 换宿主对它没有意义 —— 它就是段序列里的一段。
 * ② UI 生命状态:没有 empty(没有 marker 就没有这个段)、没有 loading(compacting
 *    本身就是那一档)、没有独立的 error 档(failed 是三态之一)。**超量**两处:
 *    标签一行只截断不换行(结构行,弯腰件),摘要正文过长时由 Fold 关着 +
 *    块自己的钳高管。
 * ③ UI 交互状态:compacting / failed 的标签**不可点**(那里没有第二件事可做);
 *    completed 的标签是 `ui/Fold` 的触发器(rest / hover / focus 全局环 / 展开),
 *    失败态多一颗行内重试(rest / hover / **disabled**:引擎在跑时原生 disabled,
 *    不配 Tooltip —— 禁灰的理由由灰色本身承担,09-08 重试钮判例)。
 *
 * ── 留账 ────────────────────────────────────────────────────────────────
 * 折痕**以上**的消息不变灰(设计正本 §5:先看真机,变灰是第二步)。
 */
export function CompactSeam({ marker, ctx }: { marker: CompactMarker; ctx: BlockCtx }) {
  const t = useT()
  /*
   * 线的填色比例。**只有多块压缩才有** —— 单块时 `--seam-fill` 整个不出现,
   * CSS 里那格 `var(--seam-fill, 0)` 的兜底 0 说的正是「没有进度可报」。
   * 自定义属性的值是个算出来的比值,不是字面量(Token 纪律管的是写死的量)。
   */
  const fill = marker.progress
    ? Math.min(1, marker.progress.chunk / marker.progress.totalChunks)
    : undefined

  return (
    <div
      className={s.seam}
      /* 三态的**唯一**开关:线怎么画、标签什么色,全挂在这一格上(CSS 那边一条
         `[data-state=…]` 一句话),组件里不拼 className 字符串。 */
      data-state={marker.status}
      /* 节奏表的钩子(表在 content/ChatStream.module.css):折痕按**物件**档留白,
         与错误卡同一档 —— 它上下都该有一口气,而不是像一段字那样贴着。 */
      data-prose="object"
      data-testid="compact-seam"
      style={fill === undefined ? undefined : ({ '--seam-fill': String(fill) } as CSSProperties)}
    >
      {marker.status === 'completed' ? (
        <CompletedSeam marker={marker} ctx={ctx} t={t} />
      ) : marker.status === 'failed' ? (
        <FailedSeam marker={marker} sessionId={ctx.sessionId} t={t} />
      ) : (
        <RunningSeam marker={marker} t={t} />
      )}
    </div>
  )
}

/**
 * **进行中**。标签只有一句话;多块时后面跟一格 `2 / 5`(tabular-nums —— 数字换位
 * 时不许推着前面那句话动)。单块**没有** k/N 那一格:半个进度不是进度,而
 * `marker.progress` 缺席说的正是「后端这次没分块」。
 */
function RunningSeam({ marker, t }: { marker: CompactMarker; t: TFn }) {
  return (
    <>
      <span className={s.seamLine} />
      <span className={s.seamLabel} data-testid="compact-seam-label">
        {t('chat.compactRunning')}
        {marker.progress && (
          <span className={s.seamCount}>
            {t('chat.compactProgress', {
              chunk: marker.progress.chunk,
              total: marker.progress.totalChunks,
            })}
          </span>
        )}
      </span>
      <span className={s.seamLine} />
    </>
  )
}

/**
 * **完成**。标签是折叠触发器,摘要正文**默认折**(压完那一刻用户在等回复,不在读
 * 摘要;与思考段「想完就折回去」同一口径,设计正本 §4 第三条)。
 *
 * 触发器走 `ui/Fold` 的 div/span 形(裸钮三类判的第三类:结构性交互件,视觉本该
 * 定制 —— 换成 28px 描边的 `ui/Button` 是改版不是等价迁移),圈选守卫与 ↵ / Space
 * 归 Fold,这里不写第二份。
 *
 * **摘要为空时它不是折叠件**:没有正文的折叠头按下去什么都不会发生,那颗 chevron
 * 是在撒谎。所以这一支退成一枚普通标签 —— 状态表沉默的那一格,按组件规格补齐。
 */
function CompletedSeam({ marker, ctx, t }: { marker: CompactMarker; ctx: BlockCtx; t: TFn }) {
  const label = completedLabel(t, marker)
  if (!marker.summary) {
    return (
      <>
        <span className={s.seamLine} />
        <span className={s.seamLabel} data-testid="compact-seam-label">
          {label}
        </span>
        <span className={s.seamLine} />
      </>
    )
  }
  return (
    <Fold>
      <span className={s.seamLine} />
      <FoldTrigger
        as="span"
        className={`${s.seamLabel} ${s.seamLabelFold}`}
        data-testid="compact-seam-label"
      >
        {label}
        <ChevronDown className={s.seamChevron} strokeWidth={1.9} aria-hidden="true" />
      </FoldTrigger>
      <span className={s.seamLine} />
      <FoldBody className={s.seamSummary} data-testid="compact-seam-summary">
        <CompactSummary text={marker.summary} ctx={ctx} />
      </FoldBody>
      {/* 底把手:摘要往往几屏长,读到底还得滚回顶上那枚标签才能收 —— 这颗只在
          展开态出场,按下合上并把标签送回视野(行为在 ui/Fold,这里只有皮肤)。 */}
      <FoldFoot as="span" className={s.seamFoot} data-testid="compact-seam-foot">
        <ChevronDown className={s.seamFootChevron} strokeWidth={1.9} aria-hidden="true" />
        {t('chat.compactCollapse')}
      </FoldFoot>
    </Fold>
  )
}

/**
 * 摘要正文 —— **走块渲染,不是 `pre-wrap` 文本**。
 *
 * 摘要是模型写出来的 markdown(样例页 ③ 里那份带小标题与清单的),而这台上
 * 「markdown → 块」只有一条路:`assemble/markdown.ts` + `BlockView`。原样摆一段
 * pre-wrap 会让同一份文本在折痕里和在回复里长得不一样,那是两套渲染。
 *
 * 身份号带 `#compact` 后缀:块流那台机器按 id 记车道,与这条消息本身的正文
 * (压缩标记不产 rich-text 段,所以今天不会撞;后缀是给将来留的护栏)。
 * `live` 恒为 false —— 摘要是压完那一刻一次性落账的,没有「正在长」这回事。
 */
function CompactSummary({ text, ctx }: { text: string; ctx: BlockCtx }) {
  const id = `${ctx.messageId}#compact`
  const frame = useMemo(() => markdownToFrame(id, text, false), [id, text])
  return (
    <>
      {frame.blocks.map((block, index) => (
        <BlockView
          key={blockKey(id, index, block, frame.offsets[index], frame.ids?.[index])}
          block={block}
          ctx={ctx}
        />
      ))}
    </>
  )
}

/**
 * **失败 / 中断**。两件事一起说:一句「压缩失败」+ **provider 那句原文**。
 *
 * 原句不改写、不总结(与错误卡同一条纪律:后端说的话原样显示)。中断改判
 * (`timeline.ts` 把卡死的 compacting 判成 failed)走的是同一支 —— 它的 error 是一句
 * 固定文案,照样原样显示,不为它多开一格状态:屏幕上要说的是同一件事。
 *
 * **不飞 toast**:它已经落在会话里且带重试,再飞一条是双重播报(09-08 判例)。
 */
function FailedSeam({
  marker,
  sessionId,
  t,
}: {
  marker: CompactMarker
  sessionId?: string
  t: TFn
}) {
  return (
    <>
      <span className={s.seamLine} />
      <span className={`${s.seamLabel} ${s.seamLabelFailed}`} data-testid="compact-seam-label">
        {t('chat.compactFailed')}
        {/* 没有会话上下文(查看器回放)就不画这颗钮 —— 见 BlockCtx.sessionId 的注。 */}
        {sessionId !== undefined && sessionId !== '' && (
          <CompactRetry sessionId={sessionId} t={t} />
        )}
      </span>
      <span className={s.seamLine} />
      {marker.error && (
        <span className={s.seamSentence} data-testid="compact-seam-error">
          {marker.error}
        </span>
      )}
    </>
  )
}

/**
 * 行内那颗「重试」。
 *
 * ── 词 ──────────────────────────────────────────────────────────────────
 * 与消息动作行、overlay 车道同一个 `chat.retry` —— 同一件事在同一台上不该有两种叫法。
 *
 * ── 形 ──────────────────────────────────────────────────────────────────
 * 裸钮三类判的**第三类**(09-02 批 6 细化):行内微型文字动作(fs-micro、无边无底、
 * 与那句话同行)走 `ButtonBase` 保本地皮肤,不是 `ui/Button`。
 *
 * ── 什么时候点不动 ──────────────────────────────────────────────────────
 * 引擎在跑(`selectEngineBusy`,判据在账本上、不在这块面上另立忙布尔)。走原生
 * `disabled` 而不是 `aria-disabled`,**不配 Tooltip**:禁灰的理由由灰色本身承担
 * (09-08 重试钮判例)。这里没有 `retryPending` 那一格 —— 那格治的是「命令已离开壳、
 * 账本上还什么都没有」的真空,而压缩这条路一旦发出去,后端当场把同一条 system 消息
 * 刷成 compacting,屏幕上就是这道折痕自己在动,不需要第二个忙态。
 */
function CompactRetry({ sessionId, t }: { sessionId: string; t: TFn }) {
  const busy = useChatSourceOf(sessionId, selectEngineBusy)
  return (
    <ButtonBase
      className={s.seamRetry}
      data-testid="compact-seam-retry"
      disabled={busy}
      onClick={() => {
        // 禁着的时候连命令都不组:原生 disabled 已经挡掉点击,这一句是它的同款声明。
        if (busy) return
        void retryCompact(sessionId)
      }}
    >
      {t('chat.retry')}
    </ButtonBase>
  )
}

const log = getLogger('chat.compact')

/**
 * 骑 `/compact` 那条口(`commands-source.ts` 的 `case 'compact'` 用的是同一条)。
 *
 * **只发不等**:结果会以同一条 system 消息的正文刷新落回屏幕,壳这边没有第二块地方
 * 去画「压缩中」。发不出去(RPC 拒了)时按设计**不飞 toast**,但也不假装成功 ——
 * 落一行结构化日志,那是排障看的那一路(`bun run log:tail`)。
 */
async function retryCompact(sessionId: string): Promise<void> {
  try {
    const port = await commandsPort()
    const response = await port.compactContext(sessionId)
    if (!response?.success) {
      log.warn('compact retry refused', { sessionId, error: response?.error })
    }
  } catch (error) {
    log.warn('compact retry failed', { sessionId }, error)
  }
}

/**
 * 完成态标签那句话 —— **纯函数,单测直接问它**。
 *
 * 三格,后两格缺一格就少说一句,不编:
 *  · 「已压缩 42 条」 —— 条数(marker 给 0 时它也照说 0,那是后端的事实);
 *  · 「701k → 96k」 —— 前后读数都在;
 *  · 「剩 96k」 —— 只有后(压缩开始那一刻的 provider 读数是后端 09-08 才补的一格,
 *    老会话的 marker 里没有它)。
 *
 * 进位走 `format/quantity.formatQuantity`(全壳唯一产地),不在这里手写 k / M。
 * 分隔号 `·` 与 ContextDeltaChip 那一行同一手:拼在代码里,不进字典 —— 它是**排版**,
 * 不是一句要翻译的话。
 */
export function completedLabel(t: TFn, marker: CompactMarker): string {
  const parts = [t('chat.compactDone', { n: marker.compactedMessageCount })]
  const before = marker.contextSizeBefore
  const after = marker.retainedContextSize
  if (before !== undefined && after !== undefined) {
    parts.push(t('chat.compactSize', { before: formatQuantity(before), after: formatQuantity(after) }))
  } else if (after !== undefined) {
    parts.push(t('chat.compactRetained', { after: formatQuantity(after) }))
  }
  return parts.join(' · ')
}
