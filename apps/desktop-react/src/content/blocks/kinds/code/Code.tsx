import type { BlockModel } from '../../../model/blocks'
import { CodeLines, sourceCodeLines } from '../../../code/CodeLines'
import { useHighlight } from '../../../code/useHighlight'

type CodeModel = Extract<BlockModel, { kind: 'code' }>

/**
 * 代码块的本体 —— **檐卡**的 body(檐由壳画,见 index.ts 的 chrome 声明)。
 *
 * 块内横滚、限高渐隐折叠、复制源码,三件都归壳(铁律 3);**行怎么画**归基础件
 * `content/code/CodeLines`(2026-09-13 批 ①:同一串行从前在代码块、查看器、diff
 * 三处各写一份)。所以这里只剩两件事:把源码切成行,有颜色就把 token 填进去。
 *
 * 代码块要的是三档行号里**最朴素的那一档**(`numbers: 'none'`)—— markdown 正文里
 * 的一块代码不是一份「有坐标的文件」,给它一列行号等于说「你可以引用第几行」,
 * 而这块上没有任何按行的入口。
 *
 * 素文本先行那条降级路径长在 `content/code/useHighlight` 上(三处共用一把闸)。
 * 这块自己要补的只有一句:块 key 由源偏移派生,所以库到了原位重画,不重挂 ——
 * 滚动位置与展开态都留着。
 */
export function Code({ model }: { model: CodeModel }) {
  const highlighted = useHighlight(model.source, model.lang)

  return <CodeLines lines={sourceCodeLines(model.source, highlighted)} numbers="none" />
}
