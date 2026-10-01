import type { SessionEventToolSchema } from './events/types.js'

/** Read projection for one recorded tool call and its paired result. */
export interface SessionToolCallInspection {
  callId: string
  name: string
  argumentsRaw: string
  callTime: number
  callSeq: number
  resultPreview?: string
  isError?: boolean
  resultTime?: number
  /** The last recorded schema at or before this call, never today's schema. */
  schema?: SessionEventToolSchema
}
