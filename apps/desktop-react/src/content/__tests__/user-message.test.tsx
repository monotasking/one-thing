import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { segmentUserMessage, UserMessageBody } from '../user-message'
import { useStageStore } from '../../stage/store'

/**
 * 用户气泡里的 `@路径` / `/命令`(2026-09-12)。
 *
 * 两半分开量:**切分表**是纯函数,一条一条钉判据;**画**那一半只问三件事 ——
 * chip 出不出得来、点下去叫不叫得对人、五十个引用会不会炸。
 */

const openFile = vi.hoisted(() => vi.fn())
const openDir = vi.hoisted(() => vi.fn())

// 打开那两条路各自拖着一整片 store(viewer-source / workbench / stage),
// 这里量的是「叫对了谁」,不是那两条路自己 —— 它们有自己的用例。
vi.mock('../viewer/open-target', () => ({ openFileInCurrentTarget: openFile }))
vi.mock('../dir-open', () => ({ openDirectoryPanel: openDir }))

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  openFile.mockClear()
  openDir.mockClear()
})

describe('切分表', () => {
  it('纯文本原样一段', () => {
    expect(segmentUserMessage('帮我看看这个')).toEqual([{ kind: 'text', text: '帮我看看这个' }])
  })

  it('空文本零段', () => {
    expect(segmentUserMessage('')).toEqual([])
  })

  it('@ + 绝对路径 = 文件引用,前后正文原样留着', () => {
    expect(segmentUserMessage('看 @/Users/me/a.ts 这个')).toEqual([
      { kind: 'text', text: '看 ' },
      { kind: 'fileRef', path: '/Users/me/a.ts' },
      { kind: 'text', text: ' 这个' },
    ])
  })

  it('结尾一个斜杠 = 目录引用', () => {
    expect(segmentUserMessage('@/Users/me/src/')).toEqual([
      { kind: 'dirRef', path: '/Users/me/src/' },
    ])
  })

  /**
   * **病 ② 的收口**(09-12 真机:@ 的是一个目录,气泡与模型都把它当成文件)。
   * 尾巴上那个 `/` 由 `usePickDrawer.applyPick` 在选中的那一刻写进路径里
   * (壳没有 stat,那是这一侧唯一的判据),这里钉的是**句中**的那一形 ——
   * 后面还跟着话,目录判据照样成立。
   */
  it('句中的目录引用:后面跟着正文,照旧判成 dirRef', () => {
    expect(segmentUserMessage('@/a/dir/ 看看')).toEqual([
      { kind: 'dirRef', path: '/a/dir/' },
      { kind: 'text', text: ' 看看' },
    ])
  })

  it('~/ 开头也认(展不展开是打开那条路的事,这里不碰)', () => {
    expect(segmentUserMessage('@~/notes/a.md')).toEqual([
      { kind: 'fileRef', path: '~/notes/a.md' },
    ])
  })

  it('连着两个引用之间的那个空格不会被吃掉', () => {
    expect(segmentUserMessage('@/a.ts @/b.ts')).toEqual([
      { kind: 'fileRef', path: '/a.ts' },
      { kind: 'text', text: ' ' },
      { kind: 'fileRef', path: '/b.ts' },
    ])
  })

  describe('尾随标点剥回正文(09-12 review 打回:吞了标点的路径点开必然打不开)', () => {
    it('中文逗号剥回正文', () => {
      expect(segmentUserMessage('@/a/b.ts，然后')).toEqual([
        { kind: 'fileRef', path: '/a/b.ts' },
        { kind: 'text', text: '，然后' },
      ])
    })

    it('全角括号夹注:左括号留正文,右括号剥回正文,目录判据在剥完之后才判', () => {
      expect(segmentUserMessage('（@/a/dir/）')).toEqual([
        { kind: 'text', text: '（' },
        { kind: 'dirRef', path: '/a/dir/' },
        { kind: 'text', text: '）' },
      ])
    })

    it('结尾那个 . 也剥 —— 以点结尾的不是文件名,那是句号', () => {
      expect(segmentUserMessage('改好了 @/a/b.ts.')).toEqual([
        { kind: 'text', text: '改好了 ' },
        { kind: 'fileRef', path: '/a/b.ts' },
        { kind: 'text', text: '.' },
      ])
    })

    it('连着几个标点一次剥干净', () => {
      expect(segmentUserMessage('(@/a/b.ts)。')).toEqual([
        { kind: 'text', text: '(' },
        { kind: 'fileRef', path: '/a/b.ts' },
        { kind: 'text', text: ')。' },
      ])
    })

    it('反例:路径中间的 . 一个字不动', () => {
      expect(segmentUserMessage('@/a/b.v2.ts')).toEqual([{ kind: 'fileRef', path: '/a/b.v2.ts' }])
    })

    it('反例:尾巴上的 / 不是标点(它是目录的记号)', () => {
      expect(segmentUserMessage('@/a/dir/')).toEqual([{ kind: 'dirRef', path: '/a/dir/' }])
    })
  })

  it('拼回来与原文逐字相同(切分一个字符都不吃)', () => {
    // 带标点的那几种一起进来:剥尾巴是「还给正文」不是「丢掉」。
    const text = '/cd ~/x\n看 @/a.ts,和 @/dir/ 还有 a@b.com(@/c.v2.ts)。'
    const joined = segmentUserMessage(text)
      .map((seg) => (seg.kind === 'text' ? seg.text : seg.kind === 'fileRef' || seg.kind === 'dirRef' ? `@${seg.path}` : seg.token))
      .join('')
    expect(joined).toBe(text)
  })

  describe('反例', () => {
    it('邮箱不认(@ 后面没有绝对路径的起笔)', () => {
      expect(segmentUserMessage('写信给 a@b.com')).toEqual([
        { kind: 'text', text: '写信给 a@b.com' },
      ])
    })

    it('地址形 user@/path 不认(@ 前不是行首也不是空白)', () => {
      // 反证锚点:把 REF_PATTERN 里 `@` 前那一组(行首 | 空白 | 左括号)拆掉,
      // 这一条当场红 —— 地址形里 `@` 前是个字母,靠的就是这一组挡住。
      expect(segmentUserMessage('rsync backup@/mnt/data/ dst')).toEqual([
        { kind: 'text', text: 'rsync backup@/mnt/data/ dst' },
      ])
    })

    it('裸文件名 @foo 不认(没有斜杠就是三个字)', () => {
      expect(segmentUserMessage('@foo 看看')).toEqual([{ kind: 'text', text: '@foo 看看' }])
    })

    it('带空格的路径只认到空格为止,后半句仍是正文', () => {
      expect(segmentUserMessage('@/Users/my file.ts')).toEqual([
        { kind: 'fileRef', path: '/Users/my' },
        { kind: 'text', text: ' file.ts' },
      ])
    })

    it('句中的 / 不是命令', () => {
      expect(segmentUserMessage('用 a/b 这个写法')).toEqual([
        { kind: 'text', text: '用 a/b 这个写法' },
      ])
    })

    it('以绝对路径开头的整条消息不是命令', () => {
      expect(segmentUserMessage('/Users/me/a.ts 看一下')).toEqual([
        { kind: 'text', text: '/Users/me/a.ts 看一下' },
      ])
    })
  })

  describe('命令与技能', () => {
    it('/cd 是命令,参数照旧是正文', () => {
      expect(segmentUserMessage('/cd ~/x')).toEqual([
        { kind: 'command', token: '/cd' },
        { kind: 'text', text: ' ~/x' },
      ])
    })

    it('光一个 /compact 也是命令', () => {
      expect(segmentUserMessage('/compact')).toEqual([{ kind: 'command', token: '/compact' }])
    })

    it('/skill:commit 归技能段,名字剥出来', () => {
      expect(segmentUserMessage('/skill:commit 提交')).toEqual([
        { kind: 'skill', token: '/skill:commit', name: 'commit' },
        { kind: 'text', text: ' 提交' },
      ])
    })

    it('命令后面的 @ 引用照认', () => {
      expect(segmentUserMessage('/cd @/Users/me/')).toEqual([
        { kind: 'command', token: '/cd' },
        { kind: 'text', text: ' ' },
        { kind: 'dirRef', path: '/Users/me/' },
      ])
    })
  })
})

describe('画', () => {
  it('文件引用画成 chip:屏幕上只写 basename,全路径进无障碍名', () => {
    render(<UserMessageBody text="看 @/Users/me/src/a.ts" />)
    const chip = screen.getByRole('button', { name: '打开 /Users/me/src/a.ts' })
    expect(chip.textContent).toBe('a.ts')
    expect(chip.getAttribute('data-ref-kind')).toBe('fileRef')
    // 禁 native title —— 提示只走 ui/Tooltip。
    expect(chip.getAttribute('title')).toBeNull()
  })

  it('目录名带回尾巴上那个斜杠', () => {
    render(<UserMessageBody text="@/Users/me/src/" />)
    const chip = screen.getByRole('button', { name: '打开目录 /Users/me/src/' })
    expect(chip.textContent).toBe('src/')
  })

  it('点文件 chip = openFileInCurrentTarget', () => {
    render(<UserMessageBody text="@/Users/me/a.ts" />)
    fireEvent.click(screen.getByRole('button'))
    expect(openFile).toHaveBeenCalledWith('/Users/me/a.ts')
    expect(openDir).not.toHaveBeenCalled()
  })

  it('点目录 chip = openDirectoryPanel', () => {
    render(<UserMessageBody text="@/Users/me/src/" />)
    fireEvent.click(screen.getByRole('button'))
    expect(openDir).toHaveBeenCalledWith('/Users/me/src/')
    expect(openFile).not.toHaveBeenCalled()
  })

  it('chip 键盘可达:是个真 BUTTON 元素,回车由浏览器转成 click', () => {
    render(<UserMessageBody text="@/Users/me/a.ts" />)
    const chip = screen.getByRole('button')
    expect(chip.tagName).toBe('BUTTON')
    // 没有 tabindex="-1",它就在 Tab 序里;焦点环走全局 :focus-visible,本地不画。
    expect(chip.getAttribute('tabindex')).toBeNull()
    chip.focus()
    expect(document.activeElement).toBe(chip)
  })

  it('命令与技能不可点(不是按钮)', () => {
    const { container } = render(<UserMessageBody text="/skill:commit 提交" />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(container.textContent).toBe('◇commit 提交')
  })

  it('超量:一条消息里 50 个引用 + 一段长正文,五十枚 chip 全在', () => {
    const body = '正'.repeat(2000)
    const refs = Array.from({ length: 50 }, (_, i) => `@/Users/me/src/file-${i}.ts`).join(' ')
    render(<UserMessageBody text={`${body} ${refs}`} />)
    expect(screen.getAllByRole('button')).toHaveLength(50)
  })

  it('换行由 pre-wrap 保留 —— 切分不吃换行符', () => {
    const { container } = render(<UserMessageBody text={'第一行\n第二行 @/a.ts'} />)
    expect(container.textContent).toBe('第一行\n第二行 a.ts')
  })
})
