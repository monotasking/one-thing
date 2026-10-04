import type { RefTypeSpec } from '../reference-spec.js'

export const dirRefType: RefTypeSpec = {
  type: 'dir',
  summary: 'a directory',
  attrs: [
    {
      name: 'path',
      required: true,
      description: 'absolute directory path, `~/` allowed',
    },
  ],
  example: {
    type: 'dir',
    attrs: { path: '/Users/me/project/src/' },
  },
}
