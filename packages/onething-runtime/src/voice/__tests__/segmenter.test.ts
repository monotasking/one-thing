import { describe, expect, it } from 'vitest'
import { splitOnethingSpeakableSentences as splitSpeakableSentences } from '../text.js'

describe('splitSpeakableSentences', () => {
  it('keeps incomplete text as remainder', () => {
    expect(splitSpeakableSentences('Hello world')).toEqual({
      ready: [],
      remainder: 'Hello world',
    })
  })

  it('splits English and Chinese sentence endings', () => {
    expect(splitSpeakableSentences('Hello world. 你好！Still going')).toEqual({
      ready: ['Hello world.', '你好！'],
      remainder: 'Still going',
    })
  })

  it('keeps soft punctuation buffered by default', () => {
    expect(splitSpeakableSentences('好的，我来处理')).toEqual({
      ready: [],
      remainder: '好的，我来处理',
    })
  })

  it('can split on long soft punctuation for low-latency speech', () => {
    expect(splitSpeakableSentences('I can help with that, and continue later', {
      lowLatency: true,
      minSoftChars: 8,
    })).toEqual({
      ready: ['I can help with that,'],
      remainder: 'and continue later',
    })
  })

  it('chunks long text in low-latency mode even without sentence punctuation', () => {
    expect(splitSpeakableSentences('one two three four five six seven', {
      lowLatency: true,
      minSoftChars: 8,
      maxChars: 20,
    })).toEqual({
      ready: ['one two three four'],
      remainder: 'five six seven',
    })
  })

  it('flushes the remainder when forced', () => {
    expect(splitSpeakableSentences('没有句号也要说', true)).toEqual({
      ready: ['没有句号也要说'],
      remainder: '',
    })
  })
})
