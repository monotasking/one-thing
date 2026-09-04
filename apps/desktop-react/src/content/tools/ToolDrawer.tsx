import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useT } from '../../i18n'
import { BlockView } from '../blocks/BlockView'
import { blockKey } from '../assemble'
import type { BlockCtx } from '../blocks/registry'
import type { ProjectedToolCall } from '../model/segments'
import type { ToolProgress } from './card'
import { resolveToolPresenter } from './presenter'
import s from './ToolDrawer.module.css'

/**
 * C1 行内抽屉:**行下原位下拉**,两小节 —— 参数 · 结果。
 *
 * ── 这是「一张注册表,两个产地」兑现的地方 ────────────────────────────
 * 结果那一节画的**不是**抽屉自己发明的一种展示,而是 presenter 产出的
 * `BlockModel[]` 经**块注册表**渲染。所以 read 的结果画出来的代码块,与聊天正文里
 * 一段 ```ts 围栏画出来的,是同一个组件、同一条檐、同一套动作(复制源码)、同一个
 * 限高折叠。「工具抽屉里出现一段 diff」因此不是特例,是复用的自然结果(铁律 1)。
 *
 * ── 惰性 ────────────────────────────────────────────────────────────
 * `detail()` 只在这个组件被挂上来的时候才跑 —— 一条消息上十次调用,九次没被拉开
 * 就一次都不算。这正是「详情不进段模型」买到的东西(§5.1)。
 *
 * ── 左竖线禁令 ──────────────────────────────────────────────────────
 * 抽屉与行的从属关系靠**衬面**(surface-1 + 圆角)说,不靠在左边画一条引线。
 * 引线在全仓被禁(六轮比稿的横切规范),嵌套结构也不例外。
 */
export function ToolDrawer({
  call,
  ctx,
  live = false,
  progress,
}: {
  call: ProjectedToolCall
  ctx: BlockCtx
  /**
   * 这一步还在跑(C2-a:执行中的行也能展开了,拍点 ⑩)。
   *
   * 它只改**空态那句话**:「这次调用没有留下结果」是给收场了的调用说的,
   * 对一条正在跑的调用说这句话是**说错**(它还没到留下结果的时候)。
   * 正在长的输出由 C2-b 的 `progress` 那一格摆出来(下面「实时输出」一节)。
   */
  live?: boolean
  /**
   * 这次调用**此刻**的过程读数(C2-b)。
   *
   * 它是**读数不是结果**:每来一份快照整段替换,不进账本,收场那一刻整节消失
   * (结果那一节接手)。所以它单独一节、单独一套样式,不混进「结果」那一节 ——
   * 混进去等于让一段随时会被替换掉的文字冒充这次调用的产出。
   */
  progress?: ToolProgress
}) {
  const t = useT()

  // 详情按 call 引用缓存:折叠器保证消息不可变、变则换引用,所以同一次调用在抽屉
  // 开着期间重渲染多少次都只算一遍(与装配那份 memo 同款判据)。
  const blocks = useMemo(() => resolveToolPresenter(call).detail(call), [call])
  const args = useMemo(() => argumentRows(call), [call])

  // 抽屉里的块与正文里的块共用 key 的派生规则,只是段身份换成了这次调用。
  const keyBase = `tool:${call.id}`

  const tail = live ? progress?.outputTail : undefined

  return (
    <div className={s.drawer}>
      {args.length > 0 && (
        <section className={s.section}>
          <h4 className={s.label}>{t('chat.tool.arguments')}</h4>
          <dl className={s.args}>
            {args.map(([name, value]) => (
              <div className={s.argRow} key={name}>
                <dt className={s.argName}>{name}</dt>
                <dd className={s.argValue}>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {tail && (
        <section className={s.section}>
          <h4 className={s.label}>{t('chat.tool.liveOutput')}</h4>
          <LiveOutput text={tail} />
        </section>
      )}

      <section className={s.section}>
        <h4 className={s.label}>{t('chat.tool.result')}</h4>
        {blocks.length === 0 ? (
          // 没有结果**也要说出来**:空白会被读成「还没加载完」。
          <p className={s.empty}>{t(live ? 'chat.tool.noOutputYet' : 'chat.tool.noResult')}</p>
        ) : (
          blocks.map((block, index) => (
            <BlockView key={blockKey(keyBase, index, block)} block={block} ctx={ctx} />
          ))
        )}
      </section>
    </div>
  )
}

/**
 * 活输出那一小块:**限高 + 新行到达时跟到底**。
 *
 * ── 跟底判据 ──────────────────────────────────────────────────────────
 * 「新行到达前**此前是贴底的**」才跟 —— 用户自己往上翻了就别把他拽回去,那是
 * 这台上所有跟随滚动共用的一条判(C1 的消息跟随会把这条判据抽成公用件,
 * **归并待办留账在这里**:那时这个组件改成消费它,判据一个字不用变)。
 *
 * 量「此前贴底没有」必须在 DOM 改之前(`useLayoutEffect` 的上一轮结束时已经晚了),
 * 所以用一个 ref 记住上一次渲染后的贴底状态,`useLayoutEffect` 里读它再决定跟不跟。
 */
function LiveOutput({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement | null>(null)
  const wasAtBottom = useRef(true)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (wasAtBottom.current) el.scrollTop = el.scrollHeight
  }, [text])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      // 2px 余量:亚像素与缩放会让「正好贴底」量出 0.5px 的差。
      wasAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 2
    }
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    return () => el.removeEventListener('scroll', measure)
  }, [])

  return (
    <pre className={s.liveOutput} ref={ref} data-tool-live-output="true">
      {text}
    </pre>
  )
}

/**
 * 参数 → 紧凑 mono 键值。
 *
 * 值只做一件事:不是字符串就 `JSON.stringify` 一下。**不截断、不摘要** —— 摘要是
 * 行上那一格干的活(`row.summary`),抽屉是「我要看全的」那一层,在这里再省一次
 * 就等于没有一个地方看得到真参数。序列化炸了就把那句话原样摆出来(与兜底
 * presenter 同一条:最后一层不许自己再抛)。
 */
function argumentRows(call: ProjectedToolCall): [string, string][] {
  const args = call.arguments as Record<string, unknown> | undefined
  if (!args) return []
  return Object.entries(args).map(([name, value]) => [name, stringifyArgument(value)])
}

function stringifyArgument(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch (thrown) {
    return String(thrown)
  }
}
