import { forwardRef } from 'react'
import type { ButtonHTMLAttributes } from 'react'
// 普通 `.css`,不是 `.module.css` —— 这份东西整份是全局样式表(零本地类名),
// 而「只为副作用」的 CSS Module import 会被 `vite build` 摇掉、规则整份不进产物
// (09-02 病历,全文在 ButtonBase.css 文件头)。普通 CSS 的 import 摇不掉。
import './ButtonBase.css'

/**
 * **无样式按钮基座**(09-01 立,起因:业务面 88 处裸 `<button>`)。
 *
 * ── 裸钮的三类判法(`ui:consume` 门的 bare-button 规则)────────────────────
 *  ① **文字动作钮**(「保存」「重试」)→ 该消费 `ui/Button` / `ui/AsyncButton`;
 *  ② **图标钮**(⋯ / ✕ / 眼睛)→ 该消费 `ui/IconButton`;
 *  ③ **结构性交互元素**(瓦 / 卡 / 行 / 琴键 / 选项)→ 视觉本该定制,
 *     不该硬套 ①②。但它仍然**不许裸着**:一个裸 `<button>` 带着浏览器
 *     自己那套内边距、边框、字体和 `text-align: center`,每个消费面都要
 *     再手写一遍「清 UA」——那正是「各写各的」的另一种形态。
 * 这件就是 ③ 的落点:**只清 UA,一个像素都不画**(配方见同名 .module.css)。
 * ──────────────────────────────────────────────────────────────────────
 *
 * `type` 默认 `'button'`:表单里的 `<button>` 默认是 `submit`,一个「展开这一组」
 * 的行按下去会顺手提交整张表 —— 这条坑值得让默认值替所有人挡住。
 */
export type ButtonBaseProps = ButtonHTMLAttributes<HTMLButtonElement>

export const ButtonBase = forwardRef<HTMLButtonElement, ButtonBaseProps>(
  function ButtonBase({ type = 'button', ...rest }, ref) {
    return <button ref={ref} type={type} data-ui-base="" {...rest} />
  },
)
