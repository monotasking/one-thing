/**
 * 草稿纸正文里的**本地引用**。
 *
 * 纸上的图片是 `![](path)`(粘贴管线落盘后插入的),文件是 `@/abs/path` 或
 * markdown 链接。手动发出去的时候要知道这段文字牵扯到哪些真实文件,才谈得上
 * "vision 模型收原生图、其它模型收路径"。
 *
 * 这里**只做识别**,不做读盘、不做能力判定 —— 那两件事各有各的地方。
 */

export interface ScratchpadLocalRef {
  /** 正文里写的原样 target。 */
  rawTarget: string
  /** 解析成绝对路径后的样子(相对路径按纸所在目录解析)。 */
  absolutePath: string
  fileName: string
  mimeType: string
  isImage: boolean
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

const DOCUMENT_MIME_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
}

/** `http(s):` / `data:` / `mailto:` … 这些不是本地文件,一律不认。 */
function isRemoteTarget(target: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)
}

function isAbsolutePath(target: string): boolean {
  return target.startsWith('/') || /^[a-z]:[\\/]/i.test(target)
}

export function scratchpadRefFileName(target: string): string {
  const tail = target.split(/[\\/]/).pop() || ''
  return tail
}

function extensionOf(target: string): string {
  const name = scratchpadRefFileName(target)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/**
 * 相对路径按纸所在目录解析。刻意不引 node:path —— 渲染层跑在浏览器里,而这点
 * 拼接的规则(`.` 丢掉、`..` 退一级)简单到不值得为它拖一个 polyfill。
 */
export function resolveScratchpadRefPath(target: string, documentDir: string): string {
  if (isAbsolutePath(target)) return target
  if (!documentDir) return target
  const separator = documentDir.includes('\\') && !documentDir.includes('/') ? '\\' : '/'
  const base = documentDir.replace(/[\\/]+$/, '').split(/[\\/]/)
  for (const segment of target.split(/[\\/]/)) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (base.length > 1) base.pop()
      continue
    }
    base.push(segment)
  }
  return base.join(separator)
}

function decodeTarget(target: string): string {
  // markdown 里空格常被写成 %20;解不开就用原样(一个坏转义不该让整条引用消失)。
  try {
    return decodeURI(target)
  } catch {
    return target
  }
}

/** `![alt](target)` / `[text](target)` 里的 target,以及 `@<path>` 这一种。 */
const MARKDOWN_TARGET_RE = /!?\[[^\]]*\]\(\s*<?([^)>\s]+)>?[^)]*\)/g
const AT_PATH_RE = /(?:^|\s)@((?:\/|[a-zA-Z]:[\\/])[^\s"'`]+)/g

/**
 * 一段草稿纸正文里的本地引用,按出现顺序、去重后返回。
 *
 * `documentDir` 是纸自己所在的目录 —— 相对路径以它为基准(粘贴管线落盘时用的
 * 就是同一个基准)。
 */
export function extractLocalRefs(text: string, documentDir = ''): ScratchpadLocalRef[] {
  if (!text) return []
  const seen = new Set<string>()
  const refs: ScratchpadLocalRef[] = []

  const consider = (rawTarget: string) => {
    const target = decodeTarget(rawTarget.trim())
    if (!target || isRemoteTarget(target)) return
    const absolutePath = resolveScratchpadRefPath(target, documentDir)
    if (seen.has(absolutePath)) return
    seen.add(absolutePath)
    const extension = extensionOf(target)
    const imageMime = IMAGE_EXTENSIONS[extension]
    refs.push({
      rawTarget: target,
      absolutePath,
      fileName: scratchpadRefFileName(target) || 'attachment',
      mimeType: imageMime || DOCUMENT_MIME_TYPES[extension] || 'application/octet-stream',
      isImage: Boolean(imageMime),
    })
  }

  for (const match of text.matchAll(MARKDOWN_TARGET_RE)) consider(match[1])
  for (const match of text.matchAll(AT_PATH_RE)) consider(match[1])

  return refs
}
