import { describe, expect, it } from 'vitest'
import { formatRefTag } from '@onething/core/references'
import type { CorePromptFragment } from '@onething/core/engine'
import { refTypes, renderReferenceGuide } from '../index.js'
import type { RefTypeSpec } from '../spec.js'
import { BUILTIN_PROMPT_FRAGMENTS } from '../../prompts/builder.js'

/**
 * 陌生能力演练(仓根 09-02 法 / 设计正本 §3)。
 *
 * 「加一种 `session` 引用」这一问在线上侧的答案必须是:**一只 `types/<x>.ts`
 * 加一行登记**。这条测试现场登记一份设计时没想过的自述,断言提示词里自己
 * 多出那一行与那个例子 —— 而且**不碰任何生产文件**。它红,就说明哪里还在
 * 按类型名枚举。
 */
const drillSpec: RefTypeSpec = {
  type: 'drill-session',
  summary: 'a message in another session',
  attrs: [
    { name: 'id', required: true, description: 'the session id' },
    { name: 'message', description: 'the message id inside it' },
  ],
  example: {
    type: 'drill-session',
    attrs: { id: 'sess_1', message: 'msg_2' },
  },
}

function referencesFragmentText(): string {
  const fragment = BUILTIN_PROMPT_FRAGMENTS.find(
    (entry: CorePromptFragment) => entry.id === 'references',
  )
  expect(fragment, 'the references fragment is gone').toBeDefined()
  const content = fragment!.content
  const rendered = typeof content === 'function' ? content({} as never) : content
  expect(typeof rendered).toBe('string')
  return rendered as string
}

describe('unfamiliar reference type drill', () => {
  it('reaches the prompt on registration and leaves on disposal', () => {
    const before = referencesFragmentText()
    expect(before).not.toContain('drill-session')

    const dispose = refTypes.register(drillSpec)
    try {
      const during = referencesFragmentText()
      expect(during).toContain('`drill-session` — a message in another session')
      expect(during).toContain('`id` (required) the session id')
      expect(during).toContain('`message` the message id inside it')
      expect(during).toContain(formatRefTag(drillSpec.example))
    } finally {
      dispose()
    }

    expect(referencesFragmentText()).toBe(before)
  })

  it('renders the same guide the fragment does, from any registry', () => {
    const dispose = refTypes.register(drillSpec)
    try {
      expect(renderReferenceGuide('PREAMBLE')).toContain('drill-session')
    } finally {
      dispose()
    }
  })
})
