import { describe, expect, it } from 'vitest'
import { AshField } from '../ash-field'

describe('AshField', () => {
  it('减弱动态与动效档「无」不撒粒子', () => {
    expect(AshField.skipsParticles('standard', false)).toBe(false)
    expect(AshField.skipsParticles('calm', false)).toBe(false)
    expect(AshField.skipsParticles('standard', true)).toBe(true)
    expect(AshField.skipsParticles('none', false)).toBe(true)
    expect(AshField.skipsParticles('calm', true)).toBe(true)
  })

  it('灰往上飘,走到头就淡没', () => {
    const motes = AshField.motes([{ x: 4, y: 20, width: 80, height: 16 }])
    expect(motes.length).toBeGreaterThan(0)
    for (const mote of motes) {
      const early = AshField.place(mote, 0.2, 48)
      const late = AshField.place(mote, 0.95, 48)
      expect(late.y).toBeLessThan(early.y)
      expect(late.alpha).toBeLessThan(early.alpha)
    }
    expect(AshField.place(motes[0]!, 1, 48).alpha).toBe(0)
  })

  it('没有字面就不撒', () => {
    expect(AshField.motes([])).toEqual([])
  })
})
