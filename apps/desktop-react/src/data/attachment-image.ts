import { useEffect, useMemo, useState } from 'react'
import { chatPort } from './chat-port'
import type { MessageAttachmentMetadata } from './message-attachments'
import { fileUrlOf } from './viewer-kinds'

export interface AttachmentImageState {
  readonly src?: string
  readonly status: 'loading' | 'ready' | 'unavailable'
}

interface ImageRequest {
  sessionId: string
  mimeType?: string
  file?: File
  base64?: string
  hash?: string
  filePath?: string
}

interface FileUrlEntry { src: string; readers: number }
const fileUrls = new Map<File, FileUrlEntry>()
interface BlobEntry { result: Promise<string | undefined>; readers: number; settled: boolean }
const blobReads = new Map<string, BlobEntry>()

function acquireFileUrl(file: File): { src: string; release: () => void } {
  let entry = fileUrls.get(file)
  if (!entry) {
    entry = { src: URL.createObjectURL(file), readers: 0 }
    fileUrls.set(file, entry)
  }
  entry.readers += 1
  const held = entry
  let released = false
  return {
    src: held.src,
    release: () => {
      if (released) return
      released = true
      held.readers -= 1
      if (held.readers === 0 && fileUrls.get(file) === held) {
        fileUrls.delete(file)
        if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(held.src)
      }
    },
  }
}

/** 同一会话的同一张图只读一次;最后一个使用者离开后释放缓存。 */
function acquireBlob(sessionId: string, hash: string): { result: Promise<string | undefined>; release: () => void } {
  const key = `${sessionId}:${hash}`
  let entry = blobReads.get(key)
  if (!entry) {
    const made: BlobEntry = { result: Promise.resolve(undefined), readers: 0, settled: false }
    made.result = (async () => {
      try {
        const { base64 } = await (await chatPort()).readBlob(sessionId, hash)
        return base64 || undefined
      } catch {
        return undefined
      } finally {
        made.settled = true
        if (made.readers === 0 && blobReads.get(key) === made) blobReads.delete(key)
      }
    })()
    blobReads.set(key, made)
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
      if (held.readers === 0 && held.settled && blobReads.get(key) === held) blobReads.delete(key)
    },
  }
}

function fallbackImage(request: ImageRequest): AttachmentImageState {
  return request.filePath
    ? { status: 'ready', src: fileUrlOf(request.filePath) }
    : { status: 'unavailable' }
}

function acquireImage(request: ImageRequest): {
  result: Promise<AttachmentImageState>
  release?: () => void
} {
  if (!request.mimeType) return { result: Promise.resolve({ status: 'unavailable' }) }
  if (request.file && typeof URL.createObjectURL === 'function') {
    try {
      const lease = acquireFileUrl(request.file)
      return { result: Promise.resolve({ status: 'ready', src: lease.src }), release: lease.release }
    } catch {
      // 原文件不能预览时继续尝试已持久化的字节或路径。
    }
  }
  if (request.base64) {
    return { result: Promise.resolve({ status: 'ready', src: `data:${request.mimeType};base64,${request.base64}` }) }
  }
  if (request.hash && request.sessionId) {
    const lease = acquireBlob(request.sessionId, request.hash)
    return {
      result: lease.result.then(base64 => base64
        ? { status: 'ready', src: `data:${request.mimeType};base64,${base64}` }
        : fallbackImage(request)),
      release: lease.release,
    }
  }
  return { result: Promise.resolve(fallbackImage(request)) }
}

/** 图片字节独立加载;换会话/附件时立即撤掉旧 src,晚到结果不更新新图片。 */
export function useAttachmentImage(sessionId: string, attachment: MessageAttachmentMetadata): AttachmentImageState {
  const file = attachment.file
  const mimeType = attachment.image?.mimeType
  const data = attachment.image?.base64Data
  const base64 = typeof data === 'string' ? data : undefined
  const hash = typeof data === 'object' ? data?.hash : undefined
  const filePath = attachment.filePath
  const request = useMemo(() => ({ sessionId, file, mimeType, base64, hash, filePath }),
    [sessionId, file, mimeType, base64, hash, filePath])
  const [loaded, setLoaded] = useState<{ request: ImageRequest; state: AttachmentImageState }>()

  useEffect(() => {
    let current = true
    const lease = acquireImage(request)
    void lease.result.then(state => {
      if (current) setLoaded({ request, state })
    })
    return () => {
      current = false
      lease.release?.()
    }
  }, [request])

  return loaded?.request === request ? loaded.state
    : { status: mimeType ? 'loading' : 'unavailable' }
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (typeof URL.revokeObjectURL === 'function') {
      for (const entry of fileUrls.values()) URL.revokeObjectURL(entry.src)
    }
    fileUrls.clear()
    blobReads.clear()
  })
}
