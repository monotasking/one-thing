import { useCallback, useState } from 'react'
import { useT, type TFn } from '../../i18n'
import { resolveIcon } from '../../components/icons'
import { ButtonBase } from '../../ui/ButtonBase'
import type { BlockCtx } from '../blocks/registry'
import type { ToolGroupEntry, ToolGroupModel, ToolStepModel } from '../model/segments'
import { ToolCardBody, ToolStepRow, formatDuration, toolCardShell, toolTone } from './ToolRow'
import s from './ToolGroup.module.css'

const CaretIcon = resolveIcon('ChevronRight')

/**
 * B2:**计数句收起 ↔ 执行清单展开**。
 *
 * 收起时它是一句话:「执行了 7 步 · read / edit / bash」+ 右端总耗时。这句话回答的是
 * 「刚才那段沉默里发生了什么量级的事」—— 而不是把七行细节铺在正文中间要人跳过去。
 * 点开才是清单。
 *
 * ── 名字最多列三个 ──────────────────────────────────────────────────
 * 超过三种折成「等 N 种」:一句话列到第四个名字就不再是一句话了,读的人会开始
 * **数**而不是读。三是比稿里定下的那个数。
 *
 * ── 清单里的聚合行 ──────────────────────────────────────────────────
 * 同名连发在**装配层**已经折成了一格(`presentToolGroup`),这里只画:`count > 1`
 * 就是一行「read ×3」,点开看逐条,**失败置顶** —— 展开一组多半是因为里面有一条
 * 出了事,让它排在第一行是把「为什么点开」直接答了。
 *
 * ── 一组只有一次调用时:画从前那张卡(09-01 P2)────────────────────────
 * 「单发不说计数句」这条没变 —— 一个人做了一件事,说「执行了 1 步」比直接把那件
 * 事摆出来更远。变的是它**在哪儿判**:从前由归组判(单发产 `tool` 段、连发产
 * `tool-group` 段),于是第二次调用到达的那一帧段种一换,React 把整段卸载重挂
 * (真机 t=6614:单卡整行消失换成组卡)。现在归组只说「这几次挨着」,**画成什么样
 * 由条数在这里决定** —— 外面那个 `div` 逐帧是同一个 DOM 节点,只有里面换。
 */
export function ToolGroup({ group, ctx }: { group: ToolGroupModel; ctx: BlockCtx }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const toggle = useCallback(() => setOpen((value) => !value), [])
  // 判据是**调用数**不是格数:同名连发聚合之后 entries 只有一格,但那是「read ×3」,
  // 该说计数句(与 `ToolGroupModel.total` 的注同一条)。
  const single = group.total === 1 ? group.entries[0]?.children[0] : undefined

  return (
    /*
     * **一个元素,两种长相**。段只渲染一个元素、不加包裹层(SegmentView 的纪律),
     * 所以单发那一支不是"组里套一张卡"—— 这个 `div` **自己**就是那张卡:壳属性
     * 来自 `toolCardShell`(长相的唯一产地),里面是同一身 `ToolCardBody`,
     * 与从前的单发卡逐属性相同。
     *
     * 第二次调用到达时,React 在同一位置见到的还是一个 `div`:类名与数据属性打补丁,
     * **DOM 节点不换** —— 这正是 P2 要的那条「零重挂」。
     *
     * data-prose 两支都有:工具那件东西按物件档留白(content/ChatStream.module.css)。
     */
    <div
      {...(single
        ? toolCardShell(single.row)
        : {
            className: s.group,
            'data-tool-group': true,
            'data-open': open || undefined,
            'data-prose': 'object' as const,
          })}
    >
      {single ? (
        <ToolCardBody step={single} ctx={ctx} />
      ) : (
        /* 组头是**结构件**(caret + 读数 + 右端),视觉本该定制 —— 清 UA 归 `ui/ButtonBase`。 */
        <ButtonBase className={s.head} onClick={toggle} aria-expanded={open}>
          <CaretIcon className={s.caret} strokeWidth={2} aria-hidden="true" />
          <span className={s.count}>
            {t('chat.toolGroup.count', { n: group.total })}
            <span className={s.sep}>·</span>
            {namesText(t, group.names)}
          </span>
          <span className={s.right}>
            {group.failed > 0 && (
              <span className={s.failed}>{t('chat.toolGroup.failed', { n: group.failed })}</span>
            )}
            {group.durationMs !== undefined && (
              <span className={s.duration}>{formatDuration(t, group.durationMs)}</span>
            )}
          </span>
        </ButtonBase>
      )}

      {!single && open && (
        <ul className={s.list}>
          {group.entries.map((entry, index) => (
            <li className={s.item} key={`${entry.tool}:${entry.row.callId}:${index}`}>
              <GroupEntry entry={entry} ctx={ctx} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** 一格:单发直接是一行;聚合是一行「×N」+ 点开的逐条。 */
function GroupEntry({ entry, ctx }: { entry: ToolGroupEntry; ctx: BlockCtx }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const toggle = useCallback(() => setOpen((value) => !value), [])

  if (entry.count === 1) return <ToolStepRow step={entry.children[0]} ctx={ctx} />

  const Icon = resolveIcon(entry.row.icon)
  return (
    <>
      /* 聚合行同判:一行「工具名 ×N」,结构件。 */
      <ButtonBase className={s.aggregate} onClick={toggle} aria-expanded={open}>
        <Icon className={s.aggregateIcon} strokeWidth={1.75} aria-hidden="true" />
        <span className={s.aggregateName}>{entry.tool}</span>
        <span className={s.times}>{t('chat.toolGroup.times', { n: entry.count })}</span>
        <span className={s.right}>
          {entry.failed > 0 && (
            <span className={s.failed}>{t('chat.toolGroup.failed', { n: entry.failed })}</span>
          )}
        </span>
      </ButtonBase>
      {open && (
        <ul className={s.children}>
          {failedFirst(entry.children).map((step) => (
            <li className={s.item} key={step.row.callId}>
              <ToolStepRow step={step} ctx={ctx} />
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/**
 * 失败置顶 —— **稳定**排序:两条失败之间、两条成功之间的原顺序一个都不动。
 * 那是这一组唯一的结构(先做的排前面),排序只许把出事的那几条提上来,不许把
 * 顺序打乱成「按状态分的两堆」。
 */
function failedFirst(steps: readonly ToolStepModel[]): ToolStepModel[] {
  const bad: ToolStepModel[] = []
  const rest: ToolStepModel[] = []
  for (const step of steps) {
    if (toolTone(step.row.status) === 'bad') bad.push(step)
    else rest.push(step)
  }
  return [...bad, ...rest]
}

/** 「read / edit / bash」;超过三种折成「read / edit / bash 等 5 种」。 */
function namesText(t: TFn, names: readonly string[]): string {
  const head = names.slice(0, MAX_NAMES).join(' / ')
  if (names.length <= MAX_NAMES) return head
  return `${head} ${t('chat.toolGroup.moreKinds', { n: names.length })}`
}

const MAX_NAMES = 3
