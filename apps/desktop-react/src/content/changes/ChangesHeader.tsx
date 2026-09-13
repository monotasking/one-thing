import { RotateCcw } from '../../components/icons'
import { IconButton } from '../../ui/IconButton'
import { Tooltip } from '../../ui/Tooltip'
import { baseNameOf } from '../../data/files-source'
import type { GitStatusView } from '../../data/changes-source'
import type { MessageKey } from '../../i18n'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import s from './ChangesPanel.module.css'

/**
 * **改动面的檐**(「改动」面,正本 §3.4)。
 *
 * 四件:仓库根名 · 分支 · 合计 `+a −d` · 刷新钮。外加一格**拖把手** ——
 * 与文件面板的树行同一只 `useContentDrag`,拖出去的是 `diff:<root>`。
 *
 * ── 「仓库根名 ≠ 这一格的 key」时,tip 写根 ──────────────────────────────
 * 这一格的身份是**从哪儿问的**(`diff:<workdir>`),而答出来的根可能在它上面几层
 * (在 `packages/core` 里问,根是仓库顶)。屏幕上写的是**根的名字**(那才是「这是
 * 哪个仓」),而 Tooltip 里是那条根的全路径 —— 两句话各说各的,不合并成一句写不下
 * 的长串。
 *
 * ── 刷新钮转一圈,**是一次过渡不是一段循环动画** ────────────────────────
 * 逐字抄 `FilesPanel` 那一颗:角度单调递增(每按一次 +360),靠 `.headSpin` 上那条
 * transform 过渡走完 —— 一个 `@keyframes` 都不加(全仓关键帧只在 `styles/motion.css`
 * 里长)。它说的是「你刚才那一下到了」,不是「我在忙」(忙由旧屏不动 + 它自己的
 * pending 说)。
 */

export interface ChangesHeaderProps {
  /** 这一格的 key(问的那个目录)。 */
  root: string
  /** 读回来的那一份(还没读到 = undefined)。 */
  view: GitStatusView | undefined
  /** 按了几次刷新(单调递增,只用来转圈)。 */
  spins: number
  onRefresh: () => void
  /** 这一发重拉在不在飞(钮自己的 pending,律③)。 */
  refreshing: boolean
  onDragPointerDown: (event: ReactPointerEvent) => void
  t: (key: MessageKey, vars?: Record<string, string | number>) => string
}

export function ChangesHeader({
  root,
  view,
  spins,
  onRefresh,
  refreshing,
  onDragPointerDown,
  t,
}: ChangesHeaderProps) {
  /*
   * 仓库根答不出来(还在读 / 不是仓库)就写**问的那个目录**的名字 —— 檐上永远
   * 有一个名字,而不是先空一格再跳出来一个(无位移原则)。
   */
  const repoRoot = view?.root ?? root
  const stat = view?.stat

  return (
    <div className={s.head} data-panel-head="" data-testid="changes-head">
      {/*
       * 拖把手 = 檐上那块**写着名字的地方**本身(与文件面板的树行同一手:
       * 拖的是「这块内容」,所以抓的就是它的名字)。`onPointerDown` 之外不挂
       * 任何键盘语义 —— 它不是一颗钮,拖拽是鼠标的手势;键盘搬这一格走的是
       * 叶檐上那条既有的路(⌘W / 右键菜单)。
       */}
      {/*
       * 全路径走 `ui/Tooltip`,不写 native `title=`(禁令,而且 native 的那一格
       * 一秒多才出来、样式不受控)。屏幕上写的是**根的名字**(那才是「这是哪个仓」),
       * tip 里是那条根的全路径 —— 两句话各说各的,不合并成一句写不下的长串。
       */}
      <Tooltip content={repoRoot}>
        <div
          className={s.repo}
          data-testid="changes-repo"
          data-repo-root={repoRoot}
          onPointerDown={onDragPointerDown}
        >
          <span className={s.repoName}>{baseNameOf(repoRoot) || repoRoot}</span>
          {/*
           * 分支。**答不出就不画**(游离 HEAD / 不是仓库)—— 画一句「(无分支)」
           * 是替一个不存在的事实占位。
           */}
          {view?.branch && <span className={s.branch}>{view.branch}</span>}
        </div>
      </Tooltip>
      {/*
       * 合计。**两枚读数,不是徽章**(与 diff 块的檐同一条判词):同号同字,
       * 只有颜色不同。零那一侧不画 —— `+0` 说不出任何事。
       */}
      {stat && (stat.add > 0 || stat.del > 0) && (
        <span className={s.total} data-testid="changes-total">
          {stat.add > 0 && <span className={s.statAdd}>{`+${stat.add}`}</span>}
          {stat.del > 0 && <span className={s.statDel}>{`−${stat.del}`}</span>}
        </span>
      )}
      <IconButton
        icon={RotateCcw}
        size="md"
        className={s.headSpin}
        style={{ '--changes-spin': spins } as CSSProperties}
        label={t('diff.refresh')}
        aria-busy={refreshing || undefined}
        onClick={onRefresh}
        data-testid="changes-refresh"
      />
    </div>
  )
}
