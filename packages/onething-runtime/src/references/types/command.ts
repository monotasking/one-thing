import type { RefTypeSpec } from '../spec.js'

export const commandRefType: RefTypeSpec = {
  type: 'command',
  summary:
    'a slash command you are offering the user — clicking it fills the composer, it does not run',
  attrs: [
    {
      name: 'name',
      required: true,
      description: 'the command name, without the leading slash',
    },
    { name: 'args', description: 'arguments to prefill after it' },
  ],
  example: { type: 'command', attrs: { name: 'compact' } },
  // 缺省投影会交出裸 `compact`,而这一种在纯文本里的读法就是人手敲的那一行。
  plainText: (tag) => {
    const name = tag.attrs.name
    if (!name) return null
    const args = tag.attrs.args
    return args ? `/${name} ${args}` : `/${name}`
  },
}
