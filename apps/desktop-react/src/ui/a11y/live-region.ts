/**
 * 播报口(A11y 线 · A1 地基件之三)。立法见
 * `docs/design/react-shell-a11y-2026-08.md` 的 live region 纪律。
 *
 * **全应用只有一个播报口**,module 级懒挂在 `<body>` 末尾:两格,polite 与
 * assertive 各一格。谁要说一句话就 `announce(text)`,没有第二条路。
 *
 * ── 为什么是单例,不是每个组件挂一个 ────────────────────────────────────
 * live region 的语义是「这块地方变了就念出来」——它必须在**变之前**就已经在
 * 无障碍树里。挂一个新节点、同一帧往里写字,读屏软件多半什么都不念(它看到的
 * 是「一个新节点出现了」,不是「一块已知区域变了」)。所以口必须是常驻的,
 * 常驻的东西就该只有一份。
 * ──────────────────────────────────────────────────────────────────────
 *
 * ── 重复文案要能重播 ────────────────────────────────────────────────────
 * 同一句话连说两次(两次都失败、两次都复制成功),第二次写进去时文本没变,
 * 无障碍树没有差分,读屏软件不念。所以 `announce` 是**先清空、下一个宏任务再写**
 * ——清空这一帧产生一次差分,写入下一帧再产生一次,两次都念得出来。
 * 代价是它异步:单测要 `await` 一个 0 延时才看得到落格。
 * ──────────────────────────────────────────────────────────────────────
 *
 * 样式(视觉隐藏、对读屏可见)是全局类 `.visually-hidden`,住在 styles/global.css
 * ——它不属于任何一个组件,所以不该藏在某个 .module.css 里。
 */

export type AnnounceLevel = 'polite' | 'assertive'

const HOST_ATTR = 'data-live-region'

let host: HTMLElement | null = null
const slots = new Map<AnnounceLevel, HTMLElement>()
const pending = new Map<AnnounceLevel, ReturnType<typeof setTimeout>>()

function ensureHost(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  if (host && host.isConnected) return host
  const existing = document.querySelector<HTMLElement>(`[${HOST_ATTR}]`)
  host = existing ?? document.createElement('div')
  if (!existing) {
    host.setAttribute(HOST_ATTR, '')
    host.className = 'visually-hidden'
    document.body.appendChild(host)
  }
  slots.clear()
  return host
}

function slotFor(level: AnnounceLevel): HTMLElement | null {
  const root = ensureHost()
  if (!root) return null
  const cached = slots.get(level)
  if (cached && cached.isConnected) return cached
  let slot = root.querySelector<HTMLElement>(`[data-live="${level}"]`)
  if (!slot) {
    slot = document.createElement('div')
    slot.setAttribute('data-live', level)
    slot.setAttribute('aria-live', level)
    // atomic:整句重念,而不是只念「变了的那几个字」。播报的是一句话,不是一次 diff。
    slot.setAttribute('aria-atomic', 'true')
    root.appendChild(slot)
  }
  slots.set(level, slot)
  return slot
}

export interface AnnounceOptions {
  /** 默认 polite。只有「必须打断当前朗读」的事(错误)才配 assertive。 */
  level?: AnnounceLevel
}

/**
 * 播报一句话。空串 / 全空白直接丢掉 —— 播报一句空话只会让读屏软件停顿一下。
 */
export function announce(text: string, options: AnnounceOptions = {}): void {
  const level = options.level ?? 'polite'
  const message = text.trim()
  if (!message) return
  const slot = slotFor(level)
  if (!slot) return
  const queued = pending.get(level)
  if (queued) clearTimeout(queued)
  slot.textContent = ''
  pending.set(
    level,
    setTimeout(() => {
      pending.delete(level)
      slot.textContent = message
    }, 0),
  )
}

/** 读那一格现在写着什么。给单测与真机门用,产品代码不该读它。 */
export function liveRegionText(level: AnnounceLevel): string {
  const root = typeof document === 'undefined' ? null : document.querySelector(`[${HOST_ATTR}]`)
  return root?.querySelector(`[data-live="${level}"]`)?.textContent ?? ''
}

/** 拆掉播报口(单测之间互不串味)。产品代码不该调它 —— 口是常驻的。 */
export function resetLiveRegions(): void {
  for (const timer of pending.values()) clearTimeout(timer)
  pending.clear()
  slots.clear()
  if (typeof document !== 'undefined') {
    for (const el of Array.from(document.querySelectorAll(`[${HOST_ATTR}]`))) el.remove()
  }
  host = null
}
