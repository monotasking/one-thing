import { StreamChannel as CoreStreamChannel } from '@onething/backend/runtime/event-bus'
import type { StreamChunk } from '@shared/events/index.js'

export class StreamChannel extends CoreStreamChannel<StreamChunk> {}
