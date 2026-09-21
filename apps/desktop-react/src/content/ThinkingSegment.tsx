import { memo, useLayoutEffect, useRef, useState } from 'react'
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
 * ① **一直收着,除非人自己点开**(2026-09-20 G 线 P1 改判,正本
 *    `docs/stream-geometry-2026-09.md` §2 拍点 1 与 §5.1)。
 *    **这一条推翻了 09-14 写在这里的那句「流式中自动展开,收尾自动折」** ——
 *    那句话当时的理由是「正在想的时候那段字是此刻唯一在动的东西,人要看」,
 *    而它带来的是两处真机量到的病(§0):收尾自动折那一帧**一帧内视口被拉走**
 *    849 / 1674 / 2094 / **15054px**(思考 3 千字 → 6 万字,之后 170ms 才回到底);
 *    以及人上拨半屏正读到思考段中部时,折叠那一帧他正读的那段字**被从 DOM 上摘掉**
 *    (上方下移 2094px,锚点为 null)。用户 09-20 的原话是「思考段想完自动收起,
 *    正在读的人被打断」,三处拍点「都按照推荐的走」。
 *    所以今天:`expanded` 初值恒 `false`,`live` 翻转**一格都不动它**;
 *    **自动折叠不存在**,于是 ① 那条病在这一件身上没有产地
 *    (手动收起在贴底时仍会踩到同一个钳位,那是 P2 的账)。
 *    「正在想什么」由**收起态那一行自己说**:**这一块思考还在进行时**它显示
 *    **最新一截**(`latest`,尾部 ≤240 字,右端对齐裁左边)并带扫光,之后换回开头
 *    那一截(`preview`)。两态同为一行、**高度逐像素相同**(`.thoughtPreview` 的
 *    `block-size` 钉死),所以「落定那一帧几何上什么都不发生」逐字成立。
 * ①b **扫光跟的是「这一块思考」,不是「这条消息」**(2026-09-21 P1b 裁定 D)。
 *    用户原话:「think 区域的流式动画效果在这块思考结束后应该停止」。从前这三件
 *    (`data-live` / 扫光 / 显示 `latest` 还是 `preview`)读的是 `live` =「这条消息
 *    还在流」,于是模型早已经转去写正文、工具也跑完了,上面那块思考仍然在扫。
 *    今天它们读的是段模型那一格 `thinking` = `live` ∧ 它是序列上的最后一件
 *    (为什么是这个判据,写在 `assemble/index.ts` 的循环上面)。**`live` 这一格
 *    一个字没动** —— 它是 R 线块冻结的判据,这里连读都不读了。
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
 *  · **收起 = 只挂 `preview` / `latest` 之一**(各 ≤ 240 字;钳成一行仍然在**排版**上
 *    做 —— 240 只是给 DOM 封个顶,不是拿它当「一行」的判据);
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
  thinking,
  preview,
  latest,
}: {
  blocks: readonly TextBlock[]
  tail: string
  /**
   * **这一块思考**此刻还在进行吗(P1b 裁定 D)。
   *
   * 不是 `live`(那格说的是「这条消息还在流」,归 R 线的块冻结用,这一件不读它):
   * 收起态那一行显示 `latest` 还是 `preview`、报不报 `data-live`、扫不扫光,
   * 三件都只读这一格。
   */
  thinking: boolean
  preview: string
  /** 末尾那 ≤240 字 —— 这块思考还在进行时收起态那一行显示的就是它(G 线 P1)。 */
  latest: string
}) {
  const t = useT()
  const note = useNoteUserExpand()
  const noteFold = useNoteFold()
  /*
   * **初值恒 `false`,流式与否一格都不动它**(G 线 P1;判词整段在文件头 ①)。
   * 从前这里是 `useState(live)` 外加一只 `useEffect(() => setExpanded(live), [live])`
   * —— 那只 effect 就是「收尾自动折」的产地,而它量出来是一帧内 15,054px 的视口跳变。
   * 今天开合只有**一个**产地:下面那只 `onOpenChange`(用户自己点的)。
   */
  const [expanded, setExpanded] = useState(false)

  /**
   * ── **手动**开合那一下折起来,不是跳回去(单 B ④,正本 §2 规矩 ④)──────────
   *
   * 病历:一轮跑完那一帧,20 万字的思考从 6 万像素**一帧**缩成一行 783px,整屏
   * 跳变(`probe-stream-end.mjs` 量到上一条用户消息的 top 从 −60,879 跳到 −286)。
   * **那条自动折的路 G 线 P1 已经没有了**(判词在文件头 ①),所以这只原语今天
   * 只服务用户自己点的那两下;它仍然留着,因为手动收起在贴底时踩的是同一个钳位
   * (正本 §6 留账第一条,归 P2)。
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
   * 「别贴底」,一件说「别让内容往上抽」)。今天翻这一格的**只有用户自己那一下**
   * (G 线 P1 之后 `live` 不再驱动开合),判据仍然挂在**结果**(展开态翻成了 false)上
   * 而不是「谁翻的」上 —— 那句话少了一个产地,一个字都不必改。
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
      /* 用户点开的,报给流:别贴底(`content/expand-intent.ts`)。G 线 P1 之后
         这里是开合的**唯一**产地 —— 所以经过这里的每一下都是用户意图。 */
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
          /*
           * ── 收起态那一行:两个读法,一个盒子(G 线 P1)──────────────────────
           * **这块思考还在进行** = 最新一截(末尾 ≤240 字,右端对齐、左边裁掉)+
           * 扫光,报 `data-live`;**它已经想完** = 开头那一截(今天的 `preview`,
           * 左起、右端省略号)—— 判据是段模型那一格 `thinking`,不是这条消息还在不在流
           * (P1b 裁定 D)。
           * **高度由 `.thoughtPreview` 的 `block-size` 钉死**,两态逐像素相同 ——
           * 落定那一帧只换字与那格属性,几何上什么都不发生(正本 §1 的 G4)。
           *
           * 内层那个 `<span>` 是右端对齐那一手的一半(另一半在 CSS,判词写在那儿):
           * `min-inline-size: 100%` 让短文本照常从左起;长文本靠外面那一格的
           * `justify-content: flex-end` + 这一格的 `flex: none` 把溢出翻到**左边**
           * 去被裁掉 —— **不是** `margin-inline-start: auto`(自动外边距只吃**剩余**
           * 空间,而这里剩余是负的,它当场解析成 0)。也不用 `direction: rtl`:
           * 那会把标点与中英混排的顺序一起翻掉。
           *
           * 这一行里**不会再有换行符** —— 装配层的 `oneLine` 已经把连续空白折成
           * 一个空格了(`assemble/text.ts`),所以 CSS 那边只要一句「不折行」。
           */
          <p className={s.thoughtPreview} data-live={thinking ? '' : undefined}>
            <span className={s.thoughtLine}>{thinking ? latest : preview}</span>
          </p>
        )}
      </FoldTrigger>
    </Fold>
  )
}
