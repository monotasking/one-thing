/**
 * 时长在 CSS 里是 token,在 JS 里得有个数 —— 定时器读不了 var()。
 * 这个文件是那些 token 在 JS 侧的唯一镜像:组件不许自己写 ms 字面量,
 * 改时长时两边一起改这一处。
 */
export const DUR_MS = 120 // --dur
export const EXIT_MS = 120 // --dur-exit
export const FLASH_MS = 240 // --dur-flash
export const TOOLTIP_DELAY_MS = 300 // --dur-tooltip-delay
export const SCROLL_SETTLE_MS = 400 // --dur-scroll-settle
export const TOC_HOVER_MS = 150 // --dur-toc-hover:悬停多久才把目录长出来
export const TOC_FLASH_MS = 1200 // --dur-toc-flash:跳过去之后落点消息高亮多久
