import type { MotionTier } from '../reading/types'

/**
 * 时长在 CSS 里是 token,在 JS 里得有个数 —— 定时器读不了 var()。
 * 这个文件是那些 token 在 JS 侧的唯一镜像:组件不许自己写 ms 字面量,
 * 改时长时两边一起改这一处。
 *
 * 「两边一起改」不再靠自觉:`__tests__/motion-tokens.test.ts` 把下面每一个常量
 * 与 styles/tokens.css 里的对应 token **逐条比对**,对不上当场红。
 */
export const DUR_MS = 120 // --dur
export const EXIT_MS = 120 // --dur-exit
export const RELEASE_MS = 160 // --dur-release
export const FLASH_MS = 240 // --dur-flash
export const TOOLTIP_DELAY_MS = 300 // --dur-tooltip-delay
// --dur-dock-hide-delay:自动隐藏的收回宽限,离开留驻区后缓这么久才收,路过抖动不塌
export const DOCK_HIDE_DELAY_MS = 300
export const PREVIEW_DELAY_MS = 600 // --dur-preview-delay:悬停多久才把 Dock 预览泡长出来
/**
 * --dur-preview-grace:预览泡的收拢宽限。指针离开瓦(或泡)之后缓这么久才收,
 * 再进即取消 —— 瓦与泡之间隔着 --preview-lift 那 12px 缝,那一段路谁都不属于,
 * 修前一进缝泡就没了(08-31 真机实测:离瓦 3px 即消失)。
 * 与 ATT_GRACE_MS 同为「宽限」不是「动画」:动效档 none 一格都不碰它。
 */
export const PREVIEW_GRACE_MS = 320
/**
 * --dur-dock-aim-window:预览泡**瞄准区**的停顿窗口(09-01 修「走向泡的路上泡换人/消失」)。
 *
 * 它量的不是飞行总时长而是**停顿**:每一步只要还朝泡推进就续期,所以慢慢瞄
 * 不会被切断(真机上一条慢而平的真手路径要走一秒多,写成总时长必然中途到期);
 * 停在瞄准区里不动超过这么久,才认为「他不瞄了」并恢复常态。
 * 400 是主流 menu-aim 实现的那一档,也在用户拍板的 300–500 带内。
 * 与 PREVIEW_GRACE_MS 同为**手势窗口**不是动画:动效档 none 一格都不碰它。
 */
export const DOCK_AIM_WINDOW_MS = 400
export const SCROLL_SETTLE_MS = 400 // --dur-scroll-settle
// --dur-skeleton-delay:载入骨架的出场延迟。比这更快回来的请求根本不该闪一下骨架
// (规范:150ms 内到手就当作「立刻」)。
export const SKELETON_DELAY_MS = 150
export const TOC_HOVER_MS = 150 // --dur-toc-hover:悬停多久才把目录长出来
/**
 * Esc 停止的二次确认窗口(08-31 拍板:对齐 Vue 壳 InputBox 的双击口径)。
 * 第一下只是「预备」(占位符说一句),窗口内再按才真的停 —— Esc 在退层链的
 * 末位,单次即停会让「退个抽屉多按了一下」误伤后台正跑的一轮。
 * 这是手势窗口不是动画时长,动效档(none)不清零它。
 */
export const ESC_STOP_WINDOW_MS = 2000

/**
 * 复制这类「按了没有别的可见结果」的动作,按钮就地换字/换形说「已复制」的
 * 停留时长(08-31 拍板:复制反馈不走通知 —— 反馈长在被按的那颗钮上)。
 * 这是读认窗口不是动画时长,动效档(none)不清零它。
 */
export const COPY_FEEDBACK_MS = 1500

export const TOC_FLASH_MS = 1200 // --dur-toc-flash:跳过去之后落点消息高亮多久
/**
 * 一条 toast 自动消失前活多久 —— 按级别分档(--dur-toast-success / -info / -warn)。
 * error 不在表里:它**不自动消失**,要点 ✕ 才走(见 services/notify.ts 的命运表);
 * silent 也不在表里:它根本不弹。两种缺席都是有意的 —— 表只列「会自己走的那几档」,
 * 谁不会自己走由命运表说,不在这里用一个 0 或 Infinity 冒充。
 */
export const TOAST_LIFE_MS: Record<'success' | 'info' | 'warn', number> = {
  success: 3000,
  info: 4000,
  warn: 8000,
}
// --dur-att-grace:附件摞离开后的收拢宽限。卡缝与删卡瞬间的出界不该塌摞(同 Dock 留驻区判例),
// 再进即取消。这是「宽限」不是「动画」,所以它在 JS 里有落点、在 CSS 里只是个记账。
export const ATT_GRACE_MS = 200

/* ── 动效档在 JS 侧的那一小半 ─────────────────────────────────────────────
 *
 * CSS 侧换档是换一批 --dur-*(表在 styles/motion.css),组件一行都不必知道。
 * 但有一类东西 CSS 换不掉:**跟着出场动画走的卸载定时器**。浮窗/舞台关掉时
 * 节点要多活 EXIT_MS 才卸载(出场动画得播完),这个 120 是 JS 里的一个数 ——
 * 动效档调到「无」时它必须一起变成 0,否则「关掉了却还在屏幕上待 120ms」
 * 正是用户选「无」时最不想要的那一下。
 *
 * 所以这里镜像的**只有 --dur-exit 的三档**,不是整张表:JS 侧只有它有计时器
 * 跟着。多镜像一个数就是多一处会和 CSS 说岔的地方。相等由单测钉死。
 * ────────────────────────────────────────────────────────────────────────── */

/** --dur-exit 在三档下的值(ms),与 styles/motion.css 的档位块同一张表。 */
export const EXIT_MS_BY_TIER: Record<MotionTier, number> = {
  standard: EXIT_MS,
  calm: 60,
  none: 0,
}

/**
 * 此刻的动效档 —— 从 `documentElement` 上读,不从 store 读。
 *
 * 读属性而不读 store 是有理由的:那个属性是 reading/apply.ts 贴上去的**最终结论**
 * (已经把「用户没选过时听系统的」算进去了)。让每个消费点各自再算一遍
 * 「store 的档 + 系统偏好」,就等于把那条判据抄了 N 份。
 * 拿不到 document(单测 / SSR)按 standard 算:不动的默认是照旧动,不是照旧不动。
 */
export function currentMotionTier(): MotionTier {
  if (typeof document === 'undefined') return 'standard'
  const value = document.documentElement.getAttribute('data-motion-tier')
  return value === 'calm' || value === 'none' ? value : 'standard'
}

/** 出场卸载该等多久。`none` 档下是 0 —— 关掉就是当场没有。 */
export function exitMs(): number {
  return EXIT_MS_BY_TIER[currentMotionTier()]
}
