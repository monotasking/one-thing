/**
 * 写剪贴板 —— **一处实现**。
 *
 * 剪贴板在 Electron 渲染进程里是 `navigator.clipboard`,但它**不保证存在**
 * (非安全上下文、jsdom)。拿不到 / 写失败一律如实回 false,**不抛**:
 * 一次没复制成不该把调用方那块界面炸掉。
 *
 * 反馈不在这里:复制成没成怎么说给用户听,是各处自己的事(08-31 拍板:
 * 复制走**就地反馈**,不弹通知)—— 文件行菜单换一行字、详情浮层换一枚图标、
 * 查看器檐上换一颗钮,读屏播报由调用方按自己的现场决定。这一层只管写。
 */
export async function copyText(text: string): Promise<boolean> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (!clipboard?.writeText) return false
  return clipboard.writeText(text).then(
    () => true,
    () => false,
  )
}
