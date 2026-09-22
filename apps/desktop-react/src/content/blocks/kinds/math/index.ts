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
 *    **这句话曾经是假的**(R 线 F1,2026-09-22 真机量到):身份号确实没变,可
 *    `MathBlock` 的「还没排好」那一支返回的是 `<MathSource …/>`(组件元素)、排好那
 *    一支返回 `<div>`(宿主元素),React 比的是**元素型** —— 闭合那一拍整块卸载重挂
 *    (`DIV life 65 → 66`)。**自述与实测对不上时要改的是实现**:三支的根现在都是
 *    同一个 `div.block`,门 `gate:tool-md-flicker` B⑦ 把「一条公式一生只用一个 DOM
 *    节点、只有一种 padding」钉住了。
 *  · `failure: 'source'`:排不出来就落源码(`SourceView`,与兜底块、错误边界同一个
 *    画法)—— 源码永远可见,全系统一条失败语义。
 *  · `identity: 'origin'`:`${源偏移}:math`。直播 / 收尾 / 重折 / 冷加载四条路必须给
 *    同一个号(理由在 stream/events.ts)。
 *  · `geometry: 'flow'`:随内容长,不预留。KaTeX 到了那一下确实会改这一格的高度,
 *    但 `reserve` 的兑现物是块壳上的那几条样式,而 flow 块**根本不进块壳** ——
 *    填 `reserve` 会是一句没有落点的话。
 *    **留账兑现到哪儿了**(F1,2026-09-22;正本 `docs/stream-render-2026-09.md` §8):
 *    那点高度变化真机量到了,**18.02px**(源码 45 → 排好 26.98),其中 8px 是两个
 *    外壳的 padding 差 —— 那一半是 bug,已治(内衬搬进 `.rendered`,外壳三态同形)。
 *    剩下的 **18.02px 是排版的事实**:一段 mono 源码就是比排好的公式高。三种候选逐条
 *    实测过(读数在 §8.3):(a) 流式期就交给 KaTeX 排 —— 掉幅归零,但半截 TeX 会落进
 *    「排不出来」那一支(`renderTex` 钉着 `throwOnError: true`),屏上多一行灰说明再
 *    消失,而且每帧白排一次、失败也进缓存(09-20 审查刚拆掉的那条路);(b) 给外壳挂
 *    一条 `height` 过渡 —— **结构上不成立**:外壳的 `height` 计算值一直是 `auto`,
 *    内容撑高不改这个属性,于是压根没有过渡可跑(实测掉幅仍是一帧 18.02),要让它跑
 *    就得逐条公式挂 ResizeObserver 写像素值,那正是 09-10 那笔 916 次强制排版的账;
 *    (c) 认下这 18.02px,但**保证不换节点、不换 padding** —— 取的是它。
 *    那一下不是用户动作,`cause` 走 `settle`,由 G 线的 `ViewportAnchor` 吸收。
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
