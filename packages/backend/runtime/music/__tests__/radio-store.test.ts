import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createOnethingRadioStore } from '../radio-store.js'

describe('radio store', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'radio-store-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns an inactive empty brief when nothing was ever written', () => {
    const store = createOnethingRadioStore(dir)
    expect(store.readBrief()).toEqual({
      active: false,
      intent: '',
      startedAt: undefined,
      sessionId: undefined,
      played: [],
      skipped: [], loved: [],
      lastError: undefined,
    })
    expect(store.readProgramme()).toEqual({ entries: [] })
  })

  it('round-trips a brief', () => {
    const store = createOnethingRadioStore(dir)
    store.writeBrief({
      active: true,
      intent: '下雨天,安静的中文民谣',
      startedAt: '2026-07-16T10:00:00Z',
      played: [],
      skipped: [], loved: [],
    })
    const brief = store.readBrief()
    expect(brief.active).toBe(true)
    expect(brief.intent).toBe('下雨天,安静的中文民谣')
  })

  it('normalizes a creatively wrong brief instead of throwing', () => {
    const store = createOnethingRadioStore(dir)
    writeFileSync(
      store.briefPath,
      JSON.stringify({
        active: 'yes', // not a boolean → false
        intent: 42, // not a string → ''
        played: [{ title: '', at: 1 }, { title: 'ok' }, 'junk'],
        skipped: null,
      }),
    )
    const brief = store.readBrief()
    expect(brief.active).toBe(false)
    expect(brief.intent).toBe('')
    expect(brief.played).toEqual([{ title: 'ok', at: '' }])
    expect(brief.skipped).toEqual([])
  })

  it('survives a truncated programme file', () => {
    const store = createOnethingRadioStore(dir)
    writeFileSync(store.programmePath, '{"entries":[{"encryptedId":"D71F')
    expect(store.readProgramme()).toEqual({ entries: [] })
  })

  it('drops programme entries with unplayable ids and keeps valid ones', () => {
    const store = createOnethingRadioStore(dir)
    writeFileSync(
      store.programmePath,
      JSON.stringify({
        entries: [
          { encryptedId: 'D71F6E90EA704F1C44183933E7E0F197', originalId: 28285910, title: '岁月神偷' },
          { encryptedId: 'short', originalId: '1', title: 'bad encrypted id' },
          { encryptedId: 'D71F6E90EA704F1C44183933E7E0F197', originalId: 'abc', title: 'bad original id' },
          { encryptedId: 'D71F6E90EA704F1C44183933E7E0F197' }, // missing originalId
        ],
      }),
    )
    const programme = store.readProgramme()
    expect(programme.entries).toHaveLength(1)
    // Numeric originalId (as search returns it) is normalized to a string.
    expect(programme.entries[0]).toMatchObject({ originalId: '28285910', title: '岁月神偷' })
  })

  it('keeps the DJ patter (say) and trims it, dropping blank patter', () => {
    const store = createOnethingRadioStore(dir)
    writeFileSync(
      store.programmePath,
      JSON.stringify({
        entries: [
          { encryptedId: 'D71F6E90EA704F1C44183933E7E0F197', originalId: '1', title: '有串词', say: '  雨还在下，这首慢一点。  ' },
          { encryptedId: 'D71F6E90EA704F1C44183933E7E0F198', originalId: '2', title: '空串词', say: '   ' },
          { encryptedId: 'D71F6E90EA704F1C44183933E7E0F199', originalId: '3', title: '无串词' },
        ],
      }),
    )
    const [withSay, blankSay, noSay] = store.readProgramme().entries
    expect(withSay.say).toBe('雨还在下，这首慢一点。')
    expect(blankSay.say).toBeUndefined()
    expect(noSay.say).toBeUndefined()
  })

  it('takeNextEntry pops in order and persists the shrinking list', () => {
    const store = createOnethingRadioStore(dir)
    const entry = (n: number) => ({
      encryptedId: 'D71F6E90EA704F1C44183933E7E0F19' + n,
      originalId: String(n),
      title: `song ${n}`,
    })
    store.writeProgramme({ entries: [entry(1), entry(2)] })

    expect(store.takeNextEntry()?.title).toBe('song 1')
    expect(store.readProgramme().entries).toHaveLength(1)
    expect(store.takeNextEntry()?.title).toBe('song 2')
    expect(store.takeNextEntry()).toBeNull()
  })

  it('caps played/skipped history at 50 spins', () => {
    const store = createOnethingRadioStore(dir)
    store.writeBrief({ active: true, intent: 'x', played: [], skipped: [], loved: [] })
    for (let index = 0; index < 55; index += 1) store.recordPlayed(`song ${index}`)
    const brief = store.readBrief()
    expect(brief.played).toHaveLength(50)
    expect(brief.played.at(-1)?.title).toBe('song 54')
    expect(brief.played[0]?.title).toBe('song 5')
  })

  it('records loved songs (the strongest positive signal)', () => {
    const store = createOnethingRadioStore(dir)
    store.writeBrief({ active: true, intent: 'x', played: [], skipped: [], loved: [] })
    store.recordLoved('岁月神偷 - 金玟岐')
    expect(store.readBrief().loved.map(spin => spin.title)).toEqual(['岁月神偷 - 金玟岐'])
  })

  it('recordError writes once and clears with undefined', () => {
    const store = createOnethingRadioStore(dir)
    store.writeBrief({ active: true, intent: 'x', played: [], skipped: [], loved: [] })
    store.recordError('DJ 没接上')
    expect(store.readBrief().lastError).toBe('DJ 没接上')
    store.recordError(undefined)
    expect(store.readBrief().lastError).toBeUndefined()
  })

  describe('mergeInbox (the single-writer rule)', () => {
    const entry = (n: number, title = `song ${n}`) => ({
      encryptedId: 'D71F6E90EA704F1C44183933E7E0F19' + n,
      originalId: String(n),
      title,
    })

    it('moves the inbox into the programme and empties it', () => {
      const store = createOnethingRadioStore(dir)
      store.writeBrief({ active: true, intent: 'x', played: [], skipped: [], loved: [] })
      store.writeProgramme({ entries: [entry(1)] })
      writeFileSync(store.inboxPath, JSON.stringify({ entries: [entry(2), entry(3)] }))

      expect(store.mergeInbox()).toBe(2)
      expect(store.readProgramme().entries.map(item => item.title)).toEqual([
        'song 1', 'song 2', 'song 3',
      ])
      expect(store.mergeInbox()).toBe(0) // drained
    })

    it('carries the curation-time playFlag through, dropping non-boolean noise', () => {
      const store = createOnethingRadioStore(dir)
      store.writeBrief({ active: true, intent: 'x', played: [], skipped: [], loved: [] })
      store.writeProgramme({ entries: [] })
      writeFileSync(
        store.inboxPath,
        JSON.stringify({
          entries: [
            { ...entry(1), playFlag: false },
            { ...entry(2), playFlag: true },
            { ...entry(3), playFlag: 'yes' }, // a model is not a schema validator
          ],
        }),
      )

      expect(store.mergeInbox()).toBe(3)
      expect(store.readProgramme().entries.map(item => item.playFlag)).toEqual([
        false, true, undefined,
      ])
    })

    it('drops inbox songs already in the programme or recently played', () => {
      // The exact failure this exists for: the conductor popped a song to the
      // player while the DJ was still curating; the DJ's stale copy must not
      // bring it back (one song really did play three times).
      const store = createOnethingRadioStore(dir)
      store.writeBrief({
        active: true,
        intent: 'x',
        played: [{ title: 'Near Light - Ólafur Arnalds', at: '' }],
        skipped: [], loved: [],
      })
      store.writeProgramme({ entries: [entry(1)] })
      writeFileSync(
        store.inboxPath,
        JSON.stringify({
          entries: [
            entry(1), // already queued (same id)
            entry(2, 'Near Light - Ólafur Arnalds'), // already played (same title)
            entry(3),
          ],
        }),
      )

      expect(store.mergeInbox()).toBe(1)
      expect(store.readProgramme().entries.map(item => item.title)).toEqual([
        'song 1', 'song 3',
      ])
    })

    it('treats a missing or malformed inbox as empty', () => {
      const store = createOnethingRadioStore(dir)
      expect(store.mergeInbox()).toBe(0)
      writeFileSync(store.inboxPath, '{"entries":[{"encryptedId":"D71F')
      expect(store.mergeInbox()).toBe(0)
    })
  })

  describe('mergeIntent (the model never writes the brief)', () => {
    it('applies open/retune/close and clears the file', () => {
      const store = createOnethingRadioStore(dir)
      store.writeBrief({ active: false, intent: '', played: [], skipped: [], loved: [] })
      writeFileSync(
        store.intentPath,
        JSON.stringify({ active: true, intent: '雨天民谣', startedAt: '2026-07-16T21:00:00Z' }),
      )

      expect(store.mergeIntent()).toBe(true)
      const brief = store.readBrief()
      expect(brief.active).toBe(true)
      expect(brief.intent).toBe('雨天民谣')
      expect(brief.startedAt).toBe('2026-07-16T21:00:00Z')
      expect(store.mergeIntent()).toBe(false) // cleared

      writeFileSync(store.intentPath, JSON.stringify({ active: false }))
      expect(store.mergeIntent()).toBe(true)
      expect(store.readBrief().active).toBe(false)
      expect(store.readBrief().intent).toBe('雨天民谣') // untouched fields survive
    })

    it('preserves the conductor bookkeeping the model must not clobber', () => {
      const store = createOnethingRadioStore(dir)
      store.writeBrief({
        active: true, intent: '旧台', played: [{ title: 'a', at: '' }], skipped: [], loved: [],
        onDeck: {
          encryptedId: 'D71F6E90EA704F1C44183933E7E0F191',
          originalId: '1',
          title: '在放的歌',
        },
      })
      writeFileSync(store.intentPath, JSON.stringify({ active: true, intent: '新台' }))

      store.mergeIntent()
      const brief = store.readBrief()
      expect(brief.intent).toBe('新台')
      expect(brief.onDeck?.title).toBe('在放的歌')
      expect(brief.played).toHaveLength(1)
    })

    it('ignores garbage', () => {
      const store = createOnethingRadioStore(dir)
      writeFileSync(store.intentPath, '{"active": "yes"')
      expect(store.mergeIntent()).toBe(false)
      writeFileSync(store.intentPath, '{}')
      expect(store.mergeIntent()).toBe(false)
    })

    it('a fresh open with empty intent wipes the intent and its set-time', () => {
      const store = createOnethingRadioStore(dir)
      writeFileSync(store.intentPath, JSON.stringify({ active: true, intent: '午睡歌曲' }))
      store.mergeIntent()
      expect(store.readBrief().intent).toBe('午睡歌曲')
      expect(store.readBrief().intentSetAt).toBeTruthy()

      // 新电台 with no typed direction: intent key present but empty → cleared.
      writeFileSync(store.intentPath, JSON.stringify({ active: true, intent: '' }))
      store.mergeIntent()
      expect(store.readBrief().intent).toBe('')
      expect(store.readBrief().intentSetAt).toBeUndefined()
    })
  })

  describe('expireStaleIntent', () => {
    const TTL = 6 * 60 * 60 * 1_000

    it('clears an intent older than the ttl, keeps a fresh one', () => {
      const store = createOnethingRadioStore(dir)
      // Fresh (just set) — kept.
      writeFileSync(store.intentPath, JSON.stringify({ active: true, intent: '深夜爵士' }))
      store.mergeIntent()
      expect(store.expireStaleIntent(TTL)).toBe(false)
      expect(store.readBrief().intent).toBe('深夜爵士')

      // Backdate the set-time past the window — next check clears it.
      const brief = store.readBrief()
      brief.intentSetAt = new Date(Date.now() - TTL - 1_000).toISOString()
      store.writeBrief(brief)
      expect(store.expireStaleIntent(TTL)).toBe(true)
      expect(store.readBrief().intent).toBe('')
      expect(store.readBrief().intentSetAt).toBeUndefined()
    })

    it('treats a pre-feature intent (no set-time) as expired', () => {
      const store = createOnethingRadioStore(dir)
      store.writeBrief({ active: true, intent: '旧意图', played: [], skipped: [], loved: [] })
      expect(store.expireStaleIntent(TTL)).toBe(true)
      expect(store.readBrief().intent).toBe('')
    })

    it('is a no-op when there is no intent', () => {
      const store = createOnethingRadioStore(dir)
      store.writeBrief({ active: true, intent: '', played: [], skipped: [], loved: [] })
      expect(store.expireStaleIntent(TTL)).toBe(false)
    })
  })
})
