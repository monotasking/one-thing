import { describe, expect, it } from 'vitest'
import {
  createOnethingSpeakMarkupFilter,
  getOnethingProtocolSpeakText,
  getOnethingSpeakableTextFromDelta,
  splitOnethingSpeakableSentences,
} from '../text.js'

describe('voice text runtime', () => {
  it('keeps incomplete text as remainder', () => {
    expect(splitOnethingSpeakableSentences('Hello world')).toEqual({
      ready: [],
      remainder: 'Hello world',
    })
  })

  it('splits English and Chinese sentence endings', () => {
    expect(splitOnethingSpeakableSentences('Hello world. 你好！Still going')).toEqual({
      ready: ['Hello world.', '你好！'],
      remainder: 'Still going',
    })
  })

  it('keeps soft punctuation buffered by default', () => {
    expect(splitOnethingSpeakableSentences('好的，我来处理')).toEqual({
      ready: [],
      remainder: '好的，我来处理',
    })
  })

  it('can split on long soft punctuation for low-latency speech', () => {
    expect(splitOnethingSpeakableSentences('I can help with that, and continue later', {
      lowLatency: true,
      minSoftChars: 8,
    })).toEqual({
      ready: ['I can help with that,'],
      remainder: 'and continue later',
    })
  })

  it('chunks long text in low-latency mode even without sentence punctuation', () => {
    expect(splitOnethingSpeakableSentences('one two three four five six seven', {
      lowLatency: true,
      minSoftChars: 8,
      maxChars: 20,
    })).toEqual({
      ready: ['one two three four'],
      remainder: 'five six seven',
    })
  })

  it('flushes the remainder when forced', () => {
    expect(splitOnethingSpeakableSentences('没有句号也要说', true)).toEqual({
      ready: ['没有句号也要说'],
      remainder: '',
    })
  })

  it('selects speakable text from stream deltas', () => {
    expect(getOnethingSpeakableTextFromDelta({ text: 'Plain voice reply.' })).toBe('Plain voice reply.')
    expect(getOnethingSpeakableTextFromDelta({
      text: 'Visible full reply.',
      voiceSpeakText: 'Spoken part.',
    })).toBe('Visible full reply.')
    expect(getOnethingSpeakableTextFromDelta({
      text: '',
      voiceSpeakText: 'Legacy spoken part.',
    })).toBe('Legacy spoken part.')
  })

  it('strips speak tags from display text and emits only speak text for voice', () => {
    const filter = createOnethingSpeakMarkupFilter()
    const first = filter.push('<spe')
    const second = filter.push('ak>Hello</speak>\nDetails stay visible.')

    expect(first).toEqual({ displayText: '', speakText: '', sawControlTag: false })
    expect(second.displayText).toBe('Hello\nDetails stay visible.')
    expect(second.speakText).toBe('Hello')
  })

  it('lets callers fall back to visible text until a speak protocol tag appears', () => {
    const filter = createOnethingSpeakMarkupFilter()
    const plain = filter.push('No tag response.')

    expect(plain.displayText).toBe('No tag response.')
    expect(plain.speakText).toBe('')
    expect(getOnethingProtocolSpeakText(plain)).toBeUndefined()

    const tagged = filter.push('<speak>Tagged response.</speak>Hidden detail.')

    expect(tagged.displayText).toBe('Tagged response.Hidden detail.')
    expect(getOnethingProtocolSpeakText(tagged)).toBe('Tagged response.')
  })
})
