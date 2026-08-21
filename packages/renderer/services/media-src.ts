/**
 * 「媒体库里的一个文件」→ 这台宿主能渲染的 `<img src>`。
 *
 * 一条规则,一个地方(结构债 P4c 第三批)。从前它散在三处半:媒体面板的
 * `getImageUrl`、预览窗的画廊映射、`agent-avatar.ts` 的 `resolveAgentAvatarSrc`,
 * 外加 server 壳里那段**把每个资产的 `filePath` 改写成 `/api/media/file/…`** 的
 * 投影(`toServerClientMediaAsset`)。
 *
 * 媒体域迁到通用 RPC 通道之后,server 壳不再有地方做那次改写 —— 桌面与 web 从
 * 同一个域拿到的是**同一份数据**(库里存的绝对路径)。于是"用哪种 URL 去取这个
 * 文件"回到它本来的位置:**宿主的事,由渲染侧按 environment 决定**。桌面是
 * `media://` 协议(`apps/electron/src/media/protocol.ts` 按文件名在 images/ 与
 * files/ 两个目录里找),web 是同源路由 `/api/media/file/<name>`(server 侧那条
 * 路由原样保留)。
 */
import type { PlatformEnvironment } from '@/platform'

/**
 * 已经是一个能用的引用?带 scheme 的、协议相对的、以 `/` 开头的服务器路由,
 * 一律原样放行 —— 早于「裸文件名」形态存下的值(以及未来某个导入器写下的值)
 * 必须照旧能渲染,而不是被折成 `media://https://…`。
 */
function isResolvedImageReference(reference: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(reference)
    || reference.startsWith('//')
    || reference.startsWith('/api/')
}

/** 一个媒体引用背后的**存储文件名**。两种宿主形态都以它结尾。 */
export function mediaFileNameOf(reference: string | undefined | null): string {
  return (reference || '').split(/[\\/]/).pop() || ''
}

/**
 * 媒体库文件的引用(绝对路径 / 裸文件名 / 已解析的 URL)→ 本宿主的 `<img src>`。
 * 引用为空时返回 '',让调用方把「没有图」和「有图但没 URL」当同一支处理。
 */
export function resolveMediaFileSrc(
  reference: string | undefined | null,
  environment: PlatformEnvironment,
  fallbackFileName?: string,
): string {
  const trimmed = (reference || '').trim()
  if (!trimmed) return ''
  if (isResolvedImageReference(trimmed)) return trimmed
  const fileName = mediaFileNameOf(trimmed) || fallbackFileName || ''
  if (!fileName) return ''
  return environment === 'web'
    ? `/api/media/file/${encodeURIComponent(fileName)}`
    : `media://${encodeURIComponent(fileName)}`
}
