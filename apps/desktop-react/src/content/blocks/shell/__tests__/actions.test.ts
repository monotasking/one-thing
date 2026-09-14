import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  blockActionLabelKey,
  isBlockActionRunnable,
  runBlockAction,
  type ZoomContent,
} from '../actions'
import { configureBlockRunPort } from '../run-port'
import { __resetLogForTests, dumpLog } from '../../../../services/log'

/**
 * `zoom` 的**两个取件口**(图片批加)。
 *
 * 守的是那条「声明了不等于露得出来」:一个动作要有执行器才上屏,而 zoom 的执行器
 * 判据从「有 svg」变成「两个取件口有其一」。少了这一组,给位图接上第二个取件口时
 * 最容易忘的恰恰是 `isBlockActionRunnable` 那一行 —— 忘了的表现是**檐上那颗「放大」
 * 整个不出现**,而屏幕上一切正常,没有任何报错。
 */
describe('zoom:两个取件口', () => {
  it('一个都没有 → 不露出(点了没反应比没这个钮更糟)', () => {
    expect(isBlockActionRunnable({ verb: 'zoom' })).toBe(false)
  })

  it('有 svg 取件口 → 露出', () => {
    expect(isBlockActionRunnable({ verb: 'zoom', svg: () => '<svg/>' })).toBe(true)
  })

  it('**有 image 取件口 → 也露出**(位图那一档)', () => {
    expect(isBlockActionRunnable({ verb: 'zoom', image: () => ({ src: 'x.png', alt: 'a' }) })).toBe(true)
  })

  it('取件口在、此刻交不出东西 → 仍然露出:那是诚实的中间态,不是坏钮', () => {
    expect(isBlockActionRunnable({ verb: 'zoom', image: () => undefined })).toBe(true)
  })
})

describe('zoom:执行器把内容交给浮层', () => {
  const runtime = (openZoom: (c: ZoomContent) => void) => ({
    toggleSource: () => undefined,
    openZoom,
    runScript: () => Promise.resolve(),
  })

  it('位图那一支:浮层收到 `{ image }`', async () => {
    const openZoom = vi.fn()
    await runBlockAction(
      { verb: 'zoom', image: () => ({ src: 'file:///a.png', alt: '猫' }) },
      runtime(openZoom),
    )
    expect(openZoom).toHaveBeenCalledWith({ image: { src: 'file:///a.png', alt: '猫' } })
  })

  it('矢量那一支:浮层收到 `{ svg }`', async () => {
    const openZoom = vi.fn()
    await runBlockAction({ verb: 'zoom', svg: () => '<svg/>' }, runtime(openZoom))
    expect(openZoom).toHaveBeenCalledWith({ svg: '<svg/>' })
  })

  it('取不到东西 → 什么都不做,**不开一个空浮层**', async () => {
    const openZoom = vi.fn()
    await runBlockAction({ verb: 'zoom', image: () => undefined }, runtime(openZoom))
    expect(openZoom).not.toHaveBeenCalled()
  })
})

/**
 * `run` 那一格(2026-09-14)。守的是同一条「声明了不等于露得出来」——
 * 只是这一型的取件口是**有没有人装了执行器**(`run-port`)。
 *
 * 反证(每条真跑过一次):
 *  · 把 `isBlockActionRunnable` 的 `run` 支改成 `return true` → 第一条当场红
 *    (没装端口也露出来 = web 壳上一颗点了没反应的钮);
 *  · 把 `runBlockAction` 的 `run` 支里那句 `.catch(...)` 拆掉 → 最后两条红
 *    (拒绝会穿出来把这块内容炸成降级物,而且日志里一个字都没有)。
 */
describe('run:装了执行器才露出', () => {
  const action = { verb: 'run', shell: 'bash', script: 'ls -l' } as const

  afterEach(() => configureBlockRunPort(undefined))

  it('没装端口 → 不露出(点了没反应比没这个钮更糟)', () => {
    expect(isBlockActionRunnable(action)).toBe(false)
  })

  it('装了端口 → 露出', () => {
    configureBlockRunPort({ run: () => Promise.resolve() })
    expect(isBlockActionRunnable(action)).toBe(true)
  })

  it('标签是「运行」那一格', () => {
    expect(blockActionLabelKey(action, false)).toBe('block.action.run')
  })
})

describe('run:执行器把 `{shell, script}` 交给壳', () => {
  const runtime = (runScript: (r: unknown) => Promise<void>) => ({
    toggleSource: () => undefined,
    openZoom: () => undefined,
    runScript: runScript as never,
  })

  beforeEach(() => __resetLogForTests())

  it('交出去的就是声明里那两格 —— 现场那两格由壳自己补', async () => {
    const runScript = vi.fn(() => Promise.resolve())
    await runBlockAction({ verb: 'run', shell: 'bash', script: 'echo hi' }, runtime(runScript))
    expect(runScript).toHaveBeenCalledWith({ shell: 'bash', script: 'echo hi' })
  })

  it('可见结果在终端里,所以返回 undefined(不走复制那种就地反馈)', async () => {
    const answer = await runBlockAction(
      { verb: 'run', shell: 'bash', script: 'echo hi' },
      runtime(() => Promise.resolve()),
    )
    expect(answer).toBeUndefined()
  })

  it('拒绝 → **不抛**,就地记一条 warn(不弹通知)', async () => {
    const boom = () => Promise.reject(new Error('开不出终端'))
    await expect(
      runBlockAction({ verb: 'run', shell: 'bash', script: 'ls' }, runtime(boom)),
    ).resolves.toBeUndefined()
    const warns = dumpLog().filter((row) => row.level === 'warn' && row.ns === 'content.blocks.run')
    expect(warns).toHaveLength(1)
    // 后端/运行时说的那句原话照抄进 args,不改写(与错误消息卡同一条纪律)。
    expect(warns[0].args.join(' ')).toContain('开不出终端')
  })
})
