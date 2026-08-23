/**
 * `ProviderMediaReader` 的装配层实现(P4-2,设计稿 §5.2 Gemini 行)。
 *
 * runtime 的 provider 只声明「按 mediaId 取一张图的字节」这个**只读**接口
 * (`@onething/runtime/agent-loop/providers` 的 `ProviderMediaReader`);知道
 * 媒体库长什么样、索引在哪、文件落在哪一格,是装配层的事。Gemini 的多轮改图
 * 需要它:消息上留下的只有一段 markdown
 * (`![Generated Image|mediaId:<id>](media://<id>.png)`),字节在库里。
 *
 * 三条纪律:
 *  1. **只读**——从不写索引、从不改文件;
 *  2. **找不到就 `undefined`,读坏了也 `undefined`**(记一条 warn)——回放不到
 *     一张历史图是「少一块上下文」,不是「这一回合失败」;
 *  3. **只认图**——非 image 的资产直接当没有(线上那一格是 `inlineData` 图片块)。
 *
 * 落盘读走 runtime 的 `readOnethingImageFileDataUrl`(媒体库自己的那把尺),
 * 这一层因此不碰 `node:fs` —— `wiring/` 目录的边界规则不许它有别的 node 依赖,
 * 而「怎么把一个图片文件读成 base64」本来也是媒体库的事,不是接线的事。
 */
import type { ProviderMediaImage, ProviderMediaReader } from '@onething/runtime/agent-loop/providers'
import { readOnethingImageFileDataUrl } from '@onething/runtime/media'
import { mediaLibraryService } from '@onething/runtime/media/library-service-bound'
import { getLogger } from '../../logging/index.js'

const log = getLogger('providers.media')

/** `data:<mediaType>;base64,<payload>` → 两截。认不出就当读失败。 */
function splitImageDataUrl(dataUrl: string): ProviderMediaImage | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/is.exec(dataUrl)
  if (!match?.[2]) return undefined
  return { base64: match[2], mediaType: match[1] ?? 'image/png' }
}

export function createProviderMediaReader(): ProviderMediaReader {
  return {
    async readImageBase64(mediaId: string): Promise<ProviderMediaImage | undefined> {
      const asset = mediaLibraryService.getAsset(mediaId)
      if (!asset?.filePath || asset.kind !== 'image') return undefined
      try {
        const parsed = splitImageDataUrl(readOnethingImageFileDataUrl(asset.filePath))
        if (!parsed) {
          log.warn('media image payload unreadable', { mediaId, filePath: asset.filePath })
          return undefined
        }
        // 索引里的 mimeType 比按扩展名猜的准,有就用它。
        return asset.mimeType?.startsWith('image/')
          ? { base64: parsed.base64, mediaType: asset.mimeType }
          : parsed
      } catch (error) {
        log.warn('media image read failed', { mediaId, filePath: asset.filePath }, error)
        return undefined
      }
    },
  }
}

/** 进程级单例 —— 无状态门面,每次调用都现查索引。 */
export const providerMediaReader: ProviderMediaReader = createProviderMediaReader()
