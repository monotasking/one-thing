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
 * 摘要行仍是一个**空的格位** —— `lastMessagePreview` 落地前不画节点,
 * 所以卡不会先空着一行等它(见 SessionCard.tsx 里那段接缝注释)。
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
