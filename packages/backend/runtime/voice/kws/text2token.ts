import { pinyin } from 'pinyin-pro'

// Encodes a Chinese wake phrase into sherpa-onnx keyword-spotter tokens
// (ppinyin: orthographic initial + tone-marked final, e.g.
// "n ǐ h ǎo x iǎo y ī @你好小一"), mirroring `sherpa-onnx-cli text2token
// --tokens-type ppinyin`. Tokens must exist in the model's tokens.txt.

const PPINYIN_INITIAL_RE = /^(zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])/

export interface OnethingKeywordEncodeOptions {
  boostingScore?: number
  triggerThreshold?: number
}

export interface OnethingKeywordEncodeResult {
  /** One keywords-file line, e.g. "n ǐ h ǎo x iǎo y ī @你好小一". */
  line: string
  tokens: string[]
}

export function parseOnethingKwsTokenVocabulary(tokensFileContent: string): Set<string> {
  const vocabulary = new Set<string>()
  for (const rawLine of tokensFileContent.split('\n')) {
    const token = rawLine.trim().split(/\s+/)[0]
    if (token) vocabulary.add(token)
  }
  return vocabulary
}

export function encodeOnethingKeywordPhrase(
  phrase: string,
  tokensFileContent: string,
  options: OnethingKeywordEncodeOptions = {},
): OnethingKeywordEncodeResult {
  const normalizedPhrase = phrase.trim().replace(/\s+/g, '')
  if (!normalizedPhrase) {
    throw new Error('Wake phrase is empty.')
  }
  if (!/^[一-鿿]+$/.test(normalizedPhrase)) {
    throw new Error('The wake phrase must be Chinese characters only (e.g. 你好小一).')
  }

  const vocabulary = parseOnethingKwsTokenVocabulary(tokensFileContent)
  const syllables = pinyin(normalizedPhrase, {
    type: 'array',
    toneType: 'symbol',
    nonZh: 'removed',
  })
  if (syllables.length !== normalizedPhrase.length) {
    throw new Error(`Could not derive pinyin for the wake phrase "${normalizedPhrase}".`)
  }

  const tokens: string[] = []
  for (let index = 0; index < syllables.length; index += 1) {
    const syllable = syllables[index]
    const character = normalizedPhrase[index]
    tokens.push(...encodeSyllable(syllable, character, vocabulary))
  }

  const suffixes: string[] = []
  if (options.boostingScore !== undefined) suffixes.push(`:${options.boostingScore}`)
  if (options.triggerThreshold !== undefined) suffixes.push(`#${options.triggerThreshold}`)
  const line = `${tokens.join(' ')}${suffixes.length ? ' ' + suffixes.join(' ') : ''} @${normalizedPhrase}`
  return { line, tokens }
}

function encodeSyllable(syllable: string, character: string, vocabulary: Set<string>): string[] {
  const initialMatch = PPINYIN_INITIAL_RE.exec(syllable)
  const candidates: string[][] = []
  if (initialMatch) {
    const initial = initialMatch[1]
    const final = syllable.slice(initial.length)
    if (final) candidates.push([initial, final])
  }
  candidates.push([syllable])

  for (const candidate of candidates) {
    if (candidate.every(token => vocabulary.has(token))) return candidate
  }

  throw new Error(
    `The wake engine's vocabulary does not cover "${character}" (${syllable}). Pick a different wake phrase.`,
  )
}
