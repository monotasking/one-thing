import type { ImageRef } from '../../model/blocks'
import { fileUrlOf } from '../../../data/viewer-kinds'
import { isHostAllowed } from './remote-policy'

/**
 * 地址解析 —— **资产层的第二张表**(正本 §2)。
 *
 * ── 为什么它不住 `kinds/image/` 里 ────────────────────────────────────
 * 「一个地址怎么变成能喂给 `<img src>` 的东西」不是图片的私事:视频、文件、将来
 * 任何资产块都要答同一个问题,而远程放行与 scheme 白名单更是**一台机器一份政策**,
 * 不该有第二处判据。所以它住 `blocks/asset/`,图片块只是它今天唯一的消费者。
 * 加一个 `video` 块时这个文件一个字不改 —— 那是骨架抽到位的判据(正本 §5)。
 *
 * ── 同步、纯 ──────────────────────────────────────────────────────────
 * 今天的 `ImageRef` 只有 `url` 一员,答案当场算得出来。P2 的 `blob` 一员要读账本,
 * 那时这里多**一支**异步的路(objectURL + 缓存,与 figure 的渲染缓存同手),
 * 这一支不动。
 */
export type AssetResolution =
  /** 能直接喂给 `<img src>` 的那个字符串。 */
  | { status: 'ready'; src: string }
  /** 远程且这台还没放行这个宿主 —— 等人点一下(见 remote-policy.ts 的判词)。 */
  | { status: 'gated'; host: string }
  /**
   * 解不出来。`reason` 是**机器口径的一个词**,不是界面文案(与块的 `reason` 同一条
   * 判据:换一门语言它不该跟着变),界面上说哪句话由组件查字典。
   */
  | { status: 'unresolvable'; reason: 'no-base' | 'scheme' }

/** 解析现场。`baseDir` 可缺席 = **这里没有文档位置**(聊天今天就是这一档)。 */
export interface AssetResolveCtx {
  baseDir?: string
}

/** 认得的 scheme —— 白名单,不是黑名单(§六 11:`javascript:` 这类一律挡在外面)。 */
const KNOWN_SCHEMES = new Set(['data:', 'http:', 'https:', 'file:'])

/** `scheme:` 的形状(RFC 3986)。`./a:b.png` 命不中它 —— 冒号前面得是一串合法的 scheme 字。 */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

export function resolveAssetRef(ref: ImageRef, ctx: AssetResolveCtx): AssetResolution {
  const url = ref.url
  const scheme = SCHEME.exec(url)?.[0]?.toLowerCase()

  if (scheme) {
    if (!KNOWN_SCHEMES.has(scheme)) return { status: 'unresolvable', reason: 'scheme' }
    if (scheme === 'http:' || scheme === 'https:') return resolveRemote(url)
    // data: 与 file: 原样 —— 前者字节就在地址里,后者已经是一条本机 URL。
    // file: 只在 file:// 起源的页面(打包壳)取得到,dev / 浏览器面上会落 onError
    // 的诚实态 —— 那是宿主的事实,与查看器 image 型同一条限制。
    return { status: 'ready', src: url }
  }

  // `/uploads/x.png` 这种网站式绝对路径在这台上按本机路径解(真店里有 13 处)。
  // 它多半取不到 —— 那是对的:取不到就落诚实态显出地址,而不是画一个破图标
  // 或者悄悄编一个宿主出来拼成 http 地址。
  // 同样先解百分号(CommonMark 里空格写成 `%20`,文件系统里它就是一个空格)——
  // 与相对路径那一支同一条纪律,`fileUrlOf` 随后逐段重新编码。
  if (url.startsWith('/')) return { status: 'ready', src: fileUrlOf(decodePath(url)) }

  // 相对路径是真店里的大头(183/247):Obsidian 笔记里的 `../../91 Attachments/x.png`,
  // 经 read 工具或查看器进来。解得开的前提是知道「相对谁」。
  if (!ctx.baseDir) return { status: 'unresolvable', reason: 'no-base' }
  return { status: 'ready', src: fileUrlOf(joinPosix(ctx.baseDir, decodePath(url))) }
}

function resolveRemote(url: string): AssetResolution {
  const host = hostOf(url)
  if (!host) return { status: 'unresolvable', reason: 'scheme' }
  return isHostAllowed(host) ? { status: 'ready', src: url } : { status: 'gated', host }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host || undefined
  } catch {
    // `http://` 后面什么都没有之类 —— 说不出宿主就没法按宿主放行,当解不开处理。
    return undefined
  }
}

/**
 * markdown 里的地址是**百分号编码过的**(CommonMark 要求空格写成 `%20`),而文件
 * 系统里那个文件叫「91 Attachments」。解码失败(半截的 `%` 序列)就原样用 ——
 * 抛出去会把一整块内容炸掉,而一个解不开的名字最坏的后果只是这张图取不到。
 */
function decodePath(rel: string): string {
  try {
    return decodeURIComponent(rel)
  } catch {
    return rel
  }
}

/**
 * posix join + 归一 `..`。
 *
 * 不用 `node:path`:这是渲染层,壳也跑在浏览器里。不用 `new URL(rel, base)`:那会
 * 把路径里的字符再编码一次,而下一步 `fileUrlOf` 本来就要逐段编码 —— 编两遍的
 * `91%2520Attachments` 是一个不存在的目录。
 */
function joinPosix(baseDir: string, rel: string): string {
  const rooted = baseDir.startsWith('/')
  const out: string[] = []
  for (const seg of `${baseDir}/${rel}`.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      out.pop()
      continue
    }
    out.push(seg)
  }
  return rooted ? `/${out.join('/')}` : out.join('/')
}
