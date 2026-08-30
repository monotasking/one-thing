import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { SessionCard } from './SessionCard'
import { SESSIONS } from '../../data/__fixtures__/sessions'
import { useStageStore } from '../../stage/store'

/**
 * Quick Look 的**鼠标**入口。键盘入口(Space)一直都在,这里补的是鼠标那条。
 *
 * 两条要钉住:
 * 1. 它**占位常驻** —— 不是 hover 才渲染出来的。条件渲染会在出现的那一帧挤动布局,
 *    而这一批的规矩是「hover 只改样式,不动位置」。
 * 2. 它不嵌在卡这个 <button> 里(那是非法 HTML,浏览器会当场拆开),
 *    所以点它只触发预览,不会顺带触发「进入」。
 */
const session = SESSIONS[0]
/** 房间卡:kind 徽只在非 chat 时出现,所以「徽在不在」要有两个样本才钉得住。 */
const room = SESSIONS.find((s) => s.kind === 'room')!
/** 没跑过任何一轮的会话:lastModel 缺席 → 模型徽这一格不存在。 */
const noModel = SESSIONS.find((s) => s.model === null)!

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
})

function setup() {
  const onEnter = vi.fn()
  const onQuickLook = vi.fn()
  render(
    <SessionCard
      session={session}
      query=""
      current={false}
      focused={false}
      onEnter={onEnter}
      onQuickLook={onQuickLook}
    />,
  )
  return { onEnter, onQuickLook }
}

describe('会话卡:Quick Look 鼠标入口', () => {
  it('没 hover 时也在 DOM 里(占位常驻,只动 opacity)', () => {
    setup()
    expect(screen.getByTestId(`card-preview-${session.id}`)).toBeTruthy()
  })

  it('点它 = 预览,不触发进入', () => {
    const { onEnter, onQuickLook } = setup()
    fireEvent.click(screen.getByTestId(`card-preview-${session.id}`))
    expect(onQuickLook).toHaveBeenCalledTimes(1)
    expect(onEnter).not.toHaveBeenCalled()
  })

  it('点卡面仍然是进入,预览没被误触', () => {
    const { onEnter, onQuickLook } = setup()
    fireEvent.click(screen.getByText(session.title))
    expect(onEnter).toHaveBeenCalledTimes(1)
    expect(onQuickLook).not.toHaveBeenCalled()
  })

  it('预览按钮不是卡那个 button 的后代 —— button 套 button 是非法 HTML', () => {
    setup()
    const preview = screen.getByTestId(`card-preview-${session.id}`)
    const card = screen.getByText(session.title).closest('button')
    expect(card).toBeTruthy()
    expect(card?.contains(preview)).toBe(false)
  })
})

/**
 * D1:卡面上每一格都得有产地。改动数 / 测试通过 / 未读数 / 房间头像在
 * `SessionMeta` 上没有对应字段,所以它们**不存在**,而不是显示成 0。
 */
describe('会话卡:每一格都有产地', () => {
  it('普通会话不出 kind 徽(绝大多数会话都是它,满屏一个字没有信息)', () => {
    setup()
    expect(screen.queryByText('室')).toBeNull()
    expect(screen.queryByText('话')).toBeNull()
  })

  it('房间 / 私聊才出徽', () => {
    render(
      <SessionCard session={room} query="" current={false} focused={false} onEnter={vi.fn()} onQuickLook={vi.fn()} />,
    )
    expect(screen.getByText('室')).toBeTruthy()
  })

  it('卡面写的是 previewText,不是一句凭空的摘要', () => {
    setup()
    expect(screen.getByText(session.preview)).toBeTruthy()
  })
})

/**
 * F 批新增的两格:模型徽(有产地才画)与搜索高亮(命中词在卡上看得见)。
 * H 批把摘要行接上(见下面那个 describe)。
 */
describe('会话卡:模型徽', () => {
  it('lastModel 有值就出一枚空心 chip', () => {
    setup()
    expect(screen.getByText('claude-opus-5')).toBeTruthy()
  })

  it('没跑过任何一轮的会话不出模型徽 —— 不拿一个默认模型名去顶', () => {
    render(
      <SessionCard session={noModel} query="" current={false} focused={false} onEnter={vi.fn()} onQuickLook={vi.fn()} />,
    )
    expect(noModel.model).toBeNull()
    expect(screen.queryByText('claude-opus-5')).toBeNull()
  })
})

describe('会话卡:搜索高亮', () => {
  it('命中词在标题里被 <mark> 包起来,而标题的完整文本一个字不少', () => {
    render(
      <SessionCard session={session} query="provider" current={false} focused={false} onEnter={vi.fn()} onQuickLook={vi.fn()} />,
    )
    const marks = document.querySelectorAll('mark')
    expect(marks.length).toBeGreaterThan(0)
    expect([...marks].some((m) => m.textContent === 'provider')).toBe(true)
    // gate-data.mjs 按 `[data-session-id] span` 读标题 —— 高亮不许把它切碎。
    const card = document.querySelector(`[data-session-id="${session.id}"]`)
    expect(card?.querySelector('span')?.textContent).toBe(session.title)
  })

  it('预览行也高亮', () => {
    render(
      <SessionCard session={session} query="收敛" current={false} focused={false} onEnter={vi.fn()} onQuickLook={vi.fn()} />,
    )
    expect([...document.querySelectorAll('mark')].some((m) => m.textContent === '收敛')).toBe(true)
  })

  it('空词一个 <mark> 都不出(不搜时卡面逐字与从前相同)', () => {
    setup()
    expect(document.querySelectorAll('mark').length).toBe(0)
  })
})

/**
 * H 批:摘要行(产地 `SessionMeta.lastMessagePreview`)。
 *
 * 两条要钉住,合起来才是「无产地的格不占高」:
 *  1. 有产地时画成一行 `.digest`;
 *  2. 缺席时**一个节点都不画** —— 不是画一个空的 <p> 等它。
 */
describe('会话卡:摘要行', () => {
  it('lastMessagePreview 有值就画一行,写的是它自己而不是 preview', () => {
    setup()
    const digest = screen.getByTestId(`card-digest-${session.id}`)
    expect(digest.textContent).toBe(session.digest)
    expect(digest.textContent).not.toBe(session.preview)
  })

  it('缺席(存量老会话)时连节点都没有,所以卡不会先空着一行等它', () => {
    const old = SESSIONS.find((x) => x.digest === null)!
    render(
      <SessionCard session={old} query="" current={false} focused={false} onEnter={vi.fn()} onQuickLook={vi.fn()} />,
    )
    expect(screen.queryByTestId(`card-digest-${old.id}`)).toBeNull()
  })

  it('摘要也高亮 —— 搜的格与卡上画的格是同一批', () => {
    render(
      <SessionCard session={session} query="判定函数" current={false} focused={false} onEnter={vi.fn()} onQuickLook={vi.fn()} />,
    )
    expect([...document.querySelectorAll('mark')].some((m) => m.textContent === '判定函数')).toBe(true)
  })

  it('高亮之后标题仍是卡里的第一个 span(gate-data.mjs 按它读标题)', () => {
    render(
      <SessionCard session={session} query="判定函数" current={false} focused={false} onEnter={vi.fn()} onQuickLook={vi.fn()} />,
    )
    const card = document.querySelector(`[data-session-id="${session.id}"]`)
    expect(card?.querySelector('span')?.textContent).toBe(session.title)
  })
})

/**
 * ── 08-30 窄形 N2(用户拍板:≤420px 进压缩卡)────────────────────────────
 * jsdom 不排版、也不算容器查询,所以这里钉的是**规则本身**(读源码,与
 * Overview.test.tsx 里那两组同一个办法)。真的排出来长什么样、有没有压住别人,
 * 由 `npm run gate:squeeze` 在真机五档上判。
 *
 * 这一组要守住的其实是三句话:
 *  ① 窄档是**压缩**,不是另一张卡 —— 同一套 DOM,只改 CSS;
 *  ② 连续量在 420px 处等于宽档的老值,所以宽档逐像素不变、切档没有台阶;
 *  ③ 离散量各配一次软化,并且错峰。
 */
describe('会话卡:窄形 N2 的规则', () => {
  const css = readFileSync(
    resolve(process.cwd(), 'src/expose/components/SessionCard.module.css'),
    'utf8',
  )
  const narrowBlock = (selector: string) => {
    const band = css.indexOf('@container expose (max-width: 420px)')
    expect(band).toBeGreaterThan(-1)
    const at = css.indexOf(selector + ' {', band)
    expect(at).toBeGreaterThan(-1)
    return css.slice(at, css.indexOf('}', at))
  }
  const wideBlock = (selector: string) => {
    const at = css.indexOf(selector + ' {')
    expect(at).toBeGreaterThan(-1)
    return css.slice(at, css.indexOf('}', at))
  }

  it('只有一个阈值 —— 420,不做更窄的第二档', () => {
    const bands = [...css.matchAll(/@container expose \(max-width: (\d+)px\)/g)].map((m) => m[1])
    expect(bands).toEqual(['420'])
  })

  it('窄档:预览钳到一行、卡矮下去、模型徽设硬顶', () => {
    expect(narrowBlock('.summary')).toContain('line-clamp: 1')
    expect(narrowBlock('.card')).toContain('min-height: var(--card-min-h-narrow)')
    expect(narrowBlock('.model')).toContain('max-width: var(--model-max-w-narrow)')
  })

  it('宽档仍是两行预览 —— 窄形只是压缩,没换一张卡', () => {
    expect(wideBlock('.summary')).toContain('line-clamp: 2')
  })

  it('连续量走 clamp token,不是在阈值处硬跳(内边距 / 行距)', () => {
    const card = wideBlock('.card')
    expect(card).toContain('var(--card-pad-block-fluid)')
    expect(card).toContain('var(--card-pad-inline-fluid)')
    expect(card).toContain('var(--card-row-gap-fluid)')
    // 连续量**不许**挂 transition:它每一帧都在变,挂了就是每一帧都在补间。
    expect(card).not.toMatch(/transition:[^;]*padding/)
  })

  it('离散量各配一次软化,并且错峰(三件事不许同一帧一起跳)', () => {
    expect(wideBlock('.card')).toContain('min-height var(--dur) var(--ease) var(--squeeze-stagger-2)')
    expect(wideBlock('.summary')).toContain('max-height var(--dur) var(--ease) var(--squeeze-stagger-2)')
    expect(wideBlock('.model')).toContain('max-width var(--dur) var(--ease) var(--squeeze-stagger-3)')
  })

  it('律一:脚行里弯腰的是模型徽,时间永不弯腰', () => {
    const model = wideBlock('.model')
    expect(model).toContain('min-width: 0')
    expect(model).toContain('text-overflow: ellipsis')
    expect(wideBlock('.time')).toContain('flex: none')
  })
})
