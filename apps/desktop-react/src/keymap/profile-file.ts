/**
 * **键位组文件落地的那两下**(K5):把一段文本交给浏览器下载、给导出的文件起
 * 一个名字。读文件那一侧不在这里 —— 它是一枚 `<input type="file">`,住在设置页
 * 上(与 composer 的附件口同一条:文件选择器必须由一次真实的用户手势触发,
 * 所以它是那块面上的一个 DOM 节点,不是一只可以随时调的函数)。
 *
 * ── 为什么是 Blob + 一枚 `<a download>`,而不是宿主的原生保存对话框 ────────
 * 派工单点名了这一条:`configurePluginsHost.pickFile` 是插件系统的口,不许借。
 * 这台壳自己已经有同一件事的判例 —— `content/blocks/shell/export-png.ts` 的
 * 「导出并交给浏览器下载」:全程 blob URL(不走 `data:`,大文件的 base64 会把
 * 内存翻一倍,而且 Chromium 对 `data:` 下载有长度上限),用完当场 revoke。
 * 这一条同时**两档都能用**:桌面壳里 Electron 按 `will-download` 走它自己的下载
 * 流程,浏览器档里就是一次普通下载,没有第二条路要维护。
 */

/** 导出文件名。**不是**界面文案 —— 它是一个文件名,两种语言下逐字相同。 */
export function keymapProfileFileName(name: string): string {
  /* 文件名里不许出现的那几个字符换成 `-`;空名字回落成一个说得出口的默认。 */
  const safe = name.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-')
  return `onething-keymap-${safe === '' ? 'profile' : safe}.json`
}

/**
 * 交给浏览器下载。**失败不炸** —— 与 `exportSvgAsPng` 同一条:一次导出没成不该
 * 掀掉设置页;真要给反馈是上面那块报告区的事(它会说「导出了没有」)。
 * 回布尔,让调用方说得出话。
 */
export function downloadJsonFile(filename: string, text: string): boolean {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return false
  if (typeof URL.createObjectURL !== 'function') return false
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.click()
    URL.revokeObjectURL(url)
    return true
  } catch {
    return false
  }
}
