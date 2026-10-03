const SENTENCE_END_RE = /[.!?。！？]+["'”’)]*\s*$/
const HARD_END_CHAR_RE = /[.!?。！？]/
const SOFT_END_CHAR_RE = /[,，;；、]/

export interface OnethingSentenceSegmentationResult {
  ready: string[]
  remainder: string
}

export interface OnethingSentenceSegmentationOptions {
  force?: boolean
  lowLatency?: boolean
  minSoftChars?: number
  maxChars?: number
}

export interface OnethingSpeakableTextDelta {
  text?: string
  voiceSpeakText?: string
}

export interface OnethingSpeakMarkupChunk {
  displayText: string
  speakText: string
  sawControlTag: boolean
}

export interface OnethingSpeakMarkupFilter {
  push(input: string): OnethingSpeakMarkupChunk
  flush(): OnethingSpeakMarkupChunk
}

type OnethingSpeakMode = 'normal' | 'speak'

export function splitOnethingSpeakableSentences(
  input: string,
  options: boolean | OnethingSentenceSegmentationOptions = false,
): OnethingSentenceSegmentationResult {
  const normalizedOptions = typeof options === 'boolean' ? { force: options } : options
  const force = Boolean(normalizedOptions.force)
  const lowLatency = Boolean(normalizedOptions.lowLatency)
  const minSoftChars = Math.max(4, normalizedOptions.minSoftChars ?? 12)
  const maxChars = Math.max(minSoftChars, normalizedOptions.maxChars ?? 96)
  const text = input.replace(/\s+/g, ' ')
  const ready: string[] = []
  let start = 0

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (HARD_END_CHAR_RE.test(char)) {
      let end = i + 1
      while (end < text.length && /["'”’)]/.test(text[end])) end += 1
      const candidate = text.slice(start, end).trim()
      if (candidate.length >= 2 && SENTENCE_END_RE.test(candidate)) {
        ready.push(candidate)
        start = end
      }
      continue
    }

    if (lowLatency && SOFT_END_CHAR_RE.test(char)) {
      const end = i + 1
      const candidate = text.slice(start, end).trim()
      if (candidate.length >= minSoftChars) {
        ready.push(candidate)
        start = end
      }
    }
  }

  let remainder = text.slice(start).trimStart()
  if (lowLatency) {
    while (remainder.length >= maxChars) {
      const breakIndex = findOnethingLowLatencyBreak(remainder, minSoftChars, maxChars)
      ready.push(remainder.slice(0, breakIndex).trim())
      remainder = remainder.slice(breakIndex).trimStart()
    }
  }

  if (force && remainder.trim()) {
    ready.push(remainder.trim())
    return { ready, remainder: '' }
  }
  return { ready, remainder }
}

export function getOnethingSpeakableTextFromDelta(chunk: OnethingSpeakableTextDelta): string {
  return chunk.text || chunk.voiceSpeakText || ''
}

export function createOnethingSpeakMarkupFilter(): OnethingSpeakMarkupFilter {
  let mode: OnethingSpeakMode = 'normal'
  let pendingTag = ''
  let sawControlTag = false

  function push(input: string): OnethingSpeakMarkupChunk {
    let displayText = ''
    let speakText = ''

    for (const char of input) {
      if (pendingTag) {
        pendingTag += char
        if (char === '>') {
          const nextMode = applyOnethingSpeakTag(pendingTag, mode)
          if (nextMode) {
            mode = nextMode
            sawControlTag = true
          } else {
            displayText += pendingTag
            if (mode === 'speak') speakText += pendingTag
          }
          pendingTag = ''
        } else if (pendingTag.length > 24) {
          displayText += pendingTag
          if (mode === 'speak') speakText += pendingTag
          pendingTag = ''
        }
        continue
      }

      if (char === '<') {
        pendingTag = '<'
        continue
      }

      displayText += char
      if (mode === 'speak') speakText += char
    }

    return { displayText, speakText, sawControlTag }
  }

  function flush(): OnethingSpeakMarkupChunk {
    const displayText = pendingTag
    const speakText = mode === 'speak' ? pendingTag : ''
    pendingTag = ''
    return { displayText, speakText, sawControlTag }
  }

  return { push, flush }
}

export function getOnethingProtocolSpeakText(chunk: OnethingSpeakMarkupChunk): string | undefined {
  return chunk.sawControlTag ? chunk.speakText : undefined
}

function applyOnethingSpeakTag(rawTag: string, mode: OnethingSpeakMode): OnethingSpeakMode | null {
  const tag = rawTag.trim().toLowerCase()
  if (tag === '<speak>') return 'speak'
  if (tag === '</speak>') return 'normal'
  if (tag === '<silent>' || tag === '</silent>') return mode
  return null
}

function findOnethingLowLatencyBreak(text: string, minChars: number, maxChars: number): number {
  const window = text.slice(0, maxChars)
  for (let index = window.length - 1; index >= minChars; index -= 1) {
    if (/[\s,，;；、]/.test(window[index])) return index + 1
  }
  return maxChars
}
