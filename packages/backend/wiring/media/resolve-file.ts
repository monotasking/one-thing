/**
 * 「按文件名找媒体库里的那个文件」—— 这一份判据全仓只许有一处(G 线 §23.2)。
 *
 * 两个出口都调它:
 *  - HTTP:`GET /api/media/file/<name>`(`server/media-delivery.ts` 的 `resolveFile`),
 *    浏览器壳经 dev 代理补 Bearer 时走这条;
 *  - RPC:`media.readFile { fileName }`(`rpc/domains/media.ts`),桌面壳渲染进程
 *    `<img>` 带不了 Bearer,字节只能走通用 RPC。
 * 从前这段只在 HTTP 那边;RPC 要是再抄一份,两边迟早各说各话(一边放行、一边 404),
 * 所以抽成纯函数,两边读同一张表。
 *
 * 四道判:
 *  1. **名字归一**:只取 basename。带 `media://` / `/api/media/file/` 前缀的输入先解码,
 *     解码后若不等于它自己的 basename(`%2e%2e%2fsecret.png` 这类)直接当没有 ——
 *     名字里藏路径分隔符不是「换个名字找」,是越界企图。
 *  2. **只按资产表匹配**:文件名只是资产表里 `filePath` 的 basename 键,从不拿它拼路径去读盘,
 *     所以「猜一个存在的文件名」读不到资产表以外的任何东西。
 *  3. **同名资产每一条都要过 `assertMediaAccess`**:同名(同内容去重后)可能挂在别人的会话上,
 *     只要有一条看不见就整体当没有 —— 与原 `resolveFile` 同义,不因为「其中一条是我的」放行。
 *  4. **路径必须落在该库的 images / files 两个根里**:资产表是可写的 JSON,不信它的 filePath。
 *
 * 拒绝一律回 `undefined`(= 没有这个文件),不区分「不存在」与「无权」:区分就等于告诉
 * 调用方「这个名字别人有」。
 */
import { basename, isAbsolute, relative } from 'node:path'
import { canonicalizeStorePath } from '@onething/runtime/storage'
import type { OnethingMediaLibraryService } from '@onething/runtime/media'
import { SessionAccessError, type SessionAccess, type SessionAccessContext } from '../../session/access.js'
import { assertMediaAccess } from './access.js'

/** 一只纯函数只要库的三样读面;HTTP 那边的租户库与共享库都满足它。 */
export type MediaFileLibrary = Pick<OnethingMediaLibraryService, 'listAssetAccess' | 'storagePaths' | 'getAsset'>

export interface ResolvedMediaFile {
  /** 规范化(realpath)后的绝对路径,已确认落在库根里。 */
  path: string
  /** 资产表记的 mimeType;比按扩展名猜的准,没有就 `undefined`。 */
  mimeType?: string
}

const HTTP_PREFIX = '/api/media/file/'
const SCHEME_PREFIX = 'media://'

/**
 * 输入里取出文件名;取不出(解码失败 / 名字里带路径 / `.` `..` / 空)回 `undefined`。
 * 不带前缀的裸名只取 basename、不解码 —— 与抽出前 `resolveFile` 逐字同义,
 * HTTP 的 `?fileName=` 与 RPC 的 `{ fileName }` 都是这一档。
 */
export function mediaFileNameOf(input: string): string | undefined {
  const trimmed = input.trim()
  const encoded = trimmed.startsWith(HTTP_PREFIX) ? trimmed.slice(HTTP_PREFIX.length)
    : trimmed.startsWith(SCHEME_PREFIX) ? trimmed.slice(SCHEME_PREFIX.length) : undefined
  let fileName: string
  try {
    const decoded = encoded === undefined ? trimmed : decodeURIComponent(encoded)
    fileName = basename(decoded)
    // 带前缀的形状是「一个名字」;解码后还剩目录段,说明有人往名字里塞了路径。
    if (encoded !== undefined && decoded !== fileName) return undefined
  } catch { return undefined }
  if (!fileName || fileName === '.' || fileName === '..') return undefined
  return fileName
}

/**
 * 按名字在若干本库里找文件。库按给定顺序查,第一本命中即答 —— HTTP 那边先查进程共享库、
 * 再查旧租户库,顺序是调用方的事实,不是这里的。
 */
export function resolveMediaFileByName(
  libraries: readonly MediaFileLibrary[],
  access: Pick<SessionAccess, 'resolve'>,
  context: SessionAccessContext,
  input: string,
): ResolvedMediaFile | undefined {
  const fileName = mediaFileNameOf(input)
  if (!fileName) return undefined
  for (const library of libraries) {
    const matches = library.listAssetAccess().filter(asset => asset.filePath && basename(asset.filePath) === fileName)
    try { for (const asset of matches) assertMediaAccess(access, context, asset) }
    catch (error) {
      // 无权与不存在同答;别的异常(读索引坏了之类)是真故障,照样抛上去。
      if (error instanceof SessionAccessError) return undefined
      throw error
    }
    const roots = library.storagePaths()
    for (const asset of matches) {
      const path = canonicalizeStorePath(asset.filePath!)
      // 第一条同名资产就定案:落在根外 = 资产表被改过,整体拒,不去试下一条。
      if (![roots.imagesDir, roots.filesDir].some(root => isInside(path, canonicalizeStorePath(root)))) return undefined
      return { path, mimeType: library.getAsset(asset.id)?.mimeType }
    }
  }
  return undefined
}

function isInside(candidate: string, root: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}
