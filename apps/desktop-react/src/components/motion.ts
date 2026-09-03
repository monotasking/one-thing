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
/**
 * --dur-dock-wake:自动隐藏的**唤醒停留门槛** —— 指针进了贴边窄带之后要在带内
 * 连续停满这么久,藏着的 Dock 才出来(09-03 用户报障「dock 的出现太敏感」)。
 *
 * macOS 的屏幕边是**墙**:指针顶上去停在那儿是自然结果。我们的窗口边不是墙 ——
 * 去点系统 Dock、去别的窗口、去拖窗口边,每一次都要**穿过**那 8px,穿一次唤醒一次。
 * 所以门槛不是「碰到」而是「停留」:穿过去的手一次都留不住,想叫它的手停一下就出来。
 *
 * 180ms 是「一次有意的停顿」的量级(比一次穿越的 20–30ms 大一个量级,比
 * --dur-tooltip-delay 的 300ms 短 —— 唤醒一条边不该比读一句提示还慢)。
 * 它是**意图门槛**不是动画,动效档(none)不清零它,reduced-motion 也不影响它。
 */
export const DOCK_WAKE_DWELL_MS = 180
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

/**
 * --dur-dock-lens:Dock 磁性放大的**镜头开合**时长 —— 手落进条里那格
 * `--dock-amount` 从 0 走到 1、手离开时从 1 回到 0,各花这么久。
 * **它不是跟手的快慢**:跟手期那格恒为 1,几何每次 pointermove 直接写、零插值
 * (见 components/useDockLens.ts)。整条链子在 CSS 里跑完,JS 侧一个计时器都没有 ——
 * 这一行是**镜像**,由 __tests__/motion-tokens.test.ts 与 tokens.css 逐条比对,
 * 真机门 scripts/gate-dock.mjs 的入场判据也按它算几何上限。
 */
export const DOCK_LENS_MS = 140

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
