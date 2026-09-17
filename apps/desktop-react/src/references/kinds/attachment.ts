import { resolveIcon } from '../../components/icons'
import { openFileInCurrentTarget } from '../../content/viewer/open-target'
import { registerReferenceKind } from '../registry'
import type { ReferenceKind } from '../kind'
import s from '../ReferenceChip.module.css'

export interface AttachmentRef {
  kind: 'attachmentRef'
  name: string
  path?: string
}

const AttachmentIcon = resolveIcon('Paperclip')

/** Sent attachments keep their original name even when their stored path differs. */
export const attachmentReferenceKind: ReferenceKind<never, AttachmentRef> = {
  id: 'attachment',
  render: (ref) => ({
    className: s.ref,
    dataKind: 'attachmentRef',
    icon: AttachmentIcon,
    iconClassName: s.refIcon,
    label: ref.name,
    labelClassName: s.refName,
    tooltipText: ref.name,
    ...(ref.path ? { tooltipKey: 'chat.ref.openFile' as const, tooltipArgs: { path: ref.name } } : {}),
    clickable: Boolean(ref.path),
  }),
  open: (ref) => {
    if (!ref.path) return false
    openFileInCurrentTarget(ref.path)
    return true
  },
}

registerReferenceKind(attachmentReferenceKind, import.meta.hot)
