import { Component, type ErrorInfo, type ReactNode } from 'react'
import { recordCrash } from '../../../services/crash'

/**
 * **块级**错误边界 —— 一块炸了不带走这条消息(§3.1 第 3 条)。
 *
 * 与 `components/ErrorBoundary` 是同一个哲学、不同的粒度与不同的降级:面板边界
 * 画的是「这块面板崩了 + 重试钮」,那是一整片工作区没了才配得上的一张卡;一段
 * 富文本里的一个块炸了,人要的不是一张错误卡,而是**那块内容的源码**——
 * 一条消息里三个代码块坏了一个,另外两个和正文都该照常读。
 *
 * 所以这里不复用那个类:降级物不同(源码 vs 错误卡)、恢复语义不同(块没有
 * 「重试」——同一份不可变模型重画一次还是会抛)。共用的是**记崩溃**这件事,
 * 走同一个 `recordCrash`,现场名带上消息 id 与块 kind。
 */

interface Props {
  /** 现场名:`block:<kind>@<messageId>`。进崩溃日志,不进界面。 */
  where: string
  /** 降级物。壳把「源码 + 一行说明」的画法交给它,边界自己不认识源码是什么。 */
  fallback: (error: Error) => ReactNode
  children: ReactNode
}

interface State {
  error: Error | null
}

export class BlockErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    recordCrash('boundary', this.props.where, error, {
      componentStack: info.componentStack?.split('\n').slice(0, 8).join('\n'),
    })
  }

  /*
   * 这里**故意没有**「模型换了就再试一次」。
   *
   * 试过的写法是在 componentDidUpdate 里比 children:children 是每次渲染新造的
   * 元素,永远不相等,于是父组件每重渲染一次就重放一次那个错(还多记一条崩溃)。
   * 真正的判据是「这是不是另一份内容」,而那件事**上面已经答过了**:块 key 由
   * 源偏移派生(assemble/key.ts),换了内容就换 key,React 自己重挂。
   * 流式期间原位换装(key 不变、模型变)要恢复,是 P1 流式契约的事,
   * 到时给边界加一个 resetToken —— 不是在这里猜。
   */

  render(): ReactNode {
    const { error } = this.state
    if (error) return this.props.fallback(error)
    return this.props.children
  }
}
