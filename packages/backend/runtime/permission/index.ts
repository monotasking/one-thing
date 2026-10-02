import './grant-storage.js'

export { Permission } from '@onething/backend/core/permission'
export {
  DEFAULT_PERMISSION_REJECTED_MESSAGE,
  formatPermissionRejectedMessage,
} from '@shared/permission/rejection-message'
export type {
  PermissionCommandEnvelope,
  PermissionEventBusLike,
  PermissionRespondCommandLike,
} from '@onething/backend/core/permission'
