import { describe, expect, it } from 'vitest'
import '..'
import { parseToken } from '../registry'

/**
 * **触发检测**。09-12 之前这是 `composer/transitions.parseToken` 里两条手写正则
 * (`@` 一条、`/` 一条);今天它由注册表算出来 —— 触发字符、句首还是句中、
 * token 收哪些字符,三样都是**各种引用自述的并**。
 *
 * 断言逐条照抄旧那一批,只有一处形变了:`TokenHit` 报的是**哪个触发字符**,
 * 不再是「哪一种引用」—— 那正是这一单要拆掉的那格枚举(一个字符下可以有好几种)。
 *
 * `import '..'` 是那张登记 barrel:表空的时候一个字符都不触发(「没登记 = 这台上
 * 没有这种能力」),所以钉触发就得先保证表是装好的。
 */
describe('@ 与 / 的触发位', () => {
  it('@ 在任意处都触发,后面那截就是查询词', () => {
    expect(parseToken('看看 @model', '看看 @model')).toEqual({ trigger: '@', query: 'model' })
    expect(parseToken('刚敲下 @', '刚敲下 @')).toEqual({ trigger: '@', query: '' })
  })

  it('/ 只在整段话以 / 开头时触发 —— 命令是一句话的主语,不是句中的词', () => {
    expect(parseToken('/rev', '/rev')).toEqual({ trigger: '/', query: 'rev' })
    expect(parseToken('先看看 /rev', '先看看 /rev')).toBeNull()
  })

  it('没有 token 就是 null(路径里的斜杠不算命令)', () => {
    expect(parseToken('普通一句话', '普通一句话')).toBeNull()
    expect(parseToken('src/app', 'src/app')).toBeNull()
  })

  /* 冒号进命令词(09-12):技能引用叫 `/skill:<名字>`,而人是一个字一个字打出来的
   * —— 打到冒号那一刻 token 若断掉,抽屉当场收起来。今天这一格是**技能那份自述
   * 的 `tokenChars`**,与命令、插件两家并成同一个字符组。 */
  it('`/skill:` 打到一半 token 不断,冒号之后那几个字就是查询词', () => {
    expect(parseToken('/skill:', '/skill:')).toEqual({ trigger: '/', query: 'skill:' })
    expect(parseToken('/skill:wr', '/skill:wr')).toEqual({ trigger: '/', query: 'skill:wr' })
    // 触发前提一个字没改:整段话得以 / 开头,所以句中的冒号照旧不触发。
    expect(parseToken('见 a:b', '见 a:b')).toBeNull()
    /*
     * **留账**:`\w` 不收中日韩,所以一个中文名的技能打到名字第一个汉字时 token
     * 仍会断(抽屉收起来)—— 与 `@` 那条对中文路径的既有限制是同一格。
     * 从抽屉里选(打 `/skill` → ↑↓ → ↵)不受影响,那也是这一批设计的入口。
     */
    expect(parseToken('/skill:写', '/skill:写')).toBeNull()
  })

  /**
   * **两个字符的 token 字符集互不串味**(这一条是新的:从前两条正则各写各的,
   * 谁也串不到谁;今天它们由同一只函数按**同字符下那几家**的自述并出来,
   * 所以要钉一次「并的是那几家,不是全表」)。
   */
  it('`@` 收点与连字符、`/` 收冒号 —— 两边不互相借字符', () => {
    // token 认的是**光标前那一截的末尾**,所以「收不收这个字符」表现为整条成不成立。
    expect(parseToken('@a-b.ts', '@a-b.ts')).toEqual({ trigger: '@', query: 'a-b.ts' })
    // `@` 那一族没人要冒号 —— 打到冒号那一刻 token 当场断掉。
    expect(parseToken('@a:', '@a:')).toBeNull()
    // `/` 那一族要冒号(技能),但没人要点号。
    expect(parseToken('/a:', '/a:')).toEqual({ trigger: '/', query: 'a:' })
    expect(parseToken('/a.b', '/a.b')).toBeNull()
  })
})
