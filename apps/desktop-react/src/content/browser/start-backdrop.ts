/**
 * **叶正文那一块此刻画什么**(2026-09-17)。
 *
 * 起因是逐帧实测出来的一段难看:从起始页在地址栏回车之后,8ms 壳的乐观补丁把
 * `row.url` 写成目标地址 → 起始页被摘、占位格挂上;18ms 后端推来 `loading` 事实、
 * 重拉 tabs 表,而**那时后端的 `url` 还是空串** → 23ms 起始页又装了回来;
 * 一直到 1238ms `did-navigate` 提交,`url` 才真的进状态、占位格再挂上。人看见的
 * 就是「闪一下」。后端那一半由 `electron/browser/tab.ts` 的 `navigate` 治
 * (状态里 `url` 从此是「要去哪儿」,到没到看 `loading`);壳这一半治的是另一段:
 * **提交之后到网页首帧之间**(实测约 500ms)原生视图是透明的,屏幕上露的是壳
 * DOM 的底色,而起始页那时已经摘掉了,于是那一段是一片空底。
 *
 * 治法不是「等一等再摘」(那要一格计时器,而计时器答不出「网页画出来了没有」),
 * 是**让起始页留作底**:原生视图压在 DOM 之上、首帧之前透明,底下那块 DOM 自然
 * 露出来 —— 所以只要它还在,就没有那段空底,网页第一帧一画出来就把它盖住。
 *
 * 这只函数是这条判据的**全部**:纯的、不认识 React、不认识浏览器。
 */

export type BrowserBodyPhase = 'start' | 'warming' | 'live'

/**
 * 叶正文这一块画什么。
 *
 *  start   — 空标签页:只画起始页,不画占位格(不报帧 = 视图保持隐藏;
 *            `gate:browser` ⑮ 与 b3b 测试钉着)
 *  warming — 从起始页出发的第一次加载还没完成:占位格已在(视图建起来、开始加载),
 *            起始页留作底 —— 原生视图在首帧之前是透明的,底下的 DOM 会露出来,
 *            所以留着起始页就没有那段空底;它是装饰,inert + aria-hidden +
 *            pointer-events:none
 *  live    — 第一次加载完成过:起始页永远撤掉。之后的换页由 Chromium 自己保留
 *            上一页的画面,不需要壳兜底
 *
 * `settledOnce` 是**叶上按 tabId 的一格闩**(一旦观察到 `row.url && !row.loading`
 * 就为真,tabId 变了就重置)。它在这里是参数而不是自己算的,因为「这一格这辈子
 * 有没有成功停下来过」是一段**历史**,而这只函数只看得见此刻那一行。
 */
export function browserBodyPhase(
  row: { url: string; loading: boolean } | undefined,
  settledOnce: boolean,
): BrowserBodyPhase {
  if (settledOnce) return 'live'
  if (!row) return 'start'
  if (!row.url && !row.loading) return 'start'
  return 'warming'
}
