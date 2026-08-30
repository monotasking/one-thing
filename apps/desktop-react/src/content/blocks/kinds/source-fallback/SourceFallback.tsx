import type { BlockModel } from '../../../model/blocks'
import { SourceView } from '../../shell/SourceView'

type SourceFallbackModel = Extract<BlockModel, { kind: 'source-fallback' }>

/**
 * 兜底块 —— **一切失败的归宿**,所以它是一等公民而不是 catch 分支里的一段 JSX。
 *
 * 三条路都通到它:解析器认不出这一段、注册表不认识这个 kind、渲染器画抛了。
 * 三条路看到的东西必须是同一份(`SourceView`),否则「源码永远可见」就成了
 * 三种不同的可见。
 *
 * 檐上那个 `reason` 是**机器口径的一个词**(`unknown-kind:foo` / `tool-default`),
 * 不翻译 —— 与错误边界的 `where` 同一条判据:换一门语言它不该跟着变。
 */
export function SourceFallback({ model }: { model: SourceFallbackModel }) {
  return <SourceView source={model.source} />
}
