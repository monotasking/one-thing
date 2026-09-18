/**
 * 一个「就是个目录」的笔记库。
 *
 * 给没装 Obsidian 的机器,也给那些用户手写在 `settings.notes.folders` 里的目录。
 * 它没有 app、没有探活、没有降级态 —— 所有答案都是本地算出来的,所以它永远可
 * 用,`degraded` 永远 `undefined`。
 *
 * 与 `ObsidianVault` 的关系是**兄弟,不是父子**:两者共享的是三条纯规则
 * (`daily-format` / `link-format` / `basename-index`),不是一个基类。同一套语义
 * 的两份实现走同一批纯函数,这正是它们不会走岔的理由。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { BasenameIndex } from '../basename-index.js'
import { formatDailyDate } from '../daily-format.js'
import { buildLinkText, resolveAttachmentFolder, uniqueAttachmentName } from '../link-format.js'
import { normalizeVaultRoot } from '../paths.js'
import {
  DEFAULT_NOTES_DAILY_FORMAT,
  type DailyNoteRef,
  type NoteInit,
  type NoteLinkKind,
  type NoteVault,
} from '../types.js'

export const FOLDER_SYSTEM_ID = 'folder'

export interface FolderVaultOptions {
  root: string
  dailyFormat?: string
  /**
   * 附件目录。**缺席 = 文档同目录** —— 这是「就是个目录」最不意外的行为,而
   * 不是悄悄在库根建一个 `attachments/`。
   */
  attachmentDirectory?: string
  name?: string
  id?: string
}

export class FolderVault implements NoteVault {
  readonly id: string
  readonly name: string
  readonly root: string
  readonly system = FOLDER_SYSTEM_ID
  /** 本地目录没有「降级」这回事 —— 它不依赖任何在跑的 app。 */
  readonly degraded = undefined

  private readonly dailyFormat: string
  private readonly index: BasenameIndex

  constructor(private readonly options: FolderVaultOptions) {
    this.root = normalizeVaultRoot(options.root)
    this.id = options.id ?? `folder:${this.root}`
    this.name = options.name ?? path.basename(this.root) ?? this.root
    this.dailyFormat = options.dailyFormat || DEFAULT_NOTES_DAILY_FORMAT
    this.index = new BasenameIndex(this.root)
  }

  async dailyNote(date: Date = new Date()): Promise<DailyNoteRef> {
    const absolute = path.join(this.root, `${formatDailyDate(this.dailyFormat, date)}.md`)
    return { path: absolute, exists: await pathExists(absolute) }
  }

  async createDailyNote(date: Date = new Date()): Promise<string> {
    const { path: target, exists } = await this.dailyNote(date)
    if (!exists) {
      await fs.mkdir(path.dirname(target), { recursive: true })
      // `wx` = 已存在就抛。两个调用撞在一起时后来的那个不许把先来的内容清掉。
      await fs.writeFile(target, '', { encoding: 'utf-8', flag: 'wx' }).catch(error => {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
      })
      this.index.invalidate()
    }
    return target
  }

  async appendToDaily(content: string): Promise<void> {
    const target = await this.createDailyNote()
    const existing = await fs.readFile(target, 'utf-8').catch(() => '')
    const separator = existing === '' || existing.endsWith('\n') ? '' : '\n'
    await fs.appendFile(target, `${separator}${content}\n`, 'utf-8')
  }

  async createNote(rel: string, init: NoteInit = {}): Promise<string> {
    const target = path.join(this.root, toRelative(rel))
    await fs.mkdir(path.dirname(target), { recursive: true })
    const template = init.template ? await fs.readFile(path.join(this.root, init.template), 'utf-8').catch(() => '') : ''
    await fs.writeFile(target, init.content ?? template, { encoding: 'utf-8', flag: 'wx' }).catch(error => {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
    })
    this.index.invalidate()
    return target
  }

  async attachmentPathFor(fileName: string, sourceDoc: string): Promise<string> {
    // 缺席 = 文档同目录,写成 Obsidian 的 `./` 语义交给同一张表,免得两份规则。
    const setting = this.options.attachmentDirectory?.trim() || './'
    const folder = resolveAttachmentFolder(setting, this.toVaultRelative(sourceDoc))
    const directory = path.join(this.root, folder)
    const existing = new Set(await listDirectoryNames(directory))
    return path.join(directory, uniqueAttachmentName(fileName, candidate => existing.has(candidate)))
  }

  /** 标准 markdown 链接,相对文档所在目录 —— 一个裸目录里唯一说得通的形式。 */
  async linkTextFor(target: string, sourceDoc: string, kind: NoteLinkKind): Promise<string> {
    return buildLinkText(this.toVaultRelative(target), this.toVaultRelative(sourceDoc), kind, {
      useMarkdownLinks: true,
      pathStyle: 'relative',
    })
  }

  async resolveByName(name: string, sourceDoc: string): Promise<string | null> {
    return this.index.resolve(name, this.toVaultRelative(sourceDoc))
  }

  async listNotes(folder?: string): Promise<string[]> {
    const relatives = (await this.index.all()).map(absolute => path.relative(this.root, absolute))
    if (!folder) return relatives
    const prefix = `${folder.replace(/\/+$/, '')}${path.sep}`
    return relatives.filter(relative => relative.startsWith(prefix))
  }

  private toVaultRelative(value: string): string {
    const normalized = path.isAbsolute(value) ? path.relative(this.root, path.resolve(value)) : value
    return toRelative(normalized)
  }
}

function toRelative(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function listDirectoryNames(directory: string): Promise<string[]> {
  try {
    return await fs.readdir(directory)
  } catch {
    return []
  }
}
