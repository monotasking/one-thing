import type { MessageKey } from '../../../i18n'
import type { BlockAction } from '../registry'
import { exportSvgAsPng } from './export-png'

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
 * P3 把 download.png(SVG→PNG,见 export-png.ts)与 zoom(放大浮层)两个执行器
 * 补齐了 —— 于是**任何**能交出一段 SVG 的图种自动获得这两样,自己不写一行。
 * `download.csv` / `download.svg` 仍然没有执行器:声明了也会被筛掉,
 * 而不是画一个点了没反应的钮。
 */

/** 壳自己提供的能力(改的是壳的状态,不是块的数据)。 */
export interface BlockActionRuntime {
  toggleSource(): void
  /** 开放大浮层。SVG 是**点下去那一刻**取到的那份,不是声明时的。 */
  openZoom(svg: string): void
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
    case 'download':
      // csv / svg:词表里有,执行器还没到。
      return action.what === 'png' ? 'block.action.downloadPng' : undefined
    case 'zoom':
      return 'block.action.zoom'
  }
}

/**
 * 有执行器吗。没有就不露出 —— 点了没反应比没这个钮更糟。
 *
 * download / zoom 的判据落在**取件口在不在**(`svg`)而不是「P3 到了没有」:
 * 一个没有 SVG 可取的图种(将来的位图图种、或者只声明了词却没接上的块)不该
 * 在檐上多出两个死钮。取件口在、但点下去那一刻还没渲染完 —— 那一格是空的,
 * 执行器什么都不做:动作在,内容还没到,这是诚实的中间态,不是坏钮。
 */
export function isBlockActionRunnable(action: BlockAction): boolean {
  switch (action.verb) {
    case 'copy':
    case 'view-source':
      return true
    case 'download':
      return action.what === 'png' && action.svg !== undefined
    case 'zoom':
      return action.svg !== undefined
  }
}

/**
 * 执行。
 *
 * 剪贴板在 Electron 渲染进程里是 `navigator.clipboard`,但它**不保证存在**
 * (非安全上下文、jsdom)—— 拿不到就如实返回 false,不抛:一个复制没成功不该把
 * 这块内容炸掉。
 *
 * ── 返回值只有 copy 一档有话说(08-31 拍板:复制反馈不走通知)────────────
 * `copy` 返回成没成,**反馈长在被按的那颗钮上**(文字/图标就地换 `COPY_FEEDBACK_MS`
 * 一拍),不弹 Toast —— 复制是高频小动作,每按一下飞出一条通知是噪音;其余动词
 * 自带可见结果(源码开合、浮层、下载),返回 undefined。
 */
export async function runBlockAction(
  action: BlockAction,
  runtime: BlockActionRuntime,
): Promise<boolean | undefined> {
  switch (action.verb) {
    case 'copy': {
      const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
      if (!clipboard?.writeText) return false
      return clipboard.writeText(action.text).then(() => true, () => false)
    }
    case 'view-source':
      runtime.toggleSource()
      return
    case 'download': {
      const svg = action.svg?.()
      if (svg) await exportSvgAsPng(svg, action.filename)
      return
    }
    case 'zoom': {
      const svg = action.svg?.()
      if (svg) runtime.openZoom(svg)
      return
    }
  }
}
