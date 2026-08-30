import { gradientIndexOf } from '../../components/gradient'
import { looksLikeHost } from '../tools/web-family'

/**
 * 站点的**脸**:图标怎么取、取不到怎么降级(§5.3 末句)。
 *
 * 文件不叫 `favicon.ts` 是因为组件叫 `Favicon.tsx` —— 大小写不敏感的文件系统上
 * 那是同一个名字,tsc 会当场报 TS1261。名字也顺带说清了它管的两档:真图标,
 * 和取不到时那张代位的脸(与 palette.css 的 `--face-gN` 同一个词)。
 *
 * ── 只走站点自己那一份,不经第三方 ────────────────────────────────────────
 * `https://<域名>/favicon.ico`,没有第二条路。业界常见的写法是打到某个图标代理
 * (`google.com/s2/favicons`、`icons.duckduckgo.com` 之类)—— 那等于把「用户读过
 * 哪些站」逐条报给一个和这次会话毫无关系的第三方。检索结果本身就是隐私,
 * 不为了几个更好看的图标把它送出去。
 *
 * 代价照记:不少站点的 `/favicon.ico` 是 404 或跨域被拦,那时走代位圆片 ——
 * 而代位圆片本来就是比稿页画好的那一档降级态,不是将就。
 *
 * ── 像主机名才去取 ────────────────────────────────────────────────────────
 * 域名那一格解析不了时留的是**原样那串字符**(`domainOf` 的纪律)。把 `not a url`
 * 拼进 URL 会发一条注定失败的请求,还在控制台留一条误导排障的错 —— 所以先问一句。
 */
export function faviconUrl(domain: string): string | undefined {
  return looksLikeHost(domain) ? `https://${domain}/favicon.ico` : undefined
}

/**
 * 代位圆片里那个字。
 *
 * 取域名的第一个字素,不做任何缩写规则(与 agent 头像同一条)。`bbc.com` → `B`。
 */
export function faviconLetter(domain: string): string {
  return ([...domain][0] ?? '?').toUpperCase()
}

/**
 * 域名 → 第几对渐变。喂的是**域名**而不是完整 URL:同一个站的两页该是同一张脸。
 */
export function faviconGradient(domain: string): number {
  return gradientIndexOf(domain)
}
