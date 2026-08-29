import { describe, expect, it } from 'vitest'
import * as T from './transitions'
import { MOCK_PROVIDERS } from './data'
import type { AskSpec, Attachment } from './types'

/**
 * Composer 的判断层。这里钉的是**规则**,不是像素:
 * 触发位、答案的三种形态、摞的坐标、分组过滤。组件测试只管「谁在场」。
 */

describe('@ 与 / 的触发位', () => {
  it('@ 在任意处都触发,后面那截就是查询词', () => {
    expect(T.parseToken('看看 @model', '看看 @model')).toEqual({ kind: 'files', query: 'model' })
    expect(T.parseToken('刚敲下 @', '刚敲下 @')).toEqual({ kind: 'files', query: '' })
  })

  it('/ 只在整段话以 / 开头时触发 —— 命令是一句话的主语,不是句中的词', () => {
    expect(T.parseToken('/rev', '/rev')).toEqual({ kind: 'commands', query: 'rev' })
    expect(T.parseToken('先看看 /rev', '先看看 /rev')).toBeNull()
  })

  it('没有 token 就是 null(路径里的斜杠不算命令)', () => {
    expect(T.parseToken('普通一句话', '普通一句话')).toBeNull()
    expect(T.parseToken('src/app', 'src/app')).toBeNull()
  })

  it('文件是包含匹配,命令是前缀匹配', () => {
    expect(T.matchFiles(['model-capability.ts', 'codex.ts'], 'ex')).toEqual(['codex.ts'])
    expect(
      T.matchCommands([{ name: '/review', desc: '' }, { name: '/plan', desc: '' }], 'r').map(
        (c) => c.name,
      ),
    ).toEqual(['/review'])
  })

  it('选中行的上下走在两端钳住,空表钉在 0', () => {
    expect(T.movePickIndex(0, -1, 3)).toBe(0)
    expect(T.movePickIndex(2, 1, 3)).toBe(2)
    expect(T.movePickIndex(1, 1, 3)).toBe(2)
    expect(T.movePickIndex(2, 1, 0)).toBe(0)
    expect(T.clampPickIndex(5, 3)).toBe(2)
  })
})

const SPEC: AskSpec = {
  questions: [
    { tag: 'A', q: 'a?', multi: false, opts: [{ l: '甲', d: '' }, { l: '乙', d: '' }] },
    {
      tag: 'B',
      q: 'b?',
      multi: true,
      opts: [{ l: '一', d: '' }, { l: '二', d: '' }, { l: '三', d: '' }],
    },
  ],
}

describe('ask 问卷', () => {
  it('开场每题都是「没答」', () => {
    expect(T.initAskAnswers(SPEC)).toEqual([null, null])
    expect(T.askAnsweredCount(T.initAskAnswers(SPEC))).toBe(0)
  })

  it('单选:点一条即选中,记的是标签', () => {
    expect(T.toggleAskOption(SPEC, [null, null], 0, 1)).toEqual(['乙', null])
  })

  it('单选:再点同一条即取消 —— 答错了不必找「清除」', () => {
    expect(T.toggleAskOption(SPEC, ['乙', null], 0, 1)).toEqual([null, null])
  })

  it('多选:同一条进出集合,记的是下标', () => {
    const once = T.toggleAskOption(SPEC, [null, null], 1, 2)
    expect(once[1]).toEqual([2])
    const twice = T.toggleAskOption(SPEC, once, 1, 0)
    expect(twice[1]).toEqual([2, 0])
    expect(T.toggleAskOption(SPEC, twice, 1, 2)[1]).toEqual([0])
  })

  it('多选清空 = 没答(否则「全选再全取消」会被记成已答,提交按钮会说谎)', () => {
    expect(T.isAskAnswered([])).toBe(false)
    expect(T.isAskAnswered([1])).toBe(true)
    expect(T.isAskAnswered(null)).toBe(false)
  })

  it('「其他」写空了等于没答,写了就是一句自定义答案', () => {
    expect(T.setAskCustomAnswer([null, null], 0, '  ')).toEqual([null, null])
    expect(T.setAskCustomAnswer([null, null], 0, ' 都行 ')).toEqual(['都行', null])
    expect(T.isCustomAnswer(SPEC.questions[0], '都行')).toBe(true)
    expect(T.isCustomAnswer(SPEC.questions[0], '甲')).toBe(false)
  })

  it('翻题两端钳住,不循环', () => {
    expect(T.moveAskIndex(0, -1, 2)).toBe(0)
    expect(T.moveAskIndex(1, 1, 2)).toBe(1)
    expect(T.moveAskIndex(0, 1, 2)).toBe(1)
  })

  it('全答才算数;答案念成一句话时多选按 joiner 连起来', () => {
    const answers = ['甲', [0, 2]]
    expect(T.askAnsweredCount(answers)).toBe(2)
    expect(T.askAllAnswered(SPEC, answers)).toBe(true)
    expect(T.askAllAnswered(SPEC, ['甲', []])).toBe(false)
    expect(T.askAnswerText(SPEC.questions[1], [0, 2], '、')).toBe('一、三')
    expect(T.askAnswerText(SPEC.questions[0], '甲', '、')).toBe('甲')
  })

  it('几何按「选项最多的题 + 恒在的其他行」预留,翻题时面板不跳', () => {
    expect(T.askMaxRows(SPEC)).toBe(4)
  })
})

const photo = (id: string): Attachment => ({ id, name: `${id}.png`, url: `blob:${id}` })
const doc = (id: string): Attachment => ({ id, name: `${id}.log` })

describe('拍立得附件的摞', () => {
  it('收拢只画最上三张,更早的藏起来(阴影不堆黑晕)', () => {
    const layout = T.layoutAttachments([photo('a'), photo('b'), photo('c'), photo('d')], false)
    expect(layout.cards.map((c) => c.hidden)).toEqual([true, false, false, false])
  })

  it('收拢:基础内衬 6,每往上一张多探出 7,错角 -3/0/3', () => {
    const layout = T.layoutAttachments([photo('a'), photo('b'), photo('c')], false)
    expect(layout.cards.map((c) => c.left)).toEqual([6, 13, 20])
    expect(layout.cards.map((c) => c.rotate)).toEqual([-3, 0, 3])
  })

  it('收拢的实宽按「最宽可见卡的右缘」+ 旋转余量', () => {
    // 顶卡是长卡(132):20 + 132 + 12
    const layout = T.layoutAttachments([photo('a'), photo('b'), doc('c')], false)
    expect(layout.stackWidth).toBe(164)
    expect(layout.rowWidth).toBe(164)
  })

  it('展开:从左往右累计,零旋转,末尾不留那一个间隙;宽交给视口封顶', () => {
    const layout = T.layoutAttachments([photo('a'), doc('b')], true)
    expect(layout.cards.map((c) => c.left)).toEqual([0, 86])
    expect(layout.cards.every((c) => c.rotate === 0)).toBe(true)
    expect(layout.rowWidth).toBe(76 + 10 + 132)
    expect(layout.stackWidth).toBeNull()
  })

  it('删一张:其余就位重排,摞不塌(展开态删卡是同一个函数的同一条分支)', () => {
    const before = T.layoutAttachments([photo('a'), doc('b'), photo('c')], true)
    const after = T.layoutAttachments([photo('a'), photo('c')], true)
    expect(before.cards.map((c) => c.id)).toEqual(['a', 'b', 'c'])
    expect(after.cards.map((c) => c.left)).toEqual([0, 86])
  })

  it('扩展名徽大写且最多四个字母', () => {
    expect(T.fileExt('trace.log')).toBe('LOG')
    expect(T.fileExt('note.markdown')).toBe('MARK')
    expect(T.fileExt('README')).toBe('')
  })
})

describe('模型抽屉的过滤', () => {
  it('按模型名筛', () => {
    const groups = T.filterProviders(MOCK_PROVIDERS, 'grok')
    expect(groups.map((g) => g.provider)).toEqual(['xAI'])
    expect(groups[0].models).toHaveLength(2)
  })

  it('按 Provider 名筛 —— 整组一起出来', () => {
    const groups = T.filterProviders(MOCK_PROVIDERS, 'anthropic')
    expect(groups).toHaveLength(1)
    expect(groups[0].models).toHaveLength(3)
  })

  it('空关键词回全表;一条都不中时不留空组头', () => {
    expect(T.filterProviders(MOCK_PROVIDERS, '  ')).toHaveLength(MOCK_PROVIDERS.length)
    expect(T.filterProviders(MOCK_PROVIDERS, 'zzz')).toEqual([])
  })
})

describe('读数的格式', () => {
  it('计数按千位收成 k,整数不留 .0', () => {
    expect(T.formatCount(48_200)).toBe('48.2k')
    expect(T.formatCount(200_000)).toBe('200k')
    expect(T.formatCount(999)).toBe('999')
  })

  it('百分比取整;圆环的 dash 第二个数给整圈周长,保证只画一段', () => {
    expect(T.percent(124_000, 200_000)).toBe(62)
    expect(T.percent(1, 0)).toBe(0)
    expect(T.ringDash(62, 7)).toBe('27.3 44.0')
  })

  it('状态条上那句话按字数截断', () => {
    expect(T.truncate('abc', 5)).toBe('abc')
    expect(T.truncate('abcdefg', 3)).toBe('abc…')
  })
})
