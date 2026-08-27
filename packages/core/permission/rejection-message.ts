/**
 * 「用户拒绝了这次授权」那句话 —— **零依赖叶子**(§17.8 U1-a)。
 *
 * 它从前住在 `permission/index.ts` 的开头。那个文件本身要 `node:crypto`
 * (`randomUUID`),而它 import 的 `permission-grants.ts` / `capability-registry.ts`
 * 还要 `node:os` / `node:path` —— 于是**任何**碰这两个符号的模块都被拖进了
 * node 闭包。
 *
 * 唯一被拖进来的受害者是 `tools/tool-result.ts`(它只要这里这两样),而
 * `tool-result` 又在 `session/projection/reducer.ts` 的闭包里 —— 一条纯函数的
 * 折叠器因此在浏览器里 import 不动。**这不是分层错了,是一句话住错了文件**:
 * 一条常量 + 一个字符串拼接,与授权系统的运行期没有半点关系。
 *
 * 拆出来之后:`permission/index.ts` 原样再导出这两样(所有既有 import 一字未改),
 * 而需要它的纯件走这条叶子路径。语义零变化。
 */

/** 授权被拒时给模型看的那句话。 */
export const DEFAULT_PERMISSION_REJECTED_MESSAGE = 'The user rejected permission for this tool.'

/** 带上用户给的理由(有理由才拼,空白理由等同没给)。 */
export function formatPermissionRejectedMessage(reason?: string): string {
  const trimmedReason = typeof reason === 'string' ? reason.trim() : ''
  return trimmedReason
    ? `${DEFAULT_PERMISSION_REJECTED_MESSAGE} Reason: ${trimmedReason}`
    : DEFAULT_PERMISSION_REJECTED_MESSAGE
}
