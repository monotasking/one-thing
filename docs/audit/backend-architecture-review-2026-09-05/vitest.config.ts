import { defineConfig } from 'vitest/config'
import base from '../../../vitest.config'

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['docs/audit/backend-architecture-review-2026-09-05/repro.test.ts'],
    maxWorkers: 1,
  },
})
