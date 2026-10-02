/**
 * R7 / P2-14 — truncation that cannot split a character.
 *
 * `String.slice` counts UTF-16 code UNITS. Everything outside the BMP — emoji,
 * the CJK extension blocks where rarer 汉字 live — is two of them, and cutting
 * between the pair leaves a lone surrogate: a replacement glyph in the UI, and
 * a byte sequence some providers reject. Four room surfaces truncate (say
 * bodies, judgement lines, quote excerpts, halt reasons) and the room is full
 * of exactly this text.
 */
import { describe, expect, it } from 'vitest'
import { truncateAtCodePoint } from '../truncate.js'

/** 😀 is one code point, two UTF-16 units. */
const EMOJI = '\u{1F600}'
/** 𠀋 — a CJK extension B ideograph, also a surrogate pair. */
const RARE_HAN = '\u{2000B}'

describe('truncateAtCodePoint', () => {
  it('leaves text shorter than the limit alone', () => {
    expect(truncateAtCodePoint('abc', 10)).toBe('abc')
    expect(truncateAtCodePoint('abc', 3)).toBe('abc')
  })

  it('cuts plain text exactly at the limit', () => {
    expect(truncateAtCodePoint('abcdef', 3)).toBe('abc')
  })

  it('backs off rather than cutting a surrogate pair in half', () => {
    const text = `ab${EMOJI}cd`
    // Limit 3 lands between the emoji's two units.
    const cut = truncateAtCodePoint(text, 3)
    expect(cut).toBe('ab')
    expect([...cut].length).toBe(2)
    // No lone surrogate survived.
    expect(cut.split('').some(unit => {
      const code = unit.charCodeAt(0)
      return code >= 0xd800 && code <= 0xdfff
    })).toBe(false)
  })

  it('keeps a pair that fits whole', () => {
    expect(truncateAtCodePoint(`ab${EMOJI}cd`, 4)).toBe(`ab${EMOJI}`)
  })

  it('applies to the rare-ideograph case the room actually hits', () => {
    expect(truncateAtCodePoint(`名字${RARE_HAN}`, 3)).toBe('名字')
    expect(truncateAtCodePoint(`名字${RARE_HAN}`, 4)).toBe(`名字${RARE_HAN}`)
  })

  it('handles a run of pairs on the boundary', () => {
    const text = EMOJI.repeat(4)
    expect(truncateAtCodePoint(text, 5)).toBe(EMOJI.repeat(2))
    expect(truncateAtCodePoint(text, 6)).toBe(EMOJI.repeat(3))
  })

  it('returns empty for a non-positive limit instead of throwing', () => {
    expect(truncateAtCodePoint('abc', 0)).toBe('')
    expect(truncateAtCodePoint('abc', -1)).toBe('')
  })

  it('never grows the text', () => {
    for (const limit of [0, 1, 2, 3, 4, 5]) {
      expect(truncateAtCodePoint(`a${EMOJI}b`, limit).length).toBeLessThanOrEqual(limit)
    }
  })
})
