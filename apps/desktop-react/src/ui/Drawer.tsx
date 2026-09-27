import { useRef } from 'react'
import type { ReactNode, Ref } from 'react'
import { X } from '../components/icons'
import { FocusScope } from '../focus/FocusScope'
import { useT } from '../i18n'
import { IconButton } from './IconButton'
import s from './Drawer.module.css'

/**
 * **抽屉**(主持人抽屉 H0,2026-09-27;正本 `docs/music-panel-2026-09.md` §16.2 / §16.5)。
 *
 * 基础件先行:这副骨架原是音乐面播放列表抽屉(`content/music/PlaylistDrawer`)一家的,第二个消费者
 * (主持人抽屉 `HostDrawer`)出现的那一天抬进库里 —— 两只抽屉各自消费,不再各写一份遮罩与 Esc。
 *
 * ── 两档,差别只有「从哪儿来」─────────────────────────────────────────────
 * `form='side'` 从右边滑出(宽 `--drawer-w`、通高),`form='sheet'` 从底下升起(高 `--drawer-h`)。
 * 哪一档由**消费方自己的宽**说,件只读那一格。宿主要是一个定位容器 —— 遮罩只铺那块面,不铺整扇窗。
 *
 * ── 三条出口,一条归还 ──────────────────────────────────────────────────
 * 点遮罩(mousedown 且按在遮罩自己身上)、按 Esc、按 ✕ 都关。焦点的归还是**结构性**的(响应链
 * 规则 5):这一格 `float` 作用域一卸载,路径缩回它的父,焦点回到父上次所在的元素 —— 也就是开它
 * 的那颗钮 / 那只宠物。件里因此没有一句 `focus()`。Esc 由这一层认领(`onEscape` 答 true),它比
 * 宿主那一格深,所以「有抽屉先关抽屉」是**树的深度**保证的。
 *
 * ── API ─────────────────────────────────────────────────────────────────
 * 檐 = `lead`(可选,头像一类的装饰)+ `title` + `subtitle`(可选,一句状态)+ `tools` + ✕;
 * 身子 = `children`,自己滚;`footer`(可选)在身子下面,不跟着滚(输入框住这儿)。
 * `restingTarget` 缺省是 ✕;要让焦点落进输入框的消费方自己答。`fill` = 底下升起那一档也定高
 * (身子是一条会长的流时,抽屉不跟着行数涨落)。测试钩子全从 `testId` 派生:
 * `<testId>` / `<testId>-scrim` / `<testId>-close`。
 *
 * ── 三张状态表(库件规格)──────────────────────────────────────────────
 * ① 生命周期:随开随挂、关即卸(消费方按「开没开」挂它);挂载即 `activateOnMount`,焦点落到
 *    `restingTarget`(答不出落 ✕);换 `form` 不重挂(同一只节点只换 `data-form`);卸载不落盘;
 *    无订阅 / 无计时器 / 无模块级副作用 → 不需要 HMR dispose。
 * ② UI 生命状态:件不取数,没有 empty / loading / error —— 身子里装什么、每一态长什么样归消费方。
 *    **超量**:身子自己滚(`overscroll-behavior: contain`,滚到头不带着宿主滚),抽屉不被撑破。
 * ③ UI 交互状态:遮罩 hover 无态(它不是控件);✕ 随 `ui/IconButton`;焦点环走全局载体。
 */
export interface DrawerProps {
  form: 'side' | 'sheet'
  /** 檐上的名字。也是缺省的读屏名。 */
  title: string
  onClose: () => void
  /** 檐右边、✕ 前面那几颗(关台一类)。 */
  tools?: ReactNode
  children: ReactNode
  /** 根的 `data-testid`;遮罩与 ✕ 从它派生。 */
  testId: string
  /** 读屏名。缺省 = `title`。 */
  label?: string
  /** 檐最左边一件装饰(头像)。读屏不念 —— 名字已经在 `title` 里。 */
  lead?: ReactNode
  /** 名字后面那一句(状态牌)。一行,只截断不换行。 */
  subtitle?: ReactNode
  /** 身子下面、不跟着滚的一格(输入框)。 */
  footer?: ReactNode
  /** 身子那一格(真正在滚的那一层)—— 贴底跟随一类的读法要它。 */
  bodyRef?: Ref<HTMLDivElement>
  /** 焦点进来落在哪。缺省 ✕;答 null 也落 ✕。 */
  restingTarget?: () => HTMLElement | null
  /** 底下升起那一档也定高(缺省按内容长,封顶 `--drawer-h`)。 */
  fill?: boolean
}

export function Drawer({
  form,
  title,
  onClose,
  tools,
  children,
  testId,
  label,
  lead,
  subtitle,
  footer,
  bodyRef,
  restingTarget,
  fill = false,
}: DrawerProps) {
  const t = useT()
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const heading = <h2 className={s.title}>{title}</h2>

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
        className={s.scrim}
        data-testid={`${testId}-scrim`}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
      />
      <FocusScope
        scope="drawer"
        activateOnMount
        restingTarget={() => restingTarget?.() ?? closeRef.current}
        onEscape={() => (onClose(), true)}
      >
        {({ scopeProps }) => (
          <div
            {...scopeProps}
            className={s.drawer}
            data-form={form}
            data-fill={fill ? 'true' : undefined}
            data-testid={testId}
            role="dialog"
            aria-label={label ?? title}
          >
            <div className={s.head}>
              {lead !== undefined || subtitle !== undefined ? (
                <div className={s.ident}>
                  {lead !== undefined ? <span aria-hidden="true">{lead}</span> : null}
                  {heading}
                  {subtitle !== undefined ? <span className={s.subtitle}>{subtitle}</span> : null}
                </div>
              ) : (
                heading
              )}
              <span className={s.tools}>
                {tools}
                <IconButton ref={closeRef} icon={X} label={t('common.close')} testId={`${testId}-close`} onClick={onClose} />
              </span>
            </div>
            <div ref={bodyRef} className={s.body}>
              {children}
            </div>
            {footer !== undefined ? <div className={s.foot}>{footer}</div> : null}
          </div>
        )}
      </FocusScope>
    </>
  )
}
