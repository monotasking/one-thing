import './permission-grants.js'

export { Permission } from '@onething/core/permission'
export {
  DEFAULT_PERMISSION_REJECTED_MESSAGE,
  formatPermissionRejectedMessage,
} from '@shared/permission/rejection-message'
export type {
  PermissionCommandEnvelope,
  PermissionEventBusLike,
  PermissionRespondCommandLike,
} from '@onething/core/permission'
