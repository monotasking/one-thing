import { registerContentKind } from '../../workbench/kinds'
import { baseNameOf, revealMutation } from '../../data/files-source'
import { tabIconOf } from '../../data/file-icons'
import { isDirty, useViewerSource } from '../../data/viewer-source'
import { FileViewer } from '../viewer/FileViewer'
import { askViewerClose } from '../viewer/close-hub'
import type { ContentRef } from '../../workbench/kinds'

/**
 * **文件这一种内容**(设计 §1.1;它就是从前那块「查看器」瓦的降格)。
 *
 * `key` = 绝对路径,`singleton: false` —— 同一份文件可以在两片叶里各开一个
 * (那正是 W3「拖一份到旁边对照着看」要的)。`resident` 缺席:文件当然关得掉。
 *
 * ── 四条自述各自替掉了什么(其中 `toolbar` 已于 W7-c 退役) ──────────────────────────────────────────────
 *  · `title` —— 从前是 `ViewerPanel` 那只 effect 往 `live-title` 里发布的一句话。
 *    静态那一半(文件名)在这里;**未保存丸**那一半仍然是活的,由查看器
 *    发布进 `live-title`(键 = refId),叶檐读表时活的盖静的;
 *  · `toolbar` —— **W7-c 整格退役**。W1 时它是一句自述、由叶檐挂进动作组;
 *    顶栏右端做减法之后(裁定 2:只剩 ⋯ 与 AgentChip)那个槽位没有了,它唯一的
 *    住户(markdown 的「渲染 ⇄ 源码」)搬进内容区自己的右键菜单,由查看器型
 *    自述 `viewModes` 那组**纯数据**;
 *  · `beforeClose` —— 从前是 `FileViewer` 里那格 `confirmClose` state + 它自己
 *    挂的 `ViewerCloseConfirm`。现在关闭这件事发生在**叶檐**上(tab 的 ✕),
 *    所以那一问必须由这一种自己答,不能长在被关掉的那棵树里;
 *  · `dispose` —— 关闭 = 丢实例(隐藏不丢)。设计 §2.3 那张表的数据侧。
 */

/** 文件名的活标题里那个未保存丸,由查看器发布;这里给的是静态那一半。 */
function titleOf(ref: ContentRef) {
  const live = useViewerSource.getState().instances[ref.key]
  const name = live?.file?.name ?? baseNameOf(ref.key)
  return {
    text: name,
    dirty: live ? isDirty(live.file, live.edit) : false,
    // 提示给**整条路径**:tab 上那格窄,而两个目录里的同名文件在屏幕上长得一样。
    tip: ref.key,
  }
}

/**
 * tab 上那枚图标。**那个联合在 `data/file-icons` 里拆**(单产地,判据在
 * `file-glyph-single-source.test.ts`),这里只是一行委托。
 */
function iconOf(ref: ContentRef): string {
  return tabIconOf(baseNameOf(ref.key))
}

registerContentKind(
  {
    id: 'file',
    singleton: false,
    title: titleOf,
    icon: iconOf,
    render: (ref) => (
      <FileViewer
        path={ref.key}
        /*
         * reveal 走 `revealMutation`(7d)。这里与 FilesPanel 逐字同一条:
         * 内容表只把回调透传下去,那颗真钮长在 viewer/HonestState 里。
         */
        onReveal={(path) => void revealMutation.run(path)}
      />
    ),
    beforeClose: (ref) => askViewerClose(ref.key),
    dispose: (ref) => useViewerSource.getState().dispose(ref.key),
  },
  import.meta.hot,
)
