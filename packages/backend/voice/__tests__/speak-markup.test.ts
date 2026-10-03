import { describe, expect, it } from 'vitest'
import {
  createOnethingSpeakMarkupFilter as createSpeakMarkupFilter,
  getOnethingProtocolSpeakText as getProtocolSpeakText,
} from '../text.js'

describe('speak markup filter', () => {
  it('strips speak tags from display text and emits only speak text for voice', () => {
    const filter = createSpeakMarkupFilter()
    const first = filter.push('<spe')
    const second = filter.push('ak>Hello</speak>\nDetails stay visible.')

    expect(first).toEqual({ displayText: '', speakText: '', sawControlTag: false })
    expect(second.displayText).toBe('Hello\nDetails stay visible.')
    expect(second.speakText).toBe('Hello')
  })

  it('keeps normal text visible without speaking it', () => {
    const filter = createSpeakMarkupFilter()
    const chunk = filter.push('Visible only.')

    expect(chunk.displayText).toBe('Visible only.')
    expect(chunk.speakText).toBe('')
  })

  it('lets callers fall back to visible text until a speak protocol tag appears', () => {
    const filter = createSpeakMarkupFilter()
    const plain = filter.push('No tag response.')

    expect(getProtocolSpeakText(plain)).toBeUndefined()

    const tagged = filter.push('<speak>Tagged response.</speak>Hidden detail.')

    expect(tagged.displayText).toBe('Tagged response.Hidden detail.')
    expect(getProtocolSpeakText(tagged)).toBe('Tagged response.')
  })
})
