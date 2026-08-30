import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useStageStore } from '../../stage/store'
import { GROUPS, seedSessionsSource } from '../../data/__fixtures__/sessions'
import { useExposeStore } from '../store'
import { initialExposeState } from '../transitions'
import { ListView } from './ListView'

/**
 * 进组之后那一屏的顶行(‹ 总览 › 组名 …… 过滤框)的两条回归闸。
 *
 * 起因是 08-30 用户真机报障:会话总览钉在右边、拖到 ~300px,长目录名把过滤框
 * 整条顶出容器,屏幕上过滤框被裁得一点不剩。真因是 `.here` 写着 `flex: none`
 * —— 不肯收缩的 flex 项拿的是 max-content 宽度,于是它多宽这一行就多宽。
 *
 * 这里钉的是**样式契约**,不是像素:真排版由 `npm run gate:squeeze` 的
 * 「进组后 ListView」场景在真机上量(jsdom 没有布局,量不了几何)。两者分工是
 * 「这里保证写法没被改回去,那里保证写法真的管用」。
 */
const GROUP_ID = GROUPS[0].id

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  seedSessionsSource()
  useExposeStore.setState({ ...initialExposeState, view: { mode: 'list', groupId: GROUP_ID } })
})

describe('进组后的顶行:文案', () => {
  it('只写组名,不带条数 —— 08-30「计数禁令」在这一处的补执行', () => {
    render(<ListView groupId={GROUP_ID} />)
    // fixtures 里每组的条数都 ≥ 1,所以任何一句「N 会话 / N sessions」都不该在 DOM 里。
    expect(screen.queryByText(/\d+\s*会话/)).toBeNull()
    expect(screen.queryByText(/\d+\s*sessions?/)).toBeNull()
  })

  it('组名本身还在,面包屑也还能回总览', () => {
    render(<ListView groupId={GROUP_ID} />)
    const group = GROUPS[0]
    expect(screen.getByText(group.name ?? GROUP_ID)).toBeTruthy()
    fireEvent.click(screen.getByText('‹ 总览'))
    expect(useExposeStore.getState().view).toEqual({ mode: 'overview' })
  })

  it('过滤框在场,而且是一个真能打字的输入框', () => {
    render(<ListView groupId={GROUP_ID} />)
    const input = screen.getByLabelText('在本组内过滤') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'zzz-不该匹配任何一条' } })
    expect(input.value).toBe('zzz-不该匹配任何一条')
  })
})

describe('进组后的顶行:抗挤压样式契约', () => {
  const css = readFileSync(
    resolve(process.cwd(), 'src/expose/components/ListView.module.css'),
    'utf8',
  )
  /** 取一条规则的声明块。注释里出现的选择器不会带 `{`,所以不会被误命中。 */
  const block = (selector: string) => {
    const at = css.indexOf(selector + ' {')
    expect(at, `${selector} 这条规则不见了`).toBeGreaterThan(-1)
    return css.slice(at, css.indexOf('}', at))
  }

  it('组名同时有「能缩」与「缩了怎么收场」两把锁(律一)', () => {
    const here = block('.here')
    expect(here).toMatch(/min-width:\s*0/)
    expect(here).toMatch(/text-overflow:\s*ellipsis/)
    expect(here).toMatch(/overflow:\s*hidden/)
    // 律二:结构行里的文本永不换行,只截断。
    expect(here).toMatch(/white-space:\s*nowrap/)
    // 病灶复发的样子就是这一句回来 —— 不肯收缩 = 一行被它一个人撑开。
    expect(here).not.toMatch(/flex:\s*none/)
  })

  it('过滤框可收缩、有下限、宽档基准不变', () => {
    const filter = block('.filter')
    // 收缩因子不为 0(`flex: none` / `flex: 0 0 …` 都是「不肯让」)。
    expect(filter).not.toMatch(/flex:\s*none/)
    expect(filter).not.toMatch(/flex:\s*0\s+0\b/)
    expect(filter).toMatch(/flex:\s*0\s+1\s+var\(--pin-min\)/)
    // 有下限 = 让归让,不许被挤没。
    expect(filter).toMatch(/min-width:\s*var\(--/)
    // 下限只许是 token,不许是字面 px(与不落字面色值同级的铁律)。
    expect(filter).not.toMatch(/min-width:\s*\d/)
    // 从前那句写死的 `width: var(--pin-min)` 必须已经并进 flex-basis:
    // 同一个数只该有一个产地,留着它两处会打架。
    expect(filter).not.toMatch(/[;{]\s*width:/)
  })

  it('面包屑与分隔符永不收缩(挤压次序里它们排最后)', () => {
    expect(block('.crumb')).toMatch(/flex:\s*none/)
    expect(block('.crumbIcon')).toMatch(/flex:\s*none/)
  })
})
