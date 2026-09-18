/**
 * **我们对 Obsidian 内部 API 的全部依赖就是这个文件。**
 *
 * `eval code=<js>` 跑在 Obsidian 渲染进程里,拿得到 `app`。那是 Developer 组的
 * 口子,稳定性没有承诺(方案 R8 拍板:接受,条件是集中在一个文件、由
 * `gate:notes` 盯着)。所以:
 *  - 每一段脚本一个具名导出 + 一个返回类型;
 *  - 调用方永远不自己拼 `code=`;
 *  - Obsidian 换了 API,红的是这一个文件和那条真机门,不是半个领域。
 *
 * 全部**只读**。写入(建日记 / 建笔记 / 追加)走 CLI 自己的命令,不走 eval ——
 * 唯一的例外是 `dailyNoteScript()`,理由写在它自己的注释里。
 */

/** `app.vault.getConfig(...)` 里我们用得上的三格。 */
export interface ObsidianVaultConfigRead {
  /**
   * 四种语义:`''` / `'/'` = 库根;`'./x'` = 文档同级的 `x` 子目录;
   * `'./'` = 文档同目录;其余 = 库下固定目录。
   */
  attachmentFolderPath: string | null
  useMarkdownLinks: boolean | null
  /** `'shortest' | 'relative' | 'absolute'`。 */
  newLinkFormat: string | null
}

export function vaultConfigScript(): string {
  return 'JSON.stringify({attachmentFolderPath:app.vault.getConfig("attachmentFolderPath"),'
    + 'useMarkdownLinks:app.vault.getConfig("useMarkdownLinks"),'
    + 'newLinkFormat:app.vault.getConfig("newLinkFormat")})'
}

/** daily-notes 核心插件的 `instance.options`。插件没开时整段是 `null`。 */
export interface ObsidianDailyNotesOptions {
  format?: string
  folder?: string
  template?: string
}

export function dailyNotesOptionsScript(): string {
  return 'JSON.stringify(app.internalPlugins.getPluginById("daily-notes")?.instance?.options ?? null)'
}

/**
 * 附件落点。返回的是 vault 相对路径。
 *
 * 为什么问它而不是自己按 `attachmentFolderPath` 算:那四种语义还叠着「同名文件
 * 自动加序号」,自己算出来的路径会覆盖用户已有的附件。
 */
export function attachmentPathScript(fileName: string, sourcePath: string): string {
  return `(async()=>JSON.stringify(await app.fileManager.getAvailablePathForAttachment(`
    + `${jsString(fileName)},${jsString(sourcePath)})))()`
}

/** 链接文本(`[[x]]` / `[x](y)`,按用户的 `useMarkdownLinks` + `newLinkFormat`)。 */
export function markdownLinkScript(targetPath: string, sourcePath: string): string {
  return `app.fileManager.generateMarkdownLink(`
    + `app.vault.getAbstractFileByPath(${jsString(targetPath)}),${jsString(sourcePath)})`
}

/** 按 wikilink 规则解析一个名字 → vault 相对路径,解析不到是 `null`。 */
export function resolveLinkScript(name: string, sourcePath: string): string {
  return `app.metadataCache.getFirstLinkpathDest(${jsString(name)},${jsString(sourcePath)})?.path ?? null`
}

/**
 * 「新建今日」。
 *
 * 走 Obsidian 自己的 `getDailyNote()`:文件夹、格式、模板三件都按用户在
 * daily-notes 插件里的设置来,而且**不开窗**。自己拼路径再 `create` 的话,模板
 * 那一格就永远是我们猜的。
 *
 * 幂等:今日已存在时它返回那个文件,不重建。这也是 `gate:notes` 第 ⑤ 步敢在
 * 用户真实 vault 上调它的唯一理由 —— 门只对「今日已存在」的库调。
 */
export function dailyNoteScript(): string {
  return '(async()=>(await app.internalPlugins.getPluginById("daily-notes").instance.getDailyNote()).path)()'
}

/**
 * 进 `code=` 的字符串字面量。
 *
 * `JSON.stringify` 负责引号与转义;`<` 与两个 JS 行终止符(U+2028 / U+2029)单独再 escape ——
 * 前者防的是 `</script`(这段文本最终在渲染进程里被当代码求值),后两个在 JS
 * 源码里是行终止符,直接写进字面量会把一行代码劈成两行。
 */
function jsString(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}
