import type { RefTypeSpec } from '../spec.js'

export const skillRefType: RefTypeSpec = {
  type: 'skill',
  summary: 'an installed skill',
  attrs: [{ name: 'name', required: true, description: 'the skill id' }],
  example: {
    type: 'skill',
    attrs: { name: 'onething-self-evolution' },
  },
}
