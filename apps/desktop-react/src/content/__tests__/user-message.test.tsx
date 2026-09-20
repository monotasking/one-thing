import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { segmentUserMessage, segmentUserParts, UserMessageBody } from '../user-message'
import { useStageStore } from '../../stage/store'
import type { UserContentPart } from '../user-message'

/**
 * 用户气泡里的 `@路径` / `/命令` / 技能引用(2026-09-12)。
 *
 * 两半分开量:**切分表**是纯函数(正文一张、部件一张),一条一条钉判据;
 * **画**那一半只问四件事 —— chip 出不出得来、点下去叫不叫得对人、
 * SKILL.md 正文有没有漏上屏、五十个引用会不会炸。
 */

const openFile = vi.hoisted(() => vi.fn())
const openDir = vi.hoisted(() => vi.fn())
const openSkill = vi.hoisted(() => vi.fn(async () => true))
const notified = vi.hoisted(() => vi.fn())

// 打开那三条路各自拖着一整片 store(viewer-source / workbench / stage / 技能表),
// 这里量的是「叫对了谁」,不是那三条路自己 —— 它们有自己的用例。
/* B2:文件那一种改叫 `openFileAt(path, loc?)` —— 定位长出了行 / 区间 / 列 / 符号
 * 四格,`openFileInCurrentTarget` 今天是它的薄转发。量的仍是「叫对了谁、递对了
 * 什么」,只是那个「什么」多了一格。 */
vi.mock('../viewer/open-target', () => ({ openFileAt: openFile }))
vi.mock('../dir-open', () => ({ openDirectoryPanel: openDir }))
vi.mock('../skill-open', () => ({ openSkillDirectory: openSkill, openSkillNamed: openSkill }))
vi.mock('../../services/notify', () => ({ notify: notified }))

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  openFile.mockClear()
  openDir.mockClear()
  notified.mockClear()
  openSkill.mockReset()
  openSkill.mockResolvedValue(true)
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
      .map((seg) => {
        if (seg.kind === 'text') return seg.text
        if (seg.kind === 'fileRef' || seg.kind === 'dirRef') return `@${seg.path}`
        // 正文切出来的只可能是这三种;`skillRef` / `promptRef` 只从部件来。
        if (seg.kind === 'command' || seg.kind === 'skill') return seg.token
        throw new Error(`正文里不该切出 ${seg.kind}`)
      })
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

  it('点文件 chip = openFileAt(路径, 没有定位)', () => {
    render(<UserMessageBody text="@/Users/me/a.ts" />)
    fireEvent.click(screen.getByRole('button'))
    // `@/abs` 那条旧写法里没有行号 / 符号,所以定位那一格是空的 —— 与 B2 之前
    // `openFileInCurrentTarget(path)` 的行为逐字相同(只打开,不跳行)。
    expect(openFile).toHaveBeenCalledWith('/Users/me/a.ts', {})
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

  /*
   * 09-14 皮 B:技能那一枚的记号从字符 `◇` 换成真图标(`Sparkles`,`aria-hidden`)
   * —— 所以 `textContent` 里不再有那个字。断言换的是**这一件形变**,判据
   * (「不可点 = 不是按钮」)一个字没动。
   */
  it('命令与技能不可点(不是按钮)', () => {
    const { container } = render(<UserMessageBody text="/skill:commit 提交" />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(container.textContent).toBe('commit 提交')
    // 图标在,而且它不念给读屏听(名字才是身份)。
    expect(container.querySelector('svg[aria-hidden="true"]')).toBeTruthy()
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

/* ── 部件那一半(09-12:`/skill:名` 发出去,气泡里是一整份 SKILL.md)────── */

/** 引擎真的折出来的那一形(读数取自真账本 `7f0ab096…/events.jsonl` 第 19 行)。 */
const SKILL_BODY = '# Lenovo VoiceConnector Scripts\n\nDeployed to /usr/local/freeswitch/scripts.'
const skillPart = (over: Partial<UserContentPart> = {}): UserContentPart => ({
  type: 'skill-ref',
  skillId: 'user/lenovo-scripts',
  name: 'lenovo-scripts',
  content: SKILL_BODY,
  ...over,
})

describe('部件切分表', () => {
  it('text 部件照旧走正文那张表:`@路径` 成 chip、行首命令成药丸', () => {
    expect(segmentUserParts([{ type: 'text', content: '/cd 看 @/a.ts' }])).toEqual([
      { kind: 'command', token: '/cd' },
      { kind: 'text', text: ' 看 ' },
      { kind: 'fileRef', path: '/a.ts' },
    ])
  })

  it('skill-ref → 可点那一种段(带 skillId),**正文一个字不进段**', () => {
    const segs = segmentUserParts([skillPart(), { type: 'text', content: ' 帮我看看' }])
    expect(segs).toEqual([
      { kind: 'skillRef', skillId: 'user/lenovo-scripts', name: 'lenovo-scripts' },
      { kind: 'text', text: ' 帮我看看' },
    ])
    expect(JSON.stringify(segs)).not.toContain('Lenovo VoiceConnector')
  })

  it('prompt-ref → 标题药丸', () => {
    expect(segmentUserParts([{ type: 'prompt-ref', title: '周报' }])).toEqual([
      { kind: 'promptRef', title: '周报' },
    ])
  })

  it('不认识的部件一个字都不画(reasoning / image / provider-data 不是用户说的话)', () => {
    expect(
      segmentUserParts([
        { type: 'reasoning', content: '模型自己想的' },
        { type: 'image' } as UserContentPart,
        { type: 'text', content: '嗨' },
      ]),
    ).toEqual([{ kind: 'text', text: '嗨' }])
  })

  it('skill-ref 没带 skillId 就不画 —— 一枚打不开任何东西的 chip 比没有更坏', () => {
    expect(segmentUserParts([skillPart({ skillId: undefined })])).toEqual([])
  })

  it('name 缺席时退回 skillId(屏幕上总得有个认得出的名字)', () => {
    expect(segmentUserParts([skillPart({ name: undefined })])).toEqual([
      { kind: 'skillRef', skillId: 'user/lenovo-scripts', name: 'user/lenovo-scripts' },
    ])
  })

  /**
   * 命令词只认**整条消息**的开头那一个 —— 排在一枚部件后面的那截正文不是开头。
   *
   * 反证锚点:把 `appendText` 的 `atStart` 拆成恒真,这一条当场红
   * (前一条不会红:`/skill:x 干活` 折出来那截是 `' 干活'`,本来就不以 `/` 起笔,
   *  所以它量的是**形**,这一条量的才是**判据**)。
   */
  it('排在部件后面那截正文里的 `/x` 不是命令', () => {
    expect(
      segmentUserParts([
        { type: 'prompt-ref', title: '周报' },
        { type: 'text', content: '/cd ~/x' },
      ]),
    ).toEqual([
      { kind: 'promptRef', title: '周报' },
      { kind: 'text', text: '/cd ~/x' },
    ])
  })

  it('`/skill:x 干活` 折出来的那截正文照旧是正文', () => {
    expect(segmentUserParts([skillPart(), { type: 'text', content: ' 干活' }])).toEqual([
      { kind: 'skillRef', skillId: 'user/lenovo-scripts', name: 'lenovo-scripts' },
      { kind: 'text', text: ' 干活' },
    ])
  })

  it('相邻的文字并成一段(剥回来的尾巴与后面那截本来就是同一句话)', () => {
    expect(
      segmentUserParts([
        { type: 'text', content: '看 @/a.ts,' },
        { type: 'text', content: '然后呢' },
      ]),
    ).toEqual([
      { kind: 'text', text: '看 ' },
      { kind: 'fileRef', path: '/a.ts' },
      { kind: 'text', text: ',然后呢' },
    ])
  })
})

describe('画:有 contentParts 就按部件画', () => {
  /** 账本上那条消息的 `content` 是**模型版** —— 整份 SKILL.md。 */
  const modelContent = `<skill name="lenovo-scripts">\n${SKILL_BODY}\n</skill> 帮我看看`

  it('**SKILL.md 正文一个字都不上屏**(这一单要治的病)', () => {
    const { container } = render(
      <UserMessageBody
        text={modelContent}
        parts={[skillPart(), { type: 'text', content: ' 帮我看看' }]}
      />,
    )
    // 皮 B:记号 `◇` 换成了真图标(不进 `textContent`),名字一个字没变。
    expect(container.textContent).toBe('lenovo-scripts 帮我看看')
    expect(container.textContent).not.toContain('Lenovo VoiceConnector')
  })

  /**
   * **反证**:把「有 contentParts 就按部件画」拆掉(这里用不传 parts 模拟),
   * 整份 SKILL.md 当场回到屏幕上 —— 那正是真机报障的原样。
   */
  it('反证:不按部件画时,整份 SKILL.md 原样上屏', () => {
    const { container } = render(<UserMessageBody text={modelContent} />)
    expect(container.textContent).toContain('Lenovo VoiceConnector')
  })

  it('空 parts 不算「有」—— 照旧切正文,不画成空气泡', () => {
    const { container } = render(<UserMessageBody text="就一句话" parts={[]} />)
    expect(container.textContent).toBe('就一句话')
  })

  it('技能 chip 是一枚真按钮,全名进无障碍名,禁 native title', () => {
    render(<UserMessageBody text="" parts={[skillPart()]} />)
    const chip = screen.getByRole('button', { name: '打开技能目录 lenovo-scripts' })
    expect(chip.tagName).toBe('BUTTON')
    expect(chip.getAttribute('data-ref-kind')).toBe('skillRef')
    expect(chip.getAttribute('title')).toBeNull()
    expect(chip.getAttribute('tabindex')).toBeNull()
  })

  it('点技能 chip = openSkillDirectory(skillId)(它那头再去开目录面板)', async () => {
    render(<UserMessageBody text="" parts={[skillPart()]} />)
    fireEvent.click(screen.getByRole('button'))
    expect(openSkill).toHaveBeenCalledWith('user/lenovo-scripts')
    await waitFor(() => expect(notified).not.toHaveBeenCalled())
  })

  it('pending:点下去那一瞬 aria-busy,回来之后撤 —— **不 disabled**(焦点不许掉回 body)', async () => {
    let settle: (ok: boolean) => void = () => {}
    openSkill.mockImplementation(() => new Promise<boolean>((resolve) => { settle = resolve }))
    render(<UserMessageBody text="" parts={[skillPart()]} />)
    const chip = screen.getByRole('button')
    chip.focus()
    fireEvent.click(chip)
    await waitFor(() => expect(chip.getAttribute('aria-busy')).toBe('true'))
    expect(chip.hasAttribute('disabled')).toBe(false)
    expect(document.activeElement).toBe(chip)
    // 在飞期间再点是恒等(重复点由那格闸挡住)。
    fireEvent.click(chip)
    expect(openSkill).toHaveBeenCalledTimes(1)
    settle(true)
    await waitFor(() => expect(chip.getAttribute('aria-busy')).toBeNull())
  })

  it('三条路全落空:notify 一条 warn(异步失败得有人说话)', async () => {
    openSkill.mockResolvedValue(false)
    render(<UserMessageBody text="" parts={[skillPart()]} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(notified).toHaveBeenCalledTimes(1))
    expect(notified.mock.calls[0][0]).toMatchObject({
      level: 'warn',
      title: '打不开技能目录 lenovo-scripts',
    })
  })

  it('prompt-ref 画成药丸、**不可点**(壳里还没有能打开提示词的面)', () => {
    const { container } = render(
      <UserMessageBody text="" parts={[{ type: 'prompt-ref', title: '周报' }]} />,
    )
    expect(container.textContent).toBe('[周报]')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('prompt-ref 没标题时兜底一句人话', () => {
    const { container } = render(
      <UserMessageBody text="" parts={[{ type: 'prompt-ref' }]} />,
    )
    expect(container.textContent).toBe('[未命名提示词]')
  })

  it('超量:20 个技能引用 + 50 个文件引用,七十枚 chip 全在且正文零泄漏', () => {
    const parts: UserContentPart[] = []
    for (let i = 0; i < 20; i += 1) {
      parts.push(skillPart({ skillId: `user/s-${i}`, name: `skill-${i}` }))
      parts.push({ type: 'text', content: ' ' })
    }
    parts.push({
      type: 'text',
      content: Array.from({ length: 50 }, (_, i) => `@/Users/me/src/file-${i}.ts`).join(' '),
    })
    const { container } = render(<UserMessageBody text="" parts={parts} />)
    expect(screen.getAllByRole('button')).toHaveLength(70)
    expect(container.textContent).not.toContain('Lenovo VoiceConnector')
  })
})
