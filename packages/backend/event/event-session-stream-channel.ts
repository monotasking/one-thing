import { GenericStreamChannel } from '@onething/backend/event/event-bus-primitives'
import type { StreamChunk } from '@shared/events/index.js'

export class StreamChannel extends GenericStreamChannel<StreamChunk> {}
