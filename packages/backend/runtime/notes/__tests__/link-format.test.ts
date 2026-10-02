import { describe, expect, it } from 'vitest'
import { buildLinkText, resolveAttachmentFolder, toLinkPathStyle, uniqueAttachmentName } from '../link-format.js'
import type { NoteLinkPathStyle } from '../link-format.js'

/**
 * 扩展名那条规则的六格表(2026-09-18 review 打回的第六条)。
 *
 * 判据一句话:**wikilink 只对 `.md` 省扩展名,附件不省;markdown 链接的引用
 * 永远带扩展名,不带的只有显示文本**。排错了的后果是图片链接 Obsidian 打不开
 * (`![[shot]]` 指不到任何文件)。
 */
describe('buildLinkText:.md 与附件 × wiki/md × 三档', () => {
  const note = 'folder/Target.md'
  const asset = 'attach/shot.png'
  const source = 'notes/a.md'

  function wiki(target: string, pathStyle: NoteLinkPathStyle, kind: 'link' | 'embed' = 'link'): string {
    return buildLinkText(target, source, kind, { useMarkdownLinks: false, pathStyle })
  }
  function md(target: string, pathStyle: NoteLinkPathStyle, kind: 'link' | 'embed' = 'link'): string {
    return buildLinkText(target, source, kind, { useMarkdownLinks: true, pathStyle })
  }

  it('wikilink × .md:三档都省扩展名,档位只决定取路径的哪一段', () => {
    expect(wiki(note, 'shortest')).toBe('[[Target]]')
    expect(wiki(note, 'relative')).toBe('[[../folder/Target]]')
    expect(wiki(note, 'absolute')).toBe('[[folder/Target]]')
  })

  /** **反证靶子**:把「附件不省扩展名」那一句挖掉,这三条全红。 */
  it('wikilink × 附件:三档都**带**扩展名(不然 Obsidian 指不到那张图)', () => {
    expect(wiki(asset, 'shortest', 'embed')).toBe('![[shot.png]]')
    expect(wiki(asset, 'relative', 'embed')).toBe('![[../attach/shot.png]]')
    expect(wiki(asset, 'absolute', 'embed')).toBe('![[attach/shot.png]]')
  })

  it('markdown × .md:引用带扩展名,显示文本不带', () => {
    expect(md(note, 'shortest')).toBe('[Target](Target.md)')
    expect(md(note, 'relative')).toBe('[Target](../folder/Target.md)')
    expect(md(note, 'absolute')).toBe('[Target](folder/Target.md)')
  })

  it('markdown × 附件:同一条规则,引用一律带扩展名', () => {
    expect(md(asset, 'shortest', 'embed')).toBe('![shot](shot.png)')
    expect(md(asset, 'relative', 'embed')).toBe('![shot](../attach/shot.png)')
    expect(md(asset, 'absolute', 'embed')).toBe('![shot](attach/shot.png)')
  })

  it('`.markdown` 也算笔记;没有扩展名的目标原样', () => {
    expect(wiki('folder/Target.markdown', 'shortest')).toBe('[[Target]]')
    expect(wiki('folder/Target', 'shortest')).toBe('[[Target]]')
  })

  it('md 链接里的空格转义成 %20(路径可读性 > 严格 URL 编码)', () => {
    expect(md('My Notes/a b.md', 'absolute')).toBe('[a b](My%20Notes/a%20b.md)')
  })

  it('embed 与 link 只差一个 `!`', () => {
    expect(wiki(note, 'shortest', 'embed')).toBe('![[Target]]')
    expect(md(note, 'shortest', 'embed')).toBe('![Target](Target.md)')
  })
})

describe('toLinkPathStyle', () => {
  it('三档原样,不认识的一律 shortest', () => {
    expect(toLinkPathStyle('relative')).toBe('relative')
    expect(toLinkPathStyle('absolute')).toBe('absolute')
    expect(toLinkPathStyle('shortest')).toBe('shortest')
    expect(toLinkPathStyle(null)).toBe('shortest')
    expect(toLinkPathStyle('nope')).toBe('shortest')
  })
})

describe('resolveAttachmentFolder / uniqueAttachmentName', () => {
  it('四种 attachmentFolderPath 语义', () => {
    expect(resolveAttachmentFolder('', 'notes/a.md')).toBe('')
    expect(resolveAttachmentFolder('/', 'notes/a.md')).toBe('')
    expect(resolveAttachmentFolder('./', 'notes/a.md')).toBe('notes')
    expect(resolveAttachmentFolder('./assets', 'notes/a.md')).toBe('notes/assets')
    expect(resolveAttachmentFolder('attach', 'notes/a.md')).toBe('attach')
    // 文档在库根时,「同目录」就是库根。
    expect(resolveAttachmentFolder('./', 'a.md')).toBe('')
    expect(resolveAttachmentFolder('./assets', 'a.md')).toBe('assets')
  })

  it('同名让路:shot.png → shot 1.png → shot 2.png', () => {
    const taken = new Set(['shot.png', 'shot 1.png'])
    expect(uniqueAttachmentName('shot.png', name => taken.has(name))).toBe('shot 2.png')
    expect(uniqueAttachmentName('free.png', name => taken.has(name))).toBe('free.png')
  })
})
