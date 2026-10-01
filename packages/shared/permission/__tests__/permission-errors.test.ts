import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PERMISSION_REJECTED_MESSAGE,
  formatPermissionRejectedMessage,
} from '../rejection-message.js'

describe('core permission error text', () => {
  it('formats the default permission rejection message', () => {
    expect(DEFAULT_PERMISSION_REJECTED_MESSAGE).toBe('The user rejected permission for this tool.')
    expect(formatPermissionRejectedMessage()).toBe(DEFAULT_PERMISSION_REJECTED_MESSAGE)
    expect(formatPermissionRejectedMessage('   ')).toBe(DEFAULT_PERMISSION_REJECTED_MESSAGE)
  })

  it('includes a trimmed rejection reason when present', () => {
    expect(formatPermissionRejectedMessage(' not now '))
      .toBe('The user rejected permission for this tool. Reason: not now')
  })
})
