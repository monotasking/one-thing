import type { MessageKey } from '../../../i18n'
import type { BlockAction } from '../registry'
import { exportSvgAsPng } from './export-png'
import { hasBlockRunPort, type BlockRunRequest } from './run-port'
import { getLogger } from '../../../services/log'

/**
 * 动作执行器 —— **住壳,不住块**(§4.2)。
 *
 * 块只**声明**要哪几个动作(`def.actions`),怎么做由这里说了算。所以「复制」在
 * 全系统是同一件事:同一段代码、同一个失败处理、将来同一个成功反馈 —— 表格、代码、
 * 图、工具详情各自实现一遍剪贴板的路,从一开始就被这条分界堵死。
 *
 * ── 词表是封闭的,露出是有条件的 ──────────────────────────────────────
 * 五个动词(copy / download / view-source / zoom / run)是六轮 UI 定稿拍下来的
 * 封闭词表(`run` 是 2026-09-14 用户拍的第五格),
 * 加一格是拍板件。但**声明了不等于露得出来**:一个动作要同时有标签和执行器才上屏。
 * P3 把 download.png(SVG→PNG,见 export-png.ts)与 zoom(放大浮层)两个执行器
 * 补齐了 —— 于是**任何**能交出一段 SVG 的图种自动获得这两样,自己不写一行。
 * `download.csv` / `download.svg` 仍然没有执行器:声明了也会被筛掉,
 * 而不是画一个点了没反应的钮。
 */

/**
 * 放大浮层里装的是什么 —— **两档,一个联合**(图片批加)。
 *
 * 写成联合而不是「一个可空的 svg + 一个可空的 image」:浮层里同时只有一件东西,
 * 两个可空格子表达得出「两个都在」与「两个都没有」这两种不存在的状态,
 * 而那正是下一轮「浮层空着」报障的落脚点。
 */
export type ZoomContent = { svg: string } | { image: { src: string; alt: string } }

/** 壳自己提供的能力(改的是壳的状态,不是块的数据)。 */
export interface BlockActionRuntime {
  toggleSource(): void
  /** 开放大浮层。内容是**点下去那一刻**取到的那份,不是声明时的。 */
  openZoom(content: ZoomContent): void
  /**
   * 跑这一段脚本。**现场那两格由壳补**(`ctx.sessionId` / `ctx.baseDir`)——
   * 动作声明里只有 `shell` 与 `script`,「这块内容长在哪条会话 / 哪个目录下」
   * 是壳手里的事实,不该让每个块各报一遍(与 `BlockCtx` 那条分界同源)。
   */
  runScript(request: BlockRunRequest): Promise<void>
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
    case 'run':
      return 'block.action.run'
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
      // **两个取件口有其一**:矢量的(图块)或位图的(图片块)。一个都没有 = 这一型
      // 交不出可放大的东西,檐上就不该多一颗死钮。
      return action.svg !== undefined || action.image !== undefined
    case 'run':
      // 有没有人装了执行器 —— 同一条判据换了一种取件口(见 `run-port.ts`)。
      // 没装 = 檐上只剩「复制源码」。**装了不等于跑得了**:装配点是种类表
      // (`kinds/terminal.tsx`),web 模式同样加载它,对着一台没有终端能力的 core
      // 点下去会在下面那个 catch 里落一条 warn —— 那一档留账在正本里。
      return hasBlockRunPort()
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
      // 先矢量后位图 —— 一个块只会声明其中一个取件口,顺序只是一条确定的读法。
      const svg = action.svg?.()
      if (svg) {
        runtime.openZoom({ svg })
        return
      }
      const image = action.image?.()
      if (image) runtime.openZoom({ image })
      return
    }
    case 'run': {
      /*
       * **可见结果在终端里**,所以返回 undefined —— 复制那种「就地换字」的反馈
       * 在这一格没有位置可长:人要看的是那台 shell 打出来的东西,而屏幕上那块面
       * 已经被亮出来了(执行器自己会做这件事)。
       *
       * **失败只记一条日志**:开不出终端(后端没有终端能力、PTY 起不来)是
       * 装配层的事故,不是这块内容的事故 —— 抛出去会把这块代码炸成降级物,
       * 弹通知则违了「零 Toast」。所以这里就地吞掉并留下现场。
       */
      await runtime
        .runScript({ shell: action.shell, script: action.script })
        .catch((error: unknown) => {
          // 错误对象走 `err` 那一格(仓根 CLAUDE.md:变量进 fields,错误进 err)。
          getLogger('content.blocks.run').warn('跑这段脚本没成功', undefined, error)
        })
      return
    }
  }
}
