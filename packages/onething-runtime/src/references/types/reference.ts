import type { RefTypeSpec } from '../spec.js'

export const linkRefType: RefTypeSpec = {
  type: 'reference',
  summary:
    'a source you are citing — a web page, a spec, a document. Not a file: a file is `file`',
  attrs: [
    { name: 'href', required: true, description: 'the URL' },
    { name: 'title', description: 'how to name it on screen' },
  ],
  example: {
    type: 'reference',
    attrs: { href: 'https://example.com/spec', title: 'RFC 9110 §15' },
  },
  // 缺省投影(label ▷ href)会把网址吞掉,而在 IM / 终端里网址就是这一种的
  // 全部价值 —— 那里没有可点的东西,只有可复制的文本。
  plainText: (tag) => {
    const href = tag.attrs.href
    if (!href) return null
    const words = tag.attrs.label || tag.attrs.title
    return words ? `${words} (${href})` : href
  },
}
