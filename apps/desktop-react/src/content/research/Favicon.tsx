import { useEffect, useState } from 'react'
import { faviconGradient, faviconLetter, faviconUrl } from './site-face'
import s from './Research.module.css'

/**
 * 站点图标 —— **代位圆片打底,真图标盖上去**。
 *
 * ── 为什么不是「先画 img,出错再换字母」 ────────────────────────────────
 * 那一版在真机上当场露馅(2026-08-30,真 store 一条 20 条来源的检索段):八行里
 * 五行是**空的 14px 洞**。原因有两个,而且都不走 `onError`:
 *
 *  1. `loading="lazy"` 的图还没进视口就根本没开始加载 —— 既没 load 也没 error,
 *     那一格就一直空着;
 *  2. 不少站点的 `/favicon.ico` 返回的是 **HTTP 200 + 一页 HTML**(软 404)。
 *     浏览器把它当成一张解不开的图,`naturalWidth` 是 0 —— 事件时序上未必给你
 *     一个干净的 error。
 *
 * 所以顺序反过来:**字母圆片是底**(它本来就是比稿页画好的正式形态),真图标只是
 * 一层可能盖上来的东西。图没来、来晚了、来的是张假图,屏幕上都始终是一张脸,
 * 不会有洞。`naturalWidth === 0` 的 load 当作失败 —— 那是软 404 唯一可靠的判据。
 *
 * ── 只走站点自己那一份 ────────────────────────────────────────────────
 * 不经任何图标代理(理由见 site-face.ts:那等于把「用户读过哪些站」报给第三方)。
 */
export function Favicon({ domain, size = 'sm' }: { domain: string; size?: 'sm' | 'md' }) {
  const src = faviconUrl(domain)
  const [shown, setShown] = useState(false)
  const [failed, setFailed] = useState(false)

  // 换了域名要把上一条的结论忘掉 —— 列表复用 DOM 时,新站点会被上一条的成败连坐。
  useEffect(() => {
    setShown(false)
    setFailed(false)
  }, [domain])

  const cls = [
    s.favicon,
    size === 'md' ? s.faviconMd : s.faviconSm,
    shown ? s.faviconLoaded : s.faviconFallback,
    shown ? '' : s[`face${faviconGradient(domain)}`],
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <span className={cls} aria-hidden="true">
      {!shown && faviconLetter(domain)}
      {src && !failed && (
        <img
          className={s.faviconImg}
          src={src}
          // 清单常常几十条、而且默认收起 —— 逐条同步请求图标是白花的网络。
          // 底下有字母圆片兜着,所以「懒」在这里不会留下空白。
          loading="lazy"
          decoding="async"
          alt=""
          onLoad={(event) => {
            // 软 404(200 + HTML)也会走 load,只是解不出像素。
            if (event.currentTarget.naturalWidth > 0) setShown(true)
            else setFailed(true)
          }}
          onError={() => setFailed(true)}
        />
      )}
    </span>
  )
}

/**
 * 图标堆叠 —— 收起行与消息尾来源条那一小撮重叠的圆。
 *
 * 最多三枚:第四枚开始人不再「看到几个站」,而是开始**数**(与 B2 计数句最多列
 * 三个名字同一条判据)。多出来的由旁边那句「N 个来源」负责说。
 */
export function FaviconStack({ domains }: { domains: readonly string[] }) {
  const shown = domains.slice(0, MAX_STACK)
  if (shown.length === 0) return null
  return (
    <span className={s.stack}>
      {shown.map((domain, index) => (
        // key 带上下标:同一个域名在前三枚里出现两次是可能的(同站两页),
        // 光用域名当 key 会撞。
        <span className={s.stackItem} key={`${domain}#${index}`}>
          <Favicon domain={domain} />
        </span>
      ))}
    </span>
  )
}

const MAX_STACK = 3
