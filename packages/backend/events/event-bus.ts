import { EventBus as CoreEventBus } from '@onething/core/events'
import type { GlobalEvent, SessionBusMessage } from '@shared/events/index.js'

/**
 * 泛型是 `SessionBusMessage`(事件 ∪ 命令),不是 `SessionEvent` —— 命令确实
 * 从这条总线上走(见 `SessionBusMessage` 的注释)。
 */
export class EventBus extends CoreEventBus<SessionBusMessage, GlobalEvent> {}
