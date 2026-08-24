import { EventBus as CoreEventBus } from '@onething/core/events'
import type { CoreSessionCommandEmitterLike, CoreSessionEventEmitterLike, EmitResult } from '@onething/core/events'
import type { SessionCommand } from '@shared/events/index.js'
import type { GlobalEvent, SessionBusMessage } from '@shared/events/index.js'

/**
 * 泛型是 `SessionBusMessage`(事件 ∪ 命令),不是 `SessionEvent` —— 命令确实
 * 从这条总线上走(见 `SessionBusMessage` 的注释)。
 */
export class EventBus
	extends CoreEventBus<SessionBusMessage, GlobalEvent>
	// S2(I4-缝收口):core 的 ipc-operations 两道口就是靠这个类供货的,写出来。
	implements
		CoreSessionCommandEmitterLike<SessionCommand, EmitResult<SessionBusMessage>>,
		CoreSessionEventEmitterLike<SessionBusMessage, EmitResult<SessionBusMessage>> {}
