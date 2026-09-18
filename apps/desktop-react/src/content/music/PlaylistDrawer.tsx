import { useRef } from 'react'
import { X } from '../../components/icons'
import { FocusScope } from '../../focus/FocusScope'
import { IconButton } from '../../ui/IconButton'
import { useT } from '../../i18n'
import { ProgrammeSheet } from './ProgrammeSheet'
import s from '../MusicPanel.module.css'

/**
 * **播放列表抽屉**(音乐面 v7,正本 `docs/music-panel-2026-09.md` §1)。
 *
 * 用户原话:「你这个歌词我以为是歌曲列表呢。谁家歌曲列表直接往下铺一排啊。」——
 * 所以任何宽度下节目单都**不铺在页面上**,它住在歌条上那颗钮后面。
 *
 * ── 两档,差别只有「从哪儿来」────────────────────────────────────────────
 * ≥ 560 从右边滑出(宽 `--music-drawer-w`、通高),< 560 从底下升起(高
 * `--music-drawer-h`)。哪一档由**面板自己的宽**说(`panel-width.ts`),这件只读那格
 * `form`;里面装的东西两档逐字相同 —— 就是今天的 `ProgrammeSheet`(拖拽换序还没有,
 * 上移 / 下移与其余动作在右键菜单里,一个字没改)。
 *
 * ── 三条出口,一条归还 ──────────────────────────────────────────────────
 * 点遮罩、按 Esc、按 ✕ 都关。焦点的归还是**结构性**的(响应链 §3.5 规则 5):
 * 这一格 `float` 作用域一卸载,路径缩回它的父,焦点回到父上次所在的元素 ——
 * 也就是开它的那颗「播放列表」钮。这里因此没有一句 `focus()`,也没有一句
 * 「借了要还」的簿记。Esc 由这一层认领(`onEscape` 答 true):它比音乐面那一格深,
 * 所以「有抽屉先关抽屉」是**树的深度**保证的,不是谁先注册。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * ① 生命周期:挂载即 `activateOnMount`,焦点落到抽屉里第一个可聚焦元素(✕);
 *    换歌不关、电台关台不关(里面换成空态);卸载不落盘 —— 下次开面板从唱机开始。
 * ② UI 生命状态:身子就是 `ProgrammeSheet` 自己的四态(首载不画 / 空一句 /
 *    超量封顶 + 读数 / 出错就地一行),这件不重画一份。
 * ③ UI 交互状态:遮罩 hover 无态(它不是控件);✕ 随 `ui/IconButton`;
 *    抽屉内滚动由身子那一层管。
 */
export function PlaylistDrawer({ form, onClose }: { form: 'side' | 'sheet'; onClose: () => void }) {
  const t = useT()
  const closeRef = useRef<HTMLButtonElement | null>(null)

  return (
    <>
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions --
        * 点遮罩关闭是**鼠标的顺手路**,不是唯一出口:Esc 认领在下面那一格,✕ 也在。
        * 规则看不见那条键盘路径,所以它在这里是误报。刻意不给 role="button":
        * 遮罩不是按钮,报成按钮会让读屏软件念出一个不存在的控件。
        * 判 mousedown 且 target === currentTarget,与 ui/Dialog 逐字同一条。今天抽屉是
        * 遮罩的**兄弟**而不是孩子,所以这一条是防守性的;把它写成「谁按下的都算」,
        * 将来把抽屉挪进遮罩里就会变成「从抽屉里拖出去松手也关」。 */}
      <div
        className={s.drawerScrim}
        data-testid="music-playlist-scrim"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
      />
      <FocusScope
        scope="drawer"
        activateOnMount
        restingTarget={() => closeRef.current}
        onEscape={() => (onClose(), true)}
      >
        {({ scopeProps }) => (
          <aside
            {...scopeProps}
            className={s.drawer}
            data-form={form}
            data-testid="music-playlist"
            role="dialog"
            aria-label={t('music.playlist')}
          >
            <div className={s.drawerHead}>
              <h2 className={s.drawerTitle}>{t('music.playlist')}</h2>
              <IconButton
                ref={closeRef}
                icon={X}
                label={t('common.close')}
                testId="music-playlist-close"
                onClick={onClose}
              />
            </div>
            <div className={s.drawerBody}>
              <ProgrammeSheet />
            </div>
          </aside>
        )}
      </FocusScope>
    </>
  )
}
