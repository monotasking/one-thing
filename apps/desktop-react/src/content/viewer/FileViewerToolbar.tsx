import { useViewerInstance, useViewerSource } from '../../data/viewer-source'
import { resolveViewer } from './registry'
import './kinds'

/**
 * **型工具条,单独一件**(W1,设计 §2.2:「文件类型工具条搬到叶檐的动作组里,
 * 由 `ContentKind` 以 `toolbar?(ref)` 自述」)。
 *
 * 它存在的理由只有一个:`ContentKind.toolbar(ref)` 交出来的是一个 React 元素,
 * 而这一格要读 store(哪一型、此刻的 view、编辑态)—— 那必须发生在一个组件里,
 * 不能在表上现算。所以表交出的是**这只组件**,由叶檐挂。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 *  ① 生命周期:跟着叶檐挂载 / 卸载。无计时器、无模块级副作用 → 不需要 HMR dispose。
 *  ② UI 生命状态:**这一型没有工具条 / 还没读到 / 正在编辑 → 整件不画**
 *     (不留一格空位:叶檐的动作组是 flex,空 span 会多出一格 gap)。
 *  ③ UI 交互状态:全部随那一型自己那件走(markdown 的分段器是 `ui/Segmented`)。
 */
export function FileViewerToolbar({ path }: { path: string }) {
  const { file, view, edit } = useViewerInstance(path)
  const setView = useViewerSource((st) => st.setView)
  if (!file || edit.editing) return null
  const handler = resolveViewer(file)
  if (!handler.Toolbar) return null
  const Toolbar = handler.Toolbar
  return <Toolbar file={file} view={view} onView={(patch) => setView(path, patch)} />
}
