import { useLayoutEffect, useRef } from 'react'
import { focusTree } from '../focus/registry'
import { FocusScope } from '../focus/FocusScope'
import { useT } from '../i18n'
import { IconButton } from '../ui/IconButton'
import { contentKindOf, refId } from '../workbench/kinds'
import { useFullSlot } from '../workbench/full-slot'
import { renderRef } from '../workbench/render'
import { useWorkbenchStore } from '../workbench/store'
import { HostTitle } from './HostTitle'
import { resolveIcon, X } from './icons'
import s from './FullLayer.module.css'

/**
 * **真全屏**(W2,设计 `docs/workbench-2026-09.md` §4)。
 *
 * 一句话:**一块内容铺满整扇窗口**。顶栏、四条架子、所有浮窗、Dock 全都被它盖住,
 * 顶上只留一条 28px 檐带(让位 + 身份 + 一颗退出钮)。
 *
 * ── 它与「盖」的差别,就是拍点 ② 那一句 ────────────────────────────────
 * 「盖」(`--z-cover: 100`,W2 退役)压不过浮窗、压不过 Dock、还让出一整条顶栏 ——
 * 用户 09-04 的原话是「不是全屏的那个全屏」。全屏 `--z-full: 550` 压得过浮窗(200)
 * 与 overlay(500),Dock(650)不靠 z 压而是**转成自动隐藏档**(判据在 `AppShell`
 * 的 `effectiveDockDisplay` 上)。压不过的只有 modal(600)以上:全屏里弹出的
 * 确认框、菜单、Tooltip、Toast 照常在它之上,那是对的。
 *
 * ── 它**不画内容**,除了一种情况 ────────────────────────────────────────
 * 全屏是**投影**:那一格 tab 仍旧住在它原来那片叶里,进出全屏一次都不重挂
 * (判词与三条实测读数写在 `workbench/PaneLeaf.tsx` 文件头)。所以这只组件的身子
 * 是一格**空容器** `[data-full-slot]`,由持有那一格的那片叶 `createPortal` 进来。
 *
 * **唯一的例外是「哪棵树都不在」那一路**(`full.from === null`):Dock 上「打开方式
 * = 全屏」的那些瓦落定时先被从每棵树里摘干净了,此刻没有任何一片叶持有它 ——
 * 没有实例可投影,也就没有「重挂」可言(它本来就要现造一份)。那一路由这里
 * `renderRef` 自己画。两条路各有各的理由,不是两个产地画同一件事。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * ① **生命周期**
 *   挂载    `full` 从 null 变成一格 → 这一层出现;`activateOnMount` 把键盘请进来
 *           (搬 DOM 会把焦点打掉 —— `appendChild` 移动一个含焦点的节点,浏览器
 *           把焦点收回 body;响应链的 I1 复查会兜住,但落点该由这一层说了算)
 *   内容进出 那片叶的 holder 搬进 `[data-full-slot]` / 搬回自己身上。
 *           **React 一格都没动**,所以这一格不是「挂载」也不是「卸载」
 *   卸载    `full` 变回 null → 这一层整个不画;焦点由下面那一句送回**原叶原 tab**
 *           (`activateScope('leaf', { owner: refId })` —— 内容的 DOM 刚被搬回去,
 *            结构归还够不着它)
 *   动效    **没有**。设计 §10 的原话是「动效档 none 直切」,而这一层的进出同时
 *           在搬一个真 DOM 节点 —— 让它多活一帧只会让内容在两个地方各闪一次
 * ② **UI 生命状态**
 *   檐带    **常驻**(拍点 ⑥ 只取了样例 A 的常驻檐带,B 的「2s 自动收起」不做,留账)
 *   身份    活的盖静的(`HostTitle` 读 `stage/live-title`);未保存丸随它
 *   内容    loading / error 全由内容自己那一层说(错误边界在 `renderRef` 里)
 *   Dock    藏 / 唤出(不是这一层画的:`AppShell` 把有效档换成 autohide)
 * ③ **UI 交互状态**
 *   退出钮  随 `ui/IconButton`(rest / hover / focus / active 配方全在件里)
 *   Esc     这一层认(`onEscape`);它同时也是退层链的第一站
 *           (`stage/transitions.escapeTargetOf`),两条路都通向同一个 `exitFull`
 *   ⌘⇧↩    再按一次 = 退出(落点在 `workbench.toggleFull`)
 */
export function FullLayer() {
  const t = useT()
  const full = useWorkbenchStore((st) => st.full)
  const exitFull = useWorkbenchStore((st) => st.exitFull)
  const setSlot = useFullSlot((st) => st.setSlot)

  /*
   * **退出时把键盘送回原叶原 tab**(§3.5 规则 5「关掉什么,焦点回打开它的地方」)。
   *
   * 为什么不靠结构归还:归还认的是**卸载**,而这一次卸载的只有全屏层自己 ——
   * 内容那棵子树一格都没动(它只是被 `appendChild` 搬回了叶的身子里)。
   * 树上记的 `returnTo` 指向的是「按 ⌘⇧↩ 之前那个第一响应者」,而那一格恰恰
   * 就是这一格内容;可搬 DOM 那一下已经把焦点打掉过一次,归还的落点不可靠。
   * 所以这里显式点名:owner = 那一格的 `refId`(`PaneTabLayer` 就是按它登记的)。
   *
   * 这只组件**永远挂着**(`full` 为空时只是不画),所以这条 effect 拿得到「上一拍
   * 是什么」——把它写成全屏层内部的 effect 反而做不到:那时它已经卸载了。
   */
  const before = useRef(full)
  useLayoutEffect(() => {
    const prev = before.current
    before.current = full
    if (prev && !full) focusTree.activateScope('leaf', { owner: refId(prev.ref), reason: 'restore' })
  }, [full])

  if (!full) return null

  const kind = contentKindOf(full.ref.kind)
  const Icon = resolveIcon(kind?.icon(full.ref) ?? 'Square')
  const still = kind?.title(full.ref)

  return (
    /*
     * 这一层是响应链上的一格 `layer`(与舞台 / 浮窗 / 架子同档):它**认 Esc** ——
     * 与退层链那一站是同一个动作,两处都收敛到 `exitFull`。
     * `activateOnMount`:开出来就把键盘请进来(§3.5 规则 2「打开什么,焦点进什么」)。
     */
    <FocusScope
      scope="full-layer"
      owner={refId(full.ref)}
      activateOnMount
      /* Esc 归这一层:退出,并且**接住**(答 true,后面的层轮不到)。 */
      onEscape={() => {
        exitFull()
        return true
      }}
    >
      {({ scopeProps }) => (
        <div
          {...scopeProps}
          className={s.full}
          data-testid="full-layer"
          /*
           * `role="region"` 而不是 `dialog`:它**不是**对话框 —— 后面那些面还在,
           * 只是被盖住了;报成 dialog 会让读屏软件宣布一个并不存在的模态。
           * 同理不加 `aria-modal`。名字给一句真话:「全屏」。
           */
          role="region"
          aria-label={t('full.region')}
        >
          <div className={s.strip} data-testid="full-strip">
            {/* 红绿灯让位:与 `TopBar` 读**同一个** `--topbar-lead`(三档的定义提到了
              * 壳根,判词写在 `AppShell.module.css` 上)。这里只消费,不定义。 */}
            <div className={s.lead} aria-hidden="true" />
            <Icon className={s.icon} strokeWidth={1.75} aria-hidden="true" />
            {/* 身份复用宿主檐那一件:活标题盖静态名 + 未保存丸 + 截断配 Tooltip 全名。 */}
            <HostTitle
              id={refId(full.ref)}
              fallback={still?.text ?? full.ref.key}
              className={s.title}
            />
            <IconButton icon={X} size="sm" onClick={exitFull} label={t('full.exit')} />
          </div>

          {/*
            身 = 那一格内容。两条路,判据是「有没有一片叶持有它」——
            住在树里 → 空容器,由那片叶 portal 进来(零重挂);
            哪棵树都不在 → 这里自己画(没有实例可投影,见文件头)。
          */}
          <div className={s.body} data-full-slot="" ref={setSlot}>
            {full.from === null && renderRef(full.ref, { visible: true, interactive: true })}
          </div>
        </div>
      )}
    </FocusScope>
  )
}
