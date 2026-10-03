import { StreamChannel as CoreStreamChannel } from '@onething/backend/runtime/events/bus-primitives'
import type { StreamChunk } from '@shared/events/index.js'

export class StreamChannel extends CoreStreamChannel<StreamChunk> {}
