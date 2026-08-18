/**
 * The variable board as a prompt source (`prompt-channels-2026-08` §1.4).
 *
 * It used to be a private hook inside the stream engine — one string, deduped
 * whole, attached at message-creation time. As a source it obeys the same rules
 * as every other contributor, and the composer is what places it.
 */
import { describe, expect, it, vi } from 'vitest'
import type { CoreBuildPromptContextOptions } from '@onething/core/engine'
import { VariableBoardSource } from '../variable-board.js'
import { PromptComposer, StaticPromptSource } from '../composer.js'

const ctx = (over: Partial<CoreBuildPromptContextOptions> = {}): CoreBuildPromptContextOptions => ({
  hasTools: false,
  skills: [],
  ...over,
})

describe('VariableBoardSource', () => {
  it('contributes one `turn` section carrying the board verbatim', async () => {
    const source = new VariableBoardSource({ render: async () => '<var name="a" state="true">1</var>' })
    expect(await source.collect(ctx({ sessionId: 's1' }))).toEqual([{
      id: 'variables',
      slot: 'section',
      channel: 'turn',
      source: 'variables',
      order: 0,
      content: '<var name="a" state="true">1</var>',
    }])
  })

  it('says nothing without a session — the board is a per-session fact', async () => {
    const render = vi.fn(async () => 'BOARD')
    const source = new VariableBoardSource({ render })
    expect(await source.collect(ctx())).toEqual([])
    expect(render).not.toHaveBeenCalled()
  })

  it('says nothing when the board is empty', async () => {
    const source = new VariableBoardSource({ render: async () => '   \n' })
    expect(await source.collect(ctx({ sessionId: 's1' }))).toEqual([])
  })

  it('lands in the turn channel, never in the system prefix', async () => {
    const composer = new PromptComposer([
      new StaticPromptSource('static', [
        { id: 'note', slot: 'section', source: 'test', order: 100, content: '# Note' },
      ]),
      new VariableBoardSource({ render: () => 'BOARD' }),
    ])
    const composed = await composer.compose(ctx({ sessionId: 's1' }))
    expect(composed.turn).toEqual([{ id: 'variables', content: 'BOARD' }])
    expect(composed.developer).toEqual(['# Note'])
    expect(composed.system).not.toContain('BOARD')
    expect(composed.sections.map(s => s.name)).toEqual(['system', 'note'])
  })
})
