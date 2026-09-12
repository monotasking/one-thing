import { describe, expect, it } from 'vitest'
import * as T from './transitions'
import type { ProviderGroup } from '../data/models-source'
import { modelOption } from '../data/__fixtures__/models'
import type { AskSpec, Attachment } from './types'

/**
 * 分组过滤的样本。D2 波一之前它是 `composer/data.ts` 的 MOCK_PROVIDERS ——
 * 那份假目录随接真一起退役了,而 `filterProviders` 仍然是一条要逐条钉的规则,
 * 所以样本就地造一份:纯函数的测试不该依赖任何数据源。
 */
const GROUPS: ProviderGroup[] = [
  {
    id: 'anthropic',
    provider: 'Anthropic',
    models: [
      modelOption('claude-opus-5', 200_000),
      modelOption('claude-sonnet-5', 200_000),
      modelOption('claude-haiku-4.5', null),
    ],
  },
  {
    id: 'xai',
    provider: 'xAI',
    models: [modelOption('grok-4', 500_000), modelOption('grok-4-fast', 500_000)],
  },
]

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

  /* 冒号进命令词(09-12):技能引用叫 `/skill:<名字>`,而人是一个字一个字打出来的
   * —— 打到冒号那一刻 token 若断掉,抽屉当场收起来。 */
  it('`/skill:` 打到一半 token 不断,冒号之后那几个字就是查询词', () => {
    expect(T.parseToken('/skill:', '/skill:')).toEqual({ kind: 'commands', query: 'skill:' })
    expect(T.parseToken('/skill:wr', '/skill:wr')).toEqual({ kind: 'commands', query: 'skill:wr' })
    // 触发前提一个字没改:整段话得以 / 开头,所以句中的冒号照旧不触发。
    expect(T.parseToken('见 a:b', '见 a:b')).toBeNull()
    /*
     * **留账**:`\w` 不收中日韩,所以一个中文名的技能打到名字第一个汉字时 token
     * 仍会断(抽屉收起来)—— 与 `@` 那条对中文路径的既有限制是同一格。
     * 从抽屉里选(打 `/skill` → ↑↓ → ↵)不受影响,那也是这一批设计的入口。
     * 放宽字符集是一次更大的行为赌注(`/新建…` 这类句子会开始触发抽屉),另批拍。
     */
    expect(T.parseToken('/skill:写', '/skill:写')).toBeNull()
  })

  /* 「选中行上下走 / 夹进范围」的判据 09-01 搬去了 ui/a11y/list-selection,
   * 断言跟着搬进 src/ui/__tests__/list-selection.test.tsx —— 判据在哪,守卫在哪。 */
})

/**
 * 命令的匹配与分组(09-12,用户报障「命令无提示」)。
 *
 * 两件事一起测,是因为它们的**次序**本身就是一条判据:分组是外层分区,
 * 匹配的排序只在组内说话 —— 反过来就会切出两次「命令」组头。
 */
describe('命令匹配:名字前缀在前,说明 / 用法子串在后', () => {
  const table = [
    { name: '/new', desc: 'Start a new chat session', usage: '/new', kind: 'builtin' },
    { name: '/compact', desc: 'Summarize older history', usage: '/compact', kind: 'builtin' },
    { name: '/cd', desc: 'Change the working directory', usage: '/cd <path>', kind: 'builtin' },
  ]

  it('空词 = 整张表原样(一条都不筛,顺序一个字不动)', () => {
    expect(T.matchCommands(table, '').map((c) => c.name)).toEqual(['/new', '/compact', '/cd'])
  })

  it('名字命中的那一组永远在上面,说明命中的跟在后面', () => {
    // `c` 命中名字的有 /compact 与 /cd(原表顺序);/new 靠说明里的 "chat" 不命中 `c`?
    // 它命中的是 "session" 里没有 c —— 但 "Start a new chat session" 有 c,所以它进第二组。
    const got = T.matchCommands(table, 'c').map((c) => c.name)
    expect(got).toEqual(['/compact', '/cd', '/new'])
  })

  it('用法里的字也算数 —— 「path」找得到 /cd,而它名字里没有这几个字母', () => {
    expect(T.matchCommands(table, 'path').map((c) => c.name)).toEqual(['/cd'])
  })

  it('不分大小写', () => {
    expect(T.matchCommands(table, 'DIRECTORY').map((c) => c.name)).toEqual(['/cd'])
    expect(T.matchCommands(table, '/CD'.slice(1)).map((c) => c.name)).toEqual(['/cd'])
  })

  it('一条都不命中就是空表(抽屉据此说「无匹配」)', () => {
    expect(T.matchCommands(table, 'zzz')).toEqual([])
  })
})

describe('命令分组:三组,每组恰好出现一次,空组不出现', () => {
  const row = (name: string, kind: string) => ({ name, desc: '', usage: name, kind })

  it('顺序固定 命令 → 技能 → 插件;dev 与内置同组', () => {
    const got = T.groupCommands([
      row('/note', 'plugin'),
      row('/new', 'builtin'),
      row('/skill:a', 'skill'),
      row('/ask-demo', 'dev'),
    ])
    expect(got.map((g) => g.id)).toEqual(['command', 'skill', 'plugin'])
    expect(got[0].items.map((c) => c.name)).toEqual(['/new', '/ask-demo'])
  })

  it('空组不出现在结果里(「只当那组非空时画」落在这里,不落在渲染层)', () => {
    const got = T.groupCommands([row('/new', 'builtin')])
    expect(got.map((g) => g.id)).toEqual(['command'])
  })

  it('**分组只许一次**:匹配把说明命中的挪到后面,组头也不许因此出现两次', () => {
    // 匹配之后的顺序是「内置 / 技能 / 内置」—— 按相邻切段会切出两个「命令」组。
    const matched = [row('/cd', 'builtin'), row('/skill:a', 'skill'), row('/goal', 'builtin')]
    const got = T.groupCommands(matched)
    expect(got.map((g) => g.id)).toEqual(['command', 'skill'])
    expect(got[0].items.map((c) => c.name)).toEqual(['/cd', '/goal'])
  })

  it('扁平序 = 各组顺次相连(键盘位与 applyPick 的下标都按它算)', () => {
    const matched = [row('/cd', 'builtin'), row('/note', 'plugin'), row('/skill:a', 'skill')]
    const flat = T.groupCommands(matched).flatMap((g) => g.items)
    expect(flat.map((c) => c.name)).toEqual(['/cd', '/skill:a', '/note'])
  })
})

/**
 * ask 形态的 ← → 翻题只在**焦点不在任何输入面里**时才响 —— 写字的人按方向键
 * 是在移动光标。判据 09-02 批 9c 从 Composer 的键盘 effect 里提上来
 * (`isTypingTarget`),这一组是它的守卫。
 *
 * 反证:把 `contenteditable` 属性那一问删掉(只信 `isContentEditable`),
 * 下面「jsdom 上属性也算数」那条立刻红 —— 而真机上的后果是在输入框里按 ← →
 * 会翻题(光标动不了)。
 */
describe('哪些元素算「正在写字」', () => {
  const el = (html: string): Element => {
    const box = document.createElement('div')
    box.innerHTML = html
    return box.firstElementChild as Element
  }

  it('input / textarea 算', () => {
    expect(T.isTypingTarget(el('<input />'))).toBe(true)
    expect(T.isTypingTarget(el('<textarea></textarea>'))).toBe(true)
  })

  it('contenteditable 两种问法各自都够 —— 属性在,算', () => {
    // jsdom 不实现 `isContentEditable`(读到 undefined),属性是它唯一的产地。
    const box = el('<div contenteditable="true"></div>')
    expect((box as Partial<HTMLElement>).isContentEditable).not.toBe(true)
    expect(T.isTypingTarget(box)).toBe(true)
  })

  it('浏览器算好的那格为真时也够 —— 属性缺席也算', () => {
    const box = el('<div></div>')
    Object.defineProperty(box, 'isContentEditable', { value: true })
    expect(box.getAttribute('contenteditable')).toBeNull()
    expect(T.isTypingTarget(box)).toBe(true)
  })

  it('普通元素、没有焦点、非 HTML 元素都不算', () => {
    expect(T.isTypingTarget(el('<div></div>'))).toBe(false)
    // 按钮上的焦点也不算 —— 焦点落在发送键上时 ← → 照样该翻题。
    // (元素用 createElement 造:写成 `<button>…</button>` 的字面量会被
    //  `ui:consume` 的 bare-button-text 按字面扫成一颗手写文字钮。)
    const btn = document.createElement('button')
    btn.textContent = '发送'
    expect(T.isTypingTarget(btn)).toBe(false)
    expect(T.isTypingTarget(el('<div contenteditable="false"></div>'))).toBe(false)
    expect(T.isTypingTarget(null)).toBe(false)
    expect(T.isTypingTarget(undefined)).toBe(false)
    // 聚焦到一个 SVG 上:它不是输入面,方向键该归翻题。
    expect(T.isTypingTarget(document.createElementNS('http://www.w3.org/2000/svg', 'svg'))).toBe(
      false,
    )
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
    const groups = T.filterProviders(GROUPS, 'grok')
    expect(groups.map((g) => g.provider)).toEqual(['xAI'])
    expect(groups[0].models).toHaveLength(2)
  })

  it('按 Provider 名筛 —— 整组一起出来', () => {
    const groups = T.filterProviders(GROUPS, 'anthropic')
    expect(groups).toHaveLength(1)
    expect(groups[0].models).toHaveLength(3)
  })

  it('空关键词回全表;一条都不中时不留空组头', () => {
    expect(T.filterProviders(GROUPS, '  ')).toHaveLength(GROUPS.length)
    expect(T.filterProviders(GROUPS, 'zzz')).toEqual([])
  })

  it('筛完组 id 还在 —— 上行要它,逐格重建会把它悄悄丢掉', () => {
    expect(T.filterProviders(GROUPS, 'grok')[0].id).toBe('xai')
  })
})

describe('读数的格式', () => {
  it('百分比取整;圆环的 dash 第二个数给整圈周长,保证只画一段', () => {
    expect(T.percent(124_000, 200_000)).toBe(62)
    expect(T.ringDash(62, 7)).toBe('27.3 44.0')
  })

  it('分母不成立 = null(不是 0):「不知道窗口」与「才用了 0%」不是一件事', () => {
    expect(T.percent(1, 0)).toBeNull()
    expect(T.percent(1, Number.NaN)).toBeNull()
    // 超窗那一下夹在 100 —— 环画不出一圈半。
    expect(T.percent(300_000, 200_000)).toBe(100)
  })

  it('缺席态的环是一串点,不是一圈空实线', () => {
    const [on, off] = T.ringUnknownDash(7).split(' ')
    expect(on).toBe(off)
    expect(Number(on)).toBeCloseTo((2 * Math.PI * 7) / 16, 1)
  })

  it('金额:不足一块留四位 —— 两位会把 $0.0031 写成「免费」', () => {
    expect(T.formatUsd(0)).toBe('0.00')
    expect(T.formatUsd(0.0031)).toBe('0.0031')
    expect(T.formatUsd(1.234_5)).toBe('1.23')
    // 末尾的零不带信息:$0.8700 与 $0.10 里那几位是噪音,砍掉但保底两位。
    expect(T.formatUsd(0.87)).toBe('0.87')
    expect(T.formatUsd(0.1)).toBe('0.10')
  })

  it('状态条上那句话按字数截断', () => {
    expect(T.truncate('abc', 5)).toBe('abc')
    expect(T.truncate('abcdefg', 3)).toBe('abc…')
  })
})
