import type { ReactNode } from 'react'
import s from './Reveal.module.css'

/**
 * **幽灵现身槽**(09-02 批 12 立件)——「休止态看不见、鼠标或键盘落到这一行上
 * 才现出来」的那一格,而且**位置在休止态就占着**。
 *
 * ── 三条纪律(照 `content/message/MessageChrome.module.css` 的幽灵动作行)──
 *  ① **占位常驻,只动 opacity**。用 `display:none` / 条件渲染的话,浮现那一刻
 *     它旁边的东西会被推开 —— 无位移原则。凭证池那一行的判据就是这条:
 *     铅笔现出来的时候 ⋯ 的 x 必须一字不动。
 *  ② **判据是整块作用域,不是这一格自己**。消费方把 `data-reveal-scope` 放在
 *     「算不算我在看这一行」的那个元素上(凭证池放在 `<li>` 上);挂在自己身上
 *     会变成「先猜它在哪儿再移上去」。选择器写成**属性**而不是类,是因为类名
 *     住在各自的 CSS Module 里、编译后彼此不可见,而属性是两边共有的事实。
 *  ③ **键盘也算「在看」**:作用域的 `:focus-within` 与 hover 同权。少了这条,
 *     Tab 走到那颗钮上时它是隐形的 —— 一个看不见的焦点比没有焦点更糟。
 * 浮现走 `--dur-hover-fade`(装饰档,动效「无」档下就是当场出现)。
 *
 * ── 与 MessageChrome 那份本地配方的关系 ────────────────────────────────
 * 那一份**本批不迁**(它的作用域是 `[data-message-id]`,一条消息;换成本件的
 * 通用属性等于顺手扩一次 scope,而消息那条链有自己的判据在跑)。两处在文件头
 * 互相点名:同一副配方今天有两个产地,下一处要用幽灵浮现的**消费这一件**。
 *
 * ── 三张状态表(库件规格)──────────────────────────────────────────────
 * ① 生命周期:纯渲染,一个 hook 都没有;无订阅 / 无计时器 / 无模块级副作用 →
 *    **不需要 HMR dispose**。它没有「换宿主」这一问 —— 它就是一格 `<span>`。
 * ② UI 生命状态:不取数,没有 empty / loading / error。装什么由消费方决定
 *    (开放集合走 children,与 `ui/Menu` 同一条 API 判据)。
 * ③ UI 交互状态:它自己**不是控件**,rest / hover / focus / disabled 全归塞进来
 *    的那几颗钮。这一件只有两态:**隐**(作用域里没有指针也没有焦点)与
 *    **现**(有其一)。禁用不归它 —— 一颗禁掉的钮照样占着这个位置,
 *    这正是「位置预留」要的。
 */
export interface RevealProps {
  children: ReactNode
  className?: string
}

/**
 * 放在作用域元素上的那一格属性。摊开写(`{...REVEAL_SCOPE}`)比手打字符串好:
 * 打错一个字母不会报错,只会**永远不现身**。
 */
export const REVEAL_SCOPE = { 'data-reveal-scope': '' } as const

export function Reveal({ children, className }: RevealProps) {
  return <span className={[s.reveal, className ?? ''].filter(Boolean).join(' ')}>{children}</span>
}
