import { registerContentKind } from '../../workbench/kinds'
import { baseNameOf } from '../../data/files-source'
import { FilesPanel } from '../FilesPanel'
import { disambiguatedDirName } from '../files/dir-names'
import { DIR_KIND } from './dir-ref'
import type { ContentRef } from '../../workbench/kinds'

/**
 * **「以某个目录为根的一棵文件树」这一种内容**(W3 立;W6-a 扶正为文件面板的
 * **唯一**形态,设计 `apps/desktop-react/docs/workbench-tabs-2026-09.md` §3)。
 *
 * ── W6-a 之前它是什么、现在是什么 ────────────────────────────────────────
 * W3 登记它,是因为「项目一行拖出去 = 一棵以那个目录为根的树」这条拖拽来源
 * 需要一个真的 `kind`。那时它是**一棵朴素的树**:没有面包屑、没有行菜单、
 * 没有打开点列 —— 因为那些东西住在 `panel:files` 那块面里,而那块面的状态
 * (一个 root、一份 expanded)是全应用一份的。
 *
 * 用户 09-05 的原话把这两者合并了:「files 本身应该是一个可以打开多个的存在,
 * 例如 note、例如 workdir,名字应该和 viewer 差不多,设置为目录名」。于是
 * `panel:files` 退役,而这一种**接手它的全部本事** —— 做法不是把那块面复制一份,
 * 是把 `FilesPanel` 改成**收 `root` 的组件**(判词写在那只文件的组件头上)。
 * 这只文件因此瘦到只剩一件事:**登记**。
 *
 * ── 名字 = 目录名,同名带父目录 ──────────────────────────────────────────
 * 标签与瓦上写的是 `basename`,Tooltip 是全路径;屏幕上同时开着两个同名目录时
 * 名字后面带上父目录(`docs · a` / `docs · b`)—— 与查看器对同名文件的做法一致。
 * 判据本体是纯函数 `content/files/dir-names.disambiguatedDirName`(它要读「此刻
 * 树上还开着哪些目录」,所以那一句不在这里)。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * 全部由 `FilesPanel` 自己说(它的组件头上那三张表)。这一层没有任何自己的状态:
 *  · 生命周期:挂载 = 这一格 tab 出现在某片叶里;**换宿主**(center → edge →
 *    float)由拼贴树的结构共享保证不重挂;卸载 = 这一格关掉 / 藏起来;
 *  · **没有 `dispose`** —— 它一格实例状态都不留在全局:展开态住在
 *    `files-source` 那张按绝对路径记的平表里(那是缓存,不是这一格的),
 *    选中 / 浮层落点随组件走。
 */

registerContentKind(
  {
    id: DIR_KIND,
    // 同一个目录可以在两片叶里各开一棵(与 `file` 同一条:它不是单例)。
    singleton: false,
    title: (ref: ContentRef) => ({
      text: disambiguatedDirName(ref.key) || baseNameOf(ref.key) || ref.key,
      tip: ref.key,
    }),
    // 目录就是目录那一枚。名字取的是 `components/icons` 的注册表键(大写开头),
    // 拼错了 `resolveIcon` 会静默退回 FolderTree —— 所以照表写。
    icon: () => 'FolderTree',
    render: (ref) => <FilesPanel root={ref.key} />,
    /*
     * **激活这一格 = 焦点进这棵树**(W7-c 裁定 6,与会话那一种同一条自述)。
     *
     * 不声明它的话,`focusIntoRef` 只能退回 `leaf` 那一层 —— 而 `leaf` 是
     * `passThrough`,能不能穿到这块面里要看那一刻这块面登记好了没有。声明成
     * 一句自述之后,「进这一格」说的就是**进它自己那块面**,与「落在哪一行」
     * 那件事(`FilesPanel` 的 `restingTarget`)各归各的:一句说进哪块面,
     * 一句说进去之后站哪儿。
     */
    focusInto: 'files',
  },
  import.meta.hot,
)
