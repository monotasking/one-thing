import type { BlockModel } from '../../../model/blocks'
import { registerBlock } from '../../registry'
import { Figure } from './Figure'
import { mermaidFigureKind } from './mermaid'
import { cachedFigureSvg, registerFigureKind, resolveFigureKind } from './registry'

type FigureModel = Extract<BlockModel, { kind: 'figure' }>

/**
 * 注册两件事:图种表里的 mermaid,主表里的 `figure`。
 *
 * 顺序无所谓(两张表互不查对方),放在同一个文件里是因为它们是**同一次装配**:
 * 「这台上有图块,而且它认识 mermaid」。将来加 plantuml = 这里多一行
 * `registerFigureKind(plantumlFigureKind)`,主表那一段一个字不改 —— 这就是
 * 二级表存在的全部理由。
 */
registerFigureKind(mermaidFigureKind, import.meta.hot)

/**
 * 注册:图是 **object**,檐按 F1 净卡定稿 —— 左端只有类型词,右端只有动作。
 *
 * ── 檐上没有 `meta`,也没有题注 ────────────────────────────────────────
 * 定稿把图的檐压到只剩一个词。`model.title` 这一格在词汇表里立着(将来工具产地
 * 可能带图名过来),但今天不画:题注行是报纸排版,图在聊天里说的话在图里。
 *
 * ── 动作三个,只露一个 ────────────────────────────────────────────────
 * 「放大」常显,「下载 PNG / 查看源码」进 ⋯(`frontActions: 1`)。放大是看图时
 * 十次有九次要的那一下,另外两个是偶尔。
 *
 * `zoom` 与 `download.png` 拿到的是**取件口**而不是内容:声明发生在渲染之前,
 * 那一刻还没有 SVG(见 registry.ts 的 `SvgSource`)。取件口读的是图种表的渲染
 * 缓存 —— 于是「屏幕上这张图」和「放大/导出的那张图」逐字节是同一份,
 * 不会出现放大后重渲染出一个略有不同的版本。
 *
 * `streaming: 'atomic'` —— 半截的图源码画不出图。流式期间它由围栏路由按
 * `code(closed:false)` 逐行长出来,闭合那一刻原位换装(§6)。
 * 没有块壳的 `loader`:拉 mermaid 归图种表自己管,理由见 Figure.tsx 头注。
 */
registerBlock({
  kind: 'figure',
  presentation: 'object',
  streaming: 'atomic',
  Component: Figure,
  chrome: (model) => ({ id: figureTypeWord(model) }),
  frontActions: 1,
  actions: (model) => [
    { verb: 'zoom', svg: () => cachedFigureSvg(model.figKind, model.source) },
    {
      verb: 'download',
      what: 'png',
      filename: `${figureTypeWord(model)}.png`,
      svg: () => cachedFigureSvg(model.figKind, model.source),
    },
    { verb: 'view-source' },
  ],
}, import.meta.hot)

/**
 * 檐上那个类型词:图种自己认得出就用它认的(mermaid 的 `flowchart` / `sequence`),
 * 认不出就显 figKind 本身(`mermaid`)。同步、纯函数 —— 檐画在渲染之前。
 */
function figureTypeWord(model: FigureModel): string {
  return resolveFigureKind(model.figKind)?.label?.(model.source) ?? model.figKind
}
