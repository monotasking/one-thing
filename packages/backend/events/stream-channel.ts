import { StreamChannel as CoreStreamChannel } from '@onething/core/events'
import type { StreamChunk } from '@shared/events/index.js'

export class StreamChannel extends CoreStreamChannel<StreamChunk> {}
