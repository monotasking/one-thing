/**
 * `Permission`(询问、回应、通道亲和)的出口,并顺带装上授权的落盘(`permission-grant-storage.js` 的副作用 import)。
 * 它从前是 `runtime/permission/index.ts`;收尾整理 2(2026-10-03)把 `runtime/permission/` 并进 `permission/`,
 * 目录桶 `index.ts` 留给 permissions 原有的那只,这只按内容改名。
 */
import './permission-grant-storage.js'

export { Permission } from '@onething/backend/permission/permission-asks'
export {
  DEFAULT_PERMISSION_REJECTED_MESSAGE,
  formatPermissionRejectedMessage,
} from '@shared/permission/rejection-message'
export type {
  PermissionCommandEnvelope,
  PermissionEventBusLike,
  PermissionRespondCommandLike,
} from '@onething/backend/permission/permission-asks'
