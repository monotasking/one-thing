import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

function withOpenFile(filePath: string, flags: 'wx' | 'r+' | 'r', action: (fd: number) => void): void {
  const fd = fs.openSync(filePath, flags, 0o600)
  let operationFailed = false
  try { action(fd) }
  catch (error) { operationFailed = true; throw error }
  finally {
    try { fs.closeSync(fd) }
    // eslint-disable-next-line no-unsafe-finally -- operationFailed 就是这条规则要的那道闸:只有在没有在飞错误时才抛,关闭失败永不顶掉写入失败
    catch (error) { if (!operationFailed) throw error }
  }
}

/**
 * Publish complete JSON and flush the file and its creation metadata.
 *
 * `syncUpTo` 是**目录屏障的上界**(工单 5 §2):默认一路 fsync 到文件系统根,
 * 而会话侧的调用方交出 `sessions/` —— 见 `syncDirectoryChain` 的说明。
 */
export function writeDurableJson(filePath: string, value: unknown, syncUpTo?: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${randomUUID()}.tmp`
  let operationFailed = false
  try {
    withOpenFile(temporary, 'wx', fd => {
      fs.writeFileSync(fd, JSON.stringify(value), 'utf8')
      fs.fsyncSync(fd)
    })
    fs.renameSync(temporary, filePath)
    withOpenFile(filePath, 'r+', fd => fs.fsyncSync(fd))
    syncDirectoryChain(path.dirname(filePath), syncUpTo)
  } catch (error) {
    operationFailed = true
    throw error
  } finally {
    try { fs.unlinkSync(temporary) }
    catch (error) {
      // Cleanup must not replace the first write/sync/rename error reported to callers.
      // eslint-disable-next-line no-unsafe-finally -- 同上:operationFailed 为真时这里不抛,原错误照原样上浮
      if (!operationFailed && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

/**
 * fsync 一条目录链:自 `directory` 起逐级向上,**到 `stopAt` 为止(含)**。
 *
 * 工单 5 §2(triage A2/A3):从前这里无条件走到 `/`。一条会话的 meta.json 落一次盘,
 * 要 fsync `<store>/sessions/<id>`、`sessions`、`<store>`、`~`、`/Users`、`/` ——
 * 后面那几级是**用户主目录与整块卷**,与这次发布没有任何因果关系,而 fsync 一个
 * 目录的代价随那个目录有多热线性上涨。屏障真正要保证的是"这个新文件名在它的父目录
 * 里可见":父目录一级足够,再加一级是因为 `<id>/` 本身也可能是这次刚创建的。
 *
 * `stopAt` 缺席、或不在 `directory` 的祖先链上时,退化为一路到根 —— 备份/恢复那条
 * 路写的是用户指定的任意目录,它没有"两级就够了"的前提。
 */
export function syncDirectoryChain(directory: string, stopAt?: string): void {
  // Windows FlushFileBuffers on the writable published file covers its metadata.
  // This does not prove durable unlink: protocols relying on deletion retain a
  // durable tombstone. Real NTFS acceptance remains separate from POSIX tests.
  // https://learn.microsoft.com/en-us/windows/win32/fileio/file-caching
  if (process.platform === 'win32') return
  const boundary = stopAt === undefined ? undefined : path.resolve(stopAt)
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    withOpenFile(current, 'r', fd => fs.fsyncSync(fd))
    if (current === boundary) return
    if (path.dirname(current) === current) return
  }
}
