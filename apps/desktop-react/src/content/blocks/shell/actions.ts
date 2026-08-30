import type { MessageKey } from '../../../i18n'
import type { BlockAction } from '../registry'

/**
 * 动作执行器 —— **住壳,不住块**(§4.2)。
 *
 * 块只**声明**要哪几个动作(`def.actions`),怎么做由这里说了算。所以「复制」在
 * 全系统是同一件事:同一段代码、同一个失败处理、将来同一个成功反馈 —— 表格、代码、
 * 图、工具详情各自实现一遍剪贴板的路,从一开始就被这条分界堵死。
 *
 * ── 词表是封闭的,露出是有条件的 ──────────────────────────────────────
 * 四个动词(copy / download / view-source / zoom)是六轮 UI 定稿拍下来的封闭词表,
 * 加一格是拍板件。但**声明了不等于露得出来**:一个动作要同时有标签和执行器才上屏。
 * P0 只有 copy 与 view-source 两样齐了,download / zoom 的类型在词表里、执行器等
 * P3(PNG 导出 / QuickLook)—— 那之前它们即使被声明也不会出现在檐上,
 * 而不是画一个点了没反应的钮。
 */

/** 壳自己提供的能力(view-source 改的是壳的状态,不是块的数据)。 */
export interface BlockActionRuntime {
  toggleSource(): void
}

/**
 * 这一格的标签。返回 undefined = 不露出。
 *
 * `copy.column`(复制列)不在这张表里不是漏了:它是**块内交互**(长在表头上),
 * 不属于块级动作组 —— 两者共用这个执行器模块,但只有块级动作进檐。
 */
export function blockActionLabelKey(action: BlockAction, sourceOpen: boolean): MessageKey | undefined {
  switch (action.verb) {
    case 'copy':
      if (action.what === 'source') return 'block.action.copySource'
      if (action.what === 'markdown') return 'block.action.copyMarkdown'
      if (action.what === 'csv') return 'block.action.copyCsv'
      return undefined
    case 'view-source':
      return sourceOpen ? 'block.action.hideSource' : 'block.action.viewSource'
    default:
      // download / zoom:词表里有,执行器还没到(P3)。
      return undefined
  }
}

/** 有执行器吗。没有就不露出 —— 点了没反应比没这个钮更糟。 */
export function isBlockActionRunnable(action: BlockAction): boolean {
  return action.verb === 'copy' || action.verb === 'view-source'
}

/**
 * 执行。
 *
 * 剪贴板在 Electron 渲染进程里是 `navigator.clipboard`,但它**不保证存在**
 * (非安全上下文、jsdom)—— 拿不到就什么都不做,不抛:一个复制没成功不该把
 * 这块内容炸掉。真要给失败反馈是 Toast 的事,那要等有反馈面再谈。
 */
export async function runBlockAction(
  action: BlockAction,
  runtime: BlockActionRuntime,
): Promise<void> {
  switch (action.verb) {
    case 'copy': {
      const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
      if (!clipboard?.writeText) return
      await clipboard.writeText(action.text).catch(() => undefined)
      return
    }
    case 'view-source':
      runtime.toggleSource()
      return
    default:
      return
  }
}
