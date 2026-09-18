/**
 * 链接文本与附件落点的**纯规则**。
 *
 * Obsidian 活着的时候这两个答案都是问它要的(`generateMarkdownLink` /
 * `getAvailablePathForAttachment`);这里是**降级态的复现**,以及 `FolderVault`
 * 的正路 —— 它没有别人可问。
 *
 * 纯函数、零 IO:它们是「同一套语义的第二份实现」,能被单测逐格钉住,正是两条
 * 路不许走岔的唯一证据。
 */

import * as path from 'node:path'
import type { NoteLinkKind } from './types.js'

/** `newLinkFormat` 的三档。不认识的值按 `shortest`。 */
export type NoteLinkPathStyle = 'shortest' | 'relative' | 'absolute'

export function toLinkPathStyle(value: string | null | undefined): NoteLinkPathStyle {
  return value === 'relative' || value === 'absolute' ? value : 'shortest'
}

export interface LinkTextOptions {
  /** true = `[x](y)`;false = `[[x]]`。 */
  useMarkdownLinks: boolean
  pathStyle: NoteLinkPathStyle
}

/**
 * 按 `target`(vault 相对)与 `sourceDoc`(vault 相对)排出链接文本。
 *
 * ## 扩展名那条规则(2026-09-18 review 打回的第六条)
 *
 * 从前这里对任何目标都取「不带扩展名的 basename」,于是一张图排成
 * `![[shot]]` / `![shot](shot)` —— Obsidian 打不开。真实规则分两半:
 *
 *  - **wikilink**:只有 `.md` 笔记省扩展名(`[[Note]]`),**附件必须带**
 *    (`![[shot.png]]`)。三档 `newLinkFormat` 都是这一条,只是 `shortest` 取
 *    basename、`relative` 取相对路径、`absolute` 取 vault 相对路径。
 *  - **markdown 链接**:**引用永远带扩展名**(`[Note](Note.md)` /
 *    `![shot](attach/shot.png)`);不带扩展名的只有**显示文本**那一半。
 *
 * §1 的真机读数与这条一致:`generateMarkdownLink` 对一篇笔记答的是
 * `[[00.00 JDex]]`(省了 `.md`)。
 */
export function buildLinkText(
  target: string,
  sourceDoc: string,
  kind: NoteLinkKind,
  options: LinkTextOptions,
): string {
  const normalizedTarget = toPosix(target)
  // 显示文本永远是不带扩展名的 basename —— 两种链接形态共用。
  const display = basenameWithoutExtension(normalizedTarget)
  const prefix = kind === 'embed' ? '!' : ''

  // 按档位取「路径的哪一段」;扩展名留在里面,由下面两条规则各自决定要不要剥。
  const scoped = ((): string => {
    if (options.pathStyle === 'absolute') return normalizedTarget
    if (options.pathStyle === 'relative') {
      const from = path.posix.dirname(toPosix(sourceDoc)) || '.'
      const relative = path.posix.relative(from, normalizedTarget)
      return relative === '' ? normalizedTarget : relative
    }
    return path.posix.basename(normalizedTarget)
  })()

  if (!options.useMarkdownLinks) {
    // wikilink:`.md` 省扩展名,**附件不省**。
    return `${prefix}[[${isMarkdownNote(normalizedTarget) ? stripExtension(scoped) : scoped}]]`
  }
  // markdown 链接:引用一律带扩展名。
  return `${prefix}[${display}](${encodeMarkdownPath(scoped)})`
}

/** 目标是一篇笔记吗(`.md` / `.markdown`),还是一个附件。 */
function isMarkdownNote(value: string): boolean {
  const extension = path.posix.extname(value).toLowerCase()
  return extension === '.md' || extension === '.markdown'
}

function stripExtension(value: string): string {
  const extension = path.posix.extname(value)
  return extension ? value.slice(0, value.length - extension.length) : value
}

/**
 * Obsidian `attachmentFolderPath` 的四种语义 → 附件目录(vault 相对)。
 *
 *  - `''` / `'/'`      → 库根
 *  - `'./'`            → 文档同目录
 *  - `'./sub'`         → 文档同级的 `sub` 子目录
 *  - 其余(`'attach'`) → 库下的固定目录
 *
 * 这张表是从 Obsidian 的真实行为反推的(§1 的 `getAvailablePathForAttachment`
 * 四种模式都对过),不是从文档抄的。
 */
export function resolveAttachmentFolder(attachmentFolderPath: string, sourceDoc: string): string {
  const setting = (attachmentFolderPath ?? '').trim()
  const docDir = path.posix.dirname(toPosix(sourceDoc))
  const inDoc = docDir === '.' ? '' : docDir
  if (setting === '' || setting === '/') return ''
  if (setting === './') return inDoc
  if (setting.startsWith('./')) {
    const sub = setting.slice(2).replace(/\/+$/, '')
    return inDoc === '' ? sub : path.posix.join(inDoc, sub)
  }
  return setting.replace(/^\/+/, '').replace(/\/+$/, '')
}

/**
 * 同名附件让路:`shot.png` 已在 → `shot 1.png` → `shot 2.png`。
 *
 * Obsidian 自己的做法就是加空格加序号;活着的时候这一步由它做(所以这个函数只
 * 在降级态跑),但两边必须排出同一串名字,不然同一张图在两条路下会落成两个文件。
 */
export function uniqueAttachmentName(fileName: string, taken: (candidate: string) => boolean): string {
  if (!taken(fileName)) return fileName
  const extension = path.extname(fileName)
  const stem = fileName.slice(0, fileName.length - extension.length)
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `${stem} ${i}${extension}`
    if (!taken(candidate)) return candidate
  }
  return `${stem} ${Date.now()}${extension}`
}

function basenameWithoutExtension(value: string): string {
  const base = path.posix.basename(value)
  const extension = path.posix.extname(base)
  return extension ? base.slice(0, base.length - extension.length) : base
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** markdown 链接里空格必须转义,别的字符原样(路径可读性 > 严格 URL 编码)。 */
function encodeMarkdownPath(value: string): string {
  return value.replace(/ /g, '%20')
}
