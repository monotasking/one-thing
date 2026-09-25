import { useEffect, useState } from 'react'
import { mediaRouter, type MediaReadFileResponse } from '@shared/ipc/media'

/**
 * 媒体库里一张图的字节,按**文件名**取(G 线 P5-a,正本 `docs/stream-geometry-2026-09.md` §23.3)。
 *
 * 生成的图落到账本上是一段 markdown `![…](media://<id><ext>)`,壳手里只有那个名字。
 * `<img src>` 带不了 Bearer —— 桌面壳渲染进程直连 core,`GET /api/media/file/<name>`
 * 对它是 401 —— 所以字节走通用 RPC `media.readFile`,回一只 data URL。
 *
 * 缓存与释放与 `attachment-image.ts` 的 `acquireBlob` **逐字同形**:同名只读一次(几个
 * 读者共用一发请求)、最后一个读者离开且那一发已经落定才撤掉这一格、HMR 退役清表。
 * 不做「读者走光之后再留一会儿」的 LRU:data URL 是几百 KB 到几 MB 的字符串,常驻
 * 就是常驻内存;再开一次多一发 RPC,而占位高度由尺寸表(按 `ref.url` 记)兜住,
 * 眼睛看不出这一发。
 */

export interface MediaImageState {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly src?: string
}

export interface MediaImagePort {
  readFile(fileName: string): Promise<MediaReadFileResponse>
}

let port: MediaImagePort | undefined
let pending: Promise<MediaImagePort> | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureMediaImagePort(next: MediaImagePort | undefined): void {
  port = next
  pending = undefined
}

/** 惰性建:它要的是连通之后才存在的客户端(与 dialog-port 同一判词)。 */
async function realPort(): Promise<MediaImagePort> {
  const { onethingClient } = await import('../platform/connection')
  const api = (await onethingClient()).api(mediaRouter)
  return { readFile: (fileName) => api.readFile({ fileName }) }
}

function mediaImagePort(): Promise<MediaImagePort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}

interface ReadEntry {
  result: Promise<string | undefined>
  readers: number
  settled: boolean
  /** 落定之后的值 —— 放大取件口要**同步**拿到它(见 `peekMediaImage`)。 */
  value?: string
}
const reads = new Map<string, ReadEntry>()

/** 同一个文件名只读一次;最后一个使用者离开后释放缓存。 */
function acquireMediaImage(fileName: string): { result: Promise<string | undefined>; release: () => void } {
  let entry = reads.get(fileName)
  if (!entry) {
    const made: ReadEntry = { result: Promise.resolve(undefined), readers: 0, settled: false }
    made.result = (async () => {
      try {
        const { dataUrl } = await (await mediaImagePort()).readFile(fileName)
        made.value = dataUrl || undefined
        return made.value
      } catch {
        // 连不上 / 老 core 没有这条方法:与「没有这个文件」同一个结局 —— 这张图没加载出来。
        return undefined
      } finally {
        made.settled = true
        if (made.readers === 0 && reads.get(fileName) === made) reads.delete(fileName)
      }
    })()
    reads.set(fileName, made)
    entry = made
  }
  entry.readers += 1
  const held = entry
  let released = false
  return {
    result: held.result,
    release: () => {
      if (released) return
      released = true
      held.readers -= 1
      if (held.readers === 0 && held.settled && reads.get(fileName) === held) reads.delete(fileName)
    },
  }
}

/**
 * 已经取到手的那一只 data URL,取不到回 undefined。**不发请求**:
 * 图块檐上的「放大」是同步取件口,它只交已经到过屏幕上的东西。
 */
export function peekMediaImage(fileName: string): string | undefined {
  const entry = reads.get(fileName)
  return entry?.settled ? entry.value : undefined
}

/**
 * 一张媒体库图的加载态。`fileName` 缺席 = 这一块不是媒体库图(调用方无条件调 hook,
 * 规矩是 hook 不许条件调用),回 `unavailable` 且什么都不读。
 * 换文件名时立即撤掉旧 src,晚到的结果不更新新图(与 `useAttachmentImage` 同一判词)。
 */
export function useMediaImage(fileName: string | undefined): MediaImageState {
  const [loaded, setLoaded] = useState<{ fileName: string; state: MediaImageState }>()

  useEffect(() => {
    if (!fileName) return
    let current = true
    const lease = acquireMediaImage(fileName)
    void lease.result.then((src) => {
      if (current) setLoaded({ fileName, state: src ? { status: 'ready', src } : { status: 'unavailable' } })
    })
    return () => {
      current = false
      lease.release()
    }
  }, [fileName])

  if (!fileName) return { status: 'unavailable' }
  if (loaded?.fileName === fileName) return loaded.state
  // 同名的图别处已经取到手(同一张图在两处出现):当场就绪,不画一帧占位。
  const cached = peekMediaImage(fileName)
  return cached ? { status: 'ready', src: cached } : { status: 'loading' }
}

/** 测试用:清表。 */
export function resetMediaImageCacheForTest(): void {
  reads.clear()
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    reads.clear()
  })
}
