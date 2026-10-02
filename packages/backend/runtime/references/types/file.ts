import type { RefTypeSpec } from '../spec.js'

export const fileRefType: RefTypeSpec = {
  type: 'file',
  summary: 'a file the user can open',
  attrs: [
    {
      name: 'path',
      required: true,
      description: 'absolute path, `~/` allowed',
    },
    { name: 'line', description: 'one line `12`, or a range `12-30`' },
    { name: 'col', description: 'a column on that line' },
    {
      name: 'symbol',
      description: 'the function, class or variable you mean inside the file',
    },
  ],
  example: {
    type: 'file',
    attrs: {
      path: '/Users/me/project/src/parser.ts',
      line: '12-30',
      symbol: 'parseToken',
    },
  },
}
