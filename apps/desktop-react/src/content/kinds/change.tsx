import { registerContentKind, refId } from '../../workbench/kinds'
import { baseNameOf } from '../../data/files-source'
import { tabIconOf } from '../../data/file-icons'
import { ChangeFileView } from '../changes/ChangeFileView'
import { CHANGE_KIND, changePartsOf } from './change-ref'
import type { ContentRef } from '../../workbench/kinds'

/**
 * **「一个文件的改动」这一种内容**(批⑤,正本
 * `apps/desktop-react/docs/changes-file-view-2026-09.md` §6;逐字对着 `file.tsx`)。
 *
 * ── 它从前是什么、现在是什么 ────────────────────────────────────────────
 * 从前看一个文件的改动 = 在改动面里选中一行,右边那条分栏就地画出来 —— 于是
 * 「文件列」与「正文」永远绑在一块面里,而屏幕上看一个文件的路只有这一条。
 * 用户 09-14 的原话是「能否把这个 diff 的文件列表和文件拆开?查看文件的 diff 走
 * 默认的文件的 tab 行为?」。答案是能,而且形是现成的:目录面板点一个文件开的是
 * `file:<path>` 这一种内容,落在哪由 `data/file-open-mode.ts` 的七档说。这一种就是
 * 那条路在改动上的同一句话 —— **一个字都不另起**。
 *
 * ── 与 `diff` 的分工(两种,不是一种的两档)──────────────────────────────
 * `diff:<workdir>` 是一个目录的改动**列表**(`ChangesPanel`,伴随面、跟着会话收放);
 * `change:<workdir>|<path>` 是其中一个文件的**正文**(`ChangeFileView`)。
 * **它不是伴随面**:它与 `file` 同一档 —— 人开出来的一格,切会话时不跟着收放
 * (那是甲在看的那个文件的改动,与乙无关)。
 *
 * ── 名字 = 文件名,图标按文件认 ──────────────────────────────────────────
 * 标签上认的是**这个文件**而不是「改动」这件事:同时开着三格改动时,三个「改动」
 * 分不出谁是谁,而三个文件名分得出。所以 `icon` 走 `tabIconOf(文件名)`(与 `file`
 * 那一种逐字相同),身份差别交给悬停那一句 —— 全路径后面缀一个「· 改动」。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * 全部由 `ChangeFileView` 自己说(它的组件头上那三张表)。这一层没有任何自己的
 * 状态:
 *  · 生命周期:挂载 = 这一格 tab 出现在某片叶里;**换宿主**(center → edge → float)
 *    由拼贴树的结构共享保证不重挂;卸载 = 这一格关掉 / 藏起来;
 *  · **没有 `dispose`** —— 它一格实例状态都不留在全局:读数住在 `changes-source`
 *    那两族 query 里(那是缓存,不是这一格的),停在第几块随组件走;
 *  · **没有 `beforeClose`** —— 它是只读的一块面,关掉不丢任何东西。
 */

registerContentKind(
  {
    id: CHANGE_KIND,
    /*
     * 同一个文件的改动可以在两片叶里各开一格(与 `file` / `dir` / `diff` 同一条:
     * 它不是单例)——「拖一份到旁边对照着看」在这一种上同样成立。
     */
    singleton: false,
    /*
     * **这一格家具记在工作区那本账上**(S1)。改动是某个仓、某条会话的事,不是
     * 「这台壳的」—— 换一个工作区它该留在原地。`space` 是缺省值,写出来是**恒等
     * 声明**:这一种的 level 被人问起时,答案在它自己这一行上,不必去查缺省。
     */
    level: 'space',
    title: (ref: ContentRef) => {
      const at = changePartsOf(ref)
      const path = at?.path ?? ref.key
      return {
        text: baseNameOf(path) || path,
        /*
         * 提示给**整条路径**(tab 上那格窄,两个目录里的同名文件在屏幕上长得一样)。
         * 交的是**路径形**(09-13 的判例):檐与 tab 条据此画成「名字一行 + 目录一
         * 行」。`dir: false` —— 它指的是一个文件。
         *
         * 「这是改动不是文件」那半句由**图标以外的东西**说不出口时就不说:
         * 路径形的 tip 不收第二段文字(判词在 `content/model/title-tip.ts` 上 ——
         * 拼一句「· 改动」进去等于把路径变成一句话,`PathText` 当场画错)。
         * 屏幕上分得出的是:同一个文件开着「文件」与「改动」两格时,图标一样、
         * 名字一样,而**改动那一格里第一屏就是加删底色**。留账见交卷报。
         */
        tip: { path: at ? `${at.root}/${at.path}` : path },
      }
    },
    /*
     * tab 上那枚图标 = **这个文件**那一枚(`tabIconOf`,与 `file` 那一种同一只)。
     * 不画 `GitCompare`:那是「改动」这件事的图标,而这一格是「这个文件」。
     */
    icon: (ref: ContentRef) => tabIconOf(baseNameOf(changePartsOf(ref)?.path ?? ref.key)),
    render: (ref: ContentRef) => {
      const at = changePartsOf(ref)
      // 拆不出两段的 ref 根本不该活到这里(`exists` 在水合那一刻就剔掉了);
      // 真到了就画一块空的,而不是让整片叶崩掉。
      if (!at) return null
      return <ChangeFileView root={at.root} path={at.path} owner={refId(ref)} />
    },
    /*
     * **激活这一格 = 焦点进这块正文**(与 `dir` / `diff` / `terminal` 那几格同一条
     * 自述)。它与改动面共用 `diff` 那一格作用域声明 —— 两者是同一种面(一块只读
     * 的改动面),**而挑哪一份实例靠 owner**:`ChangeFileView` 在标准档下把自己的
     * refId 报上来(`FocusScope owner=`),`focusIntoRef` 先点名再退回不点名,
     * 于是「进这一格」进的正是这一格,不是屏幕上另一块 `diff` 面。
     */
    focusInto: 'diff',
    /*
     * **认不认得这一个实例**(纯语法,同步)。`ContentKind.exists` 那段判词点名
     * 「key 存不存在是异步事实的那几种别声明它」—— 这里问的**不是**那件事:
     * 盘上那个文件还在不在、它此刻还改没改,是 `ChangeFileView` 自己那几种诚实态
     * (「此刻没有改动」),不是「这一格 ref 认不认得出」。这一口只剔掉**拆不出
     * 两段**的 key(手改过的档案、被截断的存量),那与 `pair` 拆不出两格同一档。
     */
    exists: (ref: ContentRef) => changePartsOf(ref) !== null,
  },
  import.meta.hot,
)
