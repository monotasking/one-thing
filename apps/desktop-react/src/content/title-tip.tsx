import type { ReactNode } from 'react'
import { PathText } from '../ui/PathText'
import type { TitleTip } from './model/title-tip'

/**
 * 一句自述的提示 → 交给 `ui/Tooltip` 的节点(09-13)。
 *
 * **全壳唯一一处把 `TitleTip` 变成画面的地方**:檐、tab 条、拼贴格头、工具卡
 * 行名四个消费者各调它一次,于是「路径长什么样」只有一个产地 —— 改一次四处
 * 一起变,而它们谁都不认识 `PathText`,更不认识 `~`。
 *
 * `home` 由**消费方在组件顶层取一次**(`data/home-dir.useHomeDir`)再传下来:
 * 这只函数是纯的(要能在 `.map` 里逐格调),而 hook 不能在循环里调。
 * 拿到之前 `home` 是 null = 不缩 —— 不缩只是多几个字,而先画 `~` 再变回全路径
 * 会闪一下。
 */
export function renderTitleTip(tip: TitleTip | undefined, home: string | null): ReactNode {
  if (tip === undefined) return undefined
  if (typeof tip === 'string') return tip
  return <PathText path={tip.path} home={home} layout="stacked" dir={tip.dir} />
}
