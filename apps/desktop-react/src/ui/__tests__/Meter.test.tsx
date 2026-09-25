import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Meter } from '../Meter'

describe('ui/Meter', () => {
  it('is a named meter with a human value text, clamped over the top', () => {
    render(<Meter label="内存" value={300} max={200} valueText="300 MB" tone="danger" />)
    const meter = screen.getByRole('meter', { name: '内存' })
    expect(meter.getAttribute('aria-valuenow')).toBe('300')
    expect(meter.getAttribute('aria-valuetext')).toBe('300 MB')
    expect(meter.getAttribute('data-tone')).toBe('danger')
    expect((meter.querySelector('[style*="width"]') as HTMLElement).style.width).toBe('100%')
  })

  it('an unmeasured value draws no fill and reports no current value (absent is not zero)', () => {
    render(<Meter label="内存" max={200} />)
    const meter = screen.getByRole('meter', { name: '内存' })
    expect(meter.hasAttribute('aria-valuenow')).toBe(false)
    expect(meter.querySelector('[style*="width"]')).toBeNull()
  })

  it('draws a tick per position and labels only the named ones, hidden from screen readers', () => {
    render(<Meter label="内存" value={50} max={200} ticks={[{ at: 100, label: 'soft' }, { at: 150, label: 'hard' }, { at: 180 }]} />)
    const meter = screen.getByRole('meter', { name: '内存' })
    const positioned = [...meter.querySelectorAll<HTMLElement>('[style*="left"]')]
    expect(positioned.map(el => el.style.left)).toEqual(['50%', '75%', '90%', '50%', '75%'])
    expect(meter.querySelector('[aria-hidden="true"]')?.textContent).toBe('softhard')
  })
})
