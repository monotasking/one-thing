import { StreamChannel as CoreStreamChannel } from '@onething/backend/core/events'
import type { StreamChunk } from '@shared/events/index.js'

export class StreamChannel extends CoreStreamChannel<StreamChunk> {}
