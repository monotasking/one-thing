/**
 * H4 深链协议 —— core 契约层(URL 语法 + 声明门 + 返回值整形)。
 *
 * 这套断言全部拿"外部世界可以随便构造这个字符串"当前提写:能被猜出来的宽松,
 * 都是一条能被滥用的路。
 */
import { describe, expect, it } from 'vitest'
import {
  DEEPLINK_HOST_VERBS,
  DEEPLINK_TEXT_MAX_BYTES,
  ONETHING_DEEPLINK_SCHEME,
  PLUGIN_DEEPLINK_ACTION_NAME_PATTERN,
  PLUGIN_DEEPLINK_NOTICE_MAX_CHARS,
  PLUGIN_PERMISSION_DEEPLINK_HANDLE,
  deepLinkTextByteLength,
  isVisibleDeepLinkRejection,
  normalizePluginDeepLinkResult,
  parseDeepLink,
  pluginDeepLinkAddress,
  pluginDeepLinkSurface,
} from '../deep-link.js'
import { describePluginPermission } from '../sessions.js'

describe('H4 deep link — 宿主动词', () => {
  it('exposes the scheme and the v1 verb table', () => {
    expect(ONETHING_DEEPLINK_SCHEME).toBe('onething')
    // v1 只开一个。加动词是 append-only,这条会提醒改的人去把三处补齐。
    expect([...DEEPLINK_HOST_VERBS]).toEqual(['ask'])
  })

  it('parses ask with text', () => {
    const result = parseDeepLink('onething://ask?text=hello%20world')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.intent).toEqual({ kind: 'ask', text: 'hello world' })
  })

  it('carries the optional agent through', () => {
    const result = parseDeepLink('onething://ask?text=hi&agent=writer')
    expect(result.ok && result.intent).toEqual({ kind: 'ask', text: 'hi', agentId: 'writer' })
  })

  it('refuses ask without text — an empty prompt is not an intent', () => {
    const result = parseDeepLink('onething://ask')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('missing-text')
  })

  it('refuses a host verb that carries path segments', () => {
    // `onething://ask/anything` 是形状非法,不是"忽略后面那段"。
    const result = parseDeepLink('onething://ask/extra?text=hi')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('unknown-verb')
  })
})

describe('H4 deep link — 插件动作支路', () => {
  it('parses the plugin form and passes every other param through verbatim', () => {
    const result = parseDeepLink('onething://x/translator/translate?text=bonjour&to=zh&tone=formal')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.intent).toEqual({
      kind: 'plugin',
      pluginId: 'translator',
      action: 'translate',
      text: 'bonjour',
      params: { to: 'zh', tone: 'formal' },
    })
  })

  it('keeps text out of params — they are two different slots', () => {
    const result = parseDeepLink('onething://x/p/a?text=body')
    expect(result.ok && result.intent.kind === 'plugin' && result.intent.params).toEqual({})
  })

  it('allows an action with no text at all', () => {
    const result = parseDeepLink('onething://x/p/a?to=zh')
    expect(result.ok && result.intent).toEqual({
      kind: 'plugin', pluginId: 'p', action: 'a', text: '', params: { to: 'zh' },
    })
  })

  it('refuses a wrong number of path segments', () => {
    for (const url of ['onething://x/only-one', 'onething://x/a/b/c', 'onething://x']) {
      const result = parseDeepLink(url)
      expect(result.ok, url).toBe(false)
    }
  })

  it('refuses an illegal action name — it goes into a URL path', () => {
    const result = parseDeepLink('onething://x/p/Translate%20This')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('bad-action-name')
    expect(PLUGIN_DEEPLINK_ACTION_NAME_PATTERN.test('translate-text')).toBe(true)
    expect(PLUGIN_DEEPLINK_ACTION_NAME_PATTERN.test('Translate')).toBe(false)
    expect(PLUGIN_DEEPLINK_ACTION_NAME_PATTERN.test('a b')).toBe(false)
  })

  it('refuses a plugin id that could climb out of its slot', () => {
    const result = parseDeepLink('onething://x/..%2F..%2Fetc/act')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('bad-plugin-id')
  })
})

describe('H4 deep link — 拒绝分两种,且分得死', () => {
  it('refuses anything that is not our scheme', () => {
    for (const url of ['https://example.com/ask?text=hi', 'file:///etc/passwd']) {
      const result = parseDeepLink(url)
      expect(result.ok, url).toBe(false)
      if (result.ok) continue
      expect(result.reason).toBe('wrong-scheme')
    }
  })

  it('refuses an unknown verb', () => {
    const result = parseDeepLink('onething://run?text=rm%20-rf')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('unknown-verb')
  })

  it('refuses a non-string and an unparsable URL', () => {
    expect(parseDeepLink(undefined).ok).toBe(false)
    expect(parseDeepLink('').ok).toBe(false)
    expect(parseDeepLink('not a url at all').ok).toBe(false)
  })

  it('refuses text over the cap — and that one IS visible to the user', () => {
    const big = 'a'.repeat(DEEPLINK_TEXT_MAX_BYTES + 1)
    const result = parseDeepLink(`onething://ask?text=${encodeURIComponent(big)}`)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('text-too-long')
    // 这是唯一一种会走到确认卡上的拒绝 —— 其余全部静默丢弃,否则任何网页
    // 都能拿一串乱码让用户被弹一次。
    expect(isVisibleDeepLinkRejection('text-too-long')).toBe(true)
    for (const quiet of ['unknown-verb', 'wrong-scheme', 'malformed-url', 'missing-text'] as const) {
      expect(isVisibleDeepLinkRejection(quiet), quiet).toBe(false)
    }
  })

  it('measures the cap in UTF-8 bytes, not characters', () => {
    // 一个汉字 3 字节:按字符数判会让上限悄悄变成三倍。
    expect(deepLinkTextByteLength('中')).toBe(3)
    const justUnder = '中'.repeat(Math.floor(DEEPLINK_TEXT_MAX_BYTES / 3))
    expect(parseDeepLink(`onething://ask?text=${encodeURIComponent(justUnder)}`).ok).toBe(true)
    const justOver = '中'.repeat(Math.floor(DEEPLINK_TEXT_MAX_BYTES / 3) + 1)
    expect(parseDeepLink(`onething://ask?text=${encodeURIComponent(justOver)}`).ok).toBe(false)
  })

  it('treats text as data, never as a verb — a command-looking body still parses as ask', () => {
    const result = parseDeepLink('onething://ask?text=%2Fclear%20then%20rm%20-rf%20%2F')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.intent).toEqual({ kind: 'ask', text: '/clear then rm -rf /' })
  })
})

describe('H4 deep link — 插件注册面', () => {
  it('declares its permission and reads it out in plain words', () => {
    expect(PLUGIN_PERMISSION_DEEPLINK_HANDLE).toBe('deeplink:handle')
    const line = describePluginPermission(PLUGIN_PERMISSION_DEEPLINK_HANDLE)
    expect(line).toContain('onething://')
    // 披露的重点是"外面能唤起它",而且要说清每次都要确认。
    expect(line).toContain('confirm')
  })

  it('namespaces the address and folds it into one surface', () => {
    expect(pluginDeepLinkAddress('trans', 'translate')).toBe('plugin:trans:translate')
    expect(pluginDeepLinkSurface('plugin:trans:translate')).toBe('deeplink:plugin:trans:translate')
  })

  it('normalizes a handler result down to the one field v1 promises', () => {
    expect(normalizePluginDeepLinkResult(undefined)).toEqual({})
    expect(normalizePluginDeepLinkResult({ notice: '  done  ' })).toEqual({ notice: 'done' })
    expect(normalizePluginDeepLinkResult({ notice: 42 })).toEqual({})
    // 返回值里的其它键**不被解释** —— v1 不约定复杂协议。
    expect(normalizePluginDeepLinkResult({ notice: 'ok', openPanel: 'x' })).toEqual({ notice: 'ok' })
    const long = normalizePluginDeepLinkResult({ notice: 'x'.repeat(1000) })
    expect(long.notice).toHaveLength(PLUGIN_DEEPLINK_NOTICE_MAX_CHARS)
  })
})
