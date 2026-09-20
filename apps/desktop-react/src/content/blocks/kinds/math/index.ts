import { registerBlock } from '../../registry'
import { MathBlock } from './MathBlock'

/**
 * 注册:块公式是 **flow** —— 纸上居中的一行,不套卡片、无檐、无动作、不限高。
 * 判词在 `MathBlock.tsx` 与 `model/blocks.ts` 的 math 那一格上(一句话:一条公式是
 * 这页纸上的一句话,不是一件被引用的东西)。
 *
 * ── 流式五问逐条,其中两问与「图」那一族**相反**,理由在这里 ──────────────
 *  · `midway: 'grow'`(不是 'hold')。`hold` 说的是「这一型在合上之前不出现,流式期
 *    由**别的型**代为呈现」—— 图与 diff 是那样的:它们在闭合之前是 `code(closed:false)`。
 *    公式不是:micromark 的 math flow **不等收尾就开块**,第一个 `$$` 一到,这里就
 *    已经是一个 `math` 块(`closed:false`)了,屏幕上由它自己画那段半成品源码。
 *    照实填 `grow`,与未闭合围栏是同一形。
 *  · `settled: 'same'`(不是 'swap')。`swap` 的语义是「换 kind = 换身份号 = React
 *    重挂」。这里 kind 从头到尾是 `math`,收尾那一刻变的只有 `closed` 与画面(源码
 *    换成排好的公式),同一个组件、同一个身份号、不重挂 —— 那正是 `same`。
 *    (写成一行的 `$$x$$` 确实会经历一次 paragraph → math 的换装,但那是**段落**在
 *    换装,不是这一型在换渲染器;身份号跟着 kind 走,该重挂的那一下照样发生。)
 *  · `failure: 'source'`:排不出来就落源码(`SourceView`,与兜底块、错误边界同一个
 *    画法)—— 源码永远可见,全系统一条失败语义。
 *  · `identity: 'origin'`:`${源偏移}:math`。直播 / 收尾 / 重折 / 冷加载四条路必须给
 *    同一个号(理由在 stream/events.ts)。
 *  · `geometry: 'flow'`:随内容长,不预留。KaTeX 到了那一下确实会改这一格的高度,
 *    但 `reserve` 的兑现物是块壳上的那几条样式,而 flow 块**根本不进块壳** ——
 *    填 `reserve` 会是一句没有落点的话。**留账**:公式排好那一刻的那点高度变化今天
 *    没有对策,真机上看得出来再治(素材是「一条消息里几十条公式同时排好」)。
 *
 * 不声明 `loader`:库到之前公式有一个完全正确的样子(它自己的源码),用骨架盖住
 * 一份已经正确的东西是拿空白换颜色(同 shiki / mermaid 两处)。
 */
registerBlock({
  kind: 'math',
  presentation: 'flow',
  stream: { midway: 'grow', settled: 'same', failure: 'source', identity: 'origin', geometry: 'flow' },
  Component: MathBlock,
}, import.meta.hot)
