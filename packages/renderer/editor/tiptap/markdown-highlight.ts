/**
 * `==高亮==` 的 markdown 往返。
 *
 * 官方的 `@tiptap/extension-highlight` 只管**文档里**的这枚 mark:输入规则
 * (`==字==` 打完即成)、快捷键、渲染成 `<mark>`。它在 tiptap v3 里另带一份
 * `renderMarkdown` / `parseMarkdown`,但那是 tiptap 自己的 markdown 通道 ——
 * 我们的存取格式走的是 **tiptap-markdown**,两条通道互不认识。
 *
 * tiptap-markdown 对没有 markdown spec 的 mark 一律回落到 `markdownHTMLMark`,
 * 而我们是 `html: false`(纸里不许出现只有编辑器看得懂的东西),那条回落会
 * **静默丢掉 mark 只留文字**(它自己 `console.warn` 一句然后返回空串)。所以这里
 * 补两半:
 *
 *  · 出:`serialize.open/close` = `==` —— 与输入规则同一套语法;
 *  · 进:`parse.setup` 给 markdown-it 装上官方的 `markdown-it-mark`,`==字==`
 *    渲染成 `<mark>`,再由 Highlight 自己的 `parseHTML` 收回文档。
 *
 * 两半必须成对存在,少哪一半都是"存进去读不回来"。
 */
import Highlight from '@tiptap/extension-highlight'
import markdownItMark from 'markdown-it-mark'

/** `parse.setup` 只用得到 `use` 这一格,不去牵 markdown-it 的整份类型。 */
interface MarkdownItLike {
  use: (plugin: unknown) => unknown
}

/**
 * `setup` 会在**每一次** `parse()` 时被调走一遍(tiptap-markdown 的 MarkdownParser
 * 每次都遍历一圈扩展),而 `md.use()` 不是幂等的 —— markdown-it 的 ruler 允许重名,
 * 于是每装载一次纸就往 inline ruler 里多插一条同名规则,只增不减。装过就记账,
 * 一个 md 实例只装一次;WeakSet 保证编辑器销毁后连带释放。
 */
const patchedMarkdownIt = new WeakSet<MarkdownItLike>()

export const MarkdownHighlight = Highlight.extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize: { open: '==', close: '==' },
        parse: {
          setup(markdownit: MarkdownItLike) {
            if (patchedMarkdownIt.has(markdownit)) return
            patchedMarkdownIt.add(markdownit)
            markdownit.use(markdownItMark)
          },
        },
      },
    }
  },
})
