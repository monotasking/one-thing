/**
 * web 壳上「这台宿主做不到」的统一答复 —— 结构债 P4 终态批 A1-a(2026-08-23)。
 *
 * 句子**逐字**沿用迁移前 `platform/web.ts` 里那只 `unsupported(method)` 生成的那句,
 * 连里面的方法名都用迁移前渲染层看见的那个名字。理由是这批只搬路,不改行为:
 * 这些调用点(`platformApi.toggleSearchWindow()` 之类)从来是**拿到一个
 * `{ success:false, error }` 就算了**,不是 catch 一个异常;换成"域里没这个方法"
 * 会让 `createRouterClient` 抛,未 await 的调用点当场变成 unhandled rejection。
 *
 * 所以 web 侧这些方法是**注册了的**,只是老实回答做不到 —— 和从前一模一样。
 */
export interface WebShellUnsupportedResult {
  success: false
  error: string
}

export function webShellUnsupported(legacyMethodName: string): WebShellUnsupportedResult {
  return {
    success: false,
    error: `Platform method "${legacyMethodName}" is not available in the web host yet.`,
  }
}
