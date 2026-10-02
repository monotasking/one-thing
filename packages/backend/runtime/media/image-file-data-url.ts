import fs from 'node:fs'
import path from 'node:path'

export function getOnethingImageMimeTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webp') return 'image/webp'
  return 'image/png'
}

export function onethingImageBufferToDataUrl(buffer: Buffer, filePath: string): string {
  return `data:${getOnethingImageMimeTypeFromPath(filePath)};base64,${buffer.toString('base64')}`
}

export function readOnethingImageFileDataUrl(filePath: string): string {
  return onethingImageBufferToDataUrl(fs.readFileSync(filePath), filePath)
}

export interface OnethingImageFileDataUrlIpcLogger {
  error?: (...args: unknown[]) => void
}

export function readOnethingImageFileDataUrlForIpc(
  filePath: string,
  options: {
    logger?: OnethingImageFileDataUrlIpcLogger
  } = {},
): string {
  try {
    return readOnethingImageFileDataUrl(filePath)
  } catch (error) {
    options.logger?.error?.('[Media IPC] Failed to read image:', filePath, error)
    throw error
  }
}
