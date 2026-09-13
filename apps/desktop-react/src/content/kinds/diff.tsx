import { registerContentKind } from '../../workbench/kinds'
import { baseNameOf } from '../../data/files-source'
import { ChangesPanel } from '../changes/ChangesPanel'
import { disambiguatedDirName } from '../files/dir-names'
import { DIFF_KIND, diffRef } from './diff-ref'
import type { ContentRef } from '../../workbench/kinds'

/**
 * **「这个工作目录此刻改了什么」这一种内容**(「改动」面,正本
 * `apps/desktop-react/docs/changes-panel-2026-09.md` §3.1;**逐字对着 `dir.tsx`**)。
 *
 * ── 它从前是什么、现在是什么 ────────────────────────────────────────────
 * 从前 Dock 上那块「改动」瓦点开是 `panel:diff` —— 一块写死五行代码的 `DiffMock`。
 * 改动不是「一块面」,它是**一族**:一个工作目录一份 `diff:<workdir>`。所以那块瓦
 * 降格成**启动瓦**(`content/diff-launcher.tsx`),这一种接手内容那一半,
 * 数据来自后端 `git:` 资源的两条读法(`status` / `diff`)。
 * 判例与 `files`(W6-a)/ `terminal`(T1)两行逐字相同。
 *
 * ── 名字 = 目录名,同名带父目录 ──────────────────────────────────────────
 * 与目录 tab **同名**,靠图标分辨(`GitCompare` vs `FolderTree`)—— 这是有意的:
 * 屏幕上那两格说的是同一个地方的两件事,名字分家反而要人各记一套。判据本体是
 * 与目录那一种共用的纯函数 `content/files/dir-names.disambiguatedDirName`
 * (它要读「此刻树上还开着哪些目录」,所以那一句不在这里)。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * 全部由 `ChangesPanel` 自己说(它的组件头上那三张表)。这一层没有任何自己的状态:
 *  · 生命周期:挂载 = 这一格 tab 出现在某片叶里;**换宿主**(center → edge →
 *    float)由拼贴树的结构共享保证不重挂;卸载 = 这一格关掉 / 藏起来;
 *  · **没有 `dispose`** —— 它一格实例状态都不留在全局:读数住在 `changes-source`
 *    那两族 query 里(那是缓存,不是这一格的),选中行随组件走。
 */

registerContentKind(
  {
    id: DIFF_KIND,
    // 同一个目录可以在两片叶里各开一份(与 `dir` / `file` 同一条:它不是单例)。
    singleton: false,
    title: (ref: ContentRef) => ({
      text: disambiguatedDirName(ref.key) || baseNameOf(ref.key) || ref.key,
      tip: ref.key,
    }),
    // 两版对照 = 改动。名字取的是 `components/icons` 的注册表键(大写开头),
    // 拼错了 `resolveIcon` 会静默退回 FolderTree —— 所以照表写。
    // 这一枚与 Dock 瓦那一行(`stage/items.ts` 的 `diff`)是同一枚:瓦与它开出来的
    // 内容长同一个形,人才认得出「我点的那块瓦开出来的就是这一格」。
    icon: () => 'GitCompare',
    render: (ref) => <ChangesPanel root={ref.key} />,
    /*
     * **激活这一格 = 焦点进文件列**(与 `dir` / `terminal` 那两格同一条自述)。
     *
     * 不声明它的话 `focusIntoRef` 只能退回 `leaf` 那一层 —— 而 `leaf` 是
     * `passThrough`,能不能穿到这块面里要看那一刻这块面登记好了没有。声明成一句
     * 自述之后,「进这一格」说的就是**进它自己那块面**,而「落在哪一行」是
     * `ChangesPanel` 的 `restingTarget`(文件列第一行):一句说进哪块面,一句说
     * 进去之后站哪儿。
     */
    focusInto: 'diff',
    /*
     * **它是伴随面**(C3 留账「`diff` 单例瓦留口」在这一行还清;设计
     * `session-continuity-2026-09.md` §3)。
     *
     * `seed` 是「没记录时按**种类**继承」那一句:离场那条会话开着改动面 → 给进场
     * 那条开一格**它自己 workdir** 的改动面。开的是 `diffRef` 而不是启动瓦那条路
     * —— 后者还要算落点,而这一下的落点是**离场那一格坐的地方**(判词在
     * `workbench/companions.ts`)。
     *
     * 会话没绑工作目录 = 答 `null` = **什么都不开**。与 `dir.companion.seed` 那句
     * 判词同源,而且在这一种上更硬:主目录多半不是一个 git 仓库,自动给人开一格
     * 「这里不是仓库」是一次没人要过的打开。
     */
    companion: {
      seed: (env) => (env.workdir ? diffRef(env.workdir) : null),
    },
  },
  import.meta.hot,
)
