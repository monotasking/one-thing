// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia } from 'pinia'
import { nextTick } from 'vue'
import StepsPanel from '../StepsPanel.vue'
import type { Step, ToolCall } from '@/types'
import { clearExpansionIntents, getExpansionIntent } from '@/stores/helpers/expansion-intent'

function step(id: string, status: Step['status'] = 'completed', turnIndex = 1): Step {
  const toolCall: ToolCall = {
    id,
    toolId: 'read',
    toolName: 'read',
    status: status === 'running' ? 'executing' : status === 'completed' ? 'completed' : 'pending',
    arguments: { filePath: `/repo/src/${id}.ts` },
    timestamp: 1,
  }
  return {
    id,
    type: 'tool-call',
    title: `read: /repo/src/${id}.ts`,
    status,
    result: 'const value = 1',
    timestamp: 1,
    turnIndex,
    toolCallId: id,
    toolCall,
  }
}

function mountPanel(steps: Step[], intentScope?: string, parentIntentIds?: string[]) {
  return mount(StepsPanel, {
    props: {
      steps,
      ...(intentScope ? { intentScope } : {}),
      ...(parentIntentIds ? { parentIntentIds } : {}),
    },
    global: {
      plugins: [createPinia()],
      stubs: {
        ToolStepDetails: { template: '<div class="detail-stub" />' },
      },
    },
  })
}

const expandedFlags = (w: ReturnType<typeof mountPanel>) =>
  w.findAll('.operation-block').map(b => b.classes().includes('is-expanded'))

async function clickBlock(w: ReturnType<typeof mountPanel>, index: number) {
  await w.findAll('.operation-block > .collapse-panel-header')[index].trigger('click')
  await nextTick()
}

describe('StepsPanel: tool call expansion is independent (no accordion)', () => {
  it('expanding one tool call in the same turn does not collapse its siblings', async () => {
    const w = mountPanel([step('a'), step('b'), step('c')])
    await nextTick()
    // same turn => grouped; open the group first
    await w.find('.group-header').trigger('click')
    await nextTick()

    await clickBlock(w, 0)
    expect(expandedFlags(w)).toEqual([true, false, false])

    await clickBlock(w, 1)
    expect(expandedFlags(w)).toEqual([true, true, false])

    await clickBlock(w, 2)
    expect(expandedFlags(w)).toEqual([true, true, true])

    // collapsing one leaves the others alone
    await clickBlock(w, 1)
    expect(expandedFlags(w)).toEqual([true, false, true])
  })

  it('expanding one tool call across different turns does not collapse the others', async () => {
    const w = mountPanel([step('a', 'completed', 1), step('b', 'completed', 2), step('c', 'completed', 3)])
    await nextTick()

    await clickBlock(w, 0)
    await clickBlock(w, 2)
    expect(expandedFlags(w)).toEqual([true, false, true])
  })

  it('a tool call arriving mid-stream does not collapse an already-expanded sibling', async () => {
    const w = mountPanel([step('a', 'completed', 1)])
    await nextTick()
    await clickBlock(w, 0)
    expect(expandedFlags(w)).toEqual([true])

    // new tool call streams in, in a new turn
    await w.setProps({ steps: [step('a', 'completed', 1), step('b', 'running', 2)] })
    await nextTick()
    expect(expandedFlags(w)[0]).toBe(true)

    // ...and in the same turn (single -> grouped transition)
    await w.setProps({ steps: [step('a', 'completed', 1), step('b', 'running', 1)] })
    await nextTick()
    expect(expandedFlags(w)[0]).toBe(true)
  })

  it('an expanded activity keeps its group open when the group forms around it', async () => {
    const w = mountPanel([step('a', 'completed', 1)])
    await nextTick()
    await clickBlock(w, 0)
    expect(expandedFlags(w)).toEqual([true])

    // second call in the same turn turns the single row into a group
    await w.setProps({ steps: [step('a', 'completed', 1), step('b', 'completed', 1)] })
    await nextTick()

    expect(w.find('.workflow-group').classes()).toContain('is-expanded')
    expect(expandedFlags(w)[0]).toBe(true)
  })
})

// `intentScope` switches the panel to CONTROLLED expansion, whose priority is
// user record > per-row auto-expand > collapsed. Without it, CollapseGroup
// re-registered every remounted panel against its *current* auto-expand flag,
// which silently re-opened rows the user had just closed.
describe('StepsPanel: expansion intent outranks auto-expand', () => {
  beforeEach(() => {
    clearExpansionIntents()
  })

  const liveGroup = () => [step('a', 'running', 1), step('b', 'running', 1)]

  it('keeps a user collapse of an auto-expanded group across a remount', async () => {
    const first = mountPanel(liveGroup(), 'steps-m1')
    await nextTick()
    // A group whose work is still in flight opens itself.
    expect(first.find('.workflow-group').classes()).toContain('is-expanded')

    await first.find('.group-header').trigger('click')
    await nextTick()
    expect(first.find('.workflow-group').classes()).not.toContain('is-expanded')
    first.unmount()

    const remounted = mountPanel(liveGroup(), 'steps-m1')
    await nextTick()
    expect(remounted.find('.workflow-group').classes()).not.toContain('is-expanded')
  })

  it('leaves the auto-expand alone under a different scope', async () => {
    const first = mountPanel(liveGroup(), 'steps-m1')
    await nextTick()
    await first.find('.group-header').trigger('click')
    first.unmount()

    const other = mountPanel(liveGroup(), 'steps-m2')
    await nextTick()
    expect(other.find('.workflow-group').classes()).toContain('is-expanded')
  })

  it('records a user expand of a row that would otherwise stay folded', async () => {
    const first = mountPanel([step('a', 'completed', 1)], 'steps-m1')
    await nextTick()
    expect(expandedFlags(first)).toEqual([false])

    await clickBlock(first, 0)
    expect(expandedFlags(first)).toEqual([true])
    first.unmount()

    const remounted = mountPanel([step('a', 'completed', 1)], 'steps-m1')
    await nextTick()
    expect(expandedFlags(remounted)).toEqual([true])
  })
})

/**
 * 展开方向连续、收起方向受限。批次 settle 时组的 auto 由 true 翻成 false ——
 * 组自己没有 intent 的话本来就该合上,但组里有用户展开的东西时合上 = 把用户
 * 正在看的详情一起藏走。
 */
describe('StepsPanel: a group never auto-collapses over a live user intent', () => {
  beforeEach(() => {
    clearExpansionIntents()
  })

  const running = () => [step('a', 'running', 1), step('b', 'running', 1)]
  const settled = () => [step('a', 'completed', 1), step('b', 'completed', 1)]

  it('folds a settled group when nobody touched anything inside it', async () => {
    const w = mountPanel(running(), 'steps-m1')
    await nextTick()
    expect(w.find('.workflow-group').classes()).toContain('is-expanded')

    await w.setProps({ steps: settled() })
    await nextTick()
    expect(w.find('.workflow-group').classes()).not.toContain('is-expanded')
  })

  it('keeps a settled group open when a row inside carries a user record', async () => {
    const w = mountPanel(running(), 'steps-m1')
    await nextTick()
    await clickBlock(w, 0)
    expect(expandedFlags(w)[0]).toBe(true)

    // 批次跑完:组的 auto 翻成 false,但组里有意图。
    await w.setProps({ steps: settled() })
    await nextTick()

    expect(w.find('.workflow-group').classes()).toContain('is-expanded')
    expect(expandedFlags(w)[0]).toBe(true)
  })

  it('writes intent onto the ancestor chain when a row is expanded', async () => {
    const w = mountPanel(running(), 'steps-m1')
    await nextTick()
    await clickBlock(w, 0)

    expect(getExpansionIntent('steps-m1:group-a')).toBe(true)

    // 收起子项不动祖先。
    await clickBlock(w, 0)
    expect(getExpansionIntent('steps-m1:group-a')).toBe(true)
  })

  it('pins host containers listed in parentIntentIds when a row is expanded', async () => {
    const w = mountPanel([step('a', 'completed', 1)], 'steps-m1', ['rail-m1-process-0'])
    await nextTick()

    await clickBlock(w, 0)
    expect(getExpansionIntent('rail-m1-process-0')).toBe(true)
  })

  it('leaves the host container alone when a row is collapsed', async () => {
    const w = mountPanel([step('a', 'running', 1)], 'steps-m1', ['rail-m1-process-0'])
    await nextTick()
    // 单行、非 flat:没有组壳,行自己就是面板。
    await clickBlock(w, 0)
    clearExpansionIntents('rail-')

    await clickBlock(w, 0)
    expect(getExpansionIntent('rail-m1-process-0')).toBeUndefined()
  })
})
