import { describe, expect, it } from 'vitest'
import {
  MEDIA_PART_TOKEN_ESTIMATE,
  estimateHistoryMessagesInputTokens,
  estimateTextTokens,
} from '../agent-loop-context-usage.js'

/**
 * 10-09 的 400 事故(`prompt is too long: 1102516 tokens`):Codex 电脑操控的截图以 200KB base64 **文本**
 * 进了请求,而估算器把 ≥4000 字符的 base64 一律当「省略」算成几十个字符 —— 四张图加了 70 万真 token,
 * 估算器一个都没数到,压缩从未触发。这里钉住两条规矩:部件里的图按一张的常数算,混在文本里的 base64 按字符折。
 */
describe('estimateHistoryMessagesInputTokens', () => {
  const base64 = 'A'.repeat(200_000)

  it('counts an image part as one image, not as its base64 length', () => {
    const history = [{ role: 'tool', content: [{ type: 'image', image: base64, mediaType: 'image/jpeg' }] }]
    const tokens = estimateHistoryMessagesInputTokens(history)!
    expect(tokens).toBeGreaterThanOrEqual(MEDIA_PART_TOKEN_ESTIMATE)
    expect(tokens).toBeLessThan(MEDIA_PART_TOKEN_ESTIMATE + 200)
  })

  it('counts base64 buried in a text part as text the provider will tokenize', () => {
    const history = [{ role: 'tool', content: [{ type: 'text', text: base64 }] }]
    const tokens = estimateHistoryMessagesInputTokens(history)!
    // 200k 字符 ÷ 2.5 = 80k;从前这里数出来的是几十。
    expect(tokens).toBeGreaterThan(70_000)
  })

  it('a data URL string counts as one image', () => {
    const history = [{ role: 'user', content: `data:image/png;base64,${base64}` }]
    const tokens = estimateHistoryMessagesInputTokens(history)!
    expect(tokens).toBeGreaterThanOrEqual(MEDIA_PART_TOKEN_ESTIMATE)
    expect(tokens).toBeLessThan(MEDIA_PART_TOKEN_ESTIMATE + 200)
  })

  it('plain text history is still the plain character estimate', () => {
    const history = [{ role: 'user', content: 'short visible provider payload' }]
    expect(estimateHistoryMessagesInputTokens(history)).toBe(estimateTextTokens(JSON.stringify(history)))
  })
})
