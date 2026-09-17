import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { ALU_RIG } from '@onething/runtime/pets/builtin/alu.rig'
import type { DeclarativeRigSpec, RigPose } from '@onething/runtime/pets/rig-spec'
import { DeclarativeRig, transformOf } from '../rigs/DeclarativeRig'
import { PetRigView } from '../rigs/PetRigView'
import type { PoseState } from '../types'
import s from '../rigs/DeclarativeRig.module.css'

/**
 * 声明式形象的解释器(宠物 P5,§12.6 第二条):
 *  ① 阿绿九个姿势各渲染一次,断言部件显隐与 motion 类名;
 *  ② 嘴:张嘴那一组出现、闭嘴那一组藏起来,张嘴那一组带一张一合的类;
 *  ③ 一次性动画:点名了部件的落在部件上(并强制出现),没点名的落到整只;
 *  ④ 不认识的东西(动作名、部件、形状、颜色、父组)不画不抛;
 *  ⑤ `PetRigView` 分叉:字符串查手画表、对象交给解释器、缺席不画。
 */

afterEach(cleanup)

const POSES: readonly PoseState[] = ['petted', 'dizzy', 'sleeping', 'speaking', 'busy', 'listening', 'dozing', 'grooving', 'sitting']

function part(container: HTMLElement, id: string): Element | null {
  return container.querySelector(`[data-part="${id}"]`)
}

function hidden(container: HTMLElement, id: string): boolean {
  return part(container, id)?.getAttribute('data-hidden') === 'true'
}

function motionOf(container: HTMLElement, id: string): string | null {
  // 外层 g → (可能的一次性动画层)→ 内层 g 带 data-motion
  const el = part(container, id)
  const inner = el?.querySelector(':scope > g[data-motion], :scope > g > g[data-motion]')
  return inner?.getAttribute('data-motion') ?? null
}

describe('DeclarativeRig · 阿绿的九个姿势', () => {
  it('keeps the shell PoseState and the product RigPose the same nine names', () => {
    expectTypeOf<PoseState>().toEqualTypeOf<RigPose>()
  })

  it.each(POSES)('renders %s with that pose\'s visibility and motions, straight from the data', (pose) => {
    const { container, getByTestId } = render(<DeclarativeRig spec={ALU_RIG} pose={pose} mouth="closed" />)
    expect(getByTestId('pet-rig').getAttribute('data-pose')).toBe(pose)
    const posed = ALU_RIG.poses[pose]?.parts ?? {}
    for (const [id, spec] of Object.entries(posed)) {
      if (typeof spec.hidden === 'boolean') expect(hidden(container, id), `${pose} ${id} hidden`).toBe(spec.hidden)
      if (spec.motion) expect(motionOf(container, id), `${pose} ${id} motion`).toBe(spec.motion)
    }
    // 没被这个姿势点名的部件按缺省:缺省藏着的就藏着(嘴那一组另算)。
    const mouthParts = new Set([...ALU_RIG.mouth.closed, ...ALU_RIG.mouth.talking])
    for (const p of ALU_RIG.parts) {
      if (posed[p.id] || mouthParts.has(p.id)) continue
      expect(hidden(container, p.id), `${pose} ${p.id} default`).toBe(p.hidden === true)
    }
  })

  it('puts motion names onto CSS classes from the fixed table', () => {
    const { container } = render(<DeclarativeRig spec={ALU_RIG} pose="grooving" mouth="closed" beat={0.5} />)
    const body = part(container, 'body')?.querySelector('g[data-motion="swayFast"]')
    expect(body?.getAttribute('class')).toContain(s.motionSwayFast)
    expect(container.querySelector('[data-testid="pet-rig"]')?.getAttribute('style')).toContain('--pet-beat: 0.5s')
  })

  it('the nine poses are nine different pictures', () => {
    const pictures = new Set(
      POSES.map((pose) => {
        const { container, unmount } = render(<DeclarativeRig spec={ALU_RIG} pose={pose} mouth="closed" />)
        const signature = [...container.querySelectorAll('[data-part]')]
          .map((el) => `${el.getAttribute('data-part')}:${el.getAttribute('data-hidden') ?? ''}:${el.getAttribute('style') ?? ''}:${el.querySelector('[data-motion]')?.getAttribute('data-motion') ?? ''}`)
          .join('|')
        unmount()
        return signature
      }),
    )
    expect(pictures.size).toBe(POSES.length)
  })
})

describe('DeclarativeRig · mouth and one-shots', () => {
  it('shows the talking group and hides the closed group while talking', () => {
    const closed = render(<DeclarativeRig spec={ALU_RIG} pose="speaking" mouth="closed" />)
    expect(hidden(closed.container, 'beakLower')).toBe(false)
    expect(hidden(closed.container, 'beakLowerOpen')).toBe(true)
    closed.unmount()
    const talking = render(<DeclarativeRig spec={ALU_RIG} pose="speaking" mouth="talking" />)
    expect(hidden(talking.container, 'beakLower')).toBe(true)
    expect(hidden(talking.container, 'beakLowerOpen')).toBe(false)
    expect(part(talking.container, 'beakLowerOpen')?.innerHTML).toContain(s.talk)
  })

  it('lands a targeted one-shot on its part (forcing it visible) and an untargeted one on the whole rig', () => {
    const love = render(<DeclarativeRig spec={ALU_RIG} pose="sitting" mouth="closed" oneShot="love" />)
    expect(hidden(love.container, 'hearts')).toBe(false)
    expect(part(love.container, 'hearts')?.innerHTML).toContain(s.shotLove)
    expect(love.getByTestId('pet-rig').getAttribute('data-one-shot')).toBeNull()
    love.unmount()
    const squish = render(<DeclarativeRig spec={ALU_RIG} pose="sitting" mouth="closed" oneShot="squish" />)
    expect(squish.getByTestId('pet-rig').getAttribute('data-one-shot')).toBe('squish')
  })
})

describe('DeclarativeRig · things it does not recognise', () => {
  const odd = {
    viewBox: [0, 0, 10, 10],
    palette: { ink: '#000', evil: 'url(javascript:alert(1))' },
    parts: [
      { id: 'ok', shape: 'circle', cx: 5, cy: 5, r: 2, fill: 'ink' },
      { id: 'badColor', shape: 'circle', cx: 5, cy: 5, r: 2, fill: 'evil' },
      { id: 'polygon', shape: 'polygon' },
      { id: 'orphan', shape: 'circle', cx: 1, cy: 1, r: 1, parent: 'ghost' },
    ],
    poses: { sitting: { parts: { ok: { motion: 'moonwalk' }, ghost: { hidden: false } } } },
    mouth: { closed: ['ghost'], talking: [] },
    oneShots: { love: 'ghost' },
  } as unknown as DeclarativeRigSpec

  it('draws what it knows and skips the rest without throwing', () => {
    const { container, getByTestId } = render(<DeclarativeRig spec={odd} pose="sitting" mouth="closed" oneShot="love" />)
    expect(part(container, 'ok')).not.toBeNull()
    expect(motionOf(container, 'ok')).toBeNull()
    expect(part(container, 'polygon')).toBeNull()
    expect(part(container, 'orphan')).toBeNull()
    expect(part(container, 'ghost')).toBeNull()
    expect(part(container, 'badColor')?.querySelector('circle')?.getAttribute('fill')).toBe('none')
    // 点名了不存在的部件的一次性动画落到整只(爱心换成压扁弹回)。
    expect(getByTestId('pet-rig').getAttribute('data-one-shot')).toBe('squish')
    expect(container.innerHTML).not.toContain('javascript')
  })

  it('builds transforms from numbers only', () => {
    expect(transformOf({ translate: [1, 2], rotate: 3, scale: [1, 2] })).toBe('translate(1px, 2px) rotate(3deg) scale(1, 2)')
    expect(transformOf({ rotate: 'calc(1)' } as never)).toBeUndefined()
    expect(transformOf(undefined)).toBeUndefined()
  })
})

describe('PetRigView', () => {
  it('picks the hand-drawn rig by id, the interpreter for a spec, and nothing otherwise', () => {
    const drawn = render(<PetRigView rig="heidou-svg" pose="sitting" mouth="closed" />)
    expect(drawn.getByTestId('pet-rig').querySelector('[data-part]')).toBeNull()
    drawn.unmount()
    const data = render(<PetRigView rig={ALU_RIG} pose="sitting" mouth="closed" />)
    expect(data.container.querySelector('[data-part="skull"]')).not.toBeNull()
    data.unmount()
    expect(render(<PetRigView rig="nope" pose="sitting" mouth="closed" />).container.innerHTML).toBe('')
    cleanup()
    expect(render(<PetRigView rig={undefined} pose="sitting" mouth="closed" />).container.innerHTML).toBe('')
  })
})
