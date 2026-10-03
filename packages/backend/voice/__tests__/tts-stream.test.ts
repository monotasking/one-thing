import { describe, expect, it } from 'vitest'
import { getOnethingSpeakableTextFromDelta as getSpeakableTextFromDelta } from '../text.js'

describe('getSpeakableTextFromDelta', () => {
  it('falls back to visible text when no speak protocol text is present', () => {
    expect(getSpeakableTextFromDelta({ text: 'Plain voice reply.' })).toBe('Plain voice reply.')
  })

  it('prefers visible text in speak mode even when legacy protocol text is present', () => {
    expect(getSpeakableTextFromDelta({
      text: 'Visible full reply.',
      voiceSpeakText: 'Spoken part.',
    })).toBe('Visible full reply.')
  })

  it('falls back to legacy protocol text only when there is no visible text', () => {
    expect(getSpeakableTextFromDelta({
      text: '',
      voiceSpeakText: 'Legacy spoken part.',
    })).toBe('Legacy spoken part.')
  })
})
