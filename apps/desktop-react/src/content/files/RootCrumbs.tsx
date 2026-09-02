import { Fragment } from 'react'
import { ButtonBase } from '../../ui/ButtonBase'
import type { TFn } from '../../i18n'
import { breadcrumbsOf } from '../../data/files-source'
import type { Crumb, RootStatus } from '../../data/files-source'
import s from '../FilesPanel.module.css'

/** 面包屑最多平铺几段;再多就把**中段**折成一个 `…`(首段与末两段永远在)。 */
const CRUMB_MAX = 4

/**
 * 头上那一排路径。**这是投影**(breadcrumbsOf 是纯函数,判据不在这里)。
 * 三档各说各的,**不拿一个假路径去顶**还没定下来的根。
 *
 * 段数超过 CRUMB_MAX 时把**中段**折成一个 `…`:首段(通常是 `/Users`)与末两段
 * (「我在哪儿」与「从哪儿来的」)是这条路径上唯一还在被读的三格,中间那几层
 * 在窄面板里只会把整条头挤成一条横向滚轨。折的是**显示**不是事实 ——
 * 那条完整路径仍然原样挂在外面那个 `<nav>` 的 `data-root` 上(门与单测问的是
 * 后者,那才是它们真正要问的事实)。
 *
 * ── 三张状态表(状态先行)────────────────────────────────────────────────
 *  ① 生命周期:纯函数组件,零 state、零 ref、零副作用 → 不需要 HMR dispose。
 *  ② UI 生命状态:`loading`/`idle`(「正在定」一句话)、`error` 或没有根
 *     (「定不下来」另一句话 —— 与上一句**不同的字**,不拿一句话糊两档)、
 *     `ready` 且根就是 `/`(一段可点的都没有,只剩那条领头的斜杠)、
 *     `ready`(逐段画出来)、**超量**(段数 > CRUMB_MAX:中段折成 `…`)。
 *  ③ UI 交互状态:可点的祖先段 rest/hover/focus(`.crumb`,焦点走全局环);
 *     尾段与折起来的 `…` **不是钮**(点它们没有一个确定的去处),所以没有交互态。
 */
export function RootCrumbs({
  root,
  status,
  t,
  onJump,
}: {
  root: string | null
  status: RootStatus
  t: TFn
  onJump: (path: string) => void
}) {
  if (status === 'loading' || status === 'idle') {
    return <span className={s.crumbNote}>{t('files.rootLoading')}</span>
  }
  if (status === 'error' || !root) {
    return <span className={s.crumbNote}>{t('files.rootFailed')}</span>
  }
  const crumbs = breadcrumbsOf(root)
  // 根就是 `/`:一段可点的都没有,屏幕上只剩那条领头的斜杠。这是事实不是缺陷。
  if (crumbs.length === 0) return <span className={s.crumbSep}>/</span>
  const shown: (Crumb | 'ellipsis')[] =
    crumbs.length > CRUMB_MAX
      ? [crumbs[0], 'ellipsis', ...crumbs.slice(-2)]
      : crumbs
  return (
    <>
      {shown.map((crumb, index) => {
        if (crumb === 'ellipsis') {
          return (
            <Fragment key="ellipsis">
              <span className={s.crumbSep}>/</span>
              {/* 折起来的那几段。它不可点 —— 点它没有一个确定的去处。 */}
              <span className={s.crumbFold} aria-hidden="true">
                …
              </span>
            </Fragment>
          )
        }
        const last = index === shown.length - 1
        return (
          <Fragment key={crumb.path}>
            {/* 分隔斜杠是**真的文本**(不是 CSS ::before):读屏与门看到的是同一句话。 */}
            <span className={s.crumbSep}>/</span>
            {last ? (
              <span className={s.crumbCurrent} aria-current="location">
                {crumb.name}
              </span>
            ) : (
              <ButtonBase className={s.crumb} onClick={() => onJump(crumb.path)}>
                {crumb.name}
              </ButtonBase>
            )}
          </Fragment>
        )
      })}
    </>
  )
}
