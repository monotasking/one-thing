import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react'
import { recordCrash } from '../services/crash'
import { translate, resolveLang, type Lang } from '../i18n'
import { useStageStore } from '../stage/store'
import { Button } from '../ui/Button'
import s from './ErrorBoundary.module.css'

/**
 * 分区错误边界 —— **一块炸掉不带走整屏**。
 *
 * React 的规矩:只有 class 组件能当边界(`getDerivedStateFromError` /
 * `componentDidCatch` 没有 hook 等价物),所以这里是全仓唯一的 class 组件。
 * 它捕的是**渲染期 / 生命周期 / 构造函数**里抛出的错;事件回调与异步里的错
 * React 根本不往上抛,那两类由 `services/crash.ts` 的两条全局监听接住。
 *
 * 错误卡的三要素(说人话 / 哪错了 / 怎么办)是硬要求,不是装饰:
 *  · 说人话 —— 「这块面板崩了」,不是 "Uncaught TypeError";
 *  · 哪错了 —— `where`(面板 id / 'chat' / 'composer')显示在副标题里;
 *  · 怎么办 —— 「重试」按钮**重挂这棵子树**(换 remountKey 强制新实例),
 *              技术细节折叠在 <details> 里给排障的人看。
 *
 * ── 为什么翻译是手写的而不是 useT() ────────────────────────────────────
 * class 组件里没有 hook。语言从 store 当场读一次(`resolveLang`)——
 * 边界只在崩了的那一刻渲染,拿不到实时切语言的订阅不是问题:
 * 切语言会让上层重渲染,错误卡跟着换语言的路径是「重试后重新崩一次」,
 * 而**没崩的时候这个组件根本不渲染任何文案**。为这个再引一层订阅不值。
 * ──────────────────────────────────────────────────────────────────────
 */

type Props = {
  /** 现场名。进错误卡副标题,也进崩溃日志的 `where` 字段。 */
  where: string
  children: ReactNode
}

type State = {
  error: Error | null
  /** 重挂计数:变一次 = 换一次 key = 子树被彻底丢弃重建。 */
  remountKey: number
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, remountKey: 0 }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    recordCrash('boundary', this.props.where, error, {
      componentStack: info.componentStack?.split('\n').slice(0, 8).join('\n'),
    })
  }

  private retry = (): void => {
    this.setState((prev) => ({ error: null, remountKey: prev.remountKey + 1 }))
  }

  render(): ReactNode {
    const { error, remountKey } = this.state
    if (!error) {
      // 每次重试换一个 key = 明确要求 React 丢弃旧子树重建。
      //
      // 说清它到底做了什么,别夸大:React 在边界接住错之后本来就会卸载那棵子树,
      // 所以「重试后是新实例」不全靠这个 key。key 在这里是**把这件事写死**——
      // 它同时管住另一种情形:边界因为别的原因重渲染(父组件更新)时,React 本可以
      // 复用现有实例;换了 key 就一定重建。一行的代价,换掉「重试有时不灵」这类玄学。
      //
      // 用**带 key 的 Fragment** 而不是 <div key>:边界的落点全是 flex/grid 子项
      // (聊天区、输入框、面板容器),多插一个 DOM 节点会当场改掉它们的布局参与方式。
      // Fragment 能带 key 却不生成节点 —— 「没崩的时候边界完全不存在」是硬要求。
      return <Fragment key={remountKey}>{this.props.children}</Fragment>
    }
    const lang: Lang = resolveLang(useStageStore.getState().locale)
    const t = (key: Parameters<typeof translate>[1]) => translate(lang, key)

    return (
      <div className={s.card} role="alert" data-testid={`error-card-${this.props.where}`}>
        <div className={s.head}>
          <span className={s.title}>{t('error.title')}</span>
          {/* `where` 是**标识**(面板 id),不是界面文案 —— 换语言它不该跟着变,
            * 所以它不进字典,和会话标题、终端输出走同一条判据(见 i18n/index.ts 的边界段)。 */}
          <span className={s.where}>{this.props.where}</span>
        </div>
        <p className={s.hint}>{t('error.hint')}</p>
        <div className={s.actions}>
          <Button
            variant="primary"
            onClick={this.retry}
            data-testid={`error-retry-${this.props.where}`}
          >
            {t('error.retry')}
          </Button>
        </div>
        <details className={s.detail}>
          <summary className={s.summary}>{t('error.detail')}</summary>
          <pre className={s.stack}>{`${error.name}: ${error.message}\n${error.stack ?? ''}`}</pre>
        </details>
      </div>
    )
  }
}
