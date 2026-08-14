import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { net, protocol } from 'electron'

type ProtocolHandle = typeof protocol.handle
type ElectronFetch = typeof net.fetch

export interface ElectronMediaProtocolOptions {
  getMediaImagesDir(): string
  /**
   * 非图片资产(document/audio/video/file)住在 files/ 目录。缺省时协议只服务
   * images/ —— 那是这条协议 2026-08 之前的全部本事,拖放入库开始产出非图片资产
   * 之后才需要第二个目录。
   */
  getMediaFilesDir?(): string
  scheme?: string
  handle?: ProtocolHandle
  fetch?: ElectronFetch
  /** 注入式存在性判定(单测用);缺省 `fs.existsSync`。 */
  exists?(filePath: string): boolean
}

/**
 * 把 `media://<name>` 解成目录内的一个真实路径,**并确认它没跑出去**。
 *
 * 这一层不是洁癖:`media://` 的名字整个来自渲染进程,`../../..` 一路走上去就能
 * 让协议读任意文件。解析后重新比对前缀是唯一可靠的判据(字符串里找 `..` 会被
 * 编码变体绕过)。
 */
function resolveWithinDir(dir: string, fileName: string): string | null {
  if (!dir) return null
  const root = path.resolve(dir)
  const resolved = path.resolve(root, fileName)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null
  return resolved
}

export function registerElectronMediaProtocol(options: ElectronMediaProtocolOptions): void {
  const scheme = options.scheme ?? 'media'
  const handle = options.handle ?? protocol.handle.bind(protocol)
  const fetch = options.fetch ?? net.fetch
  const exists = options.exists ?? ((filePath: string) => fs.existsSync(filePath))

  handle(scheme, (request) => {
    const prefix = `${scheme}://`
    const filename = decodeURIComponent(request.url.slice(prefix.length))
    const imagePath = resolveWithinDir(options.getMediaImagesDir(), filename)
    const filesPath = resolveWithinDir(options.getMediaFilesDir?.() ?? '', filename)

    // images 优先(绝大多数请求都是图片,少一次 stat),miss 了才查 files。
    // 两处都没有时仍然发 images 的那条路径:404 该由文件层给,不由这里编造。
    const target = imagePath && exists(imagePath)
      ? imagePath
      : (filesPath && exists(filesPath) ? filesPath : imagePath)

    if (!target) {
      return new Response(null, { status: 404 })
    }
    return fetch(pathToFileURL(target).toString())
  })
}
