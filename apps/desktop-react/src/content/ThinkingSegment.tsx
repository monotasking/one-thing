import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CARD_FLIP_MS, currentMotionTier } from '../components/motion'
import { useT } from '../i18n'
import { Fold, FoldTrigger } from '../ui/Fold'
import { useFlipHeight } from '../ui/flip-height'
import { useNoteUserExpand } from './expand-intent'
import { useNoteFold } from './fold-intent'
import { thoughtHeights } from './thought-heights'
import s from './SegmentView.module.css'
import type { TextBlock } from './text/text-stream'

/**
 * 思考段 —— **定稿形**(六轮比稿的 S2),09-14 起**分块流式**
 * (正本 `docs/thinking-stream-2026-09.md` §4)。
 *
 * ── 一句话:它是同一段字的两个读法,不是两块内容 ────────────────────────
 * 收起时是**开头那一截钳成一行**(斜体、灰、不可选中);点开时**原位继续往下读**
 * (可圈选)。没有秒数、没有圆点、没有左竖线 —— 三样都被六轮比稿否掉了:秒数是在给
 * 一件不确定的事编一个精确读数,圆点和竖线是在给一段「顺带看看」的字加仪式感。
 * 左竖线还额外撞上全域禁令(引线全仓禁用),所以它连作为装饰都不成立。
 *
 * ── 三条行为,各有各的理由 ────────────────────────────────────────────
 * ① **流式中自动展开,收尾自动折**:正在想的时候,那段字是此刻唯一在动的东西,
 *    人要看;想完了,它就退回成一行索引。这两下都是**跟着事实走**(live 是折叠器
 *    给的),不是替用户记偏好。**这一条是本文件自己的业务**,不进 `ui/Fold`:
 *    「开合跟着哪个事实走」永远是消费方的事,所以这里用 Fold 的**受控档**。
 * ② **圈选不收**:展开之后正文可圈选,而「选中一段字」的收尾动作恰好是一次
 *    mouseup/click —— 不判一下选区,用户每次复制到一半这段就自己关了。
 *    这条判据(`getSelection().isCollapsed`)09-09 随 U1 搬进了 `ui/Fold`,
 *    因为压缩折痕的摘要与上下文更新 chip 同样要它。
 * ③ **原地再点收起**:收起钮不另设一个热区。整块就是它自己的开关 —— 一件东西一个
 *    交互面,少一个要找的小三角。所以这里**没有 `FoldBody`**:两态的字都摆在
 *    `FoldTrigger` 里,`hidden` 掉它就没有收起态可看了。
 *
 * ── 两态挂的不是同一堆东西(09-14 分块流式改的就是这一格)────────────────
 * 从前两态是同一个 `<p>`(收起靠 `line-clamp: 1` 钳)。那对**短**思考没问题,对
 * 20 万字的思考是两场事故:流式中每帧把整段重排一次(正本 §0 真机量到 71–136ms),
 * 而收起之后那 20 万字仍然整份留在 DOM 里(停靠池里 175 段共 104 万字)。
 * 所以现在:
 *  · **收起 = 只挂 `preview`**(≤ 240 字,line-clamp 仍然负责钳成一行 —— 钳在
 *    **排版**上做这件事没变,240 只是给 DOM 封个顶,不是拿它当「一行」的判据);
 *  · **展开 = 冻住的块各一个 memo 的 `<p>` + 活动尾一个 `<p>`**。块的 props 不变
 *    就不重渲,所以流式期间浏览器只重排活动尾那 ≤ 4,000 字(≤ 1.5ms)。
 * 两态的字拼起来仍然逐字等于原文(`blocks` 与 `tail` 首尾相接、一个字符不丢),
 * 这一条由单测钉,不由人眼看。
 *
 * `data-prose="thought"` 与 `data-testid="chat-thought"` 仍在**同一个元素**上:
 * 节奏表(ChatStream.module.css 的 ④「同类相接」)、`gate:focus` 与 `gate:a11y`
 * 的取件口都认它,换了载体就是换了取件口。
 */

/**
 * 一个冻住的块。**它存在的全部理由就是这只 `memo`** —— 块的文本一旦冻住就永不再变,
 * 于是流式后续每一帧,React 在这里当场返回,连 diff 都不做,DOM 一个字节不碰。
 * 拆掉 memo 就等于回到「每帧重排整段」,正本 §5 的反证量的就是这一格。
 */
const ThoughtBlock = memo(function ThoughtBlock({ text }: { text: string }) {
  return <p className={s.thoughtBlock}>{text}</p>
})

export function ThinkingSegment({
  blocks,
  tail,
  live,
  preview,
}: {
  blocks: readonly TextBlock[]
  tail: string
  live: boolean
  preview: string
}) {
  const t = useT()
  const note = useNoteUserExpand()
  const noteFold = useNoteFold()
  const [expanded, setExpanded] = useState(live)

  // 跟着 live 走:开始想就展开,想完就折回去。用户在**非流式**时手动展开的那一份
  // 不会被这里推翻(live 没变,effect 不跑)。
  useEffect(() => {
    setExpanded(live)
  }, [live])

  /**
   * ── 收尾那一下**折起来,不是跳回去**(单 B ④,正本 §2 规矩 ④)────────────
   *
   * 病历:一轮跑完那一帧,20 万字的思考从 6 万像素**一帧**缩成一行 783px,整屏
   * 跳变(`probe-stream-end.mjs` 量到上一条用户消息的 top 从 −60,879 跳到 −286)。
   *
   * 机制整只复用 `ui/flip-height`(基础件先行:第二个消费者不许再抄一份):
   *  · 「改前」由这一族自己的账本(`thought-heights.ts`)**报**过来,不现问 ——
   *    现问一次 `offsetHeight` 会把整棵跳渲的消息树逼出来排一次版;
   *  · 「改后」由那只原语在 React 提交完**折起来的 DOM 之后**同步量一次 ——
   *    量的就是**预览行自己**,这正是样例页 `animateHeight` 那段判词说的
   *    「不许把容器设成 auto 去量」(首版那么量,量到 639px 的假高、跳一下);
   *  · 动效档 `none` 整段跳过(那只原语第一句就判)。
   *
   * `structure` 只有开 / 合两态:流式期间字每帧在变,高度跟着长 —— 那是 RO 记账的事,
   * 不该每帧触发一次 FLIP。
   */
  const boxRef = useRef<HTMLElement>(null)
  useFlipHeight(boxRef, expanded ? 'open' : 'closed', {
    book: thoughtHeights,
    durVar: '--dur-card-flip',
    durMs: CARD_FLIP_MS,
  })

  /**
   * 开始折的那一帧报一句「钉住视口」(`content/fold-intent.ts`)。
   *
   * **只在折起那一侧报**,展开那一侧归 `expand-intent`(两条通道,两件事:一件说
   * 「别贴底」,一件说「别让内容往上抽」)。**手动收起也报** —— 几何上它与自动折
   * 逐字相同,人正读着的那一行同样不该往上蹿;`Fold` 的 `onOpenChange` 与 `live`
   * 那只 effect 都会落到这里,所以判据挂在**结果**(展开态翻成了 false)上,
   * 不挂在「谁翻的」上。
   *
   * 排在 `useFlipHeight` **之后**声明,所以它的 layout effect 也排在后面跑:
   * 那只原语已经把起点钉住(内联 height = 改前)、把终点写下去了,此刻报出去的
   * 那一段时长说的正是接下来要走的那一段。动效档 `none` 下不报 —— 那一档没有
   * 「一段过渡」,高度当场到位,聊天流按它自己的几何判据走就对了。
   */
  const wasExpanded = useRef(expanded)
  useLayoutEffect(() => {
    const folding = wasExpanded.current && !expanded
    wasExpanded.current = expanded
    if (!folding) return
    if (currentMotionTier() === 'none') return
    noteFold(CARD_FLIP_MS)
  }, [expanded, noteFold])

  return (
    <Fold
      open={expanded}
      /* 用户点开的,报给流:别贴底(`content/expand-intent.ts`)。`live` 驱动的
         自动开合走上面那只 effect,不经过这里 —— 天然不算用户意图,正确。 */
      onOpenChange={(open) => {
        if (open) note()
        setExpanded(open)
      }}
    >
      <FoldTrigger
        ref={boxRef}
        className={expanded ? `${s.thought} ${s.thoughtOpen}` : s.thought}
        aria-label={t('chat.thought')}
        /*
         * 节奏表的钩子(表在 content/ChatStream.module.css)。思考段从前不报身份,
         * 吃默认档「它是字」—— 对「思考 → 正文」那一侧是对的,对「思考 → 思考」
         * 那一侧不对:同一股思考流被流切成的两截,按段距排等于宣布中间发生过别的事。
         * 报了身份,表才说得出「同类相接要紧」这句话(那里的 ④)。
         */
        data-prose="thought"
        data-testid="chat-thought"
      >
        {expanded ? (
          <>
            {blocks.map((block) => (
              <ThoughtBlock key={block.id} text={block.text} />
            ))}
            {/*
             * 活动尾**不带 key**:它在这个 fragment 里永远是同一格,React 因此复用
             * 同一个 DOM 节点、只换文本 —— 那正是这一整单要的那句话「每帧只重排它」。
             * 给它一个随内容变的 key 会让它每帧重挂,前功尽弃。
             * 尾空时整格不画(收尾之后、以及刚好切在换行上的那一帧)。
             */}
            {tail !== '' && <p className={s.thoughtBlock}>{tail}</p>}
          </>
        ) : (
          <p className={s.thoughtPreview}>{preview}</p>
        )}
      </FoldTrigger>
    </Fold>
  )
}
