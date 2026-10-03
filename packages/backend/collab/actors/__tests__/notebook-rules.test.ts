/**
 * 笔记的纯规则:行格式、尾部窗口、截断声明。
 *
 * 「截断要说出来」在这里有一条专门的测试:静默截断读起来和「我从来没记过东西」
 * 一模一样,而这个仓库在 history 工具的空结果三态上已经为同一件事付过一次学费。
 */
import { describe, expect, it } from 'vitest'

import {
  buildCollabNotebookBlock,
  clipCollabNotebookTail,
  COLLAB_NOTEBOOK_ENTRY_CLIPPED_SUFFIX,
  COLLAB_NOTEBOOK_TAG,
  COLLAB_NOTEBOOK_TRUNCATED_LINE,
  formatCollabNotebookEntry,
  formatCollabNotebookTime,
} from '../notebook-rules.js'

const AT = Date.parse('2026-08-03T10:05:00')

describe('笔记行格式', () => {
  it('带日期时刻的一行,日期到天(笔记跨天,只有时分不够定位)', () => {
    const entry = formatCollabNotebookEntry({ note: '答应老王周四前给方案', at: AT })
    expect(entry).toBe(`- [${formatCollabNotebookTime(AT)}] 答应老王周四前给方案`)
    expect(entry).toMatch(/^- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] /)
  })

  it('房间语境进括号', () => {
    expect(formatCollabNotebookEntry({ note: '记一笔', at: AT, roomLabel: '狼人窝' }))
      .toContain('] (狼人窝) 记一笔')
  })

  it('续行缩进两格 —— 尾部按行切时看得出一条笔记被切了半截', () => {
    expect(formatCollabNotebookEntry({ note: '第一行\n第二行', at: AT }))
      .toContain('第一行\n  第二行')
  })

  it('单条超长时截断并留尾巴', () => {
    const entry = formatCollabNotebookEntry({ note: 'x'.repeat(50), at: AT, maxChars: 10 })
    expect(entry).toContain(COLLAB_NOTEBOOK_ENTRY_CLIPPED_SUFFIX)
    expect(entry).not.toContain('x'.repeat(11))
  })
})

describe('尾部窗口', () => {
  const book = ['- [a] 一', '- [b] 二', '- [c] 三'].join('\n')

  it('放得下就整段给,不声明截断', () => {
    expect(clipCollabNotebookTail(book, 1000)).toEqual({ text: book, truncated: false })
  })

  it('放不下就切在行边界上 —— 半条笔记比没有笔记更糟', () => {
    const clipped = clipCollabNotebookTail(book, 12)
    expect(clipped.truncated).toBe(true)
    expect(clipped.text.split('\n').every(line => line.startsWith('- ['))).toBe(true)
  })

  it('整段就是一行(没有换行可切)时按字符硬切,而不是整块消失', () => {
    const clipped = clipCollabNotebookTail('- [a] '.concat('长'.repeat(100)), 20)
    expect(clipped.truncated).toBe(true)
    expect(clipped.text.length).toBeGreaterThan(0)
  })

  it('空笔记不算截断', () => {
    expect(clipCollabNotebookTail('   \n  ', 100)).toEqual({ text: '', truncated: false })
  })
})

describe('注入块', () => {
  it('空笔记返回空串 —— 一个空的 <notebook/> 是纯噪声', () => {
    expect(buildCollabNotebookBlock({ text: '' })).toBe('')
  })

  it('正常笔记裹进标签,不声明截断', () => {
    const block = buildCollabNotebookBlock({ text: '- [a] 一', maxChars: 100 })
    expect(block).toBe(`<${COLLAB_NOTEBOOK_TAG}>\n- [a] 一\n</${COLLAB_NOTEBOOK_TAG}>`)
    expect(block).not.toContain(COLLAB_NOTEBOOK_TRUNCATED_LINE)
  })

  it('超预算时把截断说出来', () => {
    const long = Array.from({ length: 40 }, (_, index) => `- [${index}] 一条挺长的笔记正文`).join('\n')
    const block = buildCollabNotebookBlock({ text: long, maxChars: 60 })
    expect(block).toContain(COLLAB_NOTEBOOK_TRUNCATED_LINE)
    expect(block).toContain('- [39]')
    expect(block).not.toContain('- [0]')
  })
})
