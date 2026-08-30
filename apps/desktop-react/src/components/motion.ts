/**
 * 时长在 CSS 里是 token,在 JS 里得有个数 —— 定时器读不了 var()。
 * 这个文件是那些 token 在 JS 侧的唯一镜像:组件不许自己写 ms 字面量,
 * 改时长时两边一起改这一处。
 */
export const DUR_MS = 120 // --dur
export const EXIT_MS = 120 // --dur-exit
export const RELEASE_MS = 160 // --dur-release
export const FLASH_MS = 240 // --dur-flash
export const TOOLTIP_DELAY_MS = 300 // --dur-tooltip-delay
export const DOCK_HIDE_DELAY_MS = 300 // 自动隐藏的收回宽限:离开留驻区后缓这么久才收,路过抖动不塌
export const PREVIEW_DELAY_MS = 600 // --dur-preview-delay:悬停多久才把 Dock 预览泡长出来
export const SCROLL_SETTLE_MS = 400 // --dur-scroll-settle
// --dur-skeleton-delay:载入骨架的出场延迟。比这更快回来的请求根本不该闪一下骨架
// (规范:150ms 内到手就当作「立刻」)。
export const SKELETON_DELAY_MS = 150
export const TOC_HOVER_MS = 150 // --dur-toc-hover:悬停多久才把目录长出来
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
